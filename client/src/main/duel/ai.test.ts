import { describe, it, expect } from "vitest";
import { OcgMessageType, SelectIdleCMDAction, SelectBattleCMDAction, OcgPosition, OcgLocation } from "@n1xx1/ocgcore-wasm";
import { aiDecide, evaluate, posture, features, setEvalWeights, getEvalWeights, applyDisruptionToSelf, survivalScore, DEFAULT_WEIGHTS, FEATURE_NAMES, type AiContext, type AiBoard } from "./ai.ts";
import { cardStats, buildSide, type CoreView } from "./ai-context.ts";

function ctx(atk: Record<number, number>, oppMonsterValues: number[] = [], oppFaceDownMonsters = 0, attackerAtk = 0, ownMonsterAtks: number[] = [], board?: AiBoard, oppRisk?: number): AiContext {
  return {
    stats: (code) => (atk[code] != null ? { atk: atk[code]!, def: 0, level: 4, isMonster: true, isEffect: false, isExtra: false, isDisruption: false, setcodes: [] } : null),
    oppMonsterValues,
    oppFaceDownMonsters,
    attackerAtk,
    ownMonsterAtks,
    ...(board ? { board } : {}),
    ...(oppRisk != null ? { oppRisk } : {}),
  };
}

const side = (over: Partial<AiBoard["self"]> = {}) => ({ lp: 8000, handCount: 3, monsters: [], backrowCount: 0, handInteraction: 0, ...over });
const board = (self: Partial<AiBoard["self"]>, opp: Partial<AiBoard["opp"]>): AiBoard => ({ self: side(self), opp: side(opp) });
const idle = (over: Record<string, unknown>) =>
  ({ type: OcgMessageType.SELECT_IDLECMD, summons: [], special_summons: [], monster_sets: [], spell_sets: [], activates: [], pos_changes: [], to_bp: true, to_ep: true, ...over }) as never;
const battle = (over: Record<string, unknown>) =>
  ({ type: OcgMessageType.SELECT_BATTLECMD, chains: [], attacks: [], to_m2: true, to_ep: true, ...over }) as never;
const chain = (over: Record<string, unknown>) =>
  ({ type: OcgMessageType.SELECT_CHAIN, selects: [], forced: false, ...over }) as never;
const effyn = () => ({ type: OcgMessageType.SELECT_EFFECTYN, code: 1 }) as never;

describe("aiDecide — idle command", () => {
  it("Normal Summons the highest-ATK monster", () => {
    const r = aiDecide(idle({ summons: [{ code: 1 }, { code: 2 }, { code: 3 }] }), ctx({ 1: 1000, 2: 2500, 3: 1700 })) as { action: number; index: number };
    expect(r.action).toBe(SelectIdleCMDAction.SELECT_SUMMON);
    expect(r.index).toBe(1);
  });
  it("Sets a spell/trap when it can't summon", () => {
    const r = aiDecide(idle({ spell_sets: [{ code: 9 }] }), ctx({})) as { action: number };
    expect(r.action).toBe(SelectIdleCMDAction.SELECT_SPELL_SET);
  });
  it("enters Battle Phase when there's nothing to play", () => {
    expect((aiDecide(idle({}), ctx({})) as { action: number }).action).toBe(SelectIdleCMDAction.TO_BP);
  });
  it("ends the turn when Battle Phase isn't available", () => {
    expect((aiDecide(idle({ to_bp: false }), ctx({})) as { action: number }).action).toBe(SelectIdleCMDAction.TO_EP);
  });
});

describe("aiDecide — activations (combo engine)", () => {
  const act = (code: number, location: OcgLocation, sequence = 0) => ({ code, controller: 1, location, sequence });
  it("activates a Main-Phase effect before Normal Summoning (combos start here)", () => {
    const m = idle({ activates: [act(9, OcgLocation.HAND)], summons: [{ code: 1 }] });
    const r = aiDecide(m, ctx({ 1: 2000, 9: 0 }), "normal") as { action: number; index: number };
    expect(r.action).toBe(SelectIdleCMDAction.SELECT_ACTIVATE);
    expect(r.index).toBe(0);
  });
  it("prefers a hand activation, and the lowest-ATK (likely searcher/Spell) among hand cards", () => {
    const m = idle({ activates: [act(1, OcgLocation.MZONE), act(2, OcgLocation.HAND), act(3, OcgLocation.HAND)] });
    expect((aiDecide(m, ctx({ 1: 2500, 2: 2400, 3: 0 }), "hard") as { index: number }).index).toBe(2);
  });
  it("Easy never proactively activates (stays basic, Normal Summons instead)", () => {
    const m = idle({ activates: [act(9, OcgLocation.HAND)], summons: [{ code: 1 }] });
    expect((aiDecide(m, ctx({ 1: 2000, 9: 0 }), "easy") as { action: number }).action).toBe(SelectIdleCMDAction.SELECT_SUMMON);
  });
});

describe("aiDecide — battle command", () => {
  it("attacks directly when possible", () => {
    const r = aiDecide(battle({ attacks: [{ code: 1, can_direct: true }] }), ctx({ 1: 1800 })) as { action: number; index: number };
    expect(r.action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
    expect(r.index).toBe(0);
  });
  it("attacks into a monster only when favorable", () => {
    const unfav = aiDecide(battle({ attacks: [{ code: 1, can_direct: false }] }), ctx({ 1: 1500 }, [1700])) as { action: number };
    expect(unfav.action).toBe(SelectBattleCMDAction.TO_M2);
    const fav = aiDecide(battle({ attacks: [{ code: 1, can_direct: false }] }), ctx({ 1: 2000 }, [1700])) as { action: number };
    expect(fav.action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
  });
  it("prefers the direct attacker over a contested one", () => {
    const r = aiDecide(battle({ attacks: [{ code: 1, can_direct: false }, { code: 2, can_direct: true }] }), ctx({ 1: 2500, 2: 1000 }, [3000])) as { index: number };
    expect(r.index).toBe(1);
  });
});

describe("aiDecide — difficulty", () => {
  it("Easy only attacks directly; Normal engages a beatable monster", () => {
    const m = battle({ attacks: [{ code: 1, can_direct: false }] });
    expect((aiDecide(m, ctx({ 1: 2000 }, [1700]), "easy") as { action: number }).action).toBe(SelectBattleCMDAction.TO_M2);
    expect((aiDecide(m, ctx({ 1: 2000 }, [1700]), "normal") as { action: number }).action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
  });
  it("Hard probes a face-down with a strong attacker; Normal holds", () => {
    const m = battle({ attacks: [{ code: 1, can_direct: false }] });
    expect((aiDecide(m, ctx({ 1: 2000 }, [], 1), "normal") as { action: number }).action).toBe(SelectBattleCMDAction.TO_M2);
    expect((aiDecide(m, ctx({ 1: 2000 }, [], 1), "hard") as { action: number }).action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
  });
  it("Easy doesn't set a backrow; Normal does", () => {
    const m = idle({ spell_sets: [{ code: 9 }] });
    expect((aiDecide(m, ctx({}), "easy") as { action: number }).action).toBe(SelectIdleCMDAction.TO_BP);
    expect((aiDecide(m, ctx({}), "normal") as { action: number }).action).toBe(SelectIdleCMDAction.SELECT_SPELL_SET);
  });
});

describe("aiDecide — special summon (Extra Deck)", () => {
  const ss = (code: number, location: OcgLocation) => ({ code, controller: 1 as const, location, sequence: 0 });
  it("Normal/Hard special summon the strongest available; Easy skips", () => {
    const m = idle({ special_summons: [ss(1, OcgLocation.EXTRA), ss(2, OcgLocation.EXTRA)] });
    const c = ctx({ 1: 2000, 2: 2600 });
    expect((aiDecide(m, c, "normal") as { action: number; index: number }).action).toBe(SelectIdleCMDAction.SELECT_SPECIAL_SUMMON);
    expect((aiDecide(m, c, "normal") as { index: number }).index).toBe(1);
    expect((aiDecide(m, c, "hard") as { action: number }).action).toBe(SelectIdleCMDAction.SELECT_SPECIAL_SUMMON);
    expect((aiDecide(m, c, "easy") as { action: number }).action).toBe(SelectIdleCMDAction.TO_BP);
  });
  it("skips an Extra Deck summon that would trade down a stronger board", () => {
    const m = idle({ special_summons: [ss(1, OcgLocation.EXTRA)] });
    const c = ctx({ 1: 500 }, [], 0, 0, [2000]);
    expect((aiDecide(m, c, "normal") as { action: number }).action).toBe(SelectIdleCMDAction.TO_BP);
  });
  it("always takes a hand / non-Extra special summon (additive, no material cost)", () => {
    const m = idle({ special_summons: [ss(1, OcgLocation.HAND)] });
    const c = ctx({ 1: 500 }, [], 0, 0, [2000]);
    expect((aiDecide(m, c, "normal") as { action: number }).action).toBe(SelectIdleCMDAction.SELECT_SPECIAL_SUMMON);
  });
  it("falls back to a weaker hand summon when the strongest Extra summon fails the guard", () => {
    const m = idle({ special_summons: [ss(1, OcgLocation.EXTRA), ss(2, OcgLocation.HAND)] });
    const c = ctx({ 1: 2500, 2: 1500 }, [], 0, 0, [3000]);
    const r = aiDecide(m, c, "normal") as { action: number; index: number };
    expect(r.action).toBe(SelectIdleCMDAction.SELECT_SPECIAL_SUMMON);
    expect(r.index).toBe(1);
  });
  it("prefers special summon over a weaker normal summon", () => {
    const m = idle({ special_summons: [ss(2, OcgLocation.EXTRA)], summons: [{ code: 1 }] });
    const c = ctx({ 1: 1800, 2: 2500 });
    expect((aiDecide(m, c, "normal") as { action: number }).action).toBe(SelectIdleCMDAction.SELECT_SPECIAL_SUMMON);
  });
});

describe("aiDecide — SELECT_SUM (Synchro material)", () => {
  const sum = (over: Record<string, unknown>) =>
    ({ type: OcgMessageType.SELECT_SUM, select_max: 0, amount: 0, min: 1, max: 3, selects_must: [], selects: [], ...over }) as never;
  const card = (amount: number) => ({ code: amount, controller: 1, location: OcgLocation.MZONE, sequence: 0, amount });
  it("picks the fewest materials that hit the level total exactly", () => {
    const m = sum({ amount: 8, min: 1, max: 2, selects_must: [card(3)], selects: [card(4), card(1), card(5)] });
    expect((aiDecide(m, ctx({})) as { indicies: number[] }).indicies).toEqual([2]);
  });
  it("decodes the packed lo/hi level options per card", () => {
    const m = sum({ amount: 8, min: 1, max: 2, selects_must: [{ ...card(0), amount: (5 << 16) | 3 }], selects: [card(5), card(3)] });
    expect((aiDecide(m, ctx({})) as { indicies: number[] }).indicies).toEqual([0]);
  });
  it("falls back to the smallest total meeting the requirement when no exact sum exists", () => {
    const m = sum({ amount: 5, min: 1, max: 2, selects_must: [], selects: [card(3), card(3)] });
    expect((aiDecide(m, ctx({})) as { indicies: number[] }).indicies).toEqual([0, 1]);
  });
});

describe("aiDecide — reactive (chains / effects)", () => {
  it("Normal and Hard activate an available chain; Easy passes", () => {
    const m = chain({ selects: [{ code: 9 }] });
    expect((aiDecide(m, ctx({}), "easy") as { index: number | null }).index).toBe(null);
    expect((aiDecide(m, ctx({}), "normal") as { index: number | null }).index).toBe(0);
    expect((aiDecide(m, ctx({}), "hard") as { index: number | null }).index).toBe(0);
  });
  it("always responds to a forced chain", () => {
    const m = chain({ selects: [{ code: 9 }], forced: true });
    expect((aiDecide(m, ctx({}), "easy") as { index: number | null }).index).toBe(0);
  });
  it("optional effect (effect-yn): Easy declines, Normal/Hard accept", () => {
    expect((aiDecide(effyn(), ctx({}), "easy") as { yes: boolean }).yes).toBe(false);
    expect((aiDecide(effyn(), ctx({}), "normal") as { yes: boolean }).yes).toBe(true);
    expect((aiDecide(effyn(), ctx({}), "hard") as { yes: boolean }).yes).toBe(true);
  });
  it("reactive TIMING: fires interaction into a real threat, holds it on a quiet board", () => {
    const m = chain({ selects: [{ code: 9 }] });
    const even = { lp: 8000, handCount: 3, monsters: [], backrowCount: 1, handInteraction: 0 };
    const bigThreat = board({ ...even }, { ...even, monsters: [{ atk: 2500, def: 0, faceUp: true, defense: false }] });
    const quiet = board({ ...even }, { ...even, monsters: [] });
    expect((aiDecide(m, ctx({}, [], 0, 0, [], bigThreat), "hard") as { index: number | null }).index).toBe(0);
    expect((aiDecide(m, ctx({}, [], 0, 0, [], quiet), "hard") as { index: number | null }).index).toBe(null);
  });
  it("reactive TIMING: fires when behind even without a big board threat", () => {
    const m = chain({ selects: [{ code: 9 }] });
    const behind = board({ lp: 800, handCount: 0, monsters: [] }, { lp: 8000, handCount: 5, monsters: [{ atk: 1000, def: 0, faceUp: true, defense: false }], backrowCount: 2 });
    expect((aiDecide(m, ctx({}, [], 0, 0, [], behind), "hard") as { index: number | null }).index).toBe(0);
  });
});

describe("aiDecide — attack target", () => {
  const target = (codes: Record<number, number>, attackerAtk = 0) => {
    const m = { type: OcgMessageType.SELECT_CARD, min: 1, max: 1, selects: Object.keys(codes).map((c) => ({ code: Number(c), position: OcgPosition.FACEUP_ATTACK })), can_cancel: false } as never;
    return (aiDecide(m, ctx(codes, [], 0, attackerAtk)) as { indicies: number[] }).indicies;
  };
  it("outside combat, takes the weakest monster", () => {
    expect(target({ 1: 2000, 2: 800 })).toEqual([1]);
  });
  it("when attacking, removes the strongest monster it can beat", () => {
    expect(target({ 1: 800, 2: 1900, 3: 2500 }, 2200)).toEqual([1]);
  });
  it("when nothing is beatable, falls back to the weakest", () => {
    expect(target({ 1: 2600, 2: 3000 }, 2000)).toEqual([0]);
  });
});

describe("aiDecide — summon position", () => {
  const pos = (over: Record<string, unknown>, c: AiContext, diff: "easy" | "normal" | "hard") => {
    const m = { type: OcgMessageType.SELECT_POSITION, code: 1, positions: OcgPosition.FACEUP_ATTACK | OcgPosition.FACEUP_DEFENSE, ...over } as never;
    return (aiDecide(m, c, diff) as { position: number }).position;
  };
  it("attacks when it matches or beats the human's best monster", () => {
    expect(pos({}, ctx({ 1: 2000 }, [1800]), "normal")).toBe(OcgPosition.FACEUP_ATTACK);
  });
  it("Normal/Hard defend when outclassed by the board", () => {
    expect(pos({}, ctx({ 1: 1600 }, [2500]), "normal")).toBe(OcgPosition.FACEUP_DEFENSE);
    expect(pos({}, ctx({ 1: 1600 }, [2500]), "hard")).toBe(OcgPosition.FACEUP_DEFENSE);
  });
  it("Easy always picks attack position", () => {
    expect(pos({}, ctx({ 1: 1600 }, [2500]), "easy")).toBe(OcgPosition.FACEUP_ATTACK);
  });
  it("defends with an even-stats monster while behind (defensive posture)", () => {
    const behind = board({ lp: 2000, monsters: [], handCount: 1 }, { lp: 8000, monsters: [{ atk: 1800, def: 0, faceUp: true, defense: false }], handCount: 5, backrowCount: 2 });
    expect(pos({}, ctx({ 1: 1800 }, [1800], 0, 0, [], behind), "normal")).toBe(OcgPosition.FACEUP_DEFENSE);
    expect(pos({}, ctx({ 1: 1800 }, [1800]), "normal")).toBe(OcgPosition.FACEUP_ATTACK);
  });
});

describe("richer features (hand-traps held, archetype cohesion)", () => {
  it("rewards hand-traps held in one's own hand", () => {
    const a = board({ handInteraction: 2 }, { handInteraction: 0 });
    const b = board({ handInteraction: 0 }, { handInteraction: 0 });
    expect(evaluate(a) - evaluate(b)).toBeCloseTo(2 * 60, 5);
  });
  it("rewards a coherent same-archetype board (cohesion = largest group − 1)", () => {
    const m = (sc: number[]) => ({ atk: 1500, def: 0, faceUp: true, defense: false, setcodes: sc }) as AiBoard["self"]["monsters"][number];
    const coherent = board({ monsters: [m([0x99]), m([0x99]), m([0x99])] }, { monsters: [m([1]), m([2]), m([3])] });
    const f = features(coherent);
    expect(f[11]).toBe(2);
    const sameStats = board({ monsters: [m([1]), m([2]), m([3])] }, { monsters: [m([1]), m([2]), m([3])] });
    expect(evaluate(coherent) - evaluate(sameStats)).toBeCloseTo(2 * 50, 5);
  });
});

describe("cardStats effect classification", () => {
  it("derives effect / extra-deck / monster bits from the type bitfield", () => {
    expect(cardStats({ type: 0x1 | 0x10 })).toMatchObject({ isMonster: true, isEffect: false, isExtra: false });
    expect(cardStats({ type: 0x1 | 0x20 })).toMatchObject({ isMonster: true, isEffect: true, isExtra: false });
    expect(cardStats({ type: 0x1 | 0x20 | 0x4000000 })).toMatchObject({ isEffect: true, isExtra: true });
    expect(cardStats({ type: 0x1 | 0x2000 })).toMatchObject({ isExtra: true });
    expect(cardStats({ type: 0x2 })).toMatchObject({ isMonster: false, isEffect: false });
    expect(cardStats(null)).toBeNull();
  });
});

describe("buildSide — effect bits, no peeking at face-downs", () => {
  it("reads the type only for face-up monsters; face-downs stay unknown", () => {
    const peeked: number[] = [];
    const view: CoreView = {
      queryLoc: (_p, loc) => (loc === OcgLocation.MZONE
        ? [
            { position: OcgPosition.FACEUP_ATTACK, code: 100, attack: 2000, defense: 0 },
            { position: OcgPosition.FACEDOWN_DEFENSE, code: 200, attack: 0, defense: 0 },
          ]
        : []),
      queryCount: () => 0,
      lp: () => 8000,
      stats: (code) => { peeked.push(code); return cardStats({ type: 0x1 | 0x20 | 0x4000000 }); },
    };
    const side = buildSide(view, 1);
    expect(side.monsters[0]).toMatchObject({ faceUp: true, isEffect: true, isExtra: true });
    expect(side.monsters[1]).toMatchObject({ faceUp: false, isEffect: false, isExtra: false });
    expect(peeked).toEqual([100]);
  });
});

describe("effect-aware features", () => {
  const effM = (atk: number): AiBoard["self"]["monsters"][number] => ({ atk, def: 0, faceUp: true, defense: false, isEffect: true });
  const vanillaM = (atk: number): AiBoard["self"]["monsters"][number] => ({ atk, def: 0, faceUp: true, defense: false });
  const extraM = (atk: number): AiBoard["self"]["monsters"][number] => ({ atk, def: 0, faceUp: true, defense: false, isEffect: true, isExtra: true });

  it("prefers an effect monster over a stat-identical vanilla (same ATK/DEF/counts)", () => {
    const withEffect = board({ monsters: [effM(2000)] }, { monsters: [vanillaM(2000)] });
    expect(evaluate(withEffect)).toBeGreaterThan(0);
  });
  it("values an Extra-Deck boss above a vanilla of equal ATK (effect + extra both count)", () => {
    const boss = board({ monsters: [extraM(2500)] }, { monsters: [vanillaM(2500)] });
    const eff = board({ monsters: [effM(2500)] }, { monsters: [vanillaM(2500)] });
    expect(evaluate(boss)).toBeGreaterThan(evaluate(eff));
  });
  it("adds disruption value for a negate/floodgate monster, all else equal", () => {
    const m = (d: boolean) => ({ atk: 2000, def: 0, faceUp: true, defense: false, isEffect: true, isExtra: true, isDisruption: d }) as AiBoard["self"]["monsters"][number];
    const withNegate = board({ monsters: [m(true)] }, { monsters: [] });
    const without = board({ monsters: [m(false)] }, { monsters: [] });
    expect(evaluate(withNegate)).toBeGreaterThan(evaluate(without));
    expect(evaluate(withNegate) - evaluate(without)).toBeCloseTo(250, 5);
  });
  it("never counts a face-down monster's type (no peeking)", () => {
    const facedown = { atk: 0, def: 0, faceUp: false, defense: true, isEffect: true, isExtra: true, isDisruption: true } as AiBoard["self"]["monsters"][number];
    const b = board({ monsters: [facedown] }, { monsters: [] });
    expect(features(b)[7]).toBe(0);
    expect(features(b)[8]).toBe(0);
    expect(features(b)[9]).toBe(0);
  });
});

describe("features / learnable weights", () => {
  const adv = board({ lp: 8000, handCount: 4, monsters: [{ atk: 2500, def: 2000, faceUp: true, defense: false }], backrowCount: 2 }, { lp: 4000, handCount: 1, monsters: [], backrowCount: 0 });
  it("emits one feature per FEATURE_NAMES entry", () => {
    expect(features(adv)).toHaveLength(FEATURE_NAMES.length);
    expect(DEFAULT_WEIGHTS).toHaveLength(FEATURE_NAMES.length);
  });
  it("is antisymmetric: swapping seats negates the feature vector", () => {
    const mirror = board({ lp: 4000, handCount: 1, monsters: [], backrowCount: 0 }, { lp: 8000, handCount: 4, monsters: [{ atk: 2500, def: 2000, faceUp: true, defense: false }], backrowCount: 2 });
    features(adv).forEach((v, i) => expect(features(mirror)[i]).toBeCloseTo(-v, 9));
  });
  it("evaluate is the dot product of features and the given weights", () => {
    const w = FEATURE_NAMES.map((_, i) => i + 1);
    const expected = features(adv).reduce((s, f, i) => s + f * w[i]!, 0);
    expect(evaluate(adv, w)).toBeCloseTo(expected, 9);
  });
  it("setEvalWeights swaps the active weights; rejects a wrong-length vector", () => {
    const original = getEvalWeights();
    try {
      setEvalWeights(FEATURE_NAMES.map(() => 0));
      expect(evaluate(adv)).toBe(0);
      setEvalWeights([1, 2, 3]);
      expect(evaluate(adv)).toBe(0);
    } finally {
      setEvalWeights(original);
    }
  });
});

describe("determinized play-around (survival-adjusted scoring)", () => {
  const mon = (atk: number, over: Partial<AiBoard["self"]["monsters"][number]> = {}) => ({ atk, def: 0, faceUp: true, defense: false, ...over }) as AiBoard["self"]["monsters"][number];
  it("wipe clears the AI's face-up monsters but never its hand", () => {
    const b = board({ monsters: [mon(2000), mon(1800)], handCount: 3 }, {});
    const after = applyDisruptionToSelf(b, { kind: "wipe" });
    expect(after.self.monsters).toHaveLength(0);
    expect(after.self.handCount).toBe(3);
  });
  it("removeBest takes the strongest body; negate strips the key monster's effect", () => {
    const b = board({ monsters: [mon(2500), mon(1000)] }, {});
    expect(applyDisruptionToSelf(b, { kind: "removeBest", n: 1 }).self.monsters.map((m) => m.atk)).toEqual([1000]);
    const nb = board({ monsters: [mon(0, { isEffect: true, isExtra: true, isDisruption: true }), mon(2000)] }, {});
    const negated = applyDisruptionToSelf(nb, { kind: "negate" }).self.monsters.find((m) => m.atk === 0)!;
    expect(negated.isDisruption).toBe(false);
    expect(negated.isEffect).toBe(false);
  });
  it("discounts a fragile (wider) board MORE than a lean one when a wipe is likely", () => {
    const wide = board({ monsters: [mon(2000), mon(2000), mon(2000)] }, { backrowCount: 3 });
    const lean = board({ monsters: [mon(2000)] }, { backrowCount: 3 });
    const wipeLikely = [{ p: 0.4, effect: { kind: "none" as const } }, { p: 0.6, effect: { kind: "wipe" as const } }];
    const discount = (b: AiBoard) => evaluate(b) - survivalScore(b, wipeLikely);
    expect(discount(wide)).toBeGreaterThan(discount(lean));
    expect(survivalScore(wide, wipeLikely)).toBeLessThan(evaluate(wide));
  });
  it("with no disruption risk, survival score is just the board evaluation", () => {
    const b = board({ monsters: [mon(2000), mon(2000)] }, {});
    expect(survivalScore(b, [{ p: 1, effect: { kind: "none" } }])).toBeCloseTo(evaluate(b), 6);
  });
});

describe("evaluate / posture", () => {
  it("scores a card- and board-advantaged side positive", () => {
    const b = board({ lp: 8000, handCount: 4, monsters: [{ atk: 2500, def: 2000, faceUp: true, defense: false }], backrowCount: 2 }, { lp: 4000, handCount: 1, monsters: [], backrowCount: 0 });
    expect(evaluate(b)).toBeGreaterThan(0);
    expect(posture(b)).toBe("aggressive");
  });
  it("scores the mirror position negative and reads defensive", () => {
    const b = board({ lp: 4000, handCount: 1, monsters: [], backrowCount: 0 }, { lp: 8000, handCount: 4, monsters: [{ atk: 2500, def: 2000, faceUp: true, defense: false }], backrowCount: 2 });
    expect(evaluate(b)).toBeLessThan(0);
    expect(posture(b)).toBe("defensive");
  });
  it("reads neutral on an even board and without a board view", () => {
    expect(posture(board({}, {}))).toBe("neutral");
    expect(posture(undefined)).toBe("neutral");
  });
});

describe("aiDecide — lethal & risk-aware combat", () => {
  it("swings for game when the unobstructed total meets the opponent's LP", () => {
    const lethalBoard = board({ monsters: [] }, { lp: 3000, monsters: [], backrowCount: 3 });
    const m = battle({ attacks: [{ code: 1, can_direct: true }, { code: 2, can_direct: true }] });
    const r = aiDecide(m, ctx({ 1: 1600, 2: 1500 }, [], 0, 0, [], lethalBoard), "hard") as { action: number };
    expect(r.action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
  });
  it("Hard holds a non-essential direct attack into open backrow while ahead", () => {
    const ahead = board({ lp: 8000, handCount: 5, monsters: [{ atk: 2500, def: 0, faceUp: true, defense: false }], backrowCount: 1 }, { lp: 8000, handCount: 0, monsters: [], backrowCount: 3 });
    const m = battle({ attacks: [{ code: 1, can_direct: true }] });
    expect((aiDecide(m, ctx({ 1: 2500 }, [], 0, 0, [2500], ahead), "hard") as { action: number }).action).toBe(SelectBattleCMDAction.TO_M2);
    expect((aiDecide(m, ctx({ 1: 2500 }, [], 0, 0, [2500], ahead), "normal") as { action: number }).action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
  });
});

describe("aiDecide — real-time adaptation (opponent-disruption risk)", () => {
  const loaded = board({ lp: 8000, monsters: [{ atk: 2500, def: 0, faceUp: true, defense: false }] }, { lp: 8000, monsters: [], backrowCount: 2 });
  const m = battle({ attacks: [{ code: 1, can_direct: true }] });
  it("holds a non-essential chip attack when the opponent looks loaded (high risk)", () => {
    expect((aiDecide(m, ctx({ 1: 2500 }, [], 0, 0, [2500], loaded, 0.7), "hard") as { action: number }).action).toBe(SelectBattleCMDAction.TO_M2);
  });
  it("presses the attack when the opponent looks tapped out (low risk), same board", () => {
    expect((aiDecide(m, ctx({ 1: 2500 }, [], 0, 0, [2500], loaded, 0.1), "hard") as { action: number }).action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
  });
  it("still takes a LETHAL swing regardless of risk", () => {
    const lethalBoard = board({ monsters: [] }, { lp: 2000, monsters: [], backrowCount: 3 });
    const lm = battle({ attacks: [{ code: 1, can_direct: true }, { code: 2, can_direct: true }] });
    expect((aiDecide(lm, ctx({ 1: 1500, 2: 1500 }, [], 0, 0, [], lethalBoard, 0.9), "hard") as { action: number }).action).toBe(SelectBattleCMDAction.SELECT_BATTLE);
  });
});

describe("aiDecide — posture-driven idle play", () => {
  it("sets a monster defensively while behind instead of summoning into a beater", () => {
    const behind = board({ lp: 1000, handCount: 2, monsters: [] }, { lp: 8000, handCount: 4, monsters: [{ atk: 2800, def: 0, faceUp: true, defense: false }], backrowCount: 2 });
    const m = idle({ summons: [{ code: 1 }], monster_sets: [{ code: 1 }] });
    const r = aiDecide(m, ctx({ 1: 1500 }, [2800], 0, 0, [], behind), "normal") as { action: number };
    expect(r.action).toBe(SelectIdleCMDAction.SELECT_MONSTER_SET);
  });
  it("conserves an optional chain response against a quiet board (both difficulties)", () => {
    const ahead = board({ lp: 8000, handCount: 5, monsters: [{ atk: 2500, def: 0, faceUp: true, defense: false }], backrowCount: 2 }, { lp: 4000, handCount: 0, monsters: [], backrowCount: 0 });
    const m = chain({ selects: [{ code: 9 }] });
    expect((aiDecide(m, ctx({}, [], 0, 0, [], ahead), "hard") as { index: number | null }).index).toBe(null);
    expect((aiDecide(m, ctx({}, [], 0, 0, [], ahead), "normal") as { index: number | null }).index).toBe(null);
  });
});
