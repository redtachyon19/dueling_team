import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, FEATURE_NAMES } from "./ai.ts";

export const WEIGHTS_REL = path.join("ai", "eval-weights.json");

export interface WeightsFile {
  weights: number[];
  features?: string[];
  games?: number;
  trainedAt?: string;
}

function findWeightsFile(startDirs: string[]): string | null {
  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "assets", WEIGHTS_REL);
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function parseWeights(json: string): number[] | null {
  let data: WeightsFile;
  try {
    data = JSON.parse(json) as WeightsFile;
  } catch {
    return null;
  }
  const w = data?.weights;
  if (!Array.isArray(w) || w.length !== DEFAULT_WEIGHTS.length || !w.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return null;
  }
  return w;
}

export function loadEvalWeights(startDirs: string[]): { weights: number[]; source: "learned" | "default" } {
  const file = findWeightsFile(startDirs);
  if (file) {
    const parsed = parseWeights(readFileSync(file, "utf8"));
    if (parsed) return { weights: parsed, source: "learned" };
  }
  return { weights: DEFAULT_WEIGHTS.slice(), source: "default" };
}

export { FEATURE_NAMES };
