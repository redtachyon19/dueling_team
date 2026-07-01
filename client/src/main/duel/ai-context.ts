// Builds the AiContext the evaluation-driven AI reasons over, from a minimal
// read-only view of an ocgcore duel. Extracted so BOTH the live session
// (player 1 = AI) and the headless self-play trainer (either player = AI) build
// context through one perspective-correct code path — the AI never assumes a
// fixed seat. Set monsters stay hidden (atk/def 0, faceUp false); the AI does
// not get to peek at the opponent's face-downs.

import { OcgLocation, OcgPosition } from "@n1xx1/ocgcore-wasm";
import type { AiContext, AiMonster, AiSide, AiStats } from "./ai.ts";
import { isDisruption as roleIsDisruption, isHandtrap } from "./card-roles.ts";
import { buildOpponentModel, disruptionRisk } from "./opponent-model.ts";

/** The slice of an ocgcore duel the context builder needs. */
export interface CoreView {
  /** Cards in a player's location (nulls for empty zone slots). */
  queryLoc(player: number, location: OcgLocation): (Record<string, unknown> | null)[];
  /** Count of cards in a player's location. */
  queryCount(player: number, location: OcgLocation): number;
  /** A player's life points. */
  lp(player: number): number;
  /** Card stats by passcode (null = unknown). */
  stats(code: number): AiStats | null;
}

const FACEUP = OcgPosition.FACEUP_ATTACK | OcgPosition.FACEUP_DEFENSE;
const DEFENSE = OcgPosition.FACEUP_DEFENSE | OcgPosition.FACEDOWN_DEFENSE;
const FACEDOWN = OcgPosition.FACEDOWN_ATTACK | OcgPosition.FACEDOWN_DEFENSE;

// OcgType bits used for coarse effect-awareness (values from the binding).
const TYPE_MONSTER = 0x1;
const TYPE_EFFECT = 0x20;
const TYPE_EXTRA = 0x40 /* FUSION */ | 0x2000 /* SYNCHRO */ | 0x800000 /* XYZ */ | 0x4000000 /* LINK */;

/** The single AiStats builder, from a raw card-data record (null → null). Used
 *  by the live session, self-play, and the search so the effect-awareness bits
 *  are derived one way everywhere. */
export function cardStats(card: { code?: number; type?: number; attack?: number; defense?: number; level?: number; setcodes?: number[] } | null | undefined): AiStats | null {
  if (!card) return null;
  const type = card.type ?? 0;
  return {
    atk: card.attack ?? 0,
    def: card.defense ?? 0,
    level: card.level ?? 0,
    isMonster: (type & TYPE_MONSTER) !== 0,
    isEffect: (type & TYPE_EFFECT) !== 0,
    isExtra: (type & TYPE_EXTRA) !== 0,
    isDisruption: card.code != null && roleIsDisruption(card.code),
    setcodes: card.setcodes ?? [],
  };
}

/** One player's resource view. Monster stats are filled only for face-up
 *  monsters; backrow is the count of set Spell/Traps in the five main S/T zones. */
export function buildSide(v: CoreView, player: number, revealHand = false): AiSide {
  const monsters: AiMonster[] = [];
  for (const raw of v.queryLoc(player, OcgLocation.MZONE)) {
    if (!raw) continue;
    const r = raw as Record<string, number>;
    const pos = (r.position ?? 0) | 0;
    const faceUp = (pos & FACEUP) !== 0;
    // Type bits only for FACE-UP monsters — never peek at a hidden card's type.
    const s = faceUp ? v.stats(r.code ?? 0) : null;
    monsters.push({
      atk: faceUp ? (r.attack ?? 0) : 0,
      def: faceUp ? (r.defense ?? 0) : 0,
      faceUp,
      defense: (pos & DEFENSE) !== 0,
      isEffect: s?.isEffect ?? false,
      isExtra: s?.isExtra ?? false,
      isDisruption: s?.isDisruption ?? false,
      setcodes: s?.setcodes ?? [],
    });
  }
  let backrowCount = 0;
  v.queryLoc(player, OcgLocation.SZONE).forEach((raw, seq) => {
    if (!raw || seq >= 5) return; // seq 5 is the Field zone, not backrow
    const pos = ((raw as Record<string, number>).position ?? 0) | 0;
    if ((pos & FACEDOWN) !== 0) backrowCount += 1;
  });
  // Hand-trap count: only for one's OWN hand (revealHand). Peeking at the
  // opponent's hand would be cheating, so it stays 0 for them.
  let handInteraction = 0;
  if (revealHand) {
    for (const raw of v.queryLoc(player, OcgLocation.HAND)) {
      if (!raw) continue;
      const code = ((raw as Record<string, number>).code ?? 0) | 0;
      if (code && isHandtrap(code)) handInteraction += 1;
    }
  }
  return { lp: v.lp(player), handCount: v.queryCount(player, OcgLocation.HAND), monsters, backrowCount, handInteraction };
}

/** Assemble the full AiContext for `aiPlayer`, with combat fields, the both-
 *  sides board the evaluation scores, and the real-time opponent-disruption
 *  risk (from public info only) that drives adaptive play-around behaviour. */
export function buildAiContext(v: CoreView, aiPlayer: 0 | 1, attackerAtk: number): AiContext {
  const oppSeat = aiPlayer === 0 ? 1 : 0;
  const self = buildSide(v, aiPlayer, true); // reveal own hand (hand-trap count)
  const opp = buildSide(v, oppSeat); // opponent hand stays hidden
  // Legacy combat fields, derived from the same monster views.
  const oppMonsterValues = opp.monsters.filter((m) => m.faceUp).map((m) => (m.defense ? m.def : m.atk));
  const oppFaceDownMonsters = opp.monsters.filter((m) => !m.faceUp).length;
  const ownMonsterAtks = self.monsters.filter((m) => m.faceUp).map((m) => (m.defense ? m.def : m.atk));
  const oppModel = buildOpponentModel(v, oppSeat);
  return { stats: v.stats, oppMonsterValues, oppFaceDownMonsters, attackerAtk, ownMonsterAtks, board: { self, opp }, oppRisk: disruptionRisk(oppModel), oppModel };
}
