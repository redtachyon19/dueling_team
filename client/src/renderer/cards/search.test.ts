import { describe, it, expect } from "vitest";
import type { CardData } from "@duel/shared";
import { filterCards, runQuery, prepareCards, supertypeOf, deriveFacets, expandArtworks } from "./search.ts";

function card(overrides: Partial<CardData>): CardData {
  return {
    id: 1,
    name: "Test",
    type: "Effect Monster",
    frameType: "effect",
    desc: "",
    race: "Dragon",
    archetype: null,
    attribute: "DARK",
    atk: 1000,
    def: 1000,
    level: 4,
    scale: null,
    linkval: null,
    linkmarkers: null,
    images: [1],
    banlistTcg: null,
    tcgDate: null,
    sets: [],
    ...overrides,
  };
}

const cards: CardData[] = [
  card({ id: 1, name: "Blue-Eyes White Dragon", desc: "This legendary dragon", attribute: "LIGHT", race: "Dragon", level: 8, frameType: "normal", archetype: "Blue-Eyes" }),
  card({ id: 2, name: "Dark Magician", desc: "The ultimate wizard", attribute: "DARK", race: "Spellcaster", level: 7, frameType: "normal", archetype: "Dark Magician" }),
  card({ id: 3, name: "Mystical Space Typhoon", desc: "Target 1 Spell/Trap; destroy it.", attribute: null, race: "Quick-Play", level: null, frameType: "spell", archetype: null }),
  card({ id: 4, name: "Mirror Force", desc: "When an opponent's monster declares an attack", attribute: null, race: "Normal", level: null, frameType: "trap", archetype: null }),
];

describe("supertypeOf", () => {
  it("classifies by frame", () => {
    expect(supertypeOf(cards[0]!)).toBe("Monster");
    expect(supertypeOf(cards[2]!)).toBe("Spell");
    expect(supertypeOf(cards[3]!)).toBe("Trap");
  });
});

describe("filterCards", () => {
  it("returns all on empty query", () => {
    expect(filterCards(cards, {})).toHaveLength(4);
  });
  it("matches text against name and desc", () => {
    expect(filterCards(cards, { text: "dragon" }).map((c) => c.id)).toEqual([1]);
    expect(filterCards(cards, { text: "wizard" }).map((c) => c.id)).toEqual([2]);
  });
  it("filters by attribute and race", () => {
    expect(filterCards(cards, { attribute: "DARK" }).map((c) => c.id)).toEqual([2]);
    expect(filterCards(cards, { race: "Dragon" }).map((c) => c.id)).toEqual([1]);
  });
  it("filters by supertype", () => {
    expect(filterCards(cards, { supertype: "Spell" }).map((c) => c.id)).toEqual([3]);
  });
  it("filters by level range and excludes level-less cards", () => {
    expect(filterCards(cards, { levelMin: 8 }).map((c) => c.id)).toEqual([1]);
    expect(filterCards(cards, { levelMin: 7, levelMax: 8 }).map((c) => c.id)).toEqual([1, 2]);
    expect(filterCards(cards, { levelMin: 1 }).map((c) => c.id)).toEqual([1, 2]); // spells/traps have no level
  });
  it("ANDs constraints together", () => {
    expect(filterCards(cards, { text: "magician", attribute: "DARK" }).map((c) => c.id)).toEqual([2]);
    expect(filterCards(cards, { text: "magician", attribute: "LIGHT" })).toHaveLength(0);
  });
});

describe("runQuery (indexed path) matches filterCards", () => {
  const prepared = prepareCards(cards);
  const queries = [
    {},
    { text: "dragon" },
    { text: "wizard" },
    { attribute: "DARK" },
    { race: "Dragon" },
    { supertype: "Spell" as const },
    { levelMin: 7, levelMax: 8 },
    { text: "magician", attribute: "DARK" },
    { text: "MAGICIAN" }, // case-insensitivity
  ];
  for (const q of queries) {
    it(`parity for ${JSON.stringify(q)}`, () => {
      expect(runQuery(prepared, q).map((c) => c.id)).toEqual(filterCards(cards, q).map((c) => c.id));
    });
  }
});

describe("runQuery ranks titles above effect text", () => {
  const ranked = prepareCards([
    card({ id: 10, name: "Polymerization", desc: "Fusion Summon 1 monster." }), // desc-only
    card({ id: 11, name: "Instant Fusion", desc: "Pay 1000 LP." }), // name contains
    card({ id: 12, name: "Fusion Recovery", desc: "Add 1 card." }), // name prefix
  ]);
  it("orders: name-prefix, then name-contains, then desc-only", () => {
    expect(runQuery(ranked, { text: "fusion" }).map((c) => c.id)).toEqual([12, 11, 10]);
  });
  it("a pure title match outranks a pure effect-text match", () => {
    const set = prepareCards([
      card({ id: 20, name: "Mirror Force", desc: "Destroy attacking monsters." }), // desc-only for 'destroy'
      card({ id: 21, name: "Destroy", desc: "Do nothing." }), // name match
    ]);
    expect(runQuery(set, { text: "destroy" }).map((c) => c.id)).toEqual([21, 20]);
  });
});

describe("runQuery searches set number and passcode, ranked below title", () => {
  const cardsRanked = prepareCards([
    card({ id: 11111111, name: "Duad Promo", desc: "no" }), // name match
    card({ id: 22222222, name: "Other Card", desc: "no", sets: [{ code: "DUAD-EN068", name: "Duelist's Advance", rarity: "Common" }] }), // set-code match
    card({ id: 98349765, name: "Unrelated", desc: "no" }), // passcode match
    card({ id: 33333333, name: "Nope", desc: "mentions duad somewhere" }), // effect-text match
  ]);
  it("finds a card by its set code", () => {
    expect(runQuery(cardsRanked, { text: "DUAD-EN068" }).map((c) => c.id)).toEqual([22222222]);
  });
  it("finds a card by its passcode", () => {
    expect(runQuery(cardsRanked, { text: "98349765" }).map((c) => c.id)).toEqual([98349765]);
  });
  it("ranks title > set number > passcode > effect text", () => {
    // 'duad' hits the title (11111111), a set code (22222222), and effect text (33333333).
    expect(runQuery(cardsRanked, { text: "duad" }).map((c) => c.id)).toEqual([11111111, 22222222, 33333333]);
  });
});

describe("expandArtworks", () => {
  it("emits one tile per DISTINCT image id, preserving order", () => {
    // Upstream sometimes repeats an artwork id; each distinct art gets one tile.
    const tiles = expandArtworks([card({ id: 90590303, images: [90590303, 90590303, 90590304, 90590304] })]);
    expect(tiles.map((t) => t.imageId)).toEqual([90590303, 90590304]);
  });
  it("emits one tile per image id, preserving order", () => {
    const tiles = expandArtworks([
      card({ id: 100, images: [100, 101, 102] }),
      card({ id: 200, images: [200] }),
    ]);
    expect(tiles.map((t) => t.imageId)).toEqual([100, 101, 102, 200]);
    expect(tiles[1]!.card.id).toBe(100); // alt art still maps to its card
  });
  it("falls back to card id when images[] is empty", () => {
    const tiles = expandArtworks([card({ id: 300, images: [] })]);
    expect(tiles.map((t) => t.imageId)).toEqual([300]);
  });
});

describe("deriveFacets", () => {
  it("collects distinct sorted values", () => {
    const f = deriveFacets(cards);
    expect(f.attributes).toEqual(["DARK", "LIGHT"]);
    expect(f.frameTypes).toEqual(["normal", "spell", "trap"]);
    expect(f.archetypes).toEqual(["Blue-Eyes", "Dark Magician"]);
  });
});
