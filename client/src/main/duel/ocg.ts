// ocgcore loader + data/script readers for the main process.
//
// The JSR build re-exports with `export *`, which drops the default export
// (createCore). We reach it via the dist module directly (same instance as the
// named enum exports). Card data is read from the prebuilt assets/ocg/carddata.json
// (decoded from BabelCDB at build time); Lua scripts from assets/ocg/script/.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { OcgCardData, OcgCoreSync } from "@n1xx1/ocgcore-wasm";

type CreateCore = typeof import("@n1xx1/ocgcore-wasm").default;

let corePromise: Promise<OcgCoreSync> | null = null;
let searchCorePromise: Promise<OcgCoreSync> | null = null;

async function createSyncCore(): Promise<OcgCoreSync> {
  // The package entry (mod.js) re-exports with `export *`, dropping the
  // default (createCore); the real declarations live in dist/index.js.
  // import.meta.resolve normally returns the entry, but a tsconfig `paths`
  // alias (used for typechecking) can make tsx return dist/index.js itself —
  // handle both so this works under the bundled app and under tsx.
  const resolved = import.meta.resolve("@n1xx1/ocgcore-wasm");
  const url = /[\\/]dist[\\/]index\.js$/.test(resolved) ? resolved : new URL("./dist/index.js", resolved).href;
  const mod: { default: CreateCore } = await import(url);
  return mod.default({ sync: true });
}

/** Load (once) the synchronous ocgcore. Sync mode avoids JSPI/stack-switching. */
export async function getCore(): Promise<OcgCoreSync> {
  if (!corePromise) corePromise = createSyncCore();
  return corePromise;
}

/** A SEPARATE ocgcore instance for the AI's look-ahead search. The forward
 *  search spins up and tears down many scratch duels; running them on their own
 *  WASM heap guarantees that churn can never disturb the live duel's handle
 *  (double-free / heap corruption on the shared core is a known crash class).
 *  Card/script readers are pure data and are safely shared across instances. */
export async function getSearchCore(): Promise<OcgCoreSync> {
  if (!searchCorePromise) searchCorePromise = createSyncCore();
  return searchCorePromise;
}

interface CardDataJson {
  code: number;
  alias: number;
  setcodes: number[];
  type: number;
  level: number;
  attribute: number;
  race: string; // bigint decimal
  attack: number;
  defense: number;
  lscale: number;
  rscale: number;
  link_marker: number;
}

let cardMap: Map<number, OcgCardData> | null = null;

/** Locate assets/ocg by walking up from this module (dev) or the app path. */
function ocgDir(startDirs: string[]): string | null {
  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "assets", "ocg");
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export interface OcgReaders {
  cardReader: (code: number) => OcgCardData | null;
  scriptReader: (name: string) => string | null;
  /** Load base scripts (constant.lua, utility.lua) into a duel before cards run. */
  baseScripts: { name: string; content: string }[];
  scriptDir: string;
  /** Every card in the DB — for build-time tools (e.g. deck-pool generation). */
  cards: OcgCardData[];
}

/** Build the card + script readers from assets/ocg. `startDirs` seeds the search. */
export function buildReaders(startDirs: string[]): OcgReaders {
  const dir = ocgDir(startDirs);
  if (!dir) throw new Error("assets/ocg not found — run `pnpm import:ocg` first.");
  const scriptDir = path.join(dir, "script");

  if (!cardMap) {
    const raw = JSON.parse(readFileSync(path.join(dir, "carddata.json"), "utf8")) as Record<string, CardDataJson>;
    cardMap = new Map();
    for (const k of Object.keys(raw)) {
      const c = raw[k]!;
      cardMap.set(c.code, {
        code: c.code,
        alias: c.alias,
        setcodes: c.setcodes,
        type: c.type,
        level: c.level,
        attribute: c.attribute,
        race: BigInt(c.race),
        attack: c.attack,
        defense: c.defense,
        lscale: c.lscale,
        rscale: c.rscale,
        link_marker: c.link_marker,
      });
    }
  }

  const scriptCache = new Map<string, string | null>();
  const scriptReader = (name: string): string | null => {
    if (scriptCache.has(name)) return scriptCache.get(name)!;
    let content: string | null = null;
    try {
      content = readFileSync(path.join(scriptDir, path.basename(name)), "utf8");
    } catch {
      content = null;
    }
    scriptCache.set(name, content);
    return content;
  };

  const baseScripts = ["constant.lua", "utility.lua"].map((name) => ({
    name,
    content: readFileSync(path.join(scriptDir, name), "utf8"),
  }));

  return {
    cardReader: (code) => cardMap!.get(code) ?? null,
    scriptReader,
    baseScripts,
    scriptDir,
    cards: Array.from(cardMap.values()),
  };
}

/** True if every passcode has card data ocgcore can load. */
export function partitionSupported(codes: number[], readers: OcgReaders): { supported: number[]; unsupported: number[] } {
  const supported: number[] = [];
  const unsupported: number[] = [];
  for (const code of codes) {
    if (readers.cardReader(code)) supported.push(code);
    else unsupported.push(code);
  }
  return { supported, unsupported };
}
