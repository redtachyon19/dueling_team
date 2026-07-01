// Re-simulation primitives for the AI's forward search. Because the ocgcore
// binding exposes no duelDuplicate/snapshot, the only way to explore "what if I
// take this action" is to rebuild the duel from scratch and replay the exact
// response log into it. ocgcore is deterministic given (seed, deck order,
// response sequence), so a faithful replay reproduces the live position bit-for-
// bit — which the resim.test.ts fidelity gate proves before any search output
// is trusted.
//
// `drive()` is the one generic process/message/response loop, parameterized by a
// `respond` policy and a `stop` predicate, so the same code serves: replaying a
// recorded log (respond = pop the log), rolling a candidate line to quiescence
// (respond = aiDecide/autoPass, stop at the AI's next decision), and the fidelity
// test. The QUESTION set / autoPass here intentionally mirror session.ts and
// self-play.ts (kept local to avoid coupling the search to the live session).

import {
  OcgProcessResult, OcgMessageType, OcgResponseType, OcgPosition, OcgLocation, OcgQueryFlags,
  SelectIdleCMDAction, SelectBattleCMDAction,
  type OcgCoreSync, type OcgDuelHandle, type OcgMessage, type OcgResponse,
} from "@n1xx1/ocgcore-wasm";
import type { OcgReaders } from "./ocg.ts";
import type { AiStats } from "./ai.ts";
import type { CoreView } from "./ai-context.ts";

// Re-export the enum VALUES so build-time scripts at the repo root can use them
// without a bare `@n1xx1/ocgcore-wasm` import (which only resolves from client/).
export { OcgDuelMode, OcgLocation, OcgPosition, OcgMessageType, OcgProcessResult, OcgResponseType } from "@n1xx1/ocgcore-wasm";

/** Everything needed to deterministically rebuild a duel: the RNG seed, the
 *  rules mode, and the EXACT post-shuffle deck arrays passed to addDeck (the
 *  cards load with sequence=1, bypassing the core's insert-shuffle, so the seed
 *  alone is NOT enough to reproduce the order). */
export interface ReplayHeader {
  seed4: [bigint, bigint, bigint, bigint];
  /** Rules-mode mask (the OcgDuelMode.MODE_* constants are typed `bigint`). */
  mode: bigint;
  p0Main: number[];
  p0Extra: number[];
  p1Main: number[];
  p1Extra: number[];
}

export const QUESTION = new Set<number>([
  OcgMessageType.SELECT_BATTLECMD, OcgMessageType.SELECT_IDLECMD, OcgMessageType.SELECT_EFFECTYN,
  OcgMessageType.SELECT_YESNO, OcgMessageType.SELECT_OPTION, OcgMessageType.SELECT_CARD,
  OcgMessageType.SELECT_CHAIN, OcgMessageType.SELECT_PLACE, OcgMessageType.SELECT_POSITION,
  OcgMessageType.SELECT_TRIBUTE, OcgMessageType.SELECT_COUNTER, OcgMessageType.SELECT_SUM,
  OcgMessageType.SELECT_DISFIELD, OcgMessageType.SELECT_UNSELECT_CARD, OcgMessageType.SORT_CARD,
  OcgMessageType.SORT_CHAIN, OcgMessageType.ANNOUNCE_RACE, OcgMessageType.ANNOUNCE_ATTRIB,
  OcgMessageType.ANNOUNCE_CARD, OcgMessageType.ANNOUNCE_NUMBER, OcgMessageType.ROCK_PAPER_SCISSORS,
]);

export const QUERY_FLAGS = (OcgQueryFlags.CODE | OcgQueryFlags.POSITION | OcgQueryFlags.ATTACK | OcgQueryFlags.DEFENSE | OcgQueryFlags.LEVEL) as unknown as OcgQueryFlags;

/** Safe default for any prompt a policy declines (mirrors session.autoPass). */
export function autoPass(m: any): OcgResponse | null {
  switch (m.type) {
    case OcgMessageType.SELECT_IDLECMD: return { type: OcgResponseType.SELECT_IDLECMD, action: m.to_ep ? SelectIdleCMDAction.TO_EP : SelectIdleCMDAction.TO_BP, index: null };
    case OcgMessageType.SELECT_BATTLECMD: return { type: OcgResponseType.SELECT_BATTLECMD, action: m.to_ep ? SelectBattleCMDAction.TO_EP : SelectBattleCMDAction.TO_M2, index: null };
    case OcgMessageType.SELECT_CHAIN: return { type: OcgResponseType.SELECT_CHAIN, index: m.forced ? 0 : null };
    case OcgMessageType.SELECT_EFFECTYN: return { type: OcgResponseType.SELECT_EFFECTYN, yes: false };
    case OcgMessageType.SELECT_YESNO: return { type: OcgResponseType.SELECT_YESNO, yes: false };
    case OcgMessageType.SELECT_OPTION: return { type: OcgResponseType.SELECT_OPTION, index: 0 };
    case OcgMessageType.SELECT_POSITION: return { type: OcgResponseType.SELECT_POSITION, position: OcgPosition.FACEUP_ATTACK };
    case OcgMessageType.SELECT_PLACE: case OcgMessageType.SELECT_DISFIELD: {
      const t = m.type === OcgMessageType.SELECT_PLACE ? OcgResponseType.SELECT_PLACE : OcgResponseType.SELECT_DISFIELD;
      for (let s = 0; s < 7; s++) if ((m.field_mask & (1 << s)) === 0) return { type: t, places: [{ player: m.player, location: OcgLocation.MZONE, sequence: s }] } as OcgResponse;
      for (let s = 0; s < 5; s++) if ((m.field_mask & (1 << (8 + s))) === 0) return { type: t, places: [{ player: m.player, location: OcgLocation.SZONE, sequence: s }] } as OcgResponse;
      return { type: t, places: [] } as OcgResponse;
    }
    case OcgMessageType.SELECT_CARD: { const min = m.min ?? 1; return { type: OcgResponseType.SELECT_CARD, indicies: Array.from({ length: Math.max(1, min) }, (_, i) => i) }; }
    case OcgMessageType.SELECT_TRIBUTE: { const min = m.min ?? 1; return { type: OcgResponseType.SELECT_TRIBUTE, indicies: Array.from({ length: Math.max(1, min) }, (_, i) => i) }; }
    case OcgMessageType.SELECT_SUM: { const min = m.min ?? 1; return { type: OcgResponseType.SELECT_SUM, indicies: Array.from({ length: Math.max(1, min) }, (_, i) => i) }; }
    case OcgMessageType.SELECT_UNSELECT_CARD: return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: (m.select_cards?.length ?? 0) > 0 ? 0 : null };
    case OcgMessageType.SELECT_COUNTER: { let need = m.count; const counters = m.cards.map((c: any) => { const take = Math.min(need, c.count); need -= take; return take; }); return { type: OcgResponseType.SELECT_COUNTER, counters }; }
    case OcgMessageType.SORT_CARD: case OcgMessageType.SORT_CHAIN: return { type: OcgResponseType.SORT_CARD, order: null };
    default: return null;
  }
}

/** Build a fresh scratch duel from a header: createDuel + base scripts + decks
 *  in the recorded order + startDuel. Returns null if the core rejects it. */
export function buildScratchDuel(core: OcgCoreSync, readers: OcgReaders, h: ReplayHeader): OcgDuelHandle | null {
  const handle = core.createDuel({
    flags: h.mode, seed: h.seed4,
    team1: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
    team2: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
    cardReader: readers.cardReader, scriptReader: readers.scriptReader, errorHandler: () => {},
  });
  if (!handle) return null;
  for (const { name, content } of readers.baseScripts) core.loadScript(handle, name, content);
  const add = (team: 0 | 1, main: number[], extra: number[]) => {
    for (const code of main) core.duelNewCard(handle, { team, duelist: 0, code, controller: team, location: OcgLocation.DECK, sequence: 1, position: OcgPosition.FACEDOWN_DEFENSE });
    for (const code of extra) core.duelNewCard(handle, { team, duelist: 0, code, controller: team, location: OcgLocation.EXTRA, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
  };
  add(0, h.p0Main, h.p0Extra);
  add(1, h.p1Main, h.p1Extra);
  core.startDuel(handle);
  return handle;
}

export interface DriveResult {
  /** 0/1 if a WIN/END decided the duel during this drive, else -1. */
  winner: number;
  /** The question the `stop` predicate halted on (the decision point), if any. */
  question: OcgMessage | null;
  /** Why the loop ended. */
  status: "stopped" | "ended" | "stalled" | "cap";
}

export interface DriveOptions {
  /** Mutable [p0,p1] life points, updated from damage/recover/lpupdate messages. */
  lp: [number, number];
  /** Produce a response for a pending question (decider = q.player). */
  respond: (q: any, decider: 0 | 1) => OcgResponse | null;
  /** Halt (status "stopped") before responding when this returns true. */
  stop?: (q: any, decider: 0 | 1) => boolean;
  /** Max engine steps before bailing (status "cap"). */
  stepCap?: number;
}

/** The single process/message/response loop, shared by replay, candidate
 *  rollout, and the fidelity test. */
export function drive(core: OcgCoreSync, handle: OcgDuelHandle, opts: DriveOptions): DriveResult {
  const cap = opts.stepCap ?? 100000;
  let step = 0;
  while (step++ < cap) {
    const status = core.duelProcess(handle);
    const messages = core.duelGetMessage(handle) as OcgMessage[];
    for (const m of messages) {
      const mm = m as any;
      if (m.type === OcgMessageType.WIN) return { winner: mm.player as number, question: null, status: "ended" };
      if (m.type === OcgMessageType.DAMAGE || m.type === OcgMessageType.PAY_LPCOST) opts.lp[mm.player as 0 | 1] = Math.max(0, opts.lp[mm.player as 0 | 1] - mm.amount);
      else if (m.type === OcgMessageType.RECOVER) opts.lp[mm.player as 0 | 1] += mm.amount;
      else if (m.type === OcgMessageType.LPUPDATE) opts.lp[mm.player as 0 | 1] = mm.lp;
    }
    if (status === OcgProcessResult.END) return { winner: -1, question: null, status: "ended" };
    if (status !== OcgProcessResult.WAITING) continue; // CONTINUE → loop
    const q = messages.find((m) => QUESTION.has(m.type)) as any;
    if (!q) return { winner: -1, question: null, status: "stalled" };
    const decider = (q.player ?? 0) as 0 | 1;
    if (opts.stop?.(q, decider)) return { winner: -1, question: q, status: "stopped" };
    const r = opts.respond(q, decider);
    if (!r) return { winner: -1, question: q, status: "stalled" };
    core.duelSetResponse(handle, r);
  }
  return { winner: -1, question: null, status: "cap" };
}

/** Replay a recorded response log into a freshly built scratch duel, halting at
 *  the first decision the log does NOT answer — i.e. the live decision point.
 *  Returns the pending question there (or a non-"stopped" status on divergence). */
export function replayTo(core: OcgCoreSync, handle: OcgDuelHandle, log: readonly OcgResponse[], fromIdx: number, lp: [number, number]): DriveResult {
  let i = fromIdx;
  return drive(core, handle, {
    lp,
    stop: () => i >= log.length, // out of recorded answers → this is "now"
    respond: () => log[i++] ?? null,
  });
}

/** Build a CoreView over a scratch duel for buildAiContext/evaluate. */
export function scratchView(core: OcgCoreSync, handle: OcgDuelHandle, lp: [number, number], stats: (code: number) => AiStats | null): CoreView {
  return {
    queryLoc: (player, location) => {
      try {
        return core.duelQueryLocation(handle, { flags: QUERY_FLAGS, controller: player as 0 | 1, location }) as (Record<string, unknown> | null)[];
      } catch {
        return [];
      }
    },
    queryCount: (player, location) => core.duelQueryCount(handle, player, location),
    lp: (player) => lp[player as 0 | 1],
    stats,
  };
}
