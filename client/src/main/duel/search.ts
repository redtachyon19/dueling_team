import {
  OcgMessageType, OcgResponseType, OcgLocation, SelectIdleCMDAction,
  type OcgCoreSync, type OcgResponse,
} from "@n1xx1/ocgcore-wasm";
import { aiDecide, evaluate, survivalScore } from "./ai.ts";
import { buildAiContext, cardStats } from "./ai-context.ts";
import { disruptionScenarios, type OpponentModel } from "./opponent-model.ts";
import { buildScratchDuel, replayTo, drive, scratchView, autoPass, type ReplayHeader } from "./resim.ts";
import type { OcgReaders } from "./ocg.ts";

const SEARCH_MS = 120;
const CANDIDATE_CAP = 8;
const STEP_CAP = 500;
const OPPONENT_PROMPT_PENALTY = 8000;
const WIN_BONUS = 1_000_000;
const EMPTY_OPP: OpponentModel = { handCount: 0, backrowCount: 0, deckCount: 40, archetype: null, revealed: { negate: 0, removal: 0, handtrap: 0, search: 0 } };
const SAFE_BOARD = 2;
const OVEREXTEND_K = 300;

export function overExtensionPenalty(risk: number, committed: number): number {
  const e = Math.max(0, committed - SAFE_BOARD);
  return risk * OVEREXTEND_K * e * e;
}

export interface IdleSearcher {
  search(header: ReplayHeader, log: readonly OcgResponse[], liveIdle: any, weights: readonly number[]): OcgResponse | null;
}

interface Candidate {
  resp: OcgResponse;
  rank: number;
}

export function createIdleSearcher(core: OcgCoreSync, readers: OcgReaders): IdleSearcher {
  const stats = (code: number) => cardStats(readers.cardReader(code));
  const A = SelectIdleCMDAction;

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
    out.push({ resp: idle(m.to_bp ? A.TO_BP : A.TO_EP, null), rank: 600 });
    return out.sort((a, b) => a.rank - b.rank).slice(0, CANDIDATE_CAP);
  }

  function sameShape(a: any, b: any): boolean {
    const n = (m: any, k: string) => (m[k]?.length ?? 0);
    return ["activates", "special_summons", "summons", "monster_sets", "spell_sets"].every((k) => n(a, k) === n(b, k)) && !!a.to_bp === !!b.to_bp;
  }

  function rollout(header: ReplayHeader, log: readonly OcgResponse[], cand: Candidate, liveIdle: any, weights: readonly number[], deadline: number): number | null {
    const handle = buildScratchDuel(core, readers, header);
    if (!handle) return null;
    try {
      const lp: [number, number] = [8000, 8000];
      const rep = replayTo(core, handle, log, 0, lp);
      if (rep.status !== "stopped" || !rep.question || rep.question.type !== OcgMessageType.SELECT_IDLECMD || (rep.question as any).player !== 1 || !sameShape(rep.question, liveIdle)) {
        return null;
      }
      core.duelSetResponse(handle, cand.resp);
      const view = scratchView(core, handle, lp, stats);
      let sawOpponentPrompt = false;
      const res = drive(core, handle, {
        lp,
        stepCap: STEP_CAP,
        stop: (q, decider) => decider === 1 && (q.type === OcgMessageType.SELECT_IDLECMD || q.type === OcgMessageType.SELECT_BATTLECMD),
        respond: (q, decider) => {
          if (decider === 0) sawOpponentPrompt = true;
          return aiDecide(q, buildAiContext(view, decider, 0), "hard") ?? autoPass(q);
        },
      });
      if (res.status === "cap" || res.status === "stalled") return null;
      const ctx = buildAiContext(view, 1, 0);
      let score: number;
      if (res.winner === 1) score = evaluate(ctx.board!, weights) + WIN_BONUS;
      else if (res.winner === 0) score = evaluate(ctx.board!, weights) - WIN_BONUS;
      else {
        const committed = ctx.board!.self.monsters.filter((m) => m.faceUp).length;
        score = survivalScore(ctx.board!, disruptionScenarios(ctx.oppModel ?? EMPTY_OPP), weights) - overExtensionPenalty(ctx.oppRisk ?? 0, committed);
      }
      if (sawOpponentPrompt) score -= OPPONENT_PROMPT_PENALTY;
      return score;
    } finally {
      try { core.destroyDuel(handle); } catch { }
      if (Date.now() > deadline) { }
    }
  }

  return {
    search(header, log, liveIdle, weights): OcgResponse | null {
      const cands = candidates(liveIdle);
      if (cands.length <= 1) return null;
      const deadline = Date.now() + SEARCH_MS;
      let best: OcgResponse | null = null;
      let bestScore = -Infinity;
      for (const cand of cands) {
        if (Date.now() > deadline) break;
        const score = rollout(header, log, cand, liveIdle, weights, deadline);
        if (score === null) continue;
        if (score > bestScore) { bestScore = score; best = cand.resp; }
      }
      return best;
    },
  };
}
