import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { OcgResponse } from "@n1xx1/ocgcore-wasm";
import { getCore, getSearchCore, buildReaders } from "../client/src/main/duel/ocg.ts";
import { playGame, type Sample } from "../client/src/main/duel/self-play.ts";
import { aiDecide, setEvalWeights, DEFAULT_WEIGHTS, FEATURE_NAMES } from "../client/src/main/duel/ai.ts";
import { buildAiContext, cardStats } from "../client/src/main/duel/ai-context.ts";
import { WEIGHTS_REL } from "../client/src/main/duel/weights.ts";
import { loadCardRoles } from "../client/src/main/duel/card-roles.ts";
import { generateDeckPool, generateArchetypeDecks, parseYdkText, type PoolDeck } from "../client/src/main/duel/deck-pool.ts";
import { createIdleSearcher } from "../client/src/main/duel/search.ts";
import { buildScratchDuel, drive, scratchView, autoPass, OcgDuelMode, OcgMessageType, type ReplayHeader } from "../client/src/main/duel/resim.ts";

const COLLECT = Number(process.argv[2] ?? 400);
const MEASURE = Number(process.argv[3] ?? 24);
const SEED = Number(process.argv[4] ?? 1);

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

const header = (seed: number, m0: number[], e0: number[], m1: number[], e1: number[]): ReplayHeader => ({
  seed4: [BigInt(seed) | 1n, (BigInt(seed) >> 16n) | 1n, (BigInt(seed) >> 32n) | 1n, (BigInt(seed) >> 48n) | 1n],
  mode: OcgDuelMode.MODE_MR5, p0Main: m0, p0Extra: e0, p1Main: m1, p1Extra: e1,
});

function train(samples: Sample[], epochs = 400, lr = 0.05, l2 = 1e-4): number[] {
  const dim = DEFAULT_WEIGHTS.length;
  const w = new Array(dim).fill(0) as number[];
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(dim).fill(0) as number[];
    for (const s of samples) {
      const err = sigmoid(dot(w, s.f)) - s.won;
      for (let i = 0; i < dim; i++) grad[i]! += err * s.f[i]!;
    }
    for (let i = 0; i < dim; i++) w[i]! -= lr * (grad[i]! / samples.length + l2 * w[i]!);
  }
  return w;
}

function rescaleToDefault(w: number[], samples: Sample[]): number[] {
  const std = (weights: readonly number[]) => {
    const vals = samples.map((s) => dot(weights, s.f));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  };
  const k = std(DEFAULT_WEIGHTS) / std(w);
  return w.map((x) => x * k);
}

const core = await getCore();
const readers = buildReaders([process.cwd()]);
loadCardRoles([process.cwd()]);
const rng = mulberry32(SEED);

const has = (c: number) => !!readers.cardReader(c);
function loadYdkDir(dir: string): PoolDeck[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".ydk")).map((f) => {
    const d = parseYdkText(readFileSync(path.join(dir, f), "utf8"));
    return { name: `ydk-${f.replace(/\.ydk$/, "")}`, main: d.main.filter(has), extra: d.extra.filter(has) };
  }).filter((d) => d.main.length >= 40);
}
function runnable(d: PoolDeck): boolean {
  let decisive = 0;
  for (let i = 0; i < 4; i++) {
    const r = playGame(core, readers, { seed: BigInt(900 + i), deck0: d.main, deck1: d.main, weights: [DEFAULT_WEIGHTS, DEFAULT_WEIGHTS], epsilon: 0.1, rng, maxSteps: 60000 });
    if (r.winner >= 0) decisive++;
  }
  return decisive >= 2;
}
const candidates = [...generateDeckPool(readers.cards, rng), ...generateArchetypeDecks(readers.cards, rng, 16), ...loadYdkDir(path.join(process.cwd(), "decks"))];
const pool = candidates.filter(runnable);
console.log(`Deck corpus: ${pool.length}/${candidates.length} runnable — ${pool.map((d) => d.name).join(", ")}`);
if (pool.length < 2) { console.error("Too few runnable decks — aborting."); process.exit(1); }

console.log(`Collecting ${COLLECT} self-play games over diverse pairings (ε-greedy)…`);
const t0 = Date.now();
const samples: Sample[] = [];
let collected = 0;
for (let i = 0; i < COLLECT; i++) {
  const a = pool[Math.floor(rng() * pool.length)]!;
  const b = pool[Math.floor(rng() * pool.length)]!;
  const r = playGame(core, readers, { seed: BigInt(SEED * 1_000_003 + i), deck0: a.main, deck1: b.main, weights: [DEFAULT_WEIGHTS, DEFAULT_WEIGHTS], epsilon: 0.25, rng, maxSteps: 100000 });
  if (r.winner >= 0) { samples.push(...r.samples); collected++; }
}
console.log(`  ${collected}/${COLLECT} decisive games, ${samples.length} samples, ${Date.now() - t0}ms`);
if (samples.length < 100) { console.error("Too few samples — aborting."); process.exit(1); }

for (let i = samples.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [samples[i], samples[j]] = [samples[j]!, samples[i]!]; }
const split = Math.floor(samples.length * 0.8);
const trainSet = samples.slice(0, split);
const valSet = samples.slice(split);
const raw = train(trainSet);

let correct = 0, logloss = 0;
for (const s of valSet) {
  const p = sigmoid(dot(raw, s.f));
  if ((p >= 0.5 ? 1 : 0) === s.won) correct++;
  logloss += -(s.won * Math.log(p + 1e-9) + (1 - s.won) * Math.log(1 - p + 1e-9));
}
console.log(`Held-out: ${valSet.length} positions, accuracy ${(100 * correct / Math.max(1, valSet.length)).toFixed(1)}%, logloss ${(logloss / Math.max(1, valSet.length)).toFixed(3)} (0.693 = coin-flip)`);

const ALPHA = Number(process.env.AI_TRAIN_ALPHA ?? 0.4);
const rescaled = rescaleToDefault(raw, trainSet);
const learned = DEFAULT_WEIGHTS.map((d, i) => Math.round((d * (1 - ALPHA) + (rescaled[i] ?? 0) * ALPHA) * 1000) / 1000);
console.log(`Default weights:`, DEFAULT_WEIGHTS.map(Number));
console.log(`Learned weights (α=${ALPHA} toward data):`, learned, `(features: ${FEATURE_NAMES.join(", ")})`);

const searcher = createIdleSearcher(await getSearchCore(), readers);
const stats = (c: number) => cardStats(readers.cardReader(c));

function playSearchMatch(h: ReplayHeader, w0: readonly number[], w1: readonly number[]): number {
  const handle = buildScratchDuel(core, readers, h);
  if (!handle) return -1;
  const lp: [number, number] = [8000, 8000];
  const log: OcgResponse[] = [];
  const view = scratchView(core, handle, lp, stats);
  try {
    const res = drive(core, handle, {
      lp, stepCap: 150000, stop: () => false,
      respond: (q, decider) => {
        const w = decider === 0 ? w0 : w1;
        setEvalWeights(w);
        let r: OcgResponse | null = null;
        if (q.type === OcgMessageType.SELECT_IDLECMD) { try { r = searcher.search(h, log, q, w); } catch { } }
        if (!r) r = aiDecide(q, buildAiContext(view, decider, 0), "hard") ?? autoPass(q);
        if (r) log.push(r);
        return r;
      },
    });
    return res.winner;
  } finally {
    try { core.destroyDuel(handle); } catch { }
  }
}

const measureDecks = [...pool].sort(() => rng() - 0.5).slice(0, Math.min(pool.length, 6));
console.log(`Measuring learned vs default with search (${MEASURE} games across ${measureDecks.length} sampled decks)…`);
const perDeck = Math.max(2, Math.round(MEASURE / measureDecks.length));
let learnedWins = 0, decisive = 0;
const tM = Date.now();
for (let p = 0; p < measureDecks.length; p++) {
  const d = measureDecks[p]!;
  for (let g = 0; g < perDeck; g++) {
    const learnedIsP0 = g % 2 === 0;
    const w: [readonly number[], readonly number[]] = learnedIsP0 ? [learned, DEFAULT_WEIGHTS] : [DEFAULT_WEIGHTS, learned];
    const winner = playSearchMatch(header(SEED * 7919 + p * 101 + g, d.main, d.extra, d.main, d.extra), w[0], w[1]);
    if (winner < 0) continue;
    decisive++;
    if (winner === (learnedIsP0 ? 0 : 1)) learnedWins++;
  }
}
const winRate = decisive ? (learnedWins / decisive) * 100 : 0;
console.log(`  learned win-rate: ${learnedWins}/${decisive} = ${winRate.toFixed(1)}%  (50% = no improvement), ${Date.now() - tM}ms`);

const ACCEPT = 55;
const outFile = path.join(process.cwd(), "assets", WEIGHTS_REL);
if (winRate >= ACCEPT) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ weights: learned, features: [...FEATURE_NAMES], games: collected, winRateVsDefault: Number(winRate.toFixed(1)), trainedAt: new Date().toISOString() }, null, 2));
  console.log(`✓ Accepted (${winRate.toFixed(1)}% ≥ ${ACCEPT}%) — wrote ${outFile}`);
} else {
  if (existsSync(outFile)) rmSync(outFile);
  console.log(`✗ Rejected (${winRate.toFixed(1)}% < ${ACCEPT}%) — kept hand-tuned defaults; removed any stale weights file. DuelBot uses DEFAULT_WEIGHTS.`);
}
