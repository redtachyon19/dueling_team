import { describe, it, expect } from "vitest";
import { OcgLocation, OcgPosition } from "@n1xx1/ocgcore-wasm";
import { buildOpponentModel, disruptionRisk, disruptionScenarios, type OpponentModel } from "./opponent-model.ts";
import { setCardRoles } from "./card-roles.ts";
import { cardStats, type CoreView } from "./ai-context.ts";

const view = (locs: Partial<Record<OcgLocation, unknown[]>>, hand: number, deck = 30): CoreView => ({
  queryLoc: (_p, loc) => (locs[loc] ?? []) as (Record<string, unknown> | null)[],
  queryCount: (_p, loc) => (loc === OcgLocation.HAND ? hand : loc === OcgLocation.DECK ? deck : 0),
  lp: () => 8000,
  stats: (code) => cardStats({ code, type: 0x1, setcodes: [] }),
});

describe("buildOpponentModel + disruptionRisk", () => {
  it("reads revealed interaction + backrow + hand into a HIGH risk", () => {
    setCardRoles({ "100": ["negate"], "200": ["removal"] });
    try {
      const m = buildOpponentModel(view({
        [OcgLocation.GRAVE]: [{ code: 100, position: 0 }, { code: 200, position: 0 }],
        [OcgLocation.SZONE]: [{ code: 300, position: OcgPosition.FACEDOWN_DEFENSE }, { code: 301, position: OcgPosition.FACEDOWN_DEFENSE }],
      }, 3), 0);
      expect(m.revealed.negate).toBe(1);
      expect(m.revealed.removal).toBe(1);
      expect(m.backrowCount).toBe(2);
      expect(m.handCount).toBe(3);
      expect(disruptionRisk(m)).toBeGreaterThan(0.5);
    } finally {
      setCardRoles({});
    }
  });
  it("reads a tapped-out, backrow-less opponent as LOW risk", () => {
    const m = buildOpponentModel(view({}, 0), 0);
    expect(m.backrowCount).toBe(0);
    expect(disruptionRisk(m)).toBeLessThan(0.1);
  });
  it("does not count a face-down monster as revealed interaction (no peeking)", () => {
    setCardRoles({ "500": ["negate"] });
    try {
      const m = buildOpponentModel(view({
        [OcgLocation.MZONE]: [{ code: 500, position: OcgPosition.FACEDOWN_DEFENSE }], // set monster — hidden
      }, 0), 0);
      expect(m.revealed.negate).toBe(0); // its type/role was never inspected
    } finally {
      setCardRoles({});
    }
  });
});

describe("disruptionScenarios", () => {
  const model = (over: Partial<OpponentModel> = {}): OpponentModel => ({ handCount: 0, backrowCount: 0, deckCount: 30, archetype: null, revealed: { negate: 0, removal: 0, handtrap: 0, search: 0 }, ...over });
  it("is certainly 'none' for a harmless opponent, and probabilities sum to 1", () => {
    const sc = disruptionScenarios(model());
    expect(sc).toHaveLength(1);
    expect(sc[0]!.effect.kind).toBe("none");
    expect(sc[0]!.p).toBeCloseTo(1, 6);
  });
  it("puts mass on 'wipe' when the opponent has open backrow; still sums to 1", () => {
    const sc = disruptionScenarios(model({ backrowCount: 3 }));
    const total = sc.reduce((t, s) => t + s.p, 0);
    expect(total).toBeCloseTo(1, 6);
    const wipe = sc.find((s) => s.effect.kind === "wipe")!;
    expect(wipe.p).toBeGreaterThan(0);
  });
  it("puts mass on 'negate' when negates/hand-traps were revealed", () => {
    const sc = disruptionScenarios(model({ handCount: 2, revealed: { negate: 2, removal: 0, handtrap: 1, search: 0 } }));
    const negate = sc.find((s) => s.effect.kind === "negate")!;
    const none = sc.find((s) => s.effect.kind === "none")!;
    expect(negate.p).toBeGreaterThan(0);
    expect(none.p).toBeLessThan(1); // there IS disruption risk
  });
});
