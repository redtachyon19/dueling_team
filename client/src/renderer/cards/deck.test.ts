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
  banStatusOf,
  LIMITS,
} from "./deck.ts";
import type { BanlistRevision } from "@duel/shared";

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
