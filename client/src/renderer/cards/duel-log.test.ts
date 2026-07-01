import { describe, it, expect } from "vitest";
import type { DuelEvent } from "@duel/shared";
import { logLine, toLogEntries } from "./duel-log.ts";

const nameOf = (c: number | null | undefined) => (c === 4 ? "Dark Magician" : c ? `#${c}` : "");

describe("logLine", () => {
  it("turn headers name the active player", () => {
    expect(logLine({ kind: "turn", turn: 1, player: 0 }, nameOf)).toBe("— Turn 1 · You —");
    expect(logLine({ kind: "turn", turn: 2, player: 1 }, nameOf)).toBe("— Turn 2 · Opponent —");
  });
  it("your draw shows card names; opponent's shows only a count", () => {
    expect(logLine({ kind: "draw", player: 0, count: 1, codes: [4] }, nameOf)).toBe("You draw Dark Magician");
    expect(logLine({ kind: "draw", player: 1, count: 2, codes: [] }, nameOf)).toBe("Opponent draws 2 cards");
  });
  it("summons read by position and player", () => {
    expect(logLine({ kind: "summon", player: 0, code: 4, position: "atk" }, nameOf)).toBe("You Summon Dark Magician");
    expect(logLine({ kind: "summon", player: 1, code: 4, position: "def" }, nameOf)).toBe("Opponent Summons Dark Magician in Defense");
    expect(logLine({ kind: "summon", player: 0, code: 4, position: "set" }, nameOf)).toBe("You Set Dark Magician");
  });
  it("a known Set shows its name; a redacted Set (code 0) shows 'a card'", () => {
    expect(logLine({ kind: "spellset", player: 0, code: 4 }, nameOf)).toBe("You Set Dark Magician");
    expect(logLine({ kind: "spellset", player: 1, code: 0 }, nameOf)).toBe("Opponent Sets a card");
  });
  it("attacks, damage, and the result line", () => {
    expect(logLine({ kind: "attack", attacker: 0, target: null }, nameOf)).toBe("You attack directly");
    expect(logLine({ kind: "attack", attacker: 1, target: 0 }, nameOf)).toBe("Opponent attacks You");
    expect(logLine({ kind: "damage", player: 1, amount: 1000 }, nameOf)).toBe("Opponent takes 1000 damage");
    expect(logLine({ kind: "win", player: 0 }, nameOf)).toBe("You win the duel.");
    expect(logLine({ kind: "win", player: 1 }, nameOf)).toBe("You lose the duel.");
  });
  it("noise events produce no line", () => {
    expect(logLine({ kind: "phase", phase: "main1" }, nameOf)).toBeNull();
    expect(logLine({ kind: "move", code: 4 }, nameOf)).toBeNull();
  });
});

describe("toLogEntries", () => {
  it("maps loggable events to numbered lines, skipping noise", () => {
    const evs: DuelEvent[] = [
      { kind: "turn", turn: 1, player: 0 },
      { kind: "phase", phase: "draw" },
      { kind: "draw", player: 0, count: 1, codes: [4] },
      { kind: "move", code: 4 },
    ];
    const out = toLogEntries(evs, nameOf, 0);
    expect(out.map((e) => e.text)).toEqual(["— Turn 1 · You —", "You draw Dark Magician"]);
    expect(out.map((e) => e.id)).toEqual([0, 1]);
  });
});
