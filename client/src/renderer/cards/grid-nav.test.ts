import { describe, it, expect } from "vitest";
import { rangeInclusive, stepIndex } from "./grid-nav.ts";

describe("rangeInclusive", () => {
  it("ascends regardless of argument order", () => {
    expect(rangeInclusive(2, 5)).toEqual([2, 3, 4, 5]);
    expect(rangeInclusive(5, 2)).toEqual([2, 3, 4, 5]);
  });
  it("returns a single index when a === b", () => {
    expect(rangeInclusive(3, 3)).toEqual([3]);
  });
});

describe("stepIndex (3-column grid of 7 items)", () => {
  const cols = 3;
  const count = 7;
  it("moves left/right by one", () => {
    expect(stepIndex(4, "ArrowLeft", cols, count)).toBe(3);
    expect(stepIndex(4, "ArrowRight", cols, count)).toBe(5);
  });
  it("moves up/down by a full row", () => {
    expect(stepIndex(4, "ArrowUp", cols, count)).toBe(1);
    expect(stepIndex(1, "ArrowDown", cols, count)).toBe(4);
  });
  it("stays put at edges instead of wrapping", () => {
    expect(stepIndex(0, "ArrowLeft", cols, count)).toBe(0);
    expect(stepIndex(6, "ArrowRight", cols, count)).toBe(6);
    expect(stepIndex(1, "ArrowUp", cols, count)).toBe(1);
    expect(stepIndex(5, "ArrowDown", cols, count)).toBe(5);
  });
  it("left/right may cross a row boundary (list-like)", () => {
    expect(stepIndex(3, "ArrowLeft", cols, count)).toBe(2);
    expect(stepIndex(2, "ArrowRight", cols, count)).toBe(3);
  });
  it("handles empty grids and degenerate columns", () => {
    expect(stepIndex(0, "ArrowDown", cols, 0)).toBe(0);
    expect(stepIndex(2, "ArrowRight", 0, 5)).toBe(3);
  });
});
