import { describe, it, expect } from "vitest";
import type { DuelEvent } from "@duel/shared";
import { redactEvents, HIDDEN_CODE } from "./redact.ts";

describe("redactEvents", () => {
  it("keeps the viewer's own drawn card codes", () => {
    const out = redactEvents([{ kind: "draw", player: 0, count: 1, codes: [4007] }], 0);
    expect(out).toEqual([{ kind: "draw", player: 0, count: 1, codes: [4007] }]);
  });
  it("strips the opponent's drawn card codes (count survives)", () => {
    const out = redactEvents([{ kind: "draw", player: 1, count: 2, codes: [4007, 555] }], 0);
    expect(out).toEqual([{ kind: "draw", player: 1, count: 2, codes: [] }]);
  });
  it("hides the opponent's Set card identity but keeps your own", () => {
    expect(redactEvents([{ kind: "spellset", player: 1, code: 4007 }], 0)).toEqual([{ kind: "spellset", player: 1, code: HIDDEN_CODE }]);
    expect(redactEvents([{ kind: "spellset", player: 0, code: 4007 }], 0)).toEqual([{ kind: "spellset", player: 0, code: 4007 }]);
  });
  it("drops bare move events (could leak a card sent to a hidden zone)", () => {
    expect(redactEvents([{ kind: "move", code: 4007 }], 0)).toEqual([]);
  });
  it("leaves public events (summon / attack / damage / turn) untouched", () => {
    const evs: DuelEvent[] = [
      { kind: "summon", player: 1, code: 4007, position: "atk" },
      { kind: "attack", attacker: 1, target: 0 },
      { kind: "damage", player: 0, amount: 1000 },
      { kind: "turn", turn: 3, player: 1 },
    ];
    expect(redactEvents(evs, 0)).toEqual(evs);
  });
  it("redacts symmetrically from player 1's perspective", () => {
    const out = redactEvents([{ kind: "draw", player: 0, count: 1, codes: [4007] }], 1);
    expect(out).toEqual([{ kind: "draw", player: 0, count: 1, codes: [] }]);
  });
});
