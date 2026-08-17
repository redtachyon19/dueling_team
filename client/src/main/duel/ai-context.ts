import { OcgLocation, OcgPosition } from "@n1xx1/ocgcore-wasm";
import type { AiContext, AiMonster, AiSide, AiStats } from "./ai.ts";
import { isDisruption as roleIsDisruption, isHandtrap } from "./card-roles.ts";
import { buildOpponentModel, disruptionRisk } from "./opponent-model.ts";

export interface CoreView {
  queryLoc(player: number, location: OcgLocation): (Record<string, unknown> | null)[];
  queryCount(player: number, location: OcgLocation): number;
  lp(player: number): number;
  stats(code: number): AiStats | null;
}

const FACEUP = OcgPosition.FACEUP_ATTACK | OcgPosition.FACEUP_DEFENSE;
const DEFENSE = OcgPosition.FACEUP_DEFENSE | OcgPosition.FACEDOWN_DEFENSE;
const FACEDOWN = OcgPosition.FACEDOWN_ATTACK | OcgPosition.FACEDOWN_DEFENSE;

const TYPE_MONSTER = 0x1;
const TYPE_EFFECT = 0x20;
const TYPE_EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;

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

export function buildSide(v: CoreView, player: number, revealHand = false): AiSide {
  const monsters: AiMonster[] = [];
  for (const raw of v.queryLoc(player, OcgLocation.MZONE)) {
    if (!raw) continue;
    const r = raw as Record<string, number>;
    const pos = (r.position ?? 0) | 0;
    const faceUp = (pos & FACEUP) !== 0;
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
    if (!raw || seq >= 5) return;
    const pos = ((raw as Record<string, number>).position ?? 0) | 0;
    if ((pos & FACEDOWN) !== 0) backrowCount += 1;
  });
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

export function buildAiContext(v: CoreView, aiPlayer: 0 | 1, attackerAtk: number): AiContext {
  const oppSeat = aiPlayer === 0 ? 1 : 0;
  const self = buildSide(v, aiPlayer, true);
  const opp = buildSide(v, oppSeat);
  const oppMonsterValues = opp.monsters.filter((m) => m.faceUp).map((m) => (m.defense ? m.def : m.atk));
  const oppFaceDownMonsters = opp.monsters.filter((m) => !m.faceUp).length;
  const ownMonsterAtks = self.monsters.filter((m) => m.faceUp).map((m) => (m.defense ? m.def : m.atk));
  const oppModel = buildOpponentModel(v, oppSeat);
  return { stats: v.stats, oppMonsterValues, oppFaceDownMonsters, attackerAtk, ownMonsterAtks, board: { self, opp }, oppRisk: disruptionRisk(oppModel), oppModel };
}
