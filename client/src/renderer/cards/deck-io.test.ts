import { describe, it, expect } from "vitest";
import type { CardData, Deck } from "@duel/shared";
import { parseYdk, serializeYdk, safeFilename, toDeckListText, toDeckJson } from "./deck-io.ts";

function deck(over: Partial<Deck> = {}): Deck {
  return {
    id: "d1", name: "Test", tags: [], main: [], extra: [], side: [],
    enforceLimits: true, createdAt: "", updatedAt: "", ...over,
  };
}

describe("parseYdk", () => {
  it("reads main/extra/side sections", () => {
    const text = "#created by x\n#main\n100\n100\n200\n#extra\n300\n!side\n400\n";
    expect(parseYdk(text)).toEqual({ main: [100, 100, 200], extra: [300], side: [400] });
  });
  it("ignores blank lines and comments, tolerates CRLF", () => {
    expect(parseYdk("#main\r\n100\r\n\r\n#whatever\r\n200\r\n")).toEqual({
      main: [100, 200], extra: [], side: [],
    });
  });
  it("drops passcodes that appear before any section header", () => {
    expect(parseYdk("999\n#main\n1\n")).toEqual({ main: [1], extra: [], side: [] });
  });
});

describe("serializeYdk", () => {
  it("emits the canonical section order", () => {
    expect(serializeYdk({ main: [1, 1], extra: [2], side: [3] })).toBe(
      "#created by Dueling Team\n#main\n1\n1\n#extra\n2\n!side\n3\n",
    );
  });
  it("round-trips through parseYdk", () => {
    const zones = { main: [10, 10, 11], extra: [20], side: [30, 31] };
    expect(parseYdk(serializeYdk(zones))).toEqual(zones);
  });
});

describe("safeFilename", () => {
  it("keeps safe characters and collapses the rest", () => {
    expect(safeFilename("Blue-Eyes Deck!")).toBe("Blue-Eyes_Deck");
    expect(safeFilename("a/b\\c")).toBe("a_b_c");
  });
  it("falls back to 'deck' when nothing usable remains", () => {
    expect(safeFilename("   ")).toBe("deck");
    expect(safeFilename("***")).toBe("deck");
  });
});

describe("toDeckListText", () => {
  const names: Record<number, string> = { 1: "Ash Blossom", 2: "Maxx C" };
  const nameOf = (id: number): string => names[id] ?? `#${id}`;
  it("groups counts and labels each zone with its cap", () => {
    const out = toDeckListText(deck({ name: "T", main: [1, 1, 2] }), nameOf);
    expect(out).toContain("Main Deck (3/40-60)");
    expect(out).toContain("2x Ash Blossom");
    expect(out).toContain("1x Maxx C");
    expect(out).toContain("Extra Deck (0/15)");
    expect(out).toContain("(empty)");
  });
});

describe("toDeckJson", () => {
  const card = (id: number): CardData => ({
    id, name: `C${id}`, type: "Effect Monster", frameType: "effect", desc: "", race: "Dragon",
    archetype: null, attribute: "DARK", atk: 0, def: 0, level: 4, scale: null, linkval: null,
    linkmarkers: null, images: [id], banlistTcg: null, tcgDate: null, sets: [],
  });
  it("enriches known cards and keeps unknowns as id-only", () => {
    const json = JSON.parse(
      toDeckJson(deck({ main: [1, 9] }), (id) => (id === 1 ? card(1) : undefined), "2026-01-01T00:00:00Z"),
    );
    expect(json.main[0]).toEqual({ id: 1, name: "C1", type: "Effect Monster", frameType: "effect" });
    expect(json.main[1]).toEqual({ id: 9 });
    expect(json.exportedAt).toBe("2026-01-01T00:00:00Z");
  });
});
