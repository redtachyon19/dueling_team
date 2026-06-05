import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Deck } from "@duel/shared";
import { listDecks, loadDeck, saveDeck, deleteDeck } from "@duel/local-backend";
import { DuelSession } from "./duel/session.ts";
import type { DuelResponse, DuelStartOptions, DuelStartResult, DuelUpdate } from "@duel/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// App display name (window title, macOS menu bar, dock).
app.setName("Dueling Team");

/** The app icon (client/build/icon.png), or null if it can't be found. */
function appIcon(): Electron.NativeImage | null {
  // Dev: main runs from client/out/main → client/build. Packaged builds fall
  // back to the app path. First existing candidate wins.
  const candidates = [
    path.join(__dirname, "../../build/icon.png"),
    path.join(app.getAppPath(), "build/icon.png"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  return null;
}

/** Where saved decks live: <userData>/decks (created on first write). */
function decksDir(): string {
  return path.join(app.getPath("userData"), "decks");
}

// Custom scheme used to serve local card art to the renderer
// (card://card/<passcode>). Must be registered before the app is ready.
// `secure`/`standard` let it behave like https for fetch/<img>; CSP still
// applies, so index.html lists `card:` under img-src.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "card",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

/**
 * Locate the local asset folder by walking up from this file. In dev, main
 * runs from client/out/main → repo-root/assets. The app never fetches over the
 * network; it only reads these local files.
 */
function findAssetsDir(): string | null {
  const starts = [__dirname, app.getAppPath()];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "assets");
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const icon = appIcon();
  // macOS shows the icon in the dock rather than the window frame.
  if (icon && process.platform === "darwin") app.dock?.setIcon(icon);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#111111",
    title: "Dueling Team",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // electron-vite injects this env var with the dev server URL.
  // In production, load the built renderer from disk.
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

// --- IPC: load the local card database ------------------------------------
// Returns the card array from assets/cards/db.json, or null when the
// database hasn't been imported yet (run `pnpm import:cards`). The renderer
// filters in-memory; the DB is read once per request.
ipcMain.handle("cards:load", async () => {
  const assets = findAssetsDir();
  if (!assets) return null;
  const dbPath = path.join(assets, "cards", "db.json");
  try {
    const parsed = JSON.parse(await readFile(dbPath, "utf8"));
    return Array.isArray(parsed?.cards) ? parsed.cards : null;
  } catch {
    return null;
  }
});

// --- IPC: load the local set database -------------------------------------
// Returns the set array from assets/sets/db.json (used to resolve a
// card's set codes to names/release dates), or null if not imported yet.
ipcMain.handle("sets:load", async () => {
  const assets = findAssetsDir();
  if (!assets) return null;
  try {
    const parsed = JSON.parse(await readFile(path.join(assets, "sets", "db.json"), "utf8"));
    return Array.isArray(parsed?.sets) ? parsed.sets : null;
  } catch {
    return null;
  }
});

// --- IPC: deck persistence (stored under <userData>/decks) -----------------
ipcMain.handle("decks:list", () => listDecks(decksDir()));
ipcMain.handle("decks:load", (_e, id: string) => loadDeck(decksDir(), id));
ipcMain.handle("decks:save", (_e, deck: Deck) => saveDeck(decksDir(), deck));
ipcMain.handle("decks:delete", (_e, id: string) => deleteDeck(decksDir(), id));

// --- IPC: file import/export via native dialogs ----------------------------
// Used by the deck editor's Import / Export. The renderer builds the file
// contents (YDK / TXT / JSON text, or base64 PNG bytes); these just pick a
// path and read/write it. Kept generic rather than deck-specific.
interface FileFilter {
  name: string;
  extensions: string[];
}
ipcMain.handle(
  "io:save",
  async (
    _e,
    opts: { defaultName: string; data: string; encoding?: "utf8" | "base64"; filters?: FileFilter[] },
  ) => {
    if (!mainWindow) return { ok: false };
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: opts.defaultName,
      ...(opts.filters ? { filters: opts.filters } : {}),
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      await writeFile(res.filePath, Buffer.from(opts.data, opts.encoding ?? "utf8"));
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
);
ipcMain.handle("io:open", async (_e, opts?: { filters?: FileFilter[] }) => {
  if (!mainWindow) return { ok: false };
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    ...(opts?.filters ? { filters: opts.filters } : {}),
  });
  const file = res.filePaths[0];
  if (res.canceled || !file) return { ok: false, canceled: true };
  try {
    const text = await readFile(file, "utf8");
    return { ok: true, name: path.basename(file), text };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// --- IPC: banlists (read-only, from assets/banlists) -----------------
// list → the index.json revisions array; load → a single dated revision file.
ipcMain.handle("banlists:list", async () => {
  const assets = findAssetsDir();
  if (!assets) return [];
  try {
    const idx = JSON.parse(await readFile(path.join(assets, "banlists", "index.json"), "utf8"));
    return Array.isArray(idx?.revisions) ? idx.revisions : [];
  } catch {
    return [];
  }
});
ipcMain.handle("banlists:load", async (_e, date: string) => {
  const assets = findAssetsDir();
  if (!assets || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return JSON.parse(await readFile(path.join(assets, "banlists", `${date}.json`), "utf8"));
  } catch {
    return null;
  }
});

// --- IPC: genesys point lists (read-only, from assets/genesys) -------------
// list → the index.json revisions array; load → a single dated revision file.
ipcMain.handle("genesys:list", async () => {
  const assets = findAssetsDir();
  if (!assets) return [];
  try {
    const idx = JSON.parse(await readFile(path.join(assets, "genesys", "index.json"), "utf8"));
    return Array.isArray(idx?.revisions) ? idx.revisions : [];
  } catch {
    return [];
  }
});
ipcMain.handle("genesys:load", async (_e, date: string) => {
  const assets = findAssetsDir();
  if (!assets || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return JSON.parse(await readFile(path.join(assets, "genesys", `${date}.json`), "utf8"));
  } catch {
    return null;
  }
});

// --- IPC: a single card's banlist + genesys history -----------------------
// Computed here (not in the renderer) so we read the ~80 banlist / ~7 genesys
// files once and cache the parsed revisions for the app session, instead of
// shipping all of them across the bridge or re-reading per card.
async function readAllRevisions(sub: string): Promise<any[]> {
  const assets = findAssetsDir();
  if (!assets) return [];
  let index: any;
  try {
    index = JSON.parse(await readFile(path.join(assets, sub, "index.json"), "utf8"));
  } catch {
    return [];
  }
  const metas: any[] = Array.isArray(index?.revisions) ? index.revisions : [];
  const out: any[] = [];
  for (const m of metas) {
    try {
      out.push(JSON.parse(await readFile(path.join(assets, sub, m.file), "utf8")));
    } catch {
      // skip unreadable revision
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date))); // chronological
}

let banlistRevs: any[] | null = null;
ipcMain.handle("banlists:history", async (_e, id: number) => {
  if (!banlistRevs) banlistRevs = await readAllRevisions("banlists");
  const has = (arr: any[]) => Array.isArray(arr) && arr.some((c) => c.id === id);
  const statusAt = (rev: any): string =>
    has(rev.forbidden) ? "Forbidden" : has(rev.limited) ? "Limited" : has(rev.semiLimited) ? "Semi-Limited" : "Unlimited";

  // Collapse consecutive same-status revisions into spans.
  const spans: Array<{ status: string; from: string; to: string }> = [];
  for (const rev of banlistRevs) {
    const status = statusAt(rev);
    const last = spans[spans.length - 1];
    if (last && last.status === status) last.to = rev.date;
    else spans.push({ status, from: rev.date, to: rev.date });
  }
  const latest = banlistRevs[banlistRevs.length - 1]?.date;
  return spans
    .filter((s) => s.status !== "Unlimited")
    .map((s) => ({ ...s, current: s.to === latest }));
});

let genesysRevs: any[] | null = null;
ipcMain.handle("genesys:history", async (_e, id: number) => {
  if (!genesysRevs) genesysRevs = await readAllRevisions("genesys");
  // Points at each revision (0 = not listed), then the change events between them.
  const seq = genesysRevs.map((rev) => {
    const hit = Array.isArray(rev.cards) ? rev.cards.find((c: any) => c.id === id) : null;
    return { date: rev.date as string, points: (hit?.points as number) ?? 0 };
  });
  const current = seq.length ? seq[seq.length - 1]!.points : 0;
  const changes: Array<{ date: string; delta: number; points: number }> = [];
  for (let i = 1; i < seq.length; i++) {
    const delta = seq[i]!.points - seq[i - 1]!.points;
    if (delta !== 0) changes.push({ date: seq[i]!.date, delta, points: seq[i]!.points });
  }
  return { current, changes };
});

// --- IPC: duel (ocgcore session in the main process) ----------------------
// One active session at a time. Updates (state + prompt + events) are pushed to
// the renderer over "match:update"; the renderer answers prompts via "match:respond".
let duelSession: DuelSession | null = null;
// Seed the duel RNG from OS entropy so every app launch (and each duel within
// it, advanced by the LCG below) deals a freshly shuffled deck. Previously this
// was a fixed constant, so the first duel after every launch was identical.
let duelSeed = randomBytes(8).readBigUInt64LE() | 1n;

ipcMain.handle("match:start", async (_e, opts: DuelStartOptions): Promise<DuelStartResult> => {
  duelSession?.end();
  duelSession = null;

  const deck = await loadDeck(decksDir(), opts.deckId);
  if (!deck) return { ok: false, error: "deck not found" };

  const send = (u: DuelUpdate) => mainWindow?.webContents.send("match:update", u);
  const startDirs = [__dirname, app.getAppPath()];
  const session = new DuelSession(send, startDirs);
  duelSession = session;

  duelSeed = (duelSeed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  const res = await session.start({ main: deck.main, extra: deck.extra }, duelSeed, opts.goldfish ?? true);
  if (!res.ok) {
    duelSession = null;
    return { ok: false, error: res.error ?? "failed to start duel", unsupported: res.unsupported };
  }
  return { ok: true, unsupported: res.unsupported };
});

ipcMain.handle("match:respond", (_e, r: DuelResponse) => {
  duelSession?.respond(r);
});

ipcMain.handle("match:surrender", () => {
  duelSession?.surrender();
});

ipcMain.handle("match:end", () => {
  duelSession?.end();
  duelSession = null;
});

app.whenReady().then(() => {
  // --- card://card/<passcode> → local card art (image/jpeg) -------------
  protocol.handle("card", async (request) => {
    const assets = findAssetsDir();
    let id = "";
    let host = "";
    try {
      const url = new URL(request.url);
      host = url.hostname;
      id = url.pathname.replace(/^\/+/, "").replace(/\.jpg$/i, "");
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!assets || host !== "card" || !/^\d+$/.test(id)) {
      return new Response(null, { status: 404 });
    }
    try {
      const buf = await readFile(path.join(assets, "cards", "images", `${id}.jpg`));
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          // Allow the renderer to draw card art onto a <canvas> and read it
          // back (deck PNG export) without tainting the canvas.
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      // Art not downloaded yet (run `pnpm build:images`); renderer shows a placeholder.
      return new Response(null, { status: 404 });
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
