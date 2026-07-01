import { describe, it, expect } from "vitest";
import type { CardData, Deck } from "@duel/shared";
import {
  isExtraDeckCard,
  defaultZone,
  addCard,
  removeCard,
  copiesOf,
  validateDeck,
  groupZone,
  buildBanlistLookup,
  buildGenesysLookup,
  banStatusOf,
  validateDeckForFormat,
  LIMITS,
} from "./deck.ts";
import type { BanlistRevision, GenesysRevision } from "@duel/shared";

function card(o: Partial<CardData>): CardData {
  return {
    id: 1, name: "C", type: "Effect Monster", frameType: "effect", desc: "", race: "Dragon",
    archetype: null, attribute: "DARK", atk: 0, def: 0, level: 4, scale: null,
    linkval: null, linkmarkers: null, images: [1], banlistTcg: null, tcgDate: null, sets: [], ...o,
  };
}
function emptyDeck(over: Partial<Deck> = {}): Deck {
  return {
    id: "d1", name: "Test", tags: [], main: [], extra: [], side: [],
    enforceLimits: true, createdAt: "", updatedAt: "", ...over,
  };
}

describe("zone classification", () => {
  it("routes extra-deck frames to extra", () => {
    for (const ft of ["fusion", "synchro", "xyz", "link", "xyz_pendulum"]) {
      expect(isExtraDeckCard(card({ frameType: ft }))).toBe(true);
      expect(defaultZone(card({ frameType: ft }))).toBe("extra");
    }
  });
  it("routes main-deck frames to main", () => {
    for (const ft of ["effect", "normal", "spell", "trap", "ritual", "normal_pendulum"]) {
      expect(isExtraDeckCard(card({ frameType: ft }))).toBe(false);
      expect(defaultZone(card({ frameType: ft }))).toBe("main");
    }
  });
});

describe("addCard auto-route", () => {
  it("sends an extra-deck card to extra even when main is requested", () => {
    const r = addCard(emptyDeck(), card({ id: 5, frameType: "synchro" }), "main");
    expect(r.ok).toBe(true);
    expect(r.deck.extra).toEqual([5]);
    expect(r.deck.main).toEqual([]);
  });
  it("honors side requests as-is", () => {
    const r = addCard(emptyDeck(), card({ id: 5, frameType: "effect" }), "side");
    expect(r.deck.side).toEqual([5]);
  });
});

describe("addCard limits", () => {
  it("blocks a 4th copy when enforcing", () => {
    let d = emptyDeck({ main: [7, 7, 7] });
    const r = addCard(d, card({ id: 7 }), "main");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/copies/);
  });
  it("allows 4th copy when limits are off", () => {
    const d = emptyDeck({ main: [7, 7, 7], enforceLimits: false });
    const r = addCard(d, card({ id: 7 }), "main");
    expect(r.ok).toBe(true);
    expect(copiesOf(r.deck, 7)).toBe(4);
  });
  it("blocks main over max", () => {
    const d = emptyDeck({ main: Array.from({ length: LIMITS.mainMax }, (_, i) => i) });
    expect(addCard(d, card({ id: 999 }), "main").ok).toBe(false);
  });
});

describe("removeCard", () => {
  it("removes one copy only", () => {
    const d = emptyDeck({ main: [7, 7, 8] });
    expect(removeCard(d, "main", 7).main).toEqual([7, 8]);
  });
});

describe("validateDeck", () => {
  it("warns under 40, errors over caps", () => {
    expect(validateDeck(emptyDeck({ main: [1, 2, 3] })).some((i) => i.level === "warn")).toBe(true);
    const big = emptyDeck({ extra: Array.from({ length: 16 }, (_, i) => i) });
    expect(validateDeck(big).some((i) => i.level === "error")).toBe(true);
  });
});

describe("groupZone", () => {
  it("collapses to [id,count] preserving first-seen order", () => {
    expect(groupZone([8, 7, 8, 8, 7])).toEqual([[8, 3], [7, 2]]);
  });
});

describe("validateDeckForFormat", () => {
  const fillIds = Array.from({ length: 40 }, (_, i) => 100 + i);
  const cardsMap = (list: CardData[]) => new Map(list.map((c) => [c.id, c] as const));
  const baseCards = cardsMap(fillIds.map((id) => card({ id, name: `V${id}`, frameType: "effect" })));

  it("advanced: a legal 40-card deck has no issues", () => {
    const deck = emptyDeck({ main: [...fillIds] });
    expect(validateDeckForFormat(deck, "advanced", { cards: baseCards, banlist: null, genesys: null })).toEqual([]);
  });

  it("advanced: an undersized Main is an error", () => {
    const deck = emptyDeck({ main: [100, 101, 102] });
    const issues = validateDeckForFormat(deck, "advanced", { cards: baseCards, banlist: null, genesys: null });
    expect(issues.some((i) => i.level === "error" && /min/.test(i.message))).toBe(true);
  });

  it("advanced: a Forbidden card is rejected", () => {
    const rev: BanlistRevision = { date: "2025-01-01", format: "TCG", source: "", fetchedAt: "", forbidden: [{ id: 100, name: "V100" }], limited: [], semiLimited: [] };
    const deck = emptyDeck({ main: [...fillIds] });
    const issues = validateDeckForFormat(deck, "advanced", { cards: baseCards, banlist: buildBanlistLookup(rev), genesys: null });
    expect(issues.some((i) => /Forbidden/.test(i.message))).toBe(true);
  });

  it("advanced: more copies than a Limited card allows is rejected", () => {
    const rev: BanlistRevision = { date: "2025-01-01", format: "TCG", source: "", fetchedAt: "", forbidden: [], limited: [{ id: 100, name: "V100" }], semiLimited: [] };
    const deck = emptyDeck({ main: [100, 100, ...fillIds.slice(1, 39)] }); // 2 of a Limited + 38 = 40
    const issues = validateDeckForFormat(deck, "advanced", { cards: baseCards, banlist: buildBanlistLookup(rev), genesys: null });
    expect(issues.some((i) => /max 1/.test(i.message))).toBe(true);
  });

  it("genesys: Link and Pendulum monsters are rejected", () => {
    const cards = cardsMap([
      ...fillIds.map((id) => card({ id, frameType: "effect" })),
      card({ id: 200, name: "Linky", frameType: "link" }),
      card({ id: 201, name: "Pendy", frameType: "normal_pendulum" }),
    ]);
    const deck = emptyDeck({ main: [201, ...fillIds.slice(0, 39)], extra: [200] });
    const issues = validateDeckForFormat(deck, "genesys", { cards, banlist: null, genesys: null });
    expect(issues.some((i) => /Link/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Pendulum/.test(i.message))).toBe(true);
  });

  it("genesys: a deck over the points cap is rejected", () => {
    const rev: GenesysRevision = { date: "2025-01-01", pointCap: 100, source: "", fetchedAt: "", cards: [{ id: 100, name: "V100", points: 60 }, { id: 101, name: "V101", points: 60 }] };
    const deck = emptyDeck({ main: [...fillIds] }); // 60 + 60 = 120 > 100
    const issues = validateDeckForFormat(deck, "genesys", { cards: baseCards, banlist: null, genesys: buildGenesysLookup(rev) });
    expect(issues.some((i) => /over the cap/.test(i.message))).toBe(true);
  });

  it("genesys: a legal deck under the cap passes", () => {
    const rev: GenesysRevision = { date: "2025-01-01", pointCap: 100, source: "", fetchedAt: "", cards: [{ id: 100, name: "V100", points: 40 }] };
    const deck = emptyDeck({ main: [...fillIds] }); // 40 ≤ 100, all effect monsters
    expect(validateDeckForFormat(deck, "genesys", { cards: baseCards, banlist: null, genesys: buildGenesysLookup(rev) })).toEqual([]);
  });
});

describe("banStatusOf", () => {
  const rev: BanlistRevision = {
    date: "2020-01-01", format: "TCG", source: "", fetchedAt: "",
    forbidden: [{ id: 1, name: "F" }],
    limited: [{ id: 2, name: "L" }],
    semiLimited: [{ id: 3, name: "S" }],
  };
  const lookup = buildBanlistLookup(rev);
  it("maps listed statuses", () => {
    expect(banStatusOf(card({ id: 1 }), lookup)).toBe("Forbidden");
    expect(banStatusOf(card({ id: 2 }), lookup)).toBe("Limited");
    expect(banStatusOf(card({ id: 3 }), lookup)).toBe("Semi-Limited");
  });
  it("unlisted is Unlimited", () => {
    expect(banStatusOf(card({ id: 99, tcgDate: "2010-01-01" }), lookup)).toBe("Unlimited");
  });
  it("future release is Unreleased relative to the banlist date", () => {
    expect(banStatusOf(card({ id: 99, tcgDate: "2021-06-01" }), lookup)).toBe("Unreleased");
  });
  it("no banlist selected → Unlimited", () => {
    expect(banStatusOf(card({ id: 1 }), null)).toBe("Unlimited");
  });
});
