// Real-time opponent modeling for adaptive play. The AI reads the opponent from
// PUBLIC information only — graveyard, banished pile, face-up board, set-backrow
// count, hand size, deck size — and the mined card roles/archetypes of what the
// opponent has REVEALED. It never peeks at the opponent's hidden hand or face-
// downs (that would be cheating in this single-player sim, where the engine
// actually knows both decks). From this it estimates how likely the opponent can
// PUNISH the AI's next commitment, so the AI can play around disruption when the
// opponent looks loaded and press when they look tapped out — adapting to the
// specific opponent as the game reveals it.

import { OcgLocation, OcgPosition } from "@n1xx1/ocgcore-wasm";
import { getRoles } from "./card-roles.ts";
import type { CoreView } from "./ai-context.ts";

export interface OpponentModel {
  handCount: number;
  /** Set Spell/Traps (open backrow) — the main source of surprise interaction. */
  backrowCount: number;
  deckCount: number;
  /** Dominant archetype (setcode) among revealed cards, or null if none stands out. */
  archetype: number | null;
  /** Counts of disruptive roles the opponent has REVEALED (grave/banish/board). */
  revealed: { negate: number; removal: number; handtrap: number; search: number };
}

const FACEUP = OcgPosition.FACEUP_ATTACK | OcgPosition.FACEUP_DEFENSE;
const FACEDOWN = OcgPosition.FACEDOWN_ATTACK | OcgPosition.FACEDOWN_DEFENSE;

/** Build the opponent model from public zones only. */
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

  // Publicly revealed cards: graveyard, banished, and face-up monsters.
  for (const raw of v.queryLoc(opp, OcgLocation.GRAVE)) if (raw) consider(code(raw));
  for (const raw of v.queryLoc(opp, OcgLocation.REMOVED)) if (raw) consider(code(raw));
  for (const raw of v.queryLoc(opp, OcgLocation.MZONE)) {
    if (!raw) continue;
    const pos = ((raw as Record<string, number>).position ?? 0) | 0;
    if ((pos & FACEUP) !== 0) consider(code(raw)); // never inspect a face-down monster
  }
  // Open backrow: count set S/T (don't peek at what they are).
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

/** Estimate 0..1 how likely the opponent can disrupt the AI's next commitment.
 *  Combines open-backrow trap risk, cards-in-hand (with revealed hand-traps
 *  raising the odds), and the interaction they've already shown. Independent
 *  factors combined as (1 − ∏(1 − risk_i)). */
export function disruptionRisk(m: OpponentModel): number {
  const trapRisk = 1 - Math.pow(0.7, Math.min(m.backrowCount, 4)); // each set card ≈30% a live trap
  const handThreat = m.handCount > 0 ? Math.min(0.15 + 0.12 * Math.min(m.revealed.handtrap, 3), 0.6) : 0;
  const revealedThreat = Math.min(0.12 * (m.revealed.negate + m.revealed.removal), 0.6);
  return Math.min(1, 1 - (1 - trapRisk) * (1 - handThreat) * (1 - revealedThreat));
}

/** What a modeled opponent disruption does to the AI's OWN board, for the
 *  survival-adjusted evaluation (applied by `applyDisruptionToSelf` in ai.ts). */
export type DisruptionEffect =
  | { kind: "none" }
  | { kind: "wipe" } // mass removal — all the AI's face-up monsters (Mirror Force / Raigeki-like)
  | { kind: "removeBest"; n: number } // targeted removal of the n best bodies
  | { kind: "negate" }; // neutralize the AI's key effect/negate monster

export interface DisruptionScenario {
  p: number;
  effect: DisruptionEffect;
}

/** A belief distribution over the opponent's likely disruption, from PUBLIC info
 *  only. `p("none") = 1 − disruptionRisk`; the remaining probability mass is
 *  split across wipe / targeted-removal / negate by the EVIDENCE (open backrow →
 *  mass-trap weight, revealed removal → removal weight, revealed negates/hand-
 *  traps + a full hand → negate weight). Probabilities sum to 1. This is what
 *  makes "play around it" concrete: the search scores a line by how much value
 *  survives across these scenarios, not by a board-width proxy. */
export function disruptionScenarios(m: OpponentModel): DisruptionScenario[] {
  const risk = disruptionRisk(m);
  const wipeW = m.backrowCount * 1.0; // set backrow ⇒ a possible mass trap
  const removeW = 1.0 + m.revealed.removal * 0.5; // targeted removal is always plausible
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
