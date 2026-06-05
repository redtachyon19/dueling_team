// client/src/renderer/cards/search.ts
//
// Pure, dependency-free card search helpers. No React, no I/O — just functions
// over an in-memory CardData[]. This is a UI/data-query concern (not game
// rules), so it lives in the renderer rather than @duel/engine, and is kept
// pure so it can be unit-tested without Electron.

import type { CardData, CardQuery, CardSort, CardSupertype } from "@duel/shared";

/** Broad category of a card, derived from its frame. */
export function supertypeOf(card: CardData): CardSupertype {
  if (card.frameType === "spell") return "Spell";
  if (card.frameType === "trap") return "Trap";
  return "Monster";
}

/** Base frame with any "_pendulum" suffix stripped ("effect_pendulum" → "effect"). */
function baseFrame(frameType: string): string {
  return frameType.replace(/_pendulum$/, "");
}

/**
 * Whether a card's frame matches any selected Frame chip. Base-frame chips
 * ("effect", "fusion", …) match the plain frame and its Pendulum variant; the
 * special "pendulum" chip matches any Pendulum card. OR semantics within the set.
 */
export function frameMatchesAny(frameType: string, selected: readonly string[]): boolean {
  const isPendulum = frameType.includes("pendulum");
  const base = baseFrame(frameType);
  for (const f of selected) {
    if (f === "pendulum") {
      if (isPendulum) return true;
    } else if (base === f) {
      return true;
    }
  }
  return false;
}

/** Space-joined, lowercased set codes for a card, e.g. "duad-en068 lob-en001". */
const setCodesOf = (c: CardData): string => c.sets.map((s) => s.code).join(" ").toLowerCase();

/** Apply a query to a card list. Empty/absent fields are ignored. The free-text
 *  query matches a card's name, set codes (set number), passcode, OR effect
 *  text. (Reference impl; the app uses the indexed `runQuery`, which also ranks
 *  these.) */
export function filterCards(cards: readonly CardData[], q: CardQuery): CardData[] {
  const text = q.text?.trim().toLowerCase();
  const { attribute, race, archetype, frameType, supertype, levelMin, levelMax,
    atkMin, atkMax, defMin, defMax, supertypes, frames, attributes } = q;

  const filtered = cards.filter((c) => {
    if (text) {
      const hit =
        c.name.toLowerCase().includes(text) ||
        setCodesOf(c).includes(text) ||
        String(c.id).startsWith(text) ||
        c.desc.toLowerCase().includes(text);
      if (!hit) return false;
    }
    if (attribute && c.attribute !== attribute) return false;
    if (race && c.race !== race) return false;
    if (archetype && c.archetype !== archetype) return false;
    if (frameType && c.frameType !== frameType) return false;
    if (supertype && supertypeOf(c) !== supertype) return false;
    if (supertypes?.length && !supertypes.includes(supertypeOf(c))) return false;
    if (frames?.length && !frameMatchesAny(c.frameType, frames)) return false;
    if (attributes?.length && (c.attribute == null || !attributes.includes(c.attribute))) return false;
    if (levelMin != null && (c.level == null || c.level < levelMin)) return false;
    if (levelMax != null && (c.level == null || c.level > levelMax)) return false;
    if (atkMin != null && (c.atk == null || c.atk < atkMin)) return false;
    if (atkMax != null && (c.atk == null || c.atk > atkMax)) return false;
    if (defMin != null && (c.def == null || c.def < defMin)) return false;
    if (defMax != null && (c.def == null || c.def > defMax)) return false;
    return true;
  });

  // Filter parity with runQuery: when an explicit sort is requested, apply it.
  return q.sort && q.sort !== "relevance" ? sortCards(filtered, q.sort) : filtered;
}

/** Push nullish values to the end regardless of direction; else compare by `dir`. */
function cmpNum(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * dir;
}
function cmpStr(a: string | null, b: string | null, dir: 1 | -1): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b) * dir;
}

/** Type ordering for the "type" sort: Monsters first, then Spells, then Traps. */
function typeRank(c: CardData): number {
  if (c.frameType === "spell") return 1;
  if (c.frameType === "trap") return 2;
  return 0;
}

/** Comparator for an explicit (non-relevance) sort key. */
function sortComparator(sort: CardSort): (a: CardData, b: CardData) => number {
  switch (sort) {
    case "name": return (a, b) => a.name.localeCompare(b.name);
    case "atk-asc": return (a, b) => cmpNum(a.atk, b.atk, 1);
    case "atk-desc": return (a, b) => cmpNum(a.atk, b.atk, -1);
    case "def-asc": return (a, b) => cmpNum(a.def, b.def, 1);
    case "def-desc": return (a, b) => cmpNum(a.def, b.def, -1);
    case "level-asc": return (a, b) => cmpNum(a.level, b.level, 1);
    case "level-desc": return (a, b) => cmpNum(a.level, b.level, -1);
    case "type": return (a, b) =>
      typeRank(a) - typeRank(b) || a.frameType.localeCompare(b.frameType) || a.name.localeCompare(b.name);
    case "newest": return (a, b) => cmpStr(a.tcgDate, b.tcgDate, -1);
    default: return () => 0; // "relevance" → no reordering
  }
}

/** Stable sort a card list by an explicit sort key (original order breaks ties). */
export function sortCards(cards: readonly CardData[], sort: CardSort): CardData[] {
  const cmp = sortComparator(sort);
  return cards
    .map((card, i) => ({ card, i }))
    .sort((a, b) => cmp(a.card, b.card) || a.i - b.i)
    .map((m) => m.card);
}

/**
 * A card with its searchable text pre-lowercased and its supertype precomputed.
 * Building this once (when the DB loads) avoids re-lowercasing ~14k name+desc
 * strings on every keystroke — the difference between a sluggish and an instant
 * search.
 */
export interface PreparedCard {
  card: CardData;
  name: string; // lowercased name
  desc: string; // lowercased card text
  setCodes: string; // lowercased, space-joined set codes (the "set number")
  passcode: string; // the card's passcode as a string
  supertype: CardSupertype;
}

export function prepareCards(cards: readonly CardData[]): PreparedCard[] {
  return cards.map((card) => ({
    card,
    name: card.name.toLowerCase(),
    desc: card.desc.toLowerCase(),
    setCodes: setCodesOf(card),
    passcode: String(card.id),
    supertype: supertypeOf(card),
  }));
}

/**
 * Filter a prepared (indexed) card list.
 *
 * When a free-text query is present, results are RANKED by which field matched,
 * in this priority order (title first, then set number, then password):
 *   0 — name starts with the query   (best)
 *   1 — name contains the query
 *   2 — a set code (set number) matches
 *   3 — the passcode (password) starts with the query
 *   4 — only the effect text matches (worst)
 * Within a rank, original DB order is preserved (the sort is stable). With no
 * text query, order is unchanged.
 */
export function runQuery(prepared: readonly PreparedCard[], q: CardQuery): CardData[] {
  const text = q.text?.trim().toLowerCase();
  const { attribute, race, archetype, frameType, supertype, levelMin, levelMax,
    atkMin, atkMax, defMin, defMax, supertypes, frames, attributes, sort } = q;

  const matches: Array<{ card: CardData; rank: number }> = [];

  for (const p of prepared) {
    const c = p.card;

    let rank = 0;
    if (text) {
      if (p.name.startsWith(text)) rank = 0;
      else if (p.name.includes(text)) rank = 1;
      else if (p.setCodes.includes(text)) rank = 2;
      else if (p.passcode.startsWith(text)) rank = 3;
      else if (p.desc.includes(text)) rank = 4;
      else continue;
    }

    if (attribute && c.attribute !== attribute) continue;
    if (race && c.race !== race) continue;
    if (archetype && c.archetype !== archetype) continue;
    if (frameType && c.frameType !== frameType) continue;
    if (supertype && p.supertype !== supertype) continue;
    if (supertypes?.length && !supertypes.includes(p.supertype)) continue;
    if (frames?.length && !frameMatchesAny(c.frameType, frames)) continue;
    if (attributes?.length && (c.attribute == null || !attributes.includes(c.attribute))) continue;
    if (levelMin != null && (c.level == null || c.level < levelMin)) continue;
    if (levelMax != null && (c.level == null || c.level > levelMax)) continue;
    if (atkMin != null && (c.atk == null || c.atk < atkMin)) continue;
    if (atkMax != null && (c.atk == null || c.atk > atkMax)) continue;
    if (defMin != null && (c.def == null || c.def < defMin)) continue;
    if (defMax != null && (c.def == null || c.def > defMax)) continue;

    matches.push({ card: c, rank });
  }

  // An explicit sort overrides relevance ranking, with or without a text query.
  if (sort && sort !== "relevance") return sortCards(matches.map((m) => m.card), sort);

  // No text query → no ranking needed; preserve DB order.
  if (!text) return matches.map((m) => m.card);

  // Stable sort by rank: titles first, then effect-text-only matches.
  return matches
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((m) => m.card);
}

/** A single artwork of a card — one card can have several alternate arts. */
export interface ArtworkTile {
  card: CardData;
  imageId: number;
}

/**
 * Expand a card list into one entry per DISTINCT artwork ID, preserving order:
 * each card contributes each of its `images[]` once, so the grid shows every
 * alternate art as its own tile. The dedup matters because upstream
 * (YGOPRODeck) sometimes lists the same artwork passcode multiple times in a
 * card's images — without it, a 2-art card renders 4+ duplicate tiles.
 */
export function expandArtworks(cards: readonly CardData[]): ArtworkTile[] {
  const out: ArtworkTile[] = [];
  for (const card of cards) {
    const ids = card.images.length ? card.images : [card.id];
    const seen = new Set<number>();
    for (const imageId of ids) {
      if (seen.has(imageId)) continue;
      seen.add(imageId);
      out.push({ card, imageId });
    }
  }
  return out;
}

export interface Facets {
  attributes: string[];
  races: string[];
  frameTypes: string[];
  archetypes: string[];
}

/**
 * Collect the distinct, sorted values present in the loaded card set, so the
 * filter dropdowns always match the actual data instead of a hardcoded list.
 */
export function deriveFacets(cards: readonly CardData[]): Facets {
  const attributes = new Set<string>();
  const races = new Set<string>();
  const frameTypes = new Set<string>();
  const archetypes = new Set<string>();

  for (const c of cards) {
    if (c.attribute) attributes.add(c.attribute);
    if (c.race) races.add(c.race);
    if (c.frameType) frameTypes.add(c.frameType);
    if (c.archetype) archetypes.add(c.archetype);
  }

  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return {
    attributes: sorted(attributes),
    races: sorted(races),
    frameTypes: sorted(frameTypes),
    archetypes: sorted(archetypes),
  };
}
