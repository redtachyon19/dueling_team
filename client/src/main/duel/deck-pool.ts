// Build-time generator of a DIVERSE pool of decks for self-play training. To
// learn a *general* evaluation (one that values any deck's boards well, not a
// single archetype), the trainer plays many different matchups — so it needs
// varied, legal, runnable decks. ocgcore doesn't enforce TCG construction rules
// at duelNewCard, so "legal" here just means 40 main / supported cards; the
// trainer validates RUNNABILITY by checking each deck produces decisive games.
//
// Flavors are biased toward compositions that run cleanly headlessly (mostly
// Normal monsters — no scripts to stall on — plus simple trap/spell suites),
// differing in power curve, board width, and trap density so the evaluation
// sees a broad distribution of positions. Role tags (card-roles.ts) flavor the
// spell/trap suites (removal/negate for control, draw/search for value).

import type { OcgCardData } from "@n1xx1/ocgcore-wasm";
import { getRoles } from "./card-roles.ts";

export interface PoolDeck {
  name: string;
  main: number[];
  extra: number[];
}

/** Parse a .ydk deck file's text (EDOPro/YGOPro format) into passcodes. Lets
 *  the trainer use REAL decks dropped into a `decks/` folder. */
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
const T_EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000; // Fusion|Synchro|Xyz|Link

function shuffle<T>(a: readonly T[], rng: () => number): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

/** Fill `count` slots from `distinct` codes, at most `copies` of each (cycling
 *  if the pool is too small). */
function take(distinct: number[], count: number, copies: number): number[] {
  const out: number[] = [];
  for (const code of distinct) { for (let k = 0; k < copies && out.length < count; k++) out.push(code); if (out.length >= count) break; }
  let i = 0;
  while (out.length < count && distinct.length) out.push(distinct[i++ % distinct.length]!);
  return out.slice(0, count);
}

/** Generate a diverse deck pool. Each flavor is parameterized by `rng` so a
 *  different seed yields a different concrete deck of that flavor. */
export function generateDeckPool(cards: OcgCardData[], rng: () => number): PoolDeck[] {
  const ty = (c: OcgCardData) => c.type as number;
  const isMon = (c: OcgCardData) => (ty(c) & T_MONSTER) !== 0 && (ty(c) & T_EXTRA) === 0;
  const isNormalMon = (c: OcgCardData) => isMon(c) && (ty(c) & T_NORMAL) !== 0;
  const low = (c: OcgCardData) => (c.level ?? 0) >= 1 && (c.level ?? 0) <= 4; // summonable without tribute
  const isTrap = (c: OcgCardData) => (ty(c) & T_TRAP) !== 0;
  const isSpell = (c: OcgCardData) => (ty(c) & T_SPELL) !== 0;
  const role = (code: number, r: string) => getRoles(code).includes(r as never);
  const codes = (pool: OcgCardData[]) => shuffle(pool, rng).map((c) => c.code);

  // Safe building blocks: Normal (scriptless) monsters by power band.
  const bigBeaters = cards.filter((c) => isNormalMon(c) && low(c) && (c.attack ?? 0) >= 1800);
  const smallBeaters = cards.filter((c) => isNormalMon(c) && low(c) && (c.attack ?? 0) >= 1000 && (c.attack ?? 0) < 1800);
  const walls = cards.filter((c) => isNormalMon(c) && low(c) && (c.defense ?? 0) >= 1700);
  // Role-flavored spell/trap suites.
  const removalTraps = cards.filter((c) => isTrap(c) && (role(c.code, "removal") || role(c.code, "negate")));
  const drawSpells = cards.filter((c) => isSpell(c) && (role(c.code, "draw") || role(c.code, "search")));

  const decks: PoolDeck[] = [];
  const add = (name: string, main: number[]) => { if (main.length === 40) decks.push({ name, main, extra: [] }); };

  // 1) Aggro: 40 big Normal beaters.
  add("aggro", take(codes(bigBeaters), 40, 3));
  // 2) Swarm: 40 smaller Normal monsters (wider boards, lower power).
  add("swarm", take(codes(smallBeaters), 40, 3));
  // 3) Trap control: defensive walls + removal/negate traps.
  add("trap-control", [...take(codes(walls), 22, 3), ...take(codes(removalTraps), 18, 3)]);
  // 4) Value: beaters + draw/search spells.
  add("value", [...take(codes(bigBeaters), 28, 3), ...take(codes(drawSpells), 12, 3)]);
  // 5) Midrange: a broad random mix of beaters + a light trap line.
  add("midrange", [...take(codes([...bigBeaters, ...smallBeaters]), 30, 2), ...take(codes(removalTraps), 10, 2)]);

  return decks;
}

/** Build ARCHETYPE decks from the `setcodes` field: cards sharing an archetype
 *  are designed to work together (searchers, extenders, bosses, negates), so —
 *  unlike the synthetic flavors above — these actually exercise the effect /
 *  disruption / combo features the evaluation cares about. Candidate archetypes
 *  are those with enough Main-Deck monsters; each deck is the archetype's cards
 *  padded with generic draw/search staples to 40, plus its Extra-Deck bodies.
 *  Quality varies and some won't run cleanly headlessly — the trainer validates
 *  each by decisive-game rate and keeps the runnable ones. */
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
