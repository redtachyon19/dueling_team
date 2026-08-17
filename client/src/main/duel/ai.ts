import {
  OcgMessageType,
  OcgResponseType,
  OcgPosition,
  OcgLocation,
  SelectIdleCMDAction,
  SelectBattleCMDAction,
  type OcgMessage,
  type OcgResponse,
} from "@n1xx1/ocgcore-wasm";
import type { DisruptionEffect, DisruptionScenario, OpponentModel } from "./opponent-model.ts";

export interface AiStats {
  atk: number;
  def: number;
  level: number;
  isMonster: boolean;
  isEffect: boolean;
  isExtra: boolean;
  isDisruption: boolean;
  setcodes: number[];
}

export type AiDifficulty = "easy" | "normal" | "hard";

export interface AiMonster {
  atk: number;
  def: number;
  faceUp: boolean;
  defense: boolean;
  isEffect?: boolean;
  isExtra?: boolean;
  isDisruption?: boolean;
  setcodes?: number[];
}

export interface AiSide {
  lp: number;
  handCount: number;
  monsters: AiMonster[];
  backrowCount: number;
  handInteraction: number;
}

export interface AiBoard {
  self: AiSide;
  opp: AiSide;
}

export interface AiContext {
  stats: (code: number) => AiStats | null;
  oppMonsterValues: number[];
  oppFaceDownMonsters: number;
  attackerAtk: number;
  ownMonsterAtks: number[];
  board?: AiBoard;
  oppRisk?: number;
  oppModel?: OpponentModel;
}

export type AiPosture = "aggressive" | "neutral" | "defensive";

const UNKNOWN_MONSTER_VALUE = 1000;

function battleValue(m: AiMonster): number {
  if (!m.faceUp) return UNKNOWN_MONSTER_VALUE;
  return m.defense ? m.def : m.atk;
}

function boardPower(s: AiSide): number {
  return s.monsters.reduce((t, m) => t + battleValue(m), 0);
}

export const FEATURE_NAMES = ["lp", "cards", "power", "bodies", "hand", "topMonster", "backrow", "effMonsters", "extraMonsters", "disruption", "handInteraction", "cohesion"] as const;
export const DEFAULT_WEIGHTS: readonly number[] = [20, 120, 400, 80, 0, 0, 0, 120, 120, 250, 60, 50];

function topThreat(s: AiSide): number {
  return s.monsters.reduce((mx, m) => Math.max(mx, battleValue(m)), 0);
}

function countMonsters(s: AiSide, pred: (m: AiMonster) => boolean): number {
  return s.monsters.reduce((n, m) => n + (m.faceUp && pred(m) ? 1 : 0), 0);
}

function cohesion(s: AiSide): number {
  const counts = new Map<number, number>();
  for (const m of s.monsters) {
    if (!m.faceUp) continue;
    for (const sc of m.setcodes ?? []) { if (sc) counts.set(sc, (counts.get(sc) ?? 0) + 1); }
  }
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return Math.max(0, max - 1);
}

export function features(b: AiBoard): number[] {
  const selfCards = b.self.handCount + b.self.monsters.length + b.self.backrowCount;
  const oppCards = b.opp.handCount + b.opp.monsters.length + b.opp.backrowCount;
  return [
    (b.self.lp - b.opp.lp) / 1000,
    selfCards - oppCards,
    (boardPower(b.self) - boardPower(b.opp)) / 1000,
    b.self.monsters.length - b.opp.monsters.length,
    b.self.handCount - b.opp.handCount,
    (topThreat(b.self) - topThreat(b.opp)) / 1000,
    b.self.backrowCount - b.opp.backrowCount,
    countMonsters(b.self, (m) => !!m.isEffect) - countMonsters(b.opp, (m) => !!m.isEffect),
    countMonsters(b.self, (m) => !!m.isExtra) - countMonsters(b.opp, (m) => !!m.isExtra),
    countMonsters(b.self, (m) => !!m.isDisruption) - countMonsters(b.opp, (m) => !!m.isDisruption),
    b.self.handInteraction - b.opp.handInteraction,
    cohesion(b.self) - cohesion(b.opp),
  ];
}

let currentWeights: number[] = DEFAULT_WEIGHTS.slice();

export function setEvalWeights(w: readonly number[]): void {
  if (w.length === DEFAULT_WEIGHTS.length && w.every((x) => Number.isFinite(x))) currentWeights = w.slice();
}

export function getEvalWeights(): number[] {
  return currentWeights.slice();
}

export function evaluate(b: AiBoard, weights: readonly number[] = currentWeights): number {
  const f = features(b);
  let score = 0;
  for (let i = 0; i < f.length; i++) score += f[i]! * (weights[i] ?? 0);
  return score;
}

export function applyDisruptionToSelf(b: AiBoard, effect: DisruptionEffect): AiBoard {
  if (effect.kind === "none") return b;
  const monsters = b.self.monsters.map((m) => ({ ...m }));
  const faceUpIdx = monsters.map((m, i) => (m.faceUp ? i : -1)).filter((i) => i >= 0);
  if (effect.kind === "wipe") {
    return { self: { ...b.self, monsters: monsters.filter((m) => !m.faceUp) }, opp: b.opp };
  }
  if (effect.kind === "removeBest") {
    const remove = new Set(faceUpIdx.slice().sort((a, c) => battleValue(monsters[c]!) - battleValue(monsters[a]!)).slice(0, Math.max(1, effect.n)));
    return { self: { ...b.self, monsters: monsters.filter((_m, i) => !remove.has(i)) }, opp: b.opp };
  }
  const pool = faceUpIdx.filter((i) => monsters[i]!.isDisruption);
  const target = (pool.length ? pool : faceUpIdx).slice().sort((a, c) => battleValue(monsters[c]!) - battleValue(monsters[a]!))[0];
  if (target != null) { monsters[target]!.isDisruption = false; monsters[target]!.isEffect = false; }
  return { self: { ...b.self, monsters }, opp: b.opp };
}

export function survivalScore(b: AiBoard, scenarios: DisruptionScenario[], weights: readonly number[] = currentWeights): number {
  let acc = 0, ptot = 0;
  for (const s of scenarios) {
    if (s.p <= 0) continue;
    acc += s.p * evaluate(applyDisruptionToSelf(b, s.effect), weights);
    ptot += s.p;
  }
  return ptot > 0 ? acc / ptot : evaluate(b, weights);
}

export function posture(b: AiBoard | undefined): AiPosture {
  if (!b) return "neutral";
  const e = evaluate(b);
  if (e > 350) return "aggressive";
  if (e < -350) return "defensive";
  return "neutral";
}

export function aiDecide(m: OcgMessage, ctx: AiContext, difficulty: AiDifficulty = "normal"): OcgResponse | null {
  switch (m.type) {
    case OcgMessageType.SELECT_IDLECMD:
      return idleCommand(m, ctx, difficulty);
    case OcgMessageType.SELECT_BATTLECMD:
      return battleCommand(m, ctx, difficulty);
    case OcgMessageType.SELECT_CARD:
      return attackTarget(m, ctx);
    case OcgMessageType.SELECT_SUM:
      return selectSum(m);
    case OcgMessageType.SELECT_POSITION:
      return summonPosition(m, ctx, difficulty);
    case OcgMessageType.SELECT_CHAIN:
      return chainResponse(m, ctx, difficulty);
    case OcgMessageType.SELECT_EFFECTYN:
      return effectYesNo(m, difficulty);
    default:
      return null;
  }
}

function chainResponse(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_CHAIN }>, ctx: AiContext, diff: AiDifficulty): OcgResponse {
  const pass = { type: OcgResponseType.SELECT_CHAIN, index: null } as const;
  const fire = { type: OcgResponseType.SELECT_CHAIN, index: 0 } as const;
  if (m.forced) return fire;
  if (diff === "easy" || (m.selects?.length ?? 0) === 0) return pass;
  if (!ctx.board) return fire;
  const THREAT = 1900;
  const behind = posture(ctx.board) === "defensive";
  if (behind || topThreat(ctx.board.opp) >= THREAT) return fire;
  return pass;
}

function effectYesNo(_m: Extract<OcgMessage, { type: OcgMessageType.SELECT_EFFECTYN }>, diff: AiDifficulty): OcgResponse {
  return { type: OcgResponseType.SELECT_EFFECTYN, yes: diff !== "easy" };
}

function bestByAtk(cards: { code: number }[], ctx: AiContext): number {
  let best = -1;
  let bestAtk = -Infinity;
  cards.forEach((c, i) => {
    const a = ctx.stats(c.code)?.atk ?? -1;
    if (a > bestAtk) { bestAtk = a; best = i; }
  });
  return best;
}

function idleCommand(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_IDLECMD }>, ctx: AiContext, diff: AiDifficulty): OcgResponse {
  const A = SelectIdleCMDAction;
  const stance = posture(ctx.board);
  if (diff !== "easy" && m.activates.length) {
    const pick = m.activates
      .map((c, i) => ({ i, fromHand: c.location === OcgLocation.HAND, atk: ctx.stats(c.code)?.atk ?? Infinity }))
      .sort((a, b) => Number(b.fromHand) - Number(a.fromHand) || a.atk - b.atk)[0]!;
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_ACTIVATE, index: pick.i };
  }
  if (diff !== "easy" && m.special_summons.length) {
    const ownWeakest = ctx.ownMonsterAtks.length ? Math.min(...ctx.ownMonsterAtks) : 0;
    const pick = m.special_summons
      .map((c, i) => ({ i, atk: ctx.stats(c.code)?.atk ?? 0, fromExtra: c.location === OcgLocation.EXTRA }))
      .sort((a, b) => b.atk - a.atk)
      .find((c) => !c.fromExtra || c.atk >= ownWeakest);
    if (pick) return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SPECIAL_SUMMON, index: pick.i };
  }
  if (stance === "defensive" && diff !== "easy" && m.monster_sets.length) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_MONSTER_SET, index: Math.max(0, bestByAtk(m.monster_sets, ctx)) };
  }
  if (m.summons.length) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SUMMON, index: Math.max(0, bestByAtk(m.summons, ctx)) };
  }
  if (diff !== "easy" && m.spell_sets.length) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SPELL_SET, index: 0 };
  }
  if (m.to_bp && !(stance === "defensive" && (ctx.oppMonsterValues.length > 0 || ctx.oppFaceDownMonsters > 0) && weakBoard(ctx))) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.TO_BP, index: null };
  }
  return { type: OcgResponseType.SELECT_IDLECMD, action: A.TO_EP, index: null };
}

function weakBoard(ctx: AiContext): boolean {
  const best = ctx.oppMonsterValues.length ? Math.max(...ctx.oppMonsterValues) : 0;
  const mine = ctx.ownMonsterAtks.length ? Math.max(...ctx.ownMonsterAtks) : 0;
  return mine <= best;
}

function battleCommand(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_BATTLECMD }>, ctx: AiContext, diff: AiDifficulty): OcgResponse {
  const B = SelectBattleCMDAction;
  const weakest = ctx.oppMonsterValues.length ? Math.min(...ctx.oppMonsterValues) : -1;
  const stance = posture(ctx.board);

  const oppLp = ctx.board?.opp.lp ?? Infinity;
  const allDirect = m.attacks.length > 0 && m.attacks.every((a) => a.can_direct);
  const totalSwing = m.attacks.reduce((t, a) => t + (ctx.stats(a.code)?.atk ?? 0), 0);
  const lethal = allDirect && totalSwing >= oppLp;

  const backrow = (ctx.board?.opp.backrowCount ?? 0) > 0;
  const cautious = !lethal && backrow && diff !== "easy" &&
    (ctx.oppRisk != null ? ctx.oppRisk >= 0.4 : diff === "hard" && stance === "aggressive");

  let pick = -1;
  let pickScore = -Infinity;
  m.attacks.forEach((a, i) => {
    const atk = ctx.stats(a.code)?.atk ?? 0;
    let favorable: boolean;
    if (diff === "easy") {
      favorable = a.can_direct;
    } else if (diff === "hard") {
      favorable = a.can_direct || (weakest >= 0 && atk >= weakest) || (ctx.oppFaceDownMonsters > 0 && atk >= 1700);
    } else {
      favorable = a.can_direct || (weakest >= 0 && atk > weakest);
    }
    if (cautious && a.can_direct) favorable = false;
    if (!favorable) return;
    const score = atk + (a.can_direct ? 1_000_000 : 0);
    if (score > pickScore) { pickScore = score; pick = i; }
  });
  if (pick >= 0) return { type: OcgResponseType.SELECT_BATTLECMD, action: B.SELECT_BATTLE, index: pick };
  return { type: OcgResponseType.SELECT_BATTLECMD, action: m.to_m2 ? B.TO_M2 : B.TO_EP, index: null };
}

function attackTarget(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_CARD }>, ctx: AiContext): OcgResponse | null {
  const sel = m.selects ?? [];
  if (!sel.length) return null;
  const min = Math.max(1, m.min ?? 1);
  if (min >= sel.length) return { type: OcgResponseType.SELECT_CARD, indicies: sel.map((_c, i) => i) };
  const value = (c: { code: number; position: number }) => {
    const s = ctx.stats(c.code);
    const def = (c.position & (OcgPosition.FACEUP_DEFENSE | OcgPosition.FACEDOWN_DEFENSE)) !== 0;
    return (def ? s?.def : s?.atk) ?? 0;
  };
  const ranked = sel.map((c, i) => ({ i, v: value(c) }));
  if (ctx.attackerAtk > 0) {
    const beatable = ranked.filter((r) => r.v < ctx.attackerAtk).sort((a, b) => b.v - a.v);
    if (beatable.length) return { type: OcgResponseType.SELECT_CARD, indicies: beatable.slice(0, min).map((r) => r.i) };
  }
  const weakest = ranked.slice().sort((a, b) => a.v - b.v);
  return { type: OcgResponseType.SELECT_CARD, indicies: weakest.slice(0, min).map((r) => r.i) };
}

function summonPosition(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_POSITION }>, ctx: AiContext, diff: AiDifficulty): OcgResponse | null {
  const P = OcgPosition;
  const pos = (p: OcgPosition): OcgResponse => ({ type: OcgResponseType.SELECT_POSITION, position: p });
  const canAttack = (m.positions & P.FACEUP_ATTACK) !== 0;
  const canDefend = (m.positions & P.FACEUP_DEFENSE) !== 0;
  if (canAttack || canDefend) {
    if (diff !== "easy" && canDefend) {
      const s = ctx.stats(m.code);
      const oppBest = ctx.oppMonsterValues.length ? Math.max(...ctx.oppMonsterValues) : -1;
      const defensive = posture(ctx.board) === "defensive";
      if (!canAttack || (s && oppBest >= 0 && (defensive ? s.atk <= oppBest : s.atk < oppBest))) return pos(P.FACEUP_DEFENSE);
    }
    return pos(canAttack ? P.FACEUP_ATTACK : P.FACEUP_DEFENSE);
  }
  if ((m.positions & P.FACEDOWN_DEFENSE) !== 0) return pos(P.FACEDOWN_DEFENSE);
  if ((m.positions & P.FACEDOWN_ATTACK) !== 0) return pos(P.FACEDOWN_ATTACK);
  return null;
}

function selectSum(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_SUM }>): OcgResponse {
  const must = m.selects_must ?? [];
  const pool = m.selects ?? [];
  const target = m.amount;
  const min = m.min ?? 0;
  const max = m.max ?? pool.length;
  const n = pool.length;
  const reach = (cards: { amount: number }[]): Set<number> => {
    let sums = new Set<number>([0]);
    for (const c of cards) {
      const lo = c.amount & 0xffff;
      const hi = ((c.amount >>> 16) & 0xffff) || lo;
      const next = new Set<number>();
      for (const s of sums) { next.add(s + lo); if (hi !== lo) next.add(s + hi); }
      sums = next;
    }
    return sums;
  };
  const idxOf = (mask: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) out.push(i);
    return out;
  };
  let exact: { idx: number[]; k: number } | null = null;
  let acc: number[] | null = null;
  let accBest = Infinity;
  if (n <= 18) {
    for (let mask = 0; mask < (1 << n); mask++) {
      const idx = idxOf(mask);
      if (idx.length < min || idx.length > max) continue;
      const reachable = reach([...must, ...idx.map((i) => pool[i]!)]);
      if (reachable.has(target)) {
        if (!exact || idx.length < exact.k) exact = { idx, k: idx.length };
      } else {
        let best = Infinity;
        for (const s of reachable) if (s >= target && s < best) best = s;
        if (best < accBest) { accBest = best; acc = idx; }
      }
    }
  }
  const chosen = exact?.idx ?? acc ?? Array.from({ length: Math.min(Math.max(min, 1), n) }, (_, i) => i);
  return { type: OcgResponseType.SELECT_SUM, indicies: chosen };
}
