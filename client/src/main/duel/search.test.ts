import { describe, it, expect } from "vitest";
import { overExtensionPenalty } from "./search.ts";

describe("overExtensionPenalty (behavioral hold-back lever)", () => {
  it("is zero at or below the safe board size, whatever the risk", () => {
    expect(overExtensionPenalty(1, 2)).toBe(0);
    expect(overExtensionPenalty(0.9, 1)).toBe(0);
  });
  it("vanishes at zero risk — go all-in for the full combo", () => {
    expect(overExtensionPenalty(0, 6)).toBe(0);
  });
  it("scales with risk and quadratically with bodies beyond the safe size", () => {
    expect(overExtensionPenalty(0.9, 5)).toBeGreaterThan(overExtensionPenalty(0.2, 5));
    expect(overExtensionPenalty(0.9, 5)).toBeCloseTo(0.9 * 300 * 9, 5);
  });
  it("grows super-linearly: the 5th body costs far more than the 3rd", () => {
    const third = overExtensionPenalty(0.8, 3) - overExtensionPenalty(0.8, 2);
    const fifth = overExtensionPenalty(0.8, 5) - overExtensionPenalty(0.8, 4);
    expect(fifth).toBeGreaterThan(third * 3);
  });
});
