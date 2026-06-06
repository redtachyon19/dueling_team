import { describe, it, expect } from "vitest";
import { shuffleDeck } from "./shuffle.ts";

const deck = Array.from({ length: 40 }, (_, i) => i + 1);

describe("shuffleDeck", () => {
  it("returns a permutation of the input (same cards, same count)", () => {
    const out = shuffleDeck(deck, 12345n);
    expect(out).toHaveLength(deck.length);
    expect([...out].sort((a, b) => a - b)).toEqual(deck);
  });
  it("is deterministic for a given seed", () => {
    expect(shuffleDeck(deck, 999n)).toEqual(shuffleDeck(deck, 999n));
  });
  it("produces different orders for different seeds", () => {
    expect(shuffleDeck(deck, 1n)).not.toEqual(shuffleDeck(deck, 2n));
  });
  it("actually reorders (not the identity)", () => {
    expect(shuffleDeck(deck, 0xdeadbeefn)).not.toEqual(deck);
  });
  it("does not mutate the input array", () => {
    const copy = [...deck];
    shuffleDeck(deck, 7n);
    expect(deck).toEqual(copy);
  });
});
