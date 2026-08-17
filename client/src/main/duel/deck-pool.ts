import type { OcgCardData } from "@n1xx1/ocgcore-wasm";
import { getRoles } from "./card-roles.ts";

export interface PoolDeck {
  name: string;
  main: number[];
  extra: number[];
}

export function parseYdkText(text: string): { main: number[]; extra: number[] } {
  const main: number[] = [], extra: number[] = [];
  let section: "main" | "extra" | "side" = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#main")) { section = "main"; continue; }
    if (line.startsWith("#extra")) { section = "extra"; continue; }
    if (line.startsWith("!side")) { section = "side"; continue; }
    if (line.startsWith("#") || !/^\d+$/.test(line)) continue;
    const code = Number(line);
    if (section === "main") main.push(code); else if (section === "extra") extra.push(code);
  }
  return { main, extra };
}

const T_MONSTER = 0x1, T_SPELL = 0x2, T_TRAP = 0x4, T_NORMAL = 0x10;
const T_EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;

function shuffle<T>(a: readonly T[], rng: () => number): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

function take(distinct: number[], count: number, copies: number): number[] {
  const out: number[] = [];
  for (const code of distinct) { for (let k = 0; k < copies && out.length < count; k++) out.push(code); if (out.length >= count) break; }
  let i = 0;
  while (out.length < count && distinct.length) out.push(distinct[i++ % distinct.length]!);
  return out.slice(0, count);
}

export function generateDeckPool(cards: OcgCardData[], rng: () => number): PoolDeck[] {
  const ty = (c: OcgCardData) => c.type as number;
  const isMon = (c: OcgCardData) => (ty(c) & T_MONSTER) !== 0 && (ty(c) & T_EXTRA) === 0;
  const isNormalMon = (c: OcgCardData) => isMon(c) && (ty(c) & T_NORMAL) !== 0;
  const low = (c: OcgCardData) => (c.level ?? 0) >= 1 && (c.level ?? 0) <= 4;
  const isTrap = (c: OcgCardData) => (ty(c) & T_TRAP) !== 0;
  const isSpell = (c: OcgCardData) => (ty(c) & T_SPELL) !== 0;
  const role = (code: number, r: string) => getRoles(code).includes(r as never);
  const codes = (pool: OcgCardData[]) => shuffle(pool, rng).map((c) => c.code);

  const bigBeaters = cards.filter((c) => isNormalMon(c) && low(c) && (c.attack ?? 0) >= 1800);
  const smallBeaters = cards.filter((c) => isNormalMon(c) && low(c) && (c.attack ?? 0) >= 1000 && (c.attack ?? 0) < 1800);
  const walls = cards.filter((c) => isNormalMon(c) && low(c) && (c.defense ?? 0) >= 1700);
  const removalTraps = cards.filter((c) => isTrap(c) && (role(c.code, "removal") || role(c.code, "negate")));
  const drawSpells = cards.filter((c) => isSpell(c) && (role(c.code, "draw") || role(c.code, "search")));

  const decks: PoolDeck[] = [];
  const add = (name: string, main: number[]) => { if (main.length === 40) decks.push({ name, main, extra: [] }); };

  add("aggro", take(codes(bigBeaters), 40, 3));
  add("swarm", take(codes(smallBeaters), 40, 3));
  add("trap-control", [...take(codes(walls), 22, 3), ...take(codes(removalTraps), 18, 3)]);
  add("value", [...take(codes(bigBeaters), 28, 3), ...take(codes(drawSpells), 12, 3)]);
  add("midrange", [...take(codes([...bigBeaters, ...smallBeaters]), 30, 2), ...take(codes(removalTraps), 10, 2)]);

  return decks;
}

export function generateArchetypeDecks(cards: OcgCardData[], rng: () => number, maxDecks = 16): PoolDeck[] {
  const ty = (c: OcgCardData) => c.type as number;
  const isMon = (c: OcgCardData) => (ty(c) & T_MONSTER) !== 0 && (ty(c) & T_EXTRA) === 0;
  const isExtraMon = (c: OcgCardData) => (ty(c) & T_EXTRA) !== 0;
  const isSpellTrap = (c: OcgCardData) => (ty(c) & (T_SPELL | T_TRAP)) !== 0;

  const bySet = new Map<number, OcgCardData[]>();
  for (const c of cards) for (const sc of c.setcodes ?? []) { if (!sc) continue; const g = bySet.get(sc) ?? []; g.push(c); bySet.set(sc, g); }

  const drawStaples = cards.filter((c) => (ty(c) & T_SPELL) !== 0 && (getRoles(c.code).includes("draw" as never) || getRoles(c.code).includes("search" as never))).map((c) => c.code);

  const candidates = [...bySet.entries()].filter(([, list]) => list.filter(isMon).length >= 8);
  const decks: PoolDeck[] = [];
  for (const [sc, list] of shuffle(candidates, rng).slice(0, maxDecks)) {
    const mons = shuffle(list.filter(isMon), rng).map((c) => c.code);
    const sts = shuffle(list.filter(isSpellTrap), rng).map((c) => c.code);
    const extra = shuffle(list.filter(isExtraMon), rng).map((c) => c.code).slice(0, 15);
    const main = [...take(mons, Math.min(27, mons.length * 3), 3), ...take(sts, Math.min(10, sts.length * 3), 3)];
    if (main.length < 40) main.push(...take(drawStaples, 40 - main.length, 3));
    if (main.length >= 40) decks.push({ name: `arch-${sc.toString(16)}`, main: main.slice(0, 40), extra });
  }
  return decks;
}
