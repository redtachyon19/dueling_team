import {
  OcgProcessResult, OcgMessageType, OcgResponseType, OcgPosition, OcgLocation, OcgDuelMode, OcgQueryFlags,
  SelectIdleCMDAction, SelectBattleCMDAction,
  type OcgCoreSync, type OcgDuelHandle, type OcgMessage, type OcgResponse,
} from "@n1xx1/ocgcore-wasm";
import { aiDecide, features, setEvalWeights, type AiContext, type AiStats } from "./ai.ts";
import { buildAiContext, cardStats, type CoreView } from "./ai-context.ts";
import type { OcgReaders } from "./ocg.ts";

export interface Sample {
  f: number[];
  player: 0 | 1;
  won: number;
}

export interface GameResult {
  winner: number;
  turns: number;
  samples: Sample[];
}

export interface PlayGameOptions {
  seed: bigint;
  deck0: number[];
  deck1: number[];
  weights: [readonly number[], readonly number[]];
  epsilon: number;
  rng: () => number;
  maxSteps?: number;
}

const QUESTION = new Set<number>([
  OcgMessageType.SELECT_BATTLECMD, OcgMessageType.SELECT_IDLECMD, OcgMessageType.SELECT_EFFECTYN,
  OcgMessageType.SELECT_YESNO, OcgMessageType.SELECT_OPTION, OcgMessageType.SELECT_CARD,
  OcgMessageType.SELECT_CHAIN, OcgMessageType.SELECT_PLACE, OcgMessageType.SELECT_POSITION,
  OcgMessageType.SELECT_TRIBUTE, OcgMessageType.SELECT_COUNTER, OcgMessageType.SELECT_SUM,
  OcgMessageType.SELECT_DISFIELD, OcgMessageType.SELECT_UNSELECT_CARD, OcgMessageType.SORT_CARD,
  OcgMessageType.SORT_CHAIN, OcgMessageType.ANNOUNCE_RACE, OcgMessageType.ANNOUNCE_ATTRIB,
  OcgMessageType.ANNOUNCE_CARD, OcgMessageType.ANNOUNCE_NUMBER, OcgMessageType.ROCK_PAPER_SCISSORS,
]);

function autoPass(m: any): OcgResponse | null {
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

function randomAction(m: any, rng: () => number): OcgResponse | null {
  if (m.type === OcgMessageType.SELECT_IDLECMD) {
    const A = SelectIdleCMDAction;
    const opts: { action: number; index: number | null }[] = [];
    m.summons.forEach((_: unknown, i: number) => opts.push({ action: A.SELECT_SUMMON, index: i }));
    m.special_summons.forEach((_: unknown, i: number) => opts.push({ action: A.SELECT_SPECIAL_SUMMON, index: i }));
    m.monster_sets.forEach((_: unknown, i: number) => opts.push({ action: A.SELECT_MONSTER_SET, index: i }));
    m.spell_sets.forEach((_: unknown, i: number) => opts.push({ action: A.SELECT_SPELL_SET, index: i }));
    m.activates.forEach((_: unknown, i: number) => opts.push({ action: A.SELECT_ACTIVATE, index: i }));
    if (m.to_bp) opts.push({ action: A.TO_BP, index: null });
    if (m.to_ep) opts.push({ action: A.TO_EP, index: null });
    if (!opts.length) return null;
    const pick = opts[Math.floor(rng() * opts.length)]!;
    return { type: OcgResponseType.SELECT_IDLECMD, action: pick.action, index: pick.index };
  }
  if (m.type === OcgMessageType.SELECT_BATTLECMD) {
    const B = SelectBattleCMDAction;
    const opts: { action: number; index: number | null }[] = [];
    m.attacks.forEach((_: unknown, i: number) => opts.push({ action: B.SELECT_BATTLE, index: i }));
    if (m.to_m2) opts.push({ action: B.TO_M2, index: null });
    if (m.to_ep) opts.push({ action: B.TO_EP, index: null });
    if (!opts.length) return null;
    const pick = opts[Math.floor(rng() * opts.length)]!;
    return { type: OcgResponseType.SELECT_BATTLECMD, action: pick.action, index: pick.index };
  }
  return null;
}

export function playGame(core: OcgCoreSync, readers: OcgReaders, opts: PlayGameOptions): GameResult {
  const seed4: [bigint, bigint, bigint, bigint] = [opts.seed | 1n, (opts.seed >> 16n) | 1n, (opts.seed >> 32n) | 1n, (opts.seed >> 48n) | 1n];
  const handle = core.createDuel({
    flags: OcgDuelMode.MODE_MR5, seed: seed4,
    team1: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
    team2: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
    cardReader: readers.cardReader, scriptReader: readers.scriptReader, errorHandler: () => {},
  });
  if (!handle) return { winner: -1, turns: 0, samples: [] };
  for (const { name, content } of readers.baseScripts) core.loadScript(handle, name, content);
  for (const code of opts.deck0) core.duelNewCard(handle, { team: 0, duelist: 0, code, controller: 0, location: OcgLocation.DECK, sequence: 1, position: OcgPosition.FACEDOWN_DEFENSE });
  for (const code of opts.deck1) core.duelNewCard(handle, { team: 1, duelist: 0, code, controller: 1, location: OcgLocation.DECK, sequence: 1, position: OcgPosition.FACEDOWN_DEFENSE });
  core.startDuel(handle);

  const lp: [number, number] = [8000, 8000];
  const stats = (code: number): AiStats | null => cardStats(readers.cardReader(code));
  const viewFor = (handleRef: OcgDuelHandle): CoreView => ({
    queryLoc: (player, location) => {
      try {
        return core.duelQueryLocation(handleRef, { flags: QUERY_FLAGS, controller: player as 0 | 1, location }) as (Record<string, unknown> | null)[];
      } catch {
        return [];
      }
    },
    queryCount: (player, location) => core.duelQueryCount(handleRef, player, location),
    lp: (player) => lp[player as 0 | 1],
    stats,
  });
  const view = viewFor(handle);

  const samples: Sample[] = [];
  const attackerAtk: [number, number] = [0, 0];
  let winner = -1, turns = 0, step = 0;
  const cap = opts.maxSteps ?? 200000;

  loop: while (step++ < cap) {
    const status = core.duelProcess(handle);
    const messages = core.duelGetMessage(handle) as OcgMessage[];
    for (const m of messages) {
      const mm = m as any;
      if (m.type === OcgMessageType.NEW_TURN) turns++;
      else if (m.type === OcgMessageType.WIN) { winner = mm.player; break loop; }
      else if (m.type === OcgMessageType.DAMAGE || m.type === OcgMessageType.PAY_LPCOST) lp[mm.player as 0 | 1] = Math.max(0, lp[mm.player as 0 | 1] - mm.amount);
      else if (m.type === OcgMessageType.RECOVER) lp[mm.player as 0 | 1] += mm.amount;
      else if (m.type === OcgMessageType.LPUPDATE) lp[mm.player as 0 | 1] = mm.lp;
    }
    if (status === OcgProcessResult.END) break;
    if (status !== OcgProcessResult.WAITING) continue;

    const q = messages.find((m) => QUESTION.has(m.type)) as any;
    if (!q) break;
    const decider = (q.player ?? 0) as 0 | 1;

    if (q.type === OcgMessageType.SELECT_BATTLECMD) attackerAtk[decider] = 0;

    setEvalWeights(opts.weights[decider]);
    const ctx: AiContext = buildAiContext(view, decider, attackerAtk[decider]);

    if (q.type === OcgMessageType.SELECT_IDLECMD || q.type === OcgMessageType.SELECT_BATTLECMD) {
      samples.push({ f: features(ctx.board!), player: decider, won: 0 });
    }

    const explore = (q.type === OcgMessageType.SELECT_IDLECMD || q.type === OcgMessageType.SELECT_BATTLECMD) && opts.rng() < opts.epsilon;
    const resp = (explore ? randomAction(q, opts.rng) : null) ?? aiDecide(q, ctx, "hard") ?? autoPass(q);
    if (!resp) break;

    if (q.type === OcgMessageType.SELECT_BATTLECMD && resp.type === OcgResponseType.SELECT_BATTLECMD && resp.action === SelectBattleCMDAction.SELECT_BATTLE && resp.index != null) {
      attackerAtk[decider] = stats(q.attacks[resp.index]?.code)?.atk ?? 0;
    }
    core.duelSetResponse(handle, resp);
  }

  core.destroyDuel(handle);
  if (winner === 0 || winner === 1) for (const s of samples) s.won = s.player === winner ? 1 : 0;
  return { winner, turns, samples: winner === 0 || winner === 1 ? samples : [] };
}

const QUERY_FLAGS = (OcgQueryFlags.CODE | OcgQueryFlags.POSITION | OcgQueryFlags.ATTACK | OcgQueryFlags.DEFENSE | OcgQueryFlags.LEVEL) as unknown as OcgQueryFlags;
