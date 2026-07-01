// Evaluation-driven opponent AI (main process). ocgcore remains the rules
// authority: the AI only ever picks among the choices the core offers for
// player 1, so it can never make an illegal move. What changed from the old
// greedy ruleset is the *brain*:
//
//   • A board-evaluation function (`evaluate`) scores any position from the
//     AI's perspective — LP, card advantage, board power and tempo folded into
//     one number. Every other decision is expressed in terms of it.
//   • A strategic *posture* (aggressive / neutral / defensive) is read off that
//     score each decision, so the AI adapts in real time: it presses when ahead
//     and walls up when behind, instead of playing the same line every game.
//   • Lethal detection: when an unobstructed swing closes the game, it takes it.
//   • Risk-aware combat: on Hard it respects the opponent's unknown set cards
//     ("ready for the unexpected") and won't overextend a winning board into a
//     possible trap when the attack isn't needed.
//
// This is a heuristic expert system, not a search — it makes one strong
// decision per prompt rather than rolling out future lines. `evaluate` is the
// deliberate seam a future look-ahead/search layer would plug into (it would
// score the leaf positions the same way).
//
// Everything degrades gracefully when the rich board view (`AiContext.board`)
// is absent: the per-prompt handlers fall back to the local, choice-only
// reasoning, which keeps them unit-testable in isolation.

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

/** Minimal card stats the AI reasons over. Beyond raw battle stats it carries
 *  two coarse EFFECT-AWARENESS bits derived from the card's type bitfield:
 *  `isEffect` (has an effect — a potential negate/searcher/disruption, not a
 *  vanilla beater) and `isExtra` (a Fusion/Synchro/Xyz/Link body — a combo
 *  payoff). The evaluation uses these so it can prefer a combo end-board over a
 *  stat-equal pile of vanillas, which raw ATK/DEF alone cannot distinguish. */
export interface AiStats {
  atk: number;
  def: number;
  level: number;
  isMonster: boolean;
  /** Has a card effect (OcgType.EFFECT) — i.e. not a Normal/vanilla monster. */
  isEffect: boolean;
  /** Extra-Deck monster (Fusion/Synchro/Xyz/Link) — a combo payoff/boss. */
  isExtra: boolean;
  /** Has a disruptive role (negate or floodgate) per the mined card-role data —
   *  worth far more on board than its battle stats imply. */
  isDisruption: boolean;
  /** Archetype codes this card belongs to (for board-cohesion scoring). */
  setcodes: number[];
}

export type AiDifficulty = "easy" | "normal" | "hard";

/** One monster on the field, as the AI sees it. For the opponent's face-down
 *  monsters `faceUp` is false and atk/def are unknown (left at 0). */
export interface AiMonster {
  atk: number;
  def: number;
  /** Face-up (stats known) vs set (hidden). */
  faceUp: boolean;
  /** In a defense position (its DEF, not ATK, is the battle value). */
  defense: boolean;
  /** Has an effect — known only for face-up monsters (omitted = unknown/false,
   *  so we never peek at a face-down opponent card's type). */
  isEffect?: boolean;
  /** Extra-Deck body (Fusion/Synchro/Xyz/Link) — always face-up when present. */
  isExtra?: boolean;
  /** Disruptive (negate/floodgate) — known only for face-up monsters. */
  isDisruption?: boolean;
  /** Archetype codes — known only for face-up monsters (for cohesion). */
  setcodes?: number[];
}

/** One player's resources. `monsters` is the full list for the AI itself and
 *  only the visible picture for the opponent (face-downs included, stats 0). */
export interface AiSide {
  lp: number;
  handCount: number;
  monsters: AiMonster[];
  /** Set Spell/Traps (the AI's own, or the count visible for the opponent). */
  backrowCount: number;
  /** Hand-traps / interaction held in hand — only known for one's OWN hand (the
   *  opponent's hand is hidden, so this is 0 for the opponent). */
  handInteraction: number;
}

/** The full board view used by `evaluate`. Optional on AiContext so the
 *  choice-only handlers stay testable without standing up a whole field. */
export interface AiBoard {
  self: AiSide; // the AI (engine player 1)
  opp: AiSide; // the human (engine player 0)
}

export interface AiContext {
  /** Card stats by passcode (null = unknown). */
  stats: (code: number) => AiStats | null;
  /** Effective battle values of the human's face-up monsters (atk in attack
   *  position, def in defense), used to judge whether an attack is favorable. */
  oppMonsterValues: number[];
  /** How many of the human's monsters are face-down (hidden stats). */
  oppFaceDownMonsters: number;
  /** ATK of the monster currently declaring an attack (0 when not attacking) —
   *  lets the target picker kill the biggest monster that attack can beat. */
  attackerAtk: number;
  /** Effective battle value (DEF in defense, else ATK) of the AI's own face-up
   *  monsters — used to judge whether an Extra Deck summon (which consumes field
   *  monsters as material) is worth it. */
  ownMonsterAtks: number[];
  /** Rich both-sides board view for evaluation/posture. Absent in unit tests
   *  that exercise a single handler; always present from a live session. */
  board?: AiBoard;
  /** Real-time adaptation: 0..1 estimate of how likely the opponent can disrupt
   *  the AI's next commitment, from the public opponent model. Drives play-around
   *  behaviour (combat caution, not over-committing). Absent → treated as 0. */
  oppRisk?: number;
  /** The full public opponent model — the search uses it to build disruption
   *  scenarios for the survival-adjusted leaf score. Absent in unit tests. */
  oppModel?: OpponentModel;
}

export type AiPosture = "aggressive" | "neutral" | "defensive";

// --- the analytical core -----------------------------------------------------

/** A face-down monster's assumed battle value when we can't see its stats — a
 *  middle-of-the-road body, so the AI neither ignores set monsters nor treats
 *  them as bombs. */
const UNKNOWN_MONSTER_VALUE = 1000;

/** Effective battle value of a monster from the field (DEF when defending). */
function battleValue(m: AiMonster): number {
  if (!m.faceUp) return UNKNOWN_MONSTER_VALUE;
  return m.defense ? m.def : m.atk;
}

/** Total board power for one side (sum of effective battle values). */
function boardPower(s: AiSide): number {
  return s.monsters.reduce((t, m) => t + battleValue(m), 0);
}

/** The evaluation is a LINEAR MODEL: `score = weights · features(board)`. The
 *  feature vector captures the things that decide Yu-Gi-Oh games — life points,
 *  card advantage, board power, bodies/tempo, hand size, biggest threat, set
 *  backrow — each as a (self − opp) difference, scaled to O(1–10) so the model
 *  trains stably. This is the deliberate seam for *learning*: a self-play
 *  trainer (`scripts/train-ai.ts`) fits these weights from game outcomes, and a
 *  future search layer would score its leaf positions with the very same
 *  `evaluate`. The DEFAULT weights below reproduce the original hand-tuned
 *  heuristic exactly (the three extra features start at weight 0), so behavior
 *  is unchanged until learned weights are loaded. */
export const FEATURE_NAMES = ["lp", "cards", "power", "bodies", "hand", "topMonster", "backrow", "effMonsters", "extraMonsters", "disruption", "handInteraction", "cohesion"] as const;
//                            lp  cards power bodies hand top backrow eff  extra disrupt hand-int cohesion
export const DEFAULT_WEIGHTS: readonly number[] = [20, 120, 400, 80, 0, 0, 0, 120, 120, 250, 60, 50];

/** Highest effective battle value on a side (the board's biggest threat). */
function topThreat(s: AiSide): number {
  return s.monsters.reduce((mx, m) => Math.max(mx, battleValue(m)), 0);
}

/** Count a side's face-up monsters matching a predicate (face-down monsters are
 *  hidden, so their type is unknown and never counted — no peeking). */
function countMonsters(s: AiSide, pred: (m: AiMonster) => boolean): number {
  return s.monsters.reduce((n, m) => n + (m.faceUp && pred(m) ? 1 : 0), 0);
}

/** Board archetype-cohesion: how many extra face-up monsters share a single
 *  archetype (largest same-setcode group minus 1). 0 = no two share one; a
 *  coherent same-archetype board (its engine is online) scores higher. */
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

/** The (self − opp) feature vector `evaluate` scores. Order matches FEATURE_NAMES. */
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
    // Effect-awareness: an effect monster (potential negate/searcher/disruption)
    // and an Extra-Deck boss are each worth more than a stat-equal vanilla body.
    countMonsters(b.self, (m) => !!m.isEffect) - countMonsters(b.opp, (m) => !!m.isEffect),
    countMonsters(b.self, (m) => !!m.isExtra) - countMonsters(b.opp, (m) => !!m.isExtra),
    // Disruption: a negate/floodgate monster on board is the single highest-
    // value end-board piece and is invisible to a stats-only evaluation.
    countMonsters(b.self, (m) => !!m.isDisruption) - countMonsters(b.opp, (m) => !!m.isDisruption),
    // Hand-traps held (own hand only; opponent's is hidden → 0): interaction in
    // hand is worth keeping rather than dumping.
    b.self.handInteraction - b.opp.handInteraction,
    // Archetype cohesion: a coherent same-archetype board means the engine is on.
    cohesion(b.self) - cohesion(b.opp),
  ];
}

// The weight vector the runtime AI evaluates with. Mutable so a loaded,
// self-play-learned vector can replace the hand-tuned defaults at startup.
let currentWeights: number[] = DEFAULT_WEIGHTS.slice();

/** Install learned evaluation weights (no-op on a wrong-length vector). */
export function setEvalWeights(w: readonly number[]): void {
  if (w.length === DEFAULT_WEIGHTS.length && w.every((x) => Number.isFinite(x))) currentWeights = w.slice();
}

/** The weights currently in use (a copy). */
export function getEvalWeights(): number[] {
  return currentWeights.slice();
}

/** Score a position from the AI's perspective. Positive = the AI is winning. */
export function evaluate(b: AiBoard, weights: readonly number[] = currentWeights): number {
  const f = features(b);
  let score = 0;
  for (let i = 0; i < f.length; i++) score += f[i]! * (weights[i] ?? 0);
  return score;
}

/** Apply a modeled opponent disruption to the AI's OWN board (returns a new
 *  board; the opponent side is untouched). This is how the search reasons about
 *  whether a line SURVIVES: a wipe clears the AI's face-up monsters, targeted
 *  removal takes the best bodies, a negate strips the key monster's effect/
 *  disruption. Resources in HAND are never touched — which is exactly why
 *  holding pieces back beats dumping everything into likely disruption. */
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
  // negate: neutralize the best disruption monster (or best body) — it stays on
  // board but loses its teeth (effect + disruption stripped).
  const pool = faceUpIdx.filter((i) => monsters[i]!.isDisruption);
  const target = (pool.length ? pool : faceUpIdx).slice().sort((a, c) => battleValue(monsters[c]!) - battleValue(monsters[a]!))[0];
  if (target != null) { monsters[target]!.isDisruption = false; monsters[target]!.isEffect = false; }
  return { self: { ...b.self, monsters }, opp: b.opp };
}

/** Survival-adjusted evaluation: the probability-weighted value of a position
 *  across the opponent's likely disruption scenarios. Replaces a bare board
 *  score in the search so a line is valued by how much survives the opponent's
 *  likely interaction, not by raw board size. With no disruption risk this is
 *  just `evaluate` (the single "none" scenario). */
export function survivalScore(b: AiBoard, scenarios: DisruptionScenario[], weights: readonly number[] = currentWeights): number {
  let acc = 0, ptot = 0;
  for (const s of scenarios) {
    if (s.p <= 0) continue;
    acc += s.p * evaluate(applyDisruptionToSelf(b, s.effect), weights);
    ptot += s.p;
  }
  return ptot > 0 ? acc / ptot : evaluate(b, weights);
}

/** Read the AI's strategic stance off the evaluation. The dead-band around 0
 *  keeps it from flip-flopping on small, noisy leads. */
export function posture(b: AiBoard | undefined): AiPosture {
  if (!b) return "neutral";
  const e = evaluate(b);
  if (e > 350) return "aggressive";
  if (e < -350) return "defensive";
  return "neutral";
}

/** Decide the opponent's response, or null to use the session's default. */
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
      return null; // positions / placements / etc. → session default
  }
}

/** Reactive chaining with high-value TIMING: activate an available trap /
 *  quick-effect in response — but at the right moment. The core only offers
 *  cards whose trigger conditions are met, so "use what's offered" is legal; the
 *  judgement is WHEN. Easy never reacts. Otherwise the AI spends its interaction
 *  when it's worth it — the opponent has a real threat on board worth answering,
 *  or the AI is behind and needs to interact to survive — and HOLDS it against a
 *  quiet/empty board, conserving the answer for a bigger threat rather than
 *  firing at the first opening. (Falls back to firing when there's no board view,
 *  e.g. unit tests.) */
function chainResponse(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_CHAIN }>, ctx: AiContext, diff: AiDifficulty): OcgResponse {
  const pass = { type: OcgResponseType.SELECT_CHAIN, index: null } as const;
  const fire = { type: OcgResponseType.SELECT_CHAIN, index: 0 } as const;
  if (m.forced) return fire; // mandatory trigger
  if (diff === "easy" || (m.selects?.length ?? 0) === 0) return pass;
  if (!ctx.board) return fire; // no board context → simple baseline
  // A monster this big is worth spending a response on; below it, hold.
  const THREAT = 1900;
  const behind = posture(ctx.board) === "defensive";
  if (behind || topThreat(ctx.board.opp) >= THREAT) return fire;
  return pass; // quiet board and we're fine → save the interaction
}

/** Optional "activate this effect?" triggers are usually beneficial — Normal and
 *  Hard say yes; Easy declines. */
function effectYesNo(_m: Extract<OcgMessage, { type: OcgMessageType.SELECT_EFFECTYN }>, diff: AiDifficulty): OcgResponse {
  return { type: OcgResponseType.SELECT_EFFECTYN, yes: diff !== "easy" };
}

/** Index of the highest-ATK card in a choice list (−1 if empty). */
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
  // 1) Activate a Main-Phase effect. The core lists every currently-legal
  //    ignition / Spell / Trap / Field-Spell activation in `m.activates`, and
  //    combo decks LIVE on these — searchers, extenders, and engine starters
  //    that Special Summon via their own activated effect (those appear here,
  //    NOT in special_summons). The previous AI ignored `m.activates` entirely,
  //    so it could never even start a combo. Without card-text knowledge we use
  //    a cheap, sound heuristic: prefer activating from the HAND (commit a card
  //    to the line) and, among those, the lowest-ATK card — a low-ATK hand card
  //    is far likelier to be a searcher/Spell than a beater worth keeping for a
  //    Normal Summon (Spells read as ATK 0, so they sort first). The core
  //    re-prompts after each activation, so a whole combo unfolds as successive
  //    picks here; the forward-search layer refines WHICH effect and in what
  //    order. Easy stays basic and never proactively activates.
  if (diff !== "easy" && m.activates.length) {
    const pick = m.activates
      .map((c, i) => ({ i, fromHand: c.location === OcgLocation.HAND, atk: ctx.stats(c.code)?.atk ?? Infinity }))
      .sort((a, b) => Number(b.fromHand) - Number(a.fromHand) || a.atk - b.atk)[0]!;
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_ACTIVATE, index: pick.i };
  }
  // 2) Special Summon the strongest available body — Extra Deck bosses
  //    (Fusion/Synchro/Xyz/Link) or hand summons (e.g. Cyber Dragon). The core
  //    only offers currently-legal summons and drives material/placement after.
  //    Easy stays basic and skips these. Extra Deck summons consume field
  //    monsters as material, so only commit when the new body is at least as
  //    strong as our weakest monster (don't trade a beater for a chump); hand /
  //    Graveyard summons are additive, so always take them.
  if (diff !== "easy" && m.special_summons.length) {
    const ownWeakest = ctx.ownMonsterAtks.length ? Math.min(...ctx.ownMonsterAtks) : 0;
    const pick = m.special_summons
      .map((c, i) => ({ i, atk: ctx.stats(c.code)?.atk ?? 0, fromExtra: c.location === OcgLocation.EXTRA }))
      .sort((a, b) => b.atk - a.atk)
      .find((c) => !c.fromExtra || c.atk >= ownWeakest);
    if (pick) return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SPECIAL_SUMMON, index: pick.i };
  }
  // 2) Normal Summon the strongest available monster (the core only lists
  //    monsters that are actually summonable, tributes included). When on the
  //    back foot, a defensive set monster (if offered) is the safer body — it
  //    can't be run over for damage — so prefer it while behind.
  if (stance === "defensive" && diff !== "easy" && m.monster_sets.length) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_MONSTER_SET, index: Math.max(0, bestByAtk(m.monster_sets, ctx)) };
  }
  if (m.summons.length) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SUMMON, index: Math.max(0, bestByAtk(m.summons, ctx)) };
  }
  // 3) Build a backrow — but Easy never sets traps (less to play around).
  if (diff !== "easy" && m.spell_sets.length) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SPELL_SET, index: 0 };
  }
  // 4) Otherwise advance: Battle Phase if we can, else end the turn. While
  //    purely defensive with nothing to gain in combat, skip the Battle Phase
  //    rather than feed attackers into the opponent's board.
  if (m.to_bp && !(stance === "defensive" && (ctx.oppMonsterValues.length > 0 || ctx.oppFaceDownMonsters > 0) && weakBoard(ctx))) {
    return { type: OcgResponseType.SELECT_IDLECMD, action: A.TO_BP, index: null };
  }
  return { type: OcgResponseType.SELECT_IDLECMD, action: A.TO_EP, index: null };
}

/** True when the AI's own face-up monsters can't beat the opponent's best
 *  blocker — i.e. entering combat would only lose monsters. */
function weakBoard(ctx: AiContext): boolean {
  const best = ctx.oppMonsterValues.length ? Math.max(...ctx.oppMonsterValues) : 0;
  const mine = ctx.ownMonsterAtks.length ? Math.max(...ctx.ownMonsterAtks) : 0;
  return mine <= best;
}

function battleCommand(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_BATTLECMD }>, ctx: AiContext, diff: AiDifficulty): OcgResponse {
  const B = SelectBattleCMDAction;
  const weakest = ctx.oppMonsterValues.length ? Math.min(...ctx.oppMonsterValues) : -1;
  const stance = posture(ctx.board);

  // Lethal check: the board is clear (every offered attack can go direct) and
  // our total swing meets or exceeds the opponent's life points. Take the game
  // — and ignore backrow caution, because there's no "next turn" to protect.
  const oppLp = ctx.board?.opp.lp ?? Infinity;
  const allDirect = m.attacks.length > 0 && m.attacks.every((a) => a.can_direct);
  const totalSwing = m.attacks.reduce((t, a) => t + (ctx.stats(a.code)?.atk ?? 0), 0);
  const lethal = allDirect && totalSwing >= oppLp;

  // Real-time play-around: the AI reads how likely the opponent can punish a
  // swing (open backrow + revealed interaction + cards in hand → `oppRisk`) and,
  // when that risk is meaningful and there's no lethal on the table, it won't
  // push a non-essential chip attacker into likely disruption. A loaded control
  // opponent makes it cautious; an empty-handed, backrow-less opponent makes it
  // press. When an opponent model is present the decision is risk-graded (any
  // non-Easy difficulty); without one it falls back to the old Hard+aggressive
  // posture rule.
  const backrow = (ctx.board?.opp.backrowCount ?? 0) > 0;
  const cautious = !lethal && backrow && diff !== "easy" &&
    (ctx.oppRisk != null ? ctx.oppRisk >= 0.4 : diff === "hard" && stance === "aggressive");

  let pick = -1;
  let pickScore = -Infinity;
  m.attacks.forEach((a, i) => {
    const atk = ctx.stats(a.code)?.atk ?? 0;
    let favorable: boolean;
    if (diff === "easy") {
      favorable = a.can_direct; // timid: only ever attack directly, never into a monster
    } else if (diff === "hard") {
      // Aggressive: direct, beat-or-tie a face-up blocker, or probe a face-down with a real beater.
      favorable = a.can_direct || (weakest >= 0 && atk >= weakest) || (ctx.oppFaceDownMonsters > 0 && atk >= 1700);
    } else {
      // Normal: direct, or an attack that beats the weakest blocker.
      favorable = a.can_direct || (weakest >= 0 && atk > weakest);
    }
    // Caution gate: skip a merely-chip direct attack into open backrow when we
    // don't need it. Attacks that destroy a monster (not can_direct) still go.
    if (cautious && a.can_direct) favorable = false;
    if (!favorable) return;
    const score = atk + (a.can_direct ? 1_000_000 : 0); // prefer direct damage
    if (score > pickScore) { pickScore = score; pick = i; }
  });
  if (pick >= 0) return { type: OcgResponseType.SELECT_BATTLECMD, action: B.SELECT_BATTLE, index: pick };
  // No worthwhile attack — go to Main Phase 2 if offered, else End Phase.
  return { type: OcgResponseType.SELECT_BATTLECMD, action: m.to_m2 ? B.TO_M2 : B.TO_EP, index: null };
}

/** Card-target picker (chiefly the SELECT_CARD the AI faces when declaring an
 *  attack). During an attack (ctx.attackerAtk > 0) it removes the biggest
 *  *beatable* threat — killing the strongest monster the attacker still wins
 *  against is better board control than chipping the weakest. Outside combat it
 *  falls back to taking the weakest card, a safe generic default. */
function attackTarget(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_CARD }>, ctx: AiContext): OcgResponse | null {
  const sel = m.selects ?? [];
  if (!sel.length) return null;
  const min = Math.max(1, m.min ?? 1);
  if (min >= sel.length) return { type: OcgResponseType.SELECT_CARD, indicies: sel.map((_c, i) => i) };
  // Effective battle value of a candidate (def when set in defense, else atk).
  const value = (c: { code: number; position: number }) => {
    const s = ctx.stats(c.code);
    const def = (c.position & (OcgPosition.FACEUP_DEFENSE | OcgPosition.FACEDOWN_DEFENSE)) !== 0;
    return (def ? s?.def : s?.atk) ?? 0;
  };
  const ranked = sel.map((c, i) => ({ i, v: value(c) }));
  // Attacking: prefer the strongest target the attacker can actually destroy.
  if (ctx.attackerAtk > 0) {
    const beatable = ranked.filter((r) => r.v < ctx.attackerAtk).sort((a, b) => b.v - a.v);
    if (beatable.length) return { type: OcgResponseType.SELECT_CARD, indicies: beatable.slice(0, min).map((r) => r.i) };
  }
  // Otherwise (or nothing beatable): take the weakest.
  const weakest = ranked.slice().sort((a, b) => a.v - b.v);
  return { type: OcgResponseType.SELECT_CARD, indicies: weakest.slice(0, min).map((r) => r.i) };
}

/** Position for a monster being summoned/placed. Easy is naive (always attack).
 *  Normal & Hard defend when the monster can't win the battle against the human's
 *  best face-up attacker — walling instead of feeding a bigger beater. While on
 *  the back foot they also lean defensive with an even-stats monster. Always
 *  answers with a position actually present in the offered mask (a bad position
 *  is rejected by the core and would stall the duel). */
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
      // Outclassed by (or can't win against) the board → wall up in defense.
      // While behind, also wall with a monster that merely ties the best threat.
      if (!canAttack || (s && oppBest >= 0 && (defensive ? s.atk <= oppBest : s.atk < oppBest))) return pos(P.FACEUP_DEFENSE);
    }
    return pos(canAttack ? P.FACEUP_ATTACK : P.FACEUP_DEFENSE);
  }
  // Only face-down positions offered (e.g. a forced set) → pick a legal one.
  if ((m.positions & P.FACEDOWN_DEFENSE) !== 0) return pos(P.FACEDOWN_DEFENSE);
  if ((m.positions & P.FACEDOWN_ATTACK) !== 0) return pos(P.FACEDOWN_ATTACK);
  return null;
}

/** Material selection for sum-constrained summons — chiefly a Synchro's level
 *  total (tuner + non-tuners = the monster's Level). `selects_must` cards are
 *  always included; we pick a subset of the optional `selects` so the combined
 *  total hits `amount`. Each card's packed `amount` carries two possible
 *  contributions (low 16 bits / high 16 bits) for level-flexible monsters. A
 *  naive "pick the first N" answer is usually an illegal total and would stall
 *  the duel (RETRY), so we actually solve it: prefer an exact total with the
 *  fewest materials, else the smallest total that meets the requirement. */
function selectSum(m: Extract<OcgMessage, { type: OcgMessageType.SELECT_SUM }>): OcgResponse {
  const must = m.selects_must ?? [];
  const pool = m.selects ?? [];
  const target = m.amount;
  const min = m.min ?? 0;
  const max = m.max ?? pool.length;
  const n = pool.length;
  // All totals reachable from a set of cards, each contributing lo or hi.
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
  // Material pools are tiny; brute-force every subset within the count bounds.
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
