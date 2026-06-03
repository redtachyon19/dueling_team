// @duel/engine
//
// Pure helpers over the duel contracts in @duel/shared. ocgcore (in the main
// process) is the rules authority and the source of board truth (queried), but
// these pure functions own the parts worth unit-testing without the WASM core:
// phase/position decoding and the life-point / turn / win reducer that projects
// the DuelEvent stream onto a DuelState. No I/O, no Date.now(), no deps beyond
// @duel/shared.

import type {
  CardPosition,
  DuelEvent,
  DuelPhase,
  DuelPlayer,
  DuelPlayerState,
  DuelState,
} from "@duel/shared";

// Mirror of ocgcore's OcgPhase bitmask (kept here so engine has no core dep).
export const OCG_PHASE = {
  DRAW: 0x01,
  STANDBY: 0x02,
  MAIN1: 0x04,
  BATTLE_START: 0x08,
  BATTLE_STEP: 0x10,
  DAMAGE: 0x20,
  DAMAGE_CAL: 0x40,
  BATTLE: 0x80,
  MAIN2: 0x100,
  END: 0x200,
} as const;

export function phaseFromOcg(phase: number): DuelPhase {
  switch (phase) {
    case OCG_PHASE.DRAW:
      return "draw";
    case OCG_PHASE.STANDBY:
      return "standby";
    case OCG_PHASE.MAIN1:
      return "main1";
    case OCG_PHASE.MAIN2:
      return "main2";
    case OCG_PHASE.END:
      return "end";
    case OCG_PHASE.BATTLE_START:
    case OCG_PHASE.BATTLE_STEP:
    case OCG_PHASE.DAMAGE:
    case OCG_PHASE.DAMAGE_CAL:
    case OCG_PHASE.BATTLE:
      return "battle";
    default:
      return "unknown";
  }
}

// Mirror of ocgcore's OcgPosition bitmask.
export const OCG_POS = {
  FACEUP_ATTACK: 0x1,
  FACEDOWN_ATTACK: 0x2,
  FACEUP_DEFENSE: 0x4,
  FACEDOWN_DEFENSE: 0x8,
} as const;

export function positionFromOcg(pos: number): { position: CardPosition; faceUp: boolean } {
  const faceUp = (pos & (OCG_POS.FACEUP_ATTACK | OCG_POS.FACEUP_DEFENSE)) !== 0;
  const defense = (pos & (OCG_POS.FACEUP_DEFENSE | OCG_POS.FACEDOWN_DEFENSE)) !== 0;
  if (!faceUp) return { position: "set", faceUp: false };
  return { position: defense ? "def" : "atk", faceUp: true };
}

export function emptyPlayerState(lp: number): DuelPlayerState {
  return {
    lp,
    hand: [],
    monsters: [null, null, null, null, null],
    spells: [null, null, null, null, null],
    field: null,
    graveCount: 0,
    banishCount: 0,
    extraCount: 0,
    deckCount: 0,
  };
}

export function initialDuelState(lp0 = 8000, lp1 = 8000): DuelState {
  return {
    turn: 0,
    turnPlayer: 0,
    phase: "draw",
    players: [emptyPlayerState(lp0), emptyPlayerState(lp1)],
    over: false,
    winner: null,
  };
}

/**
 * Pure reducer projecting one DuelEvent onto a DuelState. The board (hand /
 * zones / pile counts) is authoritative from the core's queries and is NOT
 * reduced here — this owns life points, phase, turn, and win/loss, which is the
 * "vanilla duel" outcome the milestone test asserts. Returns a new state.
 */
export function reduceEvent(state: DuelState, event: DuelEvent): DuelState {
  const next: DuelState = {
    ...state,
    players: [{ ...state.players[0] }, { ...state.players[1] }],
  };
  switch (event.kind) {
    case "damage":
      next.players[event.player].lp = Math.max(0, next.players[event.player].lp - event.amount);
      break;
    case "recover":
      next.players[event.player].lp += event.amount;
      break;
    case "phase":
      next.phase = event.phase;
      break;
    case "turn":
      next.turn = event.turn;
      next.turnPlayer = event.player;
      break;
    case "win":
      next.over = true;
      next.winner = event.player;
      break;
    default:
      break; // draw/summon/move/attack/etc. don't change reduced state
  }
  return next;
}

export function reduceEvents(state: DuelState, events: DuelEvent[]): DuelState {
  return events.reduce(reduceEvent, state);
}

/** Convenience: is `p` defeated? (lp 0, or an explicit win for the other player). */
export function isDefeated(state: DuelState, p: DuelPlayer): boolean {
  return state.players[p].lp <= 0 || (state.over && state.winner !== null && state.winner !== p);
}
