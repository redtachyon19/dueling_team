// Reproducible verification for the DuelBot forward search. MANUAL/build-time.
//
//   1. REPLAY FIDELITY (the safety gate): a full game's response log, replayed
//      into a fresh duel, must reproduce the exact final state. If this ever
//      fails, the search is scoring lines against a fabricated position — do not
//      trust its output.
//   2. SEARCH vs HEURISTIC head-to-head: player 1 plans idle decisions with the
//      re-sim search; player 0 uses the single-decision heuristic. Same deck both
//      seats, seats swapped across games to cancel first-player bias. Reports
//      win-rate, DuelBot activation counts, per-decision latency, completion.
//
// Pass your own deck to measure on a real combo deck:
//   pnpm verify:search path/to/deck.ydk [games=60]
// Otherwise a built-in Pot-of-Greed + vanilla deck is used (mechanism check only;
// a vanilla deck has no real combos, so expect a ~50% win-rate there).

import { readFileSync } from "node:fs";
import type { OcgMessage, OcgResponse } from "@n1xx1/ocgcore-wasm";
import { getCore, getSearchCore, buildReaders } from "../client/src/main/duel/ocg.ts";
import { buildScratchDuel, drive, replayTo, scratchView, autoPass, QUESTION, OcgDuelMode, OcgLocation, OcgMessageType, OcgProcessResult, OcgResponseType, type ReplayHeader } from "../client/src/main/duel/resim.ts";
import { aiDecide, getEvalWeights } from "../client/src/main/duel/ai.ts";
import { buildAiContext, cardStats } from "../client/src/main/duel/ai-context.ts";
import { loadCardRoles } from "../client/src/main/duel/card-roles.ts";
import { createIdleSearcher } from "../client/src/main/duel/search.ts";

const DECK_PATH = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null;
const GAMES = Number(process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a)) ?? 60);

const core = await getCore();
const searchCore = await getSearchCore();
const readers = buildReaders([process.cwd()]);
const roles = loadCardRoles([process.cwd()]);
console.log(`card roles loaded: ${roles.count} (${roles.source})`);
const has = (c: number) => !!readers.cardReader(c);
const stats = (c: number) => cardStats(readers.cardReader(c));
const isExtra = (c: number) => { const t = readers.cardReader(c)?.type ?? 0; return (t & (0x40 /*FUSION*/ | 0x2000 /*SYNCHRO*/ | 0x800000 /*XYZ*/ | 0x4000000 /*LINK*/)) !== 0; };

function parseYdk(path: string): { main: number[]; extra: number[] } {
  const main: number[] = [], extra: number[] = [];
  let section: "main" | "extra" | "side" = "main";
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#main")) { section = "main"; continue; }
    if (line.startsWith("#extra")) { section = "extra"; continue; }
    if (line.startsWith("!side")) { section = "side"; continue; }
    if (line.startsWith("#") || !/^\d+$/.test(line)) continue;
    const code = Number(line);
    if (section === "main") main.push(code); else if (section === "extra") extra.push(code);
  }
  return { main, extra };
}

let main: number[], extra: number[];
if (DECK_PATH) {
  const d = parseYdk(DECK_PATH);
  main = d.main.filter(has); extra = d.extra.filter(has);
  console.log(`Deck ${DECK_PATH}: ${main.length} main (${d.main.length - main.length} unsupported), ${extra.length} extra`);
} else {
  const POT = 55144522;
  const vanillas = [4148264, 14575467, 18108166, 24639891, 43096270, 47226949].filter(has);
  main = []; for (let i = 0; i < 3 && has(POT); i++) main.push(POT);
  while (main.length < 40) main.push(vanillas[main.length % vanillas.length]!);
  extra = [];
  console.log("Deck: built-in Pot-of-Greed + vanilla (mechanism check; no real combos)");
}
// Split any Extra-Deck cards that leaked into main (ydk lists them separately, but be safe).
const mainDeck = main.filter((c) => !isExtra(c));
const extraDeck = [...extra, ...main.filter(isExtra)].filter(isExtra);
const header = (seed: bigint): ReplayHeader => ({ seed4: [seed | 1n, (seed >> 16n) | 1n, (seed >> 32n) | 1n, (seed >> 48n) | 1n], mode: OcgDuelMode.MODE_MR5, p0Main: mainDeck, p0Extra: extraDeck, p1Main: mainDeck, p1Extra: extraDeck });

// --- 1) replay fidelity ------------------------------------------------------
const LOCS = [OcgLocation.HAND, OcgLocation.MZONE, OcgLocation.SZONE, OcgLocation.GRAVE, OcgLocation.REMOVED, OcgLocation.EXTRA, OcgLocation.DECK];
const sig = (h: any) => [0, 1].flatMap((p) => LOCS.map((l) => core.duelQueryCount(h, p, l))).join(",");
{
  const hdr = header(424242n);
  const h1 = buildScratchDuel(core, readers, hdr)!;
  const lp1: [number, number] = [8000, 8000]; const log: OcgResponse[] = [];
  const v1 = scratchView(core, h1, lp1, stats);
  drive(core, h1, { lp: lp1, stepCap: 100000, stop: () => false, respond: (q, d) => { const r = aiDecide(q, buildAiContext(v1, d, 0), "hard") ?? autoPass(q); if (r) log.push(r); return r; } });
  const sig1 = sig(h1); core.destroyDuel(h1);
  const h2 = buildScratchDuel(core, readers, hdr)!;
  const lp2: [number, number] = [8000, 8000]; replayTo(core, h2, log, 0, lp2);
  const sig2 = sig(h2); core.destroyDuel(h2);
  const ok = sig1 === sig2 && lp1[0] === lp2[0] && lp1[1] === lp2[1];
  console.log(`\n[1] REPLAY FIDELITY: ${ok ? "PASS" : "FAIL"} (log=${log.length})`);
  if (!ok) { console.log("  live:", sig1, "\n  replay:", sig2); process.exit(1); }
}

// --- 2) search vs heuristic --------------------------------------------------
const searcher = createIdleSearcher(searchCore, readers);
function play(seed: bigint, searchSeat: 0 | 1): { winner: number; calls: number; nulls: number; activates: number; totalMs: number; maxMs: number; completed: boolean } {
  const hdr = header(seed);
  const h = buildScratchDuel(core, readers, hdr)!;
  const lp: [number, number] = [8000, 8000]; const log: OcgResponse[] = [];
  const view = scratchView(core, h, lp, stats);
  let step = 0, winner = -1, calls = 0, nulls = 0, activates = 0, totalMs = 0, maxMs = 0;
  while (step++ < 100000) {
    const status = core.duelProcess(h);
    const msgs = core.duelGetMessage(h) as OcgMessage[];
    for (const m of msgs) { const mm = m as any; if (m.type === OcgMessageType.WIN) winner = mm.player; else if (m.type === OcgMessageType.DAMAGE || m.type === OcgMessageType.PAY_LPCOST) lp[mm.player as 0 | 1] = Math.max(0, lp[mm.player as 0 | 1] - mm.amount); else if (m.type === OcgMessageType.RECOVER) lp[mm.player as 0 | 1] += mm.amount; else if (m.type === OcgMessageType.LPUPDATE) lp[mm.player as 0 | 1] = mm.lp; }
    if (winner >= 0 || status === OcgProcessResult.END) break;
    if (status !== OcgProcessResult.WAITING) continue;
    const q = msgs.find((m) => QUESTION.has(m.type)) as any;
    if (!q) break;
    const decider = (q.player ?? 0) as 0 | 1;
    let resp: OcgResponse | null = null;
    if (decider === searchSeat && q.type === OcgMessageType.SELECT_IDLECMD) {
      const t = Date.now(); resp = searcher.search(hdr, log, q, getEvalWeights()); const dt = Date.now() - t;
      totalMs += dt; maxMs = Math.max(maxMs, dt); calls++; if (!resp) nulls++;
    }
    if (!resp) resp = aiDecide(q, buildAiContext(view, decider, 0), "hard") ?? autoPass(q);
    if (!resp) break;
    if (decider === searchSeat && q.type === OcgMessageType.SELECT_IDLECMD && (resp as any).action === 5) activates++;
    log.push(resp); core.duelSetResponse(h, resp);
  }
  core.destroyDuel(h);
  return { winner, calls, nulls, activates, totalMs, maxMs, completed: winner >= 0 || step < 100000 };
}

let searchWins = 0, decisive = 0, totalCalls = 0, totalNulls = 0, totalAct = 0, sumMs = 0, maxMs = 0, completed = 0;
for (let i = 0; i < GAMES; i++) {
  const searchSeat: 0 | 1 = i % 2 === 0 ? 1 : 0; // swap seats
  const r = play(BigInt(31337 * i + 11), searchSeat);
  totalCalls += r.calls; totalNulls += r.nulls; totalAct += r.activates; sumMs += r.totalMs; maxMs = Math.max(maxMs, r.maxMs); if (r.completed) completed++;
  if (r.winner < 0) continue;
  decisive++; if (r.winner === searchSeat) searchWins++;
}
console.log(`[2] SEARCH vs HEURISTIC over ${GAMES} games (${completed} completed):`);
console.log(`    search-AI win-rate: ${searchWins}/${decisive} = ${decisive ? (100 * searchWins / decisive).toFixed(1) : "—"}%  (50% = no edge)`);
console.log(`    search idle-decisions: ${totalCalls} (${totalNulls} fell back to heuristic), DuelBot activations: ${totalAct}`);
console.log(`    latency/idle-decision: avg=${(sumMs / Math.max(1, totalCalls)).toFixed(1)}ms max=${maxMs}ms`);
