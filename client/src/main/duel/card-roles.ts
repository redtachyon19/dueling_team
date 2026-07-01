// Coarse card EFFECT-ROLE data + classifier. Lets the evaluation know what a
// card DOES (negate / handtrap / searcher / disruption) — not just its stats —
// so it can value a negate end-board over a stat-equal vanilla board, for ANY
// deck. Roles are mined from the LOCAL ProjectIgnis Lua scripts at build time
// (scripts/classify-card-roles.mts → assets/ocg/card-roles.json) and loaded
// here at runtime. No network; the role file lives under the gitignored assets/
// like the rest of the Konami-derived data.
//
// `classifyScript` is the pure heuristic (regex over the stable EDOPro engine
// API) — exported so the build script and unit tests share one definition.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export type CardRole = "negate" | "handtrap" | "search" | "draw" | "spsummon" | "removal" | "floodgate";

/** Classify a card's Lua source into coarse roles. Approximate by nature — it
 *  greps for engine API tokens; see the build script's spot-check for accuracy. */
export function classifyScript(src: string): CardRole[] {
  const roles: CardRole[] = [];
  const has = (re: RegExp) => re.test(src);
  const negate = has(/Duel\.Negate(Activation|Effect|Summon|RelatedChain|EffectMonster)/) || has(/EFFECT_DISABLE\b/) || has(/EFFECT_CANNOT_TRIGGER/);
  const fromHand = has(/LOCATION_HAND/);
  const quick = has(/EFFECT_TYPE_QUICK_O|EFFECT_TYPE_QUICK_F|EFFECT_TYPE_TRIGGER_O/);
  const search = has(/SearchMatchingCard/) || (has(/SelectMatchingCard/) && has(/SendtoHand|ToHand/)) || has(/AddCodeList|aux\.AddCodeList/);
  const draw = has(/Duel\.Draw\b/);
  const spsummon = has(/Duel\.SpecialSummon/);
  const removal = has(/Duel\.Destroy\b/) || has(/Duel\.Banish/) || has(/Duel\.Remove\b/) || has(/Duel\.SendtoGrave/);
  const floodgate = has(/EFFECT_CANNOT_(SUMMON|SPECIAL_SUMMON|ACTIVATE|TRIGGER|ATTACK|SELECT)/) && has(/EFFECT_TYPE_FIELD|EFFECT_FLAG_PLAYER_TARGET/);

  if (negate) roles.push("negate");
  if (fromHand && quick && (negate || draw || search)) roles.push("handtrap");
  if (search) roles.push("search");
  if (draw) roles.push("draw");
  if (spsummon) roles.push("spsummon");
  if (removal) roles.push("removal");
  if (floodgate) roles.push("floodgate");
  return roles;
}

// --- runtime role lookup -----------------------------------------------------

let roleMap = new Map<number, CardRole[]>();

/** Install a passcode → roles map (used by the loader and by tests). */
export function setCardRoles(map: Map<number, CardRole[]> | Record<string, CardRole[]>): void {
  roleMap = map instanceof Map ? map : new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
}

/** Roles for a passcode (empty if unknown / unclassified / not loaded). */
export function getRoles(code: number): CardRole[] {
  return roleMap.get(code) ?? [];
}

/** True if a card has a disruptive board role — a negate or a floodgate. This
 *  is the single most under-valued thing in a stat-only eval: a 0-ATK omni-
 *  negate is worth far more than its battle stats suggest. */
export function isDisruption(code: number): boolean {
  const r = roleMap.get(code);
  return !!r && (r.includes("negate") || r.includes("floodgate"));
}

/** True if a card is a hand-trap (interaction worth holding for later). */
export function isHandtrap(code: number): boolean {
  return roleMap.get(code)?.includes("handtrap") ?? false;
}

/** Walk up from each start dir to find assets/ocg/card-roles.json. */
function findRolesFile(startDirs: string[]): string | null {
  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "assets", "ocg", "card-roles.json");
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Load the role file if present and install it. Returns how many cards loaded
 *  (0 = file absent/invalid → the AI simply has no role awareness, as before). */
export function loadCardRoles(startDirs: string[]): { count: number; source: "file" | "none" } {
  const file = findRolesFile(startDirs);
  if (file) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, CardRole[]>;
      setCardRoles(data);
      return { count: Object.keys(data).length, source: "file" };
    } catch {
      /* fall through to none */
    }
  }
  return { count: 0, source: "none" };
}
