import { describe, it, expect } from "vitest";
import { parseWeights, loadEvalWeights } from "./weights.ts";
import { DEFAULT_WEIGHTS } from "./ai.ts";

describe("parseWeights", () => {
  it("accepts a correct-length finite vector", () => {
    const w = DEFAULT_WEIGHTS.map((_, i) => i + 1);
    expect(parseWeights(JSON.stringify({ weights: w }))).toEqual(w);
  });
  it("rejects wrong length", () => {
    expect(parseWeights(JSON.stringify({ weights: [1, 2, 3] }))).toBeNull();
  });
  it("rejects non-finite or non-numeric entries", () => {
    const bad = DEFAULT_WEIGHTS.slice();
    expect(parseWeights(JSON.stringify({ weights: [...bad.slice(1), "x"] }))).toBeNull();
    expect(parseWeights(JSON.stringify({ weights: [...bad.slice(1), null] }))).toBeNull();
  });
  it("rejects malformed JSON and missing field", () => {
    expect(parseWeights("{not json")).toBeNull();
    expect(parseWeights(JSON.stringify({ nope: 1 }))).toBeNull();
  });
});

describe("loadEvalWeights", () => {
  it("falls back to defaults when no weights file is found", () => {
    const res = loadEvalWeights(["/nonexistent-root-xyz/sub/dir"]);
    expect(res.source).toBe("default");
    expect(res.weights).toEqual(DEFAULT_WEIGHTS.slice());
  });
});
