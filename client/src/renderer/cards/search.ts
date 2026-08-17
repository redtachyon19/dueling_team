import type { CardData, CardQuery, CardSort, CardSupertype } from "@duel/shared";

export function supertypeOf(card: CardData): CardSupertype {
  if (card.frameType === "spell") return "Spell";
  if (card.frameType === "trap") return "Trap";
  return "Monster";
}

function baseFrame(frameType: string): string {
  return frameType.replace(/_pendulum$/, "");
}

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

const setCodesOf = (c: CardData): string => c.sets.map((s) => s.code).join(" ").toLowerCase();

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

  return q.sort && q.sort !== "relevance" ? sortCards(filtered, q.sort) : filtered;
}

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

function typeRank(c: CardData): number {
  if (c.frameType === "spell") return 1;
  if (c.frameType === "trap") return 2;
  return 0;
}

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
    default: return () => 0;
  }
}

export function sortCards(cards: readonly CardData[], sort: CardSort): CardData[] {
  const cmp = sortComparator(sort);
  return cards
    .map((card, i) => ({ card, i }))
    .sort((a, b) => cmp(a.card, b.card) || a.i - b.i)
    .map((m) => m.card);
}

export interface PreparedCard {
  card: CardData;
  name: string;
  desc: string;
  setCodes: string;
  passcode: string;
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

  if (sort && sort !== "relevance") return sortCards(matches.map((m) => m.card), sort);

  if (!text) return matches.map((m) => m.card);

  return matches
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((m) => m.card);
}

export interface ArtworkTile {
  card: CardData;
  imageId: number;
}

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
