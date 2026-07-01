// Within-turn forward search for the DuelBot's Main Phase — the layer that lets
// it actually EXECUTE combos instead of greedily taking one action. ocgcore is
// the combo oracle: the search needs zero card-text knowledge, it just tries
// each legal idle action, re-simulates the line to the AI's next decision, and
// scores the resulting board with evaluate(). The best first action is played
// live; the core re-prompts and we re-search, so a multi-step combo emerges as
// a sequence of locally-best, re-evaluated picks.
//
// Because the binding has no duelDuplicate, every candidate is explored by
// rebuilding a scratch duel (on a SEPARATE core) and replaying the recorded
// response log into it (resim.ts). A mandatory replay-fidelity check (the
// scratch's pending idle prompt must match the live one) guards against silent
// divergence; on any mismatch/stall the candidate is abandoned and the live AI
// falls back to its single-decision heuristic.
//
// Hidden information: an own-Main-Phase line is a player-1 perfect-information
// sub-tree UNTIL it provokes a player-0 decision (an opponent quick effect /
// mandatory trigger). At that instant the scratch would resolve the opponent's
// choice via auto-pass over their REAL (clairvoyant) face-downs — untrustworthy
// — so any line that surfaced a player-0 prompt is heavily penalized rather than
// believed. See resim.test.ts for the replay-fidelity gate.

import {
  OcgMessageType, OcgResponseType, OcgLocation, SelectIdleCMDAction,
  type OcgCoreSync, type OcgResponse,
} from "@n1xx1/ocgcore-wasm";
import { aiDecide, evaluate, survivalScore } from "./ai.ts";
import { buildAiContext, cardStats } from "./ai-context.ts";
import { disruptionScenarios, type OpponentModel } from "./opponent-model.ts";
import { buildScratchDuel, replayTo, drive, scratchView, autoPass, type ReplayHeader } from "./resim.ts";
import type { OcgReaders } from "./ocg.ts";

/** Per-decision wall-clock budget (ms). The search returns the best line found
 *  so far the instant this trips; a desktop opponent "thinking" this long is an
 *  acceptable, bounded hitch on the synchronous driver. */
const SEARCH_MS = 120;
/** Max candidate lines scored per decision (pre-ranked so good ones go first). */
const CANDIDATE_CAP = 8;
/** Max engine steps per candidate rollout (kills looping scripts). */
const STEP_CAP = 500;
/** Subtracted when a line forced an opponent decision mid-resolution — the
 *  scratch resolved it by auto-passing over the opponent's real hidden cards, so
 *  the line's value is not trustworthy. Large vs. normal eval spreads, but well
 *  below the win/loss terms so a genuinely lethal line still wins. */
const OPPONENT_PROMPT_PENALTY = 8000;
const WIN_BONUS = 1_000_000;
/** A no-threat opponent model — fallback when a live model isn't attached, so
 *  `disruptionScenarios` yields only the "none" scenario (survivalScore ≡ evaluate). */
const EMPTY_OPP: OpponentModel = { handCount: 0, backrowCount: 0, deckCount: 40, archetype: null, revealed: { negate: 0, removal: 0, handtrap: 0, search: 0 } };
/** Over-extension control (behavioral lever paired with the survival score). The
 *  survival score correctly discounts a fragile board but — because the eval
 *  values a resolved body far above a held card — that discount alone rarely
 *  flips the pick below near-certain disruption. This explicit penalty, growing
 *  QUADRATICALLY in face-up bodies beyond SAFE_BOARD and scaled by oppRisk,
 *  supplies the actual "hold combo pieces back" push. Vanishes at low risk. */
const SAFE_BOARD = 2;
const OVEREXTEND_K = 300;

/** Penalty for committing `committed` face-up monsters into a board-breaker of
 *  likelihood `risk`: 0 up to SAFE_BOARD, then `risk × OVEREXTEND_K × e²` for
 *  `e` bodies beyond it. Exported for testing. */
export function overExtensionPenalty(risk: number, committed: number): number {
  const e = Math.max(0, committed - SAFE_BOARD);
  return risk * OVEREXTEND_K * e * e;
}

export interface IdleSearcher {
  /** Choose a SELECT_IDLECMD response by looking ahead, or null to fall back to
   *  the single-decision heuristic. `liveIdle` is the live SELECT_IDLECMD msg. */
  search(header: ReplayHeader, log: readonly OcgResponse[], liveIdle: any, weights: readonly number[]): OcgResponse | null;
}

interface Candidate {
  resp: OcgResponse;
  /** Sort key: lower = tried earlier (under the budget). */
  rank: number;
}

export function createIdleSearcher(core: OcgCoreSync, readers: OcgReaders): IdleSearcher {
  const stats = (code: number) => cardStats(readers.cardReader(code));
  const A = SelectIdleCMDAction;

  /** Legal idle candidates from the live message, pre-ranked to mirror the
   *  heuristic's priorities (activations/combo pieces first, biggest bodies next,
   *  PASS last) so the most promising lines are scored before the budget trips. */
  function candidates(m: any): Candidate[] {
    const out: Candidate[] = [];
    const idle = (action: number, index: number | null): OcgResponse => ({ type: OcgResponseType.SELECT_IDLECMD, action, index });
    m.activates?.forEach((c: any, i: number) => {
      const fromHand = c.location === OcgLocation.HAND;
      out.push({ resp: idle(A.SELECT_ACTIVATE, i), rank: (fromHand ? 0 : 100) + (stats(c.code)?.atk ?? 9999) / 10000 });
    });
    m.special_summons?.forEach((c: any, i: number) => out.push({ resp: idle(A.SELECT_SPECIAL_SUMMON, i), rank: 200 - (stats(c.code)?.atk ?? 0) / 10000 }));
    m.summons?.forEach((c: any, i: number) => out.push({ resp: idle(A.SELECT_SUMMON, i), rank: 300 - (stats(c.code)?.atk ?? 0) / 10000 }));
    m.monster_sets?.forEach((_c: any, i: number) => out.push({ resp: idle(A.SELECT_MONSTER_SET, i), rank: 400 + i }));
    m.spell_sets?.forEach((_c: any, i: number) => out.push({ resp: idle(A.SELECT_SPELL_SET, i), rank: 500 + i }));
    // PASS: advance the phase (the "stop developing" option must be on the table).
    out.push({ resp: idle(m.to_bp ? A.TO_BP : A.TO_EP, null), rank: 600 });
    return out.sort((a, b) => a.rank - b.rank).slice(0, CANDIDATE_CAP);
  }

  /** True if both idle messages offer the same number of each action kind —
   *  cheap proof the scratch replay reproduced the live position. */
  function sameShape(a: any, b: any): boolean {
    const n = (m: any, k: string) => (m[k]?.length ?? 0);
    return ["activates", "special_summons", "summons", "monster_sets", "spell_sets"].every((k) => n(a, k) === n(b, k)) && !!a.to_bp === !!b.to_bp;
  }

  /** Re-sim one candidate line to the AI's next decision; return its board score
   *  (or null to abandon: replay divergence, stall, or step-cap). */
  function rollout(header: ReplayHeader, log: readonly OcgResponse[], cand: Candidate, liveIdle: any, weights: readonly number[], deadline: number): number | null {
    const handle = buildScratchDuel(core, readers, header);
    if (!handle) return null;
    try {
      const lp: [number, number] = [8000, 8000];
      const rep = replayTo(core, handle, log, 0, lp);
      // Fidelity gate: the replay must have halted at the SAME player-1 idle prompt.
      if (rep.status !== "stopped" || !rep.question || rep.question.type !== OcgMessageType.SELECT_IDLECMD || (rep.question as any).player !== 1 || !sameShape(rep.question, liveIdle)) {
        return null;
      }
      core.duelSetResponse(handle, cand.resp); // commit the candidate
      const view = scratchView(core, handle, lp, stats);
      let sawOpponentPrompt = false;
      const res = drive(core, handle, {
        lp,
        stepCap: STEP_CAP,
        // Quiescence: stop at the AI's NEXT idle/battle decision (or game end).
        stop: (q, decider) => decider === 1 && (q.type === OcgMessageType.SELECT_IDLECMD || q.type === OcgMessageType.SELECT_BATTLECMD),
        respond: (q, decider) => {
          if (decider === 0) sawOpponentPrompt = true;
          return aiDecide(q, buildAiContext(view, decider, 0), "hard") ?? autoPass(q);
        },
      });
      if (res.status === "cap" || res.status === "stalled") return null;
      const ctx = buildAiContext(view, 1, 0);
      // Determinized play-around: score the leaf by how much value SURVIVES the
      // opponent's likely disruption (wipe / removal / negate), sampled from the
      // public opponent model — instead of a raw board score. A wide all-in board
      // scores low (the wipe scenario erases it); a board that keeps combo pieces
      // in hand keeps value (hand isn't disrupted). At zero risk this is just
      // `evaluate`. Skipped for a lethal/loss line (no next turn to survive to).
      let score: number;
      if (res.winner === 1) score = evaluate(ctx.board!, weights) + WIN_BONUS;
      else if (res.winner === 0) score = evaluate(ctx.board!, weights) - WIN_BONUS;
      else {
        // Survival-adjusted value (disruption-type aware) minus an over-extension
        // push so the AI actually holds pieces back against likely disruption.
        const committed = ctx.board!.self.monsters.filter((m) => m.faceUp).length;
        score = survivalScore(ctx.board!, disruptionScenarios(ctx.oppModel ?? EMPTY_OPP), weights) - overExtensionPenalty(ctx.oppRisk ?? 0, committed);
      }
      if (sawOpponentPrompt) score -= OPPONENT_PROMPT_PENALTY; // line resolved over real hidden cards → distrust
      return score;
    } finally {
      try { core.destroyDuel(handle); } catch { /* ignore */ }
      if (Date.now() > deadline) { /* caller checks the budget too */ }
    }
  }

  return {
    search(header, log, liveIdle, weights): OcgResponse | null {
      const cands = candidates(liveIdle);
      if (cands.length <= 1) return null; // trivial — let the heuristic handle it
      const deadline = Date.now() + SEARCH_MS;
      let best: OcgResponse | null = null;
      let bestScore = -Infinity;
      for (const cand of cands) {
        if (Date.now() > deadline) break; // budget tripped → best-so-far
        const score = rollout(header, log, cand, liveIdle, weights, deadline);
        if (score === null) continue;
        if (score > bestScore) { bestScore = score; best = cand.resp; }
      }
      return best; // null → caller falls back to the heuristic
    },
  };
}
