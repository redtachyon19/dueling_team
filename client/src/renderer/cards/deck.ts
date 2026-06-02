// client/src/renderer/cards/deck.ts
//
// Pure deck-building rules: which zone a card belongs to, copy limits, and
// validation. No React, no I/O — unit-testable.

import type { CardData, Deck, BanlistRevision, BanStatus, GenesysRevision } from "@duel/shared";

export type Zone = "main" | "extra" | "side";

// --- Banlist status --------------------------------------------------------

/** id → status map plus the revision date, for fast per-card lookups. */
export interface BanlistLookup {
  date: string;
  status: Map<number, "Forbidden" | "Limited" | "Semi-Limited">;
}

/** Build a lookup from a loaded banlist revision. */
export function buildBanlistLookup(rev: BanlistRevision): BanlistLookup {
  const status = new Map<number, "Forbidden" | "Limited" | "Semi-Limited">();
  for (const c of rev.forbidden) status.set(c.id, "Forbidden");
  for (const c of rev.limited) status.set(c.id, "Limited");
  for (const c of rev.semiLimited) status.set(c.id, "Semi-Limited");
  return { date: rev.date, status };
}

/**
 * A card's status under the selected banlist. "Unreleased" if the card's TCG
 * release date is after the banlist's date; otherwise its listed status, or
 * "Unlimited" if not on the list.
 */
export function banStatusOf(card: CardData, lookup: BanlistLookup | null): BanStatus {
  if (!lookup) return "Unlimited";
  if (card.tcgDate && card.tcgDate > lookup.date) return "Unreleased";
  return lookup.status.get(card.id) ?? "Unlimited";
}

// --- Genesys points --------------------------------------------------------

/** id → point cost map plus the revision date and deck point cap. */
export interface GenesysLookup {
  date: string;
  pointCap: number | null;
  points: Map<number, number>;
}

/** Build a lookup from a loaded Genesys revision. Unlisted cards cost 0. */
export function buildGenesysLookup(rev: GenesysRevision): GenesysLookup {
  const points = new Map<number, number>();
  for (const c of rev.cards) points.set(c.id, c.points);
  return { date: rev.date, pointCap: rev.pointCap, points };
}

/** A card's Genesys point cost under the selected list (0 if unlisted/free). */
export function genesysCostOf(card: CardData, lookup: GenesysLookup | null): number {
  if (!lookup) return 0;
  return lookup.points.get(card.id) ?? 0;
}

/** Total Genesys points across every copy in all three zones. */
export function deckGenesysPoints(deck: Deck, lookup: GenesysLookup | null): number {
  if (!lookup) return 0;
  let sum = 0;
  for (const zone of ["main", "extra", "side"] as Zone[]) {
    for (const id of deck[zone]) sum += lookup.points.get(id) ?? 0;
  }
  return sum;
}

// Frame types that belong in the Extra deck (incl. pendulum variants of each).
const EXTRA_FRAMES = new Set([
  "fusion",
  "synchro",
  "xyz",
  "link",
  "fusion_pendulum",
  "synchro_pendulum",
  "xyz_pendulum",
]);

/** Whether a card is an Extra-deck monster. */
export function isExtraDeckCard(card: CardData): boolean {
  return EXTRA_FRAMES.has(card.frameType);
}

/**
 * The zone a card auto-routes to when added. Extra-deck monsters always go to
 * Extra; everything else to Main. (Side is only reached by an explicit drop on
 * the Side zone — handled in the UI, not here.)
 */
export function defaultZone(card: CardData): Zone {
  return isExtraDeckCard(card) ? "extra" : "main";
}

export const LIMITS = {
  copies: 3,
  mainMin: 40,
  mainMax: 60,
  extraMax: 15,
  sideMax: 15,
} as const;

/** Total copies of a passcode across all three zones. */
export function copiesOf(deck: Deck, id: number): number {
  const count = (a: number[]) => a.filter((x) => x === id).length;
  return count(deck.main) + count(deck.extra) + count(deck.side);
}

export interface AddResult {
  ok: boolean;
  reason?: string;
  deck: Deck;
}

/**
 * Add one copy of a card to a zone, honoring auto-route and (optionally)
 * limits. Returns a new Deck plus whether it succeeded. An Extra-deck card
 * dropped on Main/anywhere is rerouted to Extra; Side accepts any card as-is.
 */
export function addCard(deck: Deck, card: CardData, requestedZone: Zone): AddResult {
  // Auto-route: Main/Extra are determined by the card; Side is honored as-is.
  let zone: Zone = requestedZone;
  if (requestedZone !== "side") zone = defaultZone(card);

  if (deck.enforceLimits) {
    if (copiesOf(deck, card.id) >= LIMITS.copies) {
      return { ok: false, reason: `Max ${LIMITS.copies} copies of a card`, deck };
    }
    if (zone === "main" && deck.main.length >= LIMITS.mainMax) {
      return { ok: false, reason: `Main deck max ${LIMITS.mainMax}`, deck };
    }
    if (zone === "extra" && deck.extra.length >= LIMITS.extraMax) {
      return { ok: false, reason: `Extra deck max ${LIMITS.extraMax}`, deck };
    }
    if (zone === "side" && deck.side.length >= LIMITS.sideMax) {
      return { ok: false, reason: `Side deck max ${LIMITS.sideMax}`, deck };
    }
  }

  return { ok: true, deck: { ...deck, [zone]: [...deck[zone], card.id] } };
}

/** Remove ONE copy of a passcode from a zone. */
export function removeCard(deck: Deck, zone: Zone, id: number): Deck {
  const i = deck[zone].indexOf(id);
  if (i === -1) return deck;
  const next = [...deck[zone]];
  next.splice(i, 1);
  return { ...deck, [zone]: next };
}

export interface DeckIssue {
  level: "error" | "warn";
  message: string;
}

/** Validate against TCG limits (only meaningful when enforceLimits is on). */
export function validateDeck(deck: Deck): DeckIssue[] {
  const issues: DeckIssue[] = [];
  if (deck.main.length < LIMITS.mainMin)
    issues.push({ level: "warn", message: `Main deck has ${deck.main.length} (min ${LIMITS.mainMin})` });
  if (deck.main.length > LIMITS.mainMax)
    issues.push({ level: "error", message: `Main deck has ${deck.main.length} (max ${LIMITS.mainMax})` });
  if (deck.extra.length > LIMITS.extraMax)
    issues.push({ level: "error", message: `Extra deck has ${deck.extra.length} (max ${LIMITS.extraMax})` });
  if (deck.side.length > LIMITS.sideMax)
    issues.push({ level: "error", message: `Side deck has ${deck.side.length} (max ${LIMITS.sideMax})` });
  return issues;
}

/** Collapse a zone's flat passcode list into [id, count] pairs, first-seen order. */
export function groupZone(ids: number[]): Array<[number, number]> {
  const order: number[] = [];
  const counts = new Map<number, number>();
  for (const id of ids) {
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return order.map((id) => [id, counts.get(id)!]);
}
