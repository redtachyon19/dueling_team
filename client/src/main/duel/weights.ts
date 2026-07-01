// Loads self-play-learned evaluation weights from a LOCAL file — no network,
// consistent with the project's local-first / no-runtime-external-API rules.
// The file is written by the manual trainer (`scripts/train-ai.ts`) and lives
// under assets/ (gitignored, like the rest of the generated data). When it is
// absent or malformed, the AI keeps its hand-tuned DEFAULT_WEIGHTS.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, FEATURE_NAMES } from "./ai.ts";

/** Relative path of the learned-weights file under an `assets/` root. */
export const WEIGHTS_REL = path.join("ai", "eval-weights.json");

/** On-disk shape: the weight vector plus provenance for debugging. */
export interface WeightsFile {
  weights: number[];
  features?: string[];
  games?: number;
  trainedAt?: string;
}

/** Walk up from each start dir looking for `assets/ai/eval-weights.json`. */
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

/** Parse + validate a weights file's contents. Returns null on any problem so
 *  callers fall back to defaults rather than running with garbage weights. */
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

/** Load learned weights if present and valid, else the hand-tuned defaults. */
export function loadEvalWeights(startDirs: string[]): { weights: number[]; source: "learned" | "default" } {
  const file = findWeightsFile(startDirs);
  if (file) {
    const parsed = parseWeights(readFileSync(file, "utf8"));
    if (parsed) return { weights: parsed, source: "learned" };
  }
  return { weights: DEFAULT_WEIGHTS.slice(), source: "default" };
}

// Re-exported so the trainer can stamp the feature names it trained against.
export { FEATURE_NAMES };
