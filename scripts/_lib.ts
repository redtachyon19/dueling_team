// scripts/_lib.ts
//
// BUILD-TIME ONLY. Shared helpers for the manual importer scripts
// (import-cards, build-image-pack, update-banlists, ...). This file is NOT a
// workspace package and is never imported by the running app — it only runs
// under `tsx` when an importer is invoked by hand.
//
// Everything here writes into assets/ (the hand-curated card data, tracked in
// this private repo) and is the only place in the project allowed to touch the
// network.

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// --- paths -----------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..");
export const ASSETS = join(REPO_ROOT, "assets");

const ENGINE = join(REPO_ROOT, "engine");

// THE GITIGNORE BOUNDARY IS THE FOLDER BOUNDARY:
//   assets/  — ENTIRELY gitignored. Everything in it is regenerable by a
//              script: card art, cropped art, set imagery, and the ocgcore
//              engine data. Wipe the folder and `pnpm import:ocg` +
//              `pnpm build:images` + `pnpm build:set-images` rebuild it.
//   engine/  — tracked. The card/set databases, the append-only banlist and
//              Genesys archives, and ocgcore.lock.json (which pins the exact
//              upstream commits assets/ocgcore/ is rebuilt from).
//   ui/assets/ — tracked. Hand-made render assets (sleeves, card-frame
//              templates, fonts, logos) that NO script can re-download.
export const PATHS = {
  root: ASSETS,
  engine: ENGINE,
  /** Card + set databases. Under engine/ with the rest of the data — assets/
   *  holds only images now. Both are regenerable (`pnpm import:cards` /
   *  `import:sets`) but they are what every other script resolves against. */
  cardsDb: join(ENGINE, "cards", "db.json"),
  /** The card ledger — every passcode we've seen, included or blacklisted, with
   *  a reason. Single source of truth for the pool; see scripts/ledger.ts. */
  cardsLedger: join(ENGINE, "cards", "ledger.json"),
  setsDb: join(ENGINE, "sets", "db.json"),
  setsIndex: join(ENGINE, "sets", "index.json"),
  /** Full card art, by passcode ({id}.jpg). */
  cardImages: join(ASSETS, "cards"),
  /** Cropped artwork only, no frame ({id}.jpg). */
  cardImagesCropped: join(ASSETS, "art"),
  /** Banlist + Genesys archives. These live under engine/, not assets/: they are
   *  append-only historical records that CANNOT be re-downloaded — upstream
   *  publishes only the current list, so a lost revision is lost for good (see
   *  the note in import-genesys-history.ts). */
  banlists: join(ENGINE, "banlists"),
  banlistIndex: join(ENGINE, "banlists", "index.json"),
  sets: join(ASSETS, "sets"),
  setImages: join(ASSETS, "sets", "images"), // YGOPRODeck set logos ({CODE}.jpg)
  // Official box/pack art (scraped by build-set-images.ts) lives under
  // assets/sets/<type>/{CODE}.png — bucketed by set type, joined at use.
  genesys: join(ENGINE, "genesys"),
  genesysIndex: join(ENGINE, "genesys", "index.json"),
  /** ocgcore (ygopro-core) engine data — the Lua card-effect scripts and the
   *  numeric carddata the core loads. Lives in assets/ because it is entirely
   *  regenerable; the tracked lockfile below pins the upstream commits it is
   *  rebuilt from. */
  ocgcore: join(ASSETS, "ocgcore"),
  ocgcoreScripts: join(ASSETS, "ocgcore", "script"),
  /** Tracked lockfile for assets/ocgcore/ — the exact ProjectIgnis commits. */
  ocgcoreLock: join(ENGINE, "ocgcore.lock.json"),
} as const;

/** Konami's official Genesys page — publishes the CURRENT list in full as an
 *  HTML table (Card Name | Points). The authority; used by update-genesys.ts. */
export const GENESYS_OFFICIAL = "https://www.yugioh-card.com/en/genesys/";

/** Third-party Genesys points API (paginated JSON: {items,nextOffset,hasMore,total}).
 *  Trailing slash avoids a 308 redirect.
 *
 *  STALE — do not use for the current list. Verified 2026-08-16: 520 unique
 *  entries vs the official 751, missing staples (D.D. Crow, Terraforming), and
 *  point values matching no single published revision. Kept only because
 *  import-genesys-history.ts anchors its reverse-walk on it; update-genesys.ts
 *  now reads GENESYS_OFFICIAL instead. */
export const GENESYS_API = "https://yugiohgenesysbuilder.com/api/cards/";

// --- upstream (YGOPRODeck v7) ----------------------------------------------
/** Comprehensive YGOPro forbidden/limited list — accumulates EVERY past list
 *  (TCG + OCG) in one file. Used to backfill historical TCG banlists. */
export const LFLIST_URL =
  "https://raw.githubusercontent.com/Fluorohydride/ygopro/master/lflist.conf";

export const YGO = {
  cardinfo: "https://db.ygoprodeck.com/api/v7/cardinfo.php",
  cardsets: "https://db.ygoprodeck.com/api/v7/cardsets.php",
  /** Full card image (frame baked in), 813×1185. */
  cardImage: (id: number | string) =>
    `https://images.ygoprodeck.com/images/cards/${id}.jpg`,
  /** Cropped artwork only (no frame), 624×624. */
  cardImageCropped: (id: number | string) =>
    `https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`,
  /** Set logo / box art. */
  setImage: (code: string) =>
    `https://images.ygoprodeck.com/images/sets/${code}.jpg`,
  source: "YGOPRODeck v7 API (https://ygoprodeck.com/api-guide/)",
} as const;

// --- upstream (Yugipedia — the TCG/OCG boundary) ---------------------------
/** Yugipedia's Semantic MediaWiki `ask` endpoint. We treat it as the single
 *  authority on which cards are OCG-only, because YGOPRODeck's per-card
 *  `formats`/`tcg_date` is unreliable — it has silently mis-flagged
 *  TCG-released cards (e.g. "Artmage Vandalism -Assault-") as OCG-only. */
export const YUGIPEDIA = {
  api: "https://yugipedia.com/api.php",
  source: "Yugipedia Semantic MediaWiki ask API (https://yugipedia.com)",
} as const;

const UA = "dueling-team/0.0 (portfolio, non-commercial; YGOPRODeck importer)";

// --- tiny utils ------------------------------------------------------------
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** YYYY-MM-DD for a given date (defaults to now), in UTC. */
export const isoDate = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await ensureDir(dirname(p));
  await writeFile(p, JSON.stringify(value, null, 2) + "\n");
}

export async function readJson<T = unknown>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Minimal promise-concurrency limiter — no dependencies. */
export function pLimit(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    queue.shift()!();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      const run = () => {
        Promise.resolve()
          .then(fn)
          .then(res, rej)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(run);
      next();
    });
}

/** GET plain text with retry + backoff. */
export async function fetchText(url: string, { tries = 4 } = {}): Promise<string> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 429) {
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(800 * (i + 1));
    }
  }
  return "";
}

/** GET JSON with retry + backoff and 429 handling. */
export async function fetchJson(url: string, { tries = 4 } = {}): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (res.status === 429) {
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(800 * (i + 1));
    }
  }
}

/**
 * The set of Konami passcodes Yugipedia classifies as OCG-only — its semantic
 * property `Medium::OCG-only`. This is the importer's TCG/OCG boundary; a
 * YGOPRODeck card is dropped if its passcode is in `passcodes`, OR — for cards
 * with no official passcode (YGOPRODeck gives those a placeholder id ≥ 1e8,
 * e.g. unreleased/anime cards) — if its name is in `names`.
 *
 * Why both: passcode is the precise, collision-free key for released cards
 * (several OCG-only entries, like the "Fluff Token" variant, share an English
 * name with a legitimate TCG print — name-matching those would wrongly drop
 * the TCG card). But Yugipedia has no Password for not-yet-released OCG cards
 * (e.g. "Dark Tyranno", future-dated OCG debuts), so those need name-matching.
 * The caller gates name-matching on the placeholder-id range so real TCG
 * tokens (which have real passcodes) are never caught by it.
 */
export async function fetchOcgOnly(): Promise<{ passcodes: Set<number>; names: Set<string> }> {
  const passcodes = new Set<number>();
  const names = new Set<string>();
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const query =
      `[[Medium::OCG-only]][[Card type::+]]|?Password|?English name|limit=${PAGE}|offset=${offset}`;
    const url =
      `${YUGIPEDIA.api}?action=ask&format=json&query=${encodeURIComponent(query)}`;
    const json = await fetchJson(url);
    const results = json?.query?.results ?? {};
    const keys = Object.keys(results);
    for (const k of keys) {
      const po = results[k]?.printouts ?? {};
      const raw = po["Password"]?.[0];
      const id = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(id)) passcodes.add(id);
      const name = po["English name"]?.[0] ?? k;
      if (typeof name === "string" && name) names.add(name);
    }
    if (keys.length < PAGE) break;
    await sleep(300); // be polite to Yugipedia between pages
  }

  // Rescue passcodes that are ALSO a TCG card on Yugipedia. The same physical
  // card can have two pages — an OCG-romanization page tagged Medium::OCG-only
  // and a TCG-name page (e.g. "Bayt'al-Hecahands" vs "Hecahands Bait", both
  // passcode 43932352). The OCG-only page would otherwise make us drop the real
  // TCG card, so remove any OCG-only passcode that also has a Medium::TCG page.
  const ids = [...passcodes];
  const CHUNK = 40;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const cond = ids.slice(i, i + CHUNK).map((p) => `Password::${p}`).join("||");
    const url = `${YUGIPEDIA.api}?action=ask&format=json&query=${encodeURIComponent(`[[${cond}]][[Medium::TCG]]|?Password|limit=500`)}`;
    let json: any;
    try {
      json = await fetchJson(url);
    } catch {
      continue;
    }
    const results = json?.query?.results ?? {};
    for (const k of Object.keys(results)) {
      const raw = results[k]?.printouts?.["Password"]?.[0];
      const id = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(id)) passcodes.delete(id);
    }
    await sleep(300);
  }

  return { passcodes, names };
}

/** A TCG printing recovered from Yugipedia (one row of a card's TCG sets list). */
export interface TcgPrint {
  code: string; // full English set code, e.g. "DUAD-EN057"
  name: string; // set name, e.g. "Duelist's Advance"
  rarity: string | null;
  date: string | null; // release date YYYY-MM-DD, or null
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

/**
 * Yugipedia's TCG debut date for a batch of passcodes — the authoritative
 * release date when YGOPRODeck has none (it mis-flags some TCG cards as
 * OCG-only and then carries no `tcg_date` for them). Returns passcode → date.
 */
export async function fetchTcgDebutDates(
  passcodes: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const CHUNK = 40;
  for (let i = 0; i < passcodes.length; i += CHUNK) {
    const cond = passcodes.slice(i, i + CHUNK).map((p) => `Password::${p}`).join("||");
    const query = `[[${cond}]]|?Password|?TCG debut date|limit=500`;
    const url = `${YUGIPEDIA.api}?action=ask&format=json&query=${encodeURIComponent(query)}`;
    let json: any;
    try {
      json = await fetchJson(url);
    } catch {
      continue;
    }
    const results = json?.query?.results ?? {};
    for (const k of Object.keys(results)) {
      const po = results[k]?.printouts ?? {};
      const pass = Number(po["Password"]?.[0]);
      const ts = po["TCG debut date"]?.[0]?.timestamp;
      // Many noise pages share a passcode (artwork/game variants); only the
      // main card page carries a date, so the first dated hit wins.
      if (!Number.isFinite(pass) || !ts || out.has(pass)) continue;
      out.set(pass, new Date(Number(ts) * 1000).toISOString().slice(0, 10));
    }
    await sleep(300);
  }
  return out;
}

/** Resolve a card's Yugipedia page title from its passcode (real codes only). */
async function pageTitleForPasscode(passcode: number): Promise<string | null> {
  const query = `[[Password::${passcode}]]|limit=1`;
  const url = `${YUGIPEDIA.api}?action=ask&format=json&query=${encodeURIComponent(query)}`;
  try {
    const keys = Object.keys((await fetchJson(url))?.query?.results ?? {});
    return keys[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Every TCG set a card was printed in, scraped from its Yugipedia page's
 * "TCG sets" table. Used to backfill cards YGOPRODeck has no `card_sets` for.
 * One entry per set (the English print), best-effort — returns [] if the page
 * or section is missing.
 *
 * Resolves the page by passcode first when one is given: the card name often
 * isn't the page title — disambiguators ("Return of the Duelist (card)"), or
 * YGOPRODeck carrying an OCG-translated name that differs from the TCG page
 * ("Layer 19 …"). Falls back to the name for passcode-less cards.
 */
export async function fetchTcgPrints(cardName: string, passcode?: number): Promise<TcgPrint[]> {
  let title = cardName;
  if (passcode != null && passcode < 100_000_000) {
    const resolved = await pageTitleForPasscode(passcode);
    if (resolved) title = resolved;
  }
  const url = `${YUGIPEDIA.api}?action=parse&prop=text&format=json&page=${encodeURIComponent(title)}`;
  let json: any;
  try {
    json = await fetchJson(url);
  } catch {
    return [];
  }
  const html: string = json?.parse?.text?.["*"] ?? "";
  const start = html.indexOf('id="TCG_sets"');
  if (start < 0) return [];
  const end = html.indexOf('id="OCG_sets"', start);
  const seg = html.slice(start, end > start ? end : start + 20000);
  const out: TcgPrint[] = [];
  const seen = new Set<string>();
  for (const row of seg.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      decodeEntities(m[1]!.replace(/<[^>]+>/g, "")).trim(),
    );
    if (cells.length < 3) continue;
    const [date, code] = cells;
    if (!code || !/-EN/.test(code)) continue; // English TCG print only
    const prefix = code.split("-")[0]!;
    if (seen.has(prefix)) continue; // one row per set
    seen.add(prefix);
    out.push({
      code,
      name: cells[2] ?? "",
      rarity: cells[cells.length - 1] || null,
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    });
  }
  return out;
}

/**
 * A set's TCG release date from Yugipedia (YYYY-MM-DD), or null. Prefers the
 * worldwide English date, falling back to North American English. Used to
 * backfill sets YGOPRODeck's cardsets endpoint omits or leaves undated.
 */
export async function fetchSetReleaseDate(setName: string): Promise<string | null> {
  const query =
    `[[${setName}]]|?English release date|?North American English release date|limit=1`;
  const url = `${YUGIPEDIA.api}?action=ask&format=json&query=${encodeURIComponent(query)}`;
  try {
    const results = (await fetchJson(url))?.query?.results ?? {};
    const po = (Object.values(results)[0] as any)?.printouts ?? {};
    const ts =
      po["English release date"]?.[0]?.timestamp ??
      po["North American English release date"]?.[0]?.timestamp;
    return ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Download a binary file to `dest`, streaming to disk.
 * Skips when the file already exists unless `force` is set (resumable).
 * Returns "skip" | "ok" | "missing".
 */
export async function downloadFile(
  url: string,
  dest: string,
  { force = false } = {},
): Promise<"skip" | "ok" | "missing"> {
  if (!force && (await exists(dest))) return "skip";
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 429) {
        await sleep(3000 * (i + 1));
        continue;
      }
      if (res.status === 404) return "missing";
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await ensureDir(dirname(dest));
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
      return "ok";
    } catch (err) {
      if (i === 3) throw err;
      await sleep(1000 * (i + 1));
    }
  }
  return "missing";
}

/** Read a numeric flag like `--concurrency=8` from argv. */
export function numFlag(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = parseInt(hit.split("=")[1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const hasFlag = (name: string): boolean =>
  process.argv.includes(`--${name}`);

/** `--name=a,b,c` → ["a","b","c"] (trimmed, empties dropped); [] if absent. */
export function listFlag(name: string): string[] {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return [];
  return (hit.split("=").slice(1).join("=") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
