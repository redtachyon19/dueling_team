import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Deck } from "@duel/shared";
import { listDecks, loadDeck, saveDeck, deleteDeck } from "@duel/local-backend";
import { DuelSession } from "./duel/session.ts";
import { NetClient } from "./net/client.ts";
import { startRelay, type RelayHandle } from "@duel/relay-server";
import type {
  DuelResponse, DuelStartOptions, DuelStartResult, DuelUpdate,
  NetHostOptions, NetJoinOptions, NetStatus, NetResult,
} from "@duel/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("Dueling Team");

function appIcon(): Electron.NativeImage | null {
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

function decksDir(): string {
  return path.join(app.getPath("userData"), "decks");
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "card",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function findAssetsDir(): string | null {
  return findRepoDir("assets");
}

function findEngineDir(): string | null {
  return findRepoDir("engine");
}

function findRepoDir(name: string): string | null {
  const starts = [__dirname, app.getAppPath()];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, name);
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

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("cards:load", async () => {
  const engine = findEngineDir();
  if (!engine) return null;
  const dbPath = path.join(engine, "cards", "db.json");
  try {
    const parsed = JSON.parse(await readFile(dbPath, "utf8"));
    return Array.isArray(parsed?.cards) ? parsed.cards : null;
  } catch {
    return null;
  }
});

ipcMain.handle("sets:load", async () => {
  const engine = findEngineDir();
  if (!engine) return null;
  try {
    const parsed = JSON.parse(await readFile(path.join(engine, "sets", "db.json"), "utf8"));
    return Array.isArray(parsed?.sets) ? parsed.sets : null;
  } catch {
    return null;
  }
});

ipcMain.handle("decks:list", () => listDecks(decksDir()));
ipcMain.handle("decks:load", (_e, id: string) => loadDeck(decksDir(), id));
ipcMain.handle("decks:save", (_e, deck: Deck) => saveDeck(decksDir(), deck));
ipcMain.handle("decks:delete", (_e, id: string) => deleteDeck(decksDir(), id));

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

ipcMain.handle("banlists:list", async () => {
  const engine = findEngineDir();
  if (!engine) return [];
  try {
    const idx = JSON.parse(await readFile(path.join(engine, "banlists", "index.json"), "utf8"));
    return Array.isArray(idx?.revisions) ? idx.revisions : [];
  } catch {
    return [];
  }
});
ipcMain.handle("banlists:load", async (_e, date: string) => {
  const engine = findEngineDir();
  if (!engine || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return JSON.parse(await readFile(path.join(engine, "banlists", `${date}.json`), "utf8"));
  } catch {
    return null;
  }
});

ipcMain.handle("genesys:list", async () => {
  const engine = findEngineDir();
  if (!engine) return [];
  try {
    const idx = JSON.parse(await readFile(path.join(engine, "genesys", "index.json"), "utf8"));
    return Array.isArray(idx?.revisions) ? idx.revisions : [];
  } catch {
    return [];
  }
});
ipcMain.handle("genesys:load", async (_e, date: string) => {
  const engine = findEngineDir();
  if (!engine || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return JSON.parse(await readFile(path.join(engine, "genesys", `${date}.json`), "utf8"));
  } catch {
    return null;
  }
});

async function readAllRevisions(sub: "banlists" | "genesys"): Promise<any[]> {
  const engine = findEngineDir();
  if (!engine) return [];
  let index: any;
  try {
    index = JSON.parse(await readFile(path.join(engine, sub, "index.json"), "utf8"));
  } catch {
    return [];
  }
  const metas: any[] = Array.isArray(index?.revisions) ? index.revisions : [];
  const out: any[] = [];
  for (const m of metas) {
    try {
      out.push(JSON.parse(await readFile(path.join(engine, sub, m.file), "utf8")));
    } catch {
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

let banlistRevs: any[] | null = null;
ipcMain.handle("banlists:history", async (_e, id: number) => {
  if (!banlistRevs) banlistRevs = await readAllRevisions("banlists");
  const has = (arr: any[]) => Array.isArray(arr) && arr.some((c) => c.id === id);
  const statusAt = (rev: any): string =>
    has(rev.forbidden) ? "Forbidden" : has(rev.limited) ? "Limited" : has(rev.semiLimited) ? "Semi-Limited" : "Unlimited";

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

let duelSession: DuelSession | null = null;
let duelSeed = randomBytes(8).readBigUInt64LE() | 1n;

ipcMain.handle("match:start", async (_e, opts: DuelStartOptions): Promise<DuelStartResult> => {
  duelSession?.end();
  duelSession = null;

  const deck = await loadDeck(decksDir(), opts.deckId);
  if (!deck) return { ok: false, error: "deck not found" };

  const aiDeck = opts.aiDeckId ? await loadDeck(decksDir(), opts.aiDeckId) : null;
  if (opts.aiDeckId && !aiDeck) return { ok: false, error: "AI deck not found" };

  const send = (u: DuelUpdate) => mainWindow?.webContents.send("match:update", u);
  const startDirs = [__dirname, app.getAppPath()];
  const session = new DuelSession(send, startDirs);
  duelSession = session;

  const res = await session.start({ main: deck.main, extra: deck.extra }, nextSeed(opts.seed), opts.goldfish ?? true, opts.format ?? "advanced", opts.opponent ?? "goldfish", opts.difficulty ?? "normal", aiDeck ? { main: aiDeck.main, extra: aiDeck.extra } : null);
  if (!res.ok) {
    duelSession = null;
    return { ok: false, error: res.error ?? "failed to start duel", unsupported: res.unsupported };
  }
  return { ok: true, unsupported: res.unsupported };
});

ipcMain.handle("match:respond", (_e, r: DuelResponse) => {
  if (netRole === "guest") netClient?.send({ t: "response", response: r });
  else duelSession?.respond(r);
});

ipcMain.handle("match:surrender", () => {
  if (netRole === "guest") netClient?.send({ t: "surrender" });
  else duelSession?.surrender();
});

ipcMain.handle("match:end", () => {
  if (netRole) teardownNet();
  else { duelSession?.end(); duelSession = null; }
});

let netClient: NetClient | null = null;
let netRole: "host" | "guest" | null = null;
let embeddedRelay: RelayHandle | null = null;

const netStatus = (s: NetStatus) => mainWindow?.webContents.send("net:status", s);
let lastUpdate: DuelUpdate | null = null;
const matchUpdate = (u: DuelUpdate) => { lastUpdate = u; mainWindow?.webContents.send("match:update", u); };

function nextSeed(seedStr?: string): bigint {
  if (seedStr != null && /^\d+$/.test(seedStr.trim())) {
    let s = BigInt(seedStr.trim()) & 0xffffffffffffffffn;
    if (s === 0n) s = 1n;
    return s;
  }
  duelSeed = (duelSeed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  return duelSeed;
}

function teardownNet(): void {
  netClient?.close();
  netClient = null;
  netRole = null;
  duelSession?.end();
  duelSession = null;
  lastUpdate = null;
}

function isLocalRelay(addr: string): boolean {
  const a = addr.trim();
  return a === "" || /^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)$/i.test(a);
}

async function ensureEmbeddedRelay(addr: string, port: number): Promise<void> {
  if (embeddedRelay || !isLocalRelay(addr)) return;
  try {
    embeddedRelay = await startRelay(port);
  } catch {
    embeddedRelay = null;
  }
}

function relayError(e: unknown, host: string, port: number): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/.test(msg)) {
    return `Couldn't reach a relay at ${host}:${port}. Start one with: pnpm --filter @duel/relay-server start`;
  }
  return msg;
}

ipcMain.handle("net:host", async (_e, opts: NetHostOptions): Promise<NetResult> => {
  teardownNet();
  const deck = await loadDeck(decksDir(), opts.deckId);
  if (!deck) return { ok: false, error: "deck not found" };
  const room = opts.room && opts.room.trim() ? opts.room.trim().toUpperCase() : randomBytes(3).toString("hex").toUpperCase();
  const startDirs = [__dirname, app.getAppPath()];
  const format = opts.format ?? "advanced";
  let started = false;

  const client = new NetClient({
    onPeerLeft: () => { duelSession?.remoteSurrender("Opponent disconnected"); netStatus({ phase: "peer-left" }); },
    onError: (message) => netStatus({ phase: "error", message }),
    onMessage: async (m) => {
      if (m.t === "deck" && !started) {
        started = true;
        const transport = { deck: m.deck, sendToGuest: (u: DuelUpdate) => client.send({ t: "update", update: u }) };
        const session = new DuelSession(matchUpdate, startDirs);
        duelSession = session;
        const res = await session.start({ main: deck.main, extra: deck.extra }, nextSeed(opts.seed), true, format, "remote", "normal", null, transport);
        client.send({ t: "start", ok: res.ok, error: res.error, format });
        if (res.ok) {
          netStatus({ phase: "playing", format });
        } else {
          duelSession = null;
          netStatus({ phase: "error", message: res.error ?? "failed to start duel" });
        }
      } else if (m.t === "response") {
        duelSession?.respond(m.response);
      } else if (m.t === "surrender") {
        duelSession?.remoteSurrender();
      }
    },
  });
  netClient = client;
  netRole = "host";
  try {
    await ensureEmbeddedRelay(opts.relayHost, opts.relayPort);
    await client.connect(opts.relayHost, opts.relayPort, room, "host");
  } catch (e) {
    teardownNet();
    return { ok: false, error: relayError(e, opts.relayHost, opts.relayPort) };
  }
  netStatus({ phase: "waiting", room });
  return { ok: true, room };
});

ipcMain.handle("net:join", async (_e, opts: NetJoinOptions): Promise<NetResult> => {
  teardownNet();
  const deck = await loadDeck(decksDir(), opts.deckId);
  if (!deck) return { ok: false, error: "deck not found" };
  const room = opts.room.trim().toUpperCase();

  const client = new NetClient({
    onPeerJoined: () => client.send({ t: "deck", deck: { main: deck.main, extra: deck.extra } }),
    onPeerLeft: () => netStatus({ phase: "peer-left" }),
    onError: (message) => netStatus({ phase: "error", message }),
    onClose: () => netStatus({ phase: "ended" }),
    onMessage: (m) => {
      if (m.t === "start") {
        if (m.ok) netStatus({ phase: "playing", format: m.format });
        else netStatus({ phase: "error", message: m.error ?? "host could not start the duel" });
      } else if (m.t === "update") {
        matchUpdate(m.update);
      } else if (m.t === "surrender") {
        netStatus({ phase: "peer-left" });
      }
    },
  });
  netClient = client;
  netRole = "guest";
  try {
    await client.connect(opts.relayHost, opts.relayPort, room, "guest");
  } catch (e) {
    teardownNet();
    return { ok: false, error: relayError(e, opts.relayHost, opts.relayPort) };
  }
  netStatus({ phase: "connecting", room });
  return { ok: true, room };
});

ipcMain.handle("net:leave", () => {
  teardownNet();
  netStatus({ phase: "ended" });
});

ipcMain.handle("net:ready", () => {
  if (lastUpdate) mainWindow?.webContents.send("match:update", lastUpdate);
});

app.whenReady().then(() => {
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
      const buf = await readFile(path.join(assets, "cards", `${id}.jpg`));
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
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

app.on("will-quit", () => {
  embeddedRelay?.close().catch(() => {});
  embeddedRelay = null;
});
