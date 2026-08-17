import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..");
export const ASSETS = join(REPO_ROOT, "assets");

const ENGINE = join(REPO_ROOT, "engine");

export const PATHS = {
  root: ASSETS,
  engine: ENGINE,
  cardsDb: join(ENGINE, "cards", "db.json"),
  cardsLedger: join(ENGINE, "cards", "ledger.json"),
  setsDb: join(ENGINE, "sets", "db.json"),
  setsIndex: join(ENGINE, "sets", "index.json"),
  cardImages: join(ASSETS, "cards"),
  cardImagesCropped: join(ASSETS, "art"),
  banlists: join(ENGINE, "banlists"),
  banlistIndex: join(ENGINE, "banlists", "index.json"),
  sets: join(ASSETS, "sets"),
  setImages: join(ASSETS, "sets", "images"),
  genesys: join(ENGINE, "genesys"),
  genesysIndex: join(ENGINE, "genesys", "index.json"),
  ocgcore: join(ASSETS, "ocgcore"),
  ocgcoreScripts: join(ASSETS, "ocgcore", "script"),
  ocgcoreLock: join(ENGINE, "ocgcore.lock.json"),
} as const;

export const GENESYS_OFFICIAL = "https://www.yugioh-card.com/en/genesys/";

export const GENESYS_API = "https://yugiohgenesysbuilder.com/api/cards/";

export const LFLIST_URL =
  "https://raw.githubusercontent.com/Fluorohydride/ygopro/master/lflist.conf";

export const YGO = {
  cardinfo: "https://db.ygoprodeck.com/api/v7/cardinfo.php",
  cardsets: "https://db.ygoprodeck.com/api/v7/cardsets.php",
  cardImage: (id: number | string) =>
    `https://images.ygoprodeck.com/images/cards/${id}.jpg`,
  cardImageCropped: (id: number | string) =>
    `https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`,
  setImage: (code: string) =>
    `https://images.ygoprodeck.com/images/sets/${code}.jpg`,
  source: "YGOPRODeck v7 API (https://ygoprodeck.com/api-guide/)",
} as const;

export const YUGIPEDIA = {
  api: "https://yugipedia.com/api.php",
  source: "Yugipedia Semantic MediaWiki ask API (https://yugipedia.com)",
} as const;

const UA = "dueling-team/0.0 (portfolio, non-commercial; YGOPRODeck importer)";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(300);
  }

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

export interface TcgPrint {
  code: string;
  name: string;
  rarity: string | null;
  date: string | null;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

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
      if (!Number.isFinite(pass) || !ts || out.has(pass)) continue;
      out.set(pass, new Date(Number(ts) * 1000).toISOString().slice(0, 10));
    }
    await sleep(300);
  }
  return out;
}

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
    if (!code || !/-EN/.test(code)) continue;
    const prefix = code.split("-")[0]!;
    if (seen.has(prefix)) continue;
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

export function numFlag(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = parseInt(hit.split("=")[1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const hasFlag = (name: string): boolean =>
  process.argv.includes(`--${name}`);

export function listFlag(name: string): string[] {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return [];
  return (hit.split("=").slice(1).join("=") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
