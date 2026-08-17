import { OcgLocation, OcgPosition } from "@n1xx1/ocgcore-wasm";
import { getRoles } from "./card-roles.ts";
import type { CoreView } from "./ai-context.ts";

export interface OpponentModel {
  handCount: number;
  backrowCount: number;
  deckCount: number;
  archetype: number | null;
  revealed: { negate: number; removal: number; handtrap: number; search: number };
}

const FACEUP = OcgPosition.FACEUP_ATTACK | OcgPosition.FACEUP_DEFENSE;
const FACEDOWN = OcgPosition.FACEDOWN_ATTACK | OcgPosition.FACEDOWN_DEFENSE;

export function buildOpponentModel(v: CoreView, opp: number): OpponentModel {
  const setTally = new Map<number, number>();
  const revealed = { negate: 0, removal: 0, handtrap: 0, search: 0 };
  const consider = (code: number) => {
    if (!code) return;
    const roles = getRoles(code);
    if (roles.includes("negate")) revealed.negate += 1;
    if (roles.includes("removal")) revealed.removal += 1;
    if (roles.includes("handtrap")) revealed.handtrap += 1;
    if (roles.includes("search")) revealed.search += 1;
    for (const sc of v.stats(code)?.setcodes ?? []) if (sc) setTally.set(sc, (setTally.get(sc) ?? 0) + 1);
  };
  const code = (raw: unknown) => (((raw as Record<string, number>)?.code ?? 0) | 0);

  for (const raw of v.queryLoc(opp, OcgLocation.GRAVE)) if (raw) consider(code(raw));
  for (const raw of v.queryLoc(opp, OcgLocation.REMOVED)) if (raw) consider(code(raw));
  for (const raw of v.queryLoc(opp, OcgLocation.MZONE)) {
    if (!raw) continue;
    const pos = ((raw as Record<string, number>).position ?? 0) | 0;
    if ((pos & FACEUP) !== 0) consider(code(raw));
  }
  let backrowCount = 0;
  v.queryLoc(opp, OcgLocation.SZONE).forEach((raw, seq) => {
    if (!raw || seq >= 5) return;
    const pos = ((raw as Record<string, number>).position ?? 0) | 0;
    if ((pos & FACEDOWN) !== 0) backrowCount += 1;
  });

  let archetype: number | null = null, best = 1;
  for (const [sc, n] of setTally) if (n > best) { best = n; archetype = sc; }

  return { handCount: v.queryCount(opp, OcgLocation.HAND), backrowCount, deckCount: v.queryCount(opp, OcgLocation.DECK), archetype, revealed };
}

export function disruptionRisk(m: OpponentModel): number {
  const trapRisk = 1 - Math.pow(0.7, Math.min(m.backrowCount, 4));
  const handThreat = m.handCount > 0 ? Math.min(0.15 + 0.12 * Math.min(m.revealed.handtrap, 3), 0.6) : 0;
  const revealedThreat = Math.min(0.12 * (m.revealed.negate + m.revealed.removal), 0.6);
  return Math.min(1, 1 - (1 - trapRisk) * (1 - handThreat) * (1 - revealedThreat));
}

export type DisruptionEffect =
  | { kind: "none" }
  | { kind: "wipe" }
  | { kind: "removeBest"; n: number }
  | { kind: "negate" };

export interface DisruptionScenario {
  p: number;
  effect: DisruptionEffect;
}

export function disruptionScenarios(m: OpponentModel): DisruptionScenario[] {
  const risk = disruptionRisk(m);
  const wipeW = m.backrowCount * 1.0;
  const removeW = 1.0 + m.revealed.removal * 0.5;
  const negateW = m.revealed.negate + m.revealed.handtrap + (m.handCount > 0 ? 0.5 : 0);
  const tot = wipeW + removeW + negateW;
  const out: DisruptionScenario[] = [{ p: 1 - risk, effect: { kind: "none" } }];
  if (tot > 0 && risk > 0) {
    out.push({ p: risk * (wipeW / tot), effect: { kind: "wipe" } });
    out.push({ p: risk * (removeW / tot), effect: { kind: "removeBest", n: 1 } });
    out.push({ p: risk * (negateW / tot), effect: { kind: "negate" } });
  }
  return out.filter((s) => s.p > 1e-6);
}
