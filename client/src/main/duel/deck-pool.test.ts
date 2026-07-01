import { describe, it, expect } from "vitest";
import { generateDeckPool } from "./deck-pool.ts";

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Synthetic Normal monsters (type = MONSTER|NORMAL = 0x11) across a power range.
const cards = Array.from({ length: 30 }, (_, i) => ({
  code: 1000 + i, type: 0x1 | 0x10, attack: 1000 + i * 60, defense: 1500, level: 4,
  alias: 0, setcodes: [], race: 0n, lscale: 0, rscale: 0, link_marker: 0,
})) as never[];

describe("generateDeckPool", () => {
  it("builds legal 40-card decks from a card list", () => {
    const pool = generateDeckPool(cards, mulberry32(1));
    expect(pool.length).toBeGreaterThan(0);
    for (const d of pool) {
      expect(d.main).toHaveLength(40); // only 40-card decks are emitted
      for (const code of d.main) expect(typeof code).toBe("number");
    }
    expect(pool.map((d) => d.name)).toContain("aggro"); // beaters are present → aggro builds
  });
  it("respects the rng: a different seed yields a different aggro deck composition", () => {
    const a = generateDeckPool(cards, mulberry32(1)).find((d) => d.name === "aggro")!;
    const b = generateDeckPool(cards, mulberry32(99)).find((d) => d.name === "aggro")!;
    // Different seed → different shuffle order/selection (order-sensitive compare).
    expect(a.main).not.toEqual(b.main);
  });
});
