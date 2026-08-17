import { describe, it, expect } from "vitest";
import {
  initialDuelState,
  reduceEvent,
  reduceEvents,
  phaseFromOcg,
  positionFromOcg,
  OCG_PHASE,
  OCG_POS,
  isDefeated,
} from "../src/index";

describe("phase decoding", () => {
  it("maps ocgcore phases to DuelPhase", () => {
    expect(phaseFromOcg(OCG_PHASE.DRAW)).toBe("draw");
    expect(phaseFromOcg(OCG_PHASE.MAIN1)).toBe("main1");
    expect(phaseFromOcg(OCG_PHASE.MAIN2)).toBe("main2");
    expect(phaseFromOcg(OCG_PHASE.END)).toBe("end");
    expect(phaseFromOcg(OCG_PHASE.BATTLE_STEP)).toBe("battle");
    expect(phaseFromOcg(OCG_PHASE.DAMAGE)).toBe("battle");
  });
});

describe("position decoding", () => {
  it("maps ocgcore positions to face-up/down + atk/def", () => {
    expect(positionFromOcg(OCG_POS.FACEUP_ATTACK)).toEqual({ position: "atk", faceUp: true });
    expect(positionFromOcg(OCG_POS.FACEUP_DEFENSE)).toEqual({ position: "def", faceUp: true });
    expect(positionFromOcg(OCG_POS.FACEDOWN_DEFENSE)).toEqual({ position: "set", faceUp: false });
    expect(positionFromOcg(OCG_POS.FACEDOWN_ATTACK)).toEqual({ position: "set", faceUp: false });
  });
});

describe("vanilla duel reducer", () => {
  it("tracks life points through battle damage", () => {
    let s = initialDuelState(8000, 8000);
    s = reduceEvents(s, [
      { kind: "turn", turn: 1, player: 0 },
      { kind: "phase", phase: "main1" },
      { kind: "summon", player: 0, code: 5053103, position: "atk" },
      { kind: "phase", phase: "battle" },
      { kind: "attack", attacker: 0, target: null },
      { kind: "damage", player: 1, amount: 1700 },
    ]);
    expect(s.players[1].lp).toBe(6300);
    expect(s.players[0].lp).toBe(8000);
    expect(s.phase).toBe("battle");
    expect(s.turnPlayer).toBe(0);
    expect(s.over).toBe(false);
  });

  it("clamps life points at zero and records the winner", () => {
    let s = initialDuelState(1000, 1000);
    s = reduceEvent(s, { kind: "damage", player: 1, amount: 1700 });
    expect(s.players[1].lp).toBe(0);
    s = reduceEvent(s, { kind: "win", player: 0 });
    expect(s.over).toBe(true);
    expect(s.winner).toBe(0);
    expect(isDefeated(s, 1)).toBe(true);
    expect(isDefeated(s, 0)).toBe(false);
  });

  it("applies recovery", () => {
    let s = initialDuelState(8000, 8000);
    s = reduceEvent(s, { kind: "recover", player: 0, amount: 500 });
    expect(s.players[0].lp).toBe(8500);
  });

  it("does not mutate the input state", () => {
    const s0 = initialDuelState(8000, 8000);
    const s1 = reduceEvent(s0, { kind: "damage", player: 1, amount: 1000 });
    expect(s0.players[1].lp).toBe(8000);
    expect(s1.players[1].lp).toBe(7000);
    expect(s1).not.toBe(s0);
  });
});
