import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export type CardRole = "negate" | "handtrap" | "search" | "draw" | "spsummon" | "removal" | "floodgate";

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

let roleMap = new Map<number, CardRole[]>();

export function setCardRoles(map: Map<number, CardRole[]> | Record<string, CardRole[]>): void {
  roleMap = map instanceof Map ? map : new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
}

export function getRoles(code: number): CardRole[] {
  return roleMap.get(code) ?? [];
}

export function isDisruption(code: number): boolean {
  const r = roleMap.get(code);
  return !!r && (r.includes("negate") || r.includes("floodgate"));
}

export function isHandtrap(code: number): boolean {
  return roleMap.get(code)?.includes("handtrap") ?? false;
}

function findRolesFile(startDirs: string[]): string | null {
  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "assets", "ocgcore", "card-roles.json");
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function loadCardRoles(startDirs: string[]): { count: number; source: "file" | "none" } {
  const file = findRolesFile(startDirs);
  if (file) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, CardRole[]>;
      setCardRoles(data);
      return { count: Object.keys(data).length, source: "file" };
    } catch {
    }
  }
  return { count: 0, source: "none" };
}
