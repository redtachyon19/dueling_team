// @duel/shared
//
// Frozen contracts: State, Command union, socket protocol, AI interface,
// card-data shape. This package has zero runtime dependencies and is the
// only thing every other package is allowed to depend on.
//
// The duel contracts (DuelState / DuelEvent / DuelPrompt / DuelResponse) live in
// ./duel.ts and are re-exported below. ocgcore is the rules authority; see that
// file. The card-data shape below is the canonical definition used by the Cards
// page, the importers, and the duel card readers.

export * from "./duel";

// ---------------------------------------------------------------------------
// Card data
// ---------------------------------------------------------------------------
//
// The shape of a single card as written by scripts/import-cards.ts into
// assets/cards/db.json (TCG only). Keep this in sync with the
// `normalize()` output in that importer — this type is the canonical
// definition; the importer mirrors it.

/** Broad card category, derived from `frameType`. */
export type CardSupertype = "Monster" | "Spell" | "Trap";

/** A single printing of a card in a set. */
export interface CardPrint {
  /** Full set code for this print, e.g. "LOB-EN001" (or just "LOB" if the
   *  per-print number is unknown — true for Yugipedia-backfilled prints). */
  code: string;
  /** Set name, e.g. "Legend of Blue Eyes White Dragon" ("" if only the code is known). */
  name: string;
  /** Rarity of this print, e.g. "Super Rare", or null when unknown. */
  rarity: string | null;
}

export interface CardData {
  /** Primary passcode. */
  id: number;
  name: string;
  /** Full type string, e.g. "Effect Monster", "Spell Card". */
  type: string;
  /** Frame, e.g. "effect" | "normal" | "spell" | "trap" | "xyz" | "link". */
  frameType: string;
  /** Card text / effect. */
  desc: string;
  /** Monster type ("Dragon") or spell/trap kind ("Continuous"). */
  race: string;
  archetype: string | null;
  attribute: string | null;
  atk: number | null;
  def: number | null;
  /** Level or Rank. */
  level: number | null;
  /** Pendulum scale. */
  scale: number | null;
  linkval: number | null;
  linkmarkers: string[] | null;
  /** Every artwork passcode for this card (alternate arts included). */
  images: number[];
  /** "Forbidden" | "Limited" | "Semi-Limited" | null (current TCG list). */
  banlistTcg: string | null;
  /** Earliest TCG release date (YYYY-MM-DD), or null if unknown. Sourced from
   *  YGOPRODeck, backfilled from Yugipedia's TCG debut date where YGOPRODeck
   *  has none. */
  tcgDate: string | null;
  /** Every set this card was printed in. From YGOPRODeck's card_sets,
   *  backfilled from Yugipedia's TCG sets list where YGOPRODeck has none. */
  sets: CardPrint[];
}

/** On-disk shape of assets/cards/db.json. */
export interface CardDatabaseFile {
  source: string;
  generatedAt: string;
  count: number;
  cards: CardData[];
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

/** A printed TCG set (booster, structure/starter deck, tin, promo). */
export interface SetData {
  /** Set code, e.g. "LOB". */
  code: string;
  name: string;
  /** TCG release date (YYYY-MM-DD), or null if unknown. */
  tcgDate: string | null;
  /** Number of cards reported by upstream. */
  numCards: number;
  /** Passcodes printed in this set (resolved from the card DB). */
  cards: number[];
}

/** On-disk shape of assets/sets/db.json. */
export interface SetDatabaseFile {
  source: string;
  generatedAt: string;
  count: number;
  sets: SetData[];
}

// ---------------------------------------------------------------------------
// Banlists
// ---------------------------------------------------------------------------

/** One entry in banlists/index.json. */
export interface BanlistRevisionMeta {
  date: string; // YYYY-MM-DD
  file: string;
  forbidden: number;
  limited: number;
  semiLimited: number;
}

/** A full banlist revision file (banlists/YYYY-MM-DD.json). */
export interface BanlistRevision {
  date: string;
  format: string;
  source: string;
  fetchedAt: string;
  forbidden: Array<{ id: number; name: string }>;
  limited: Array<{ id: number; name: string }>;
  semiLimited: Array<{ id: number; name: string }>;
}

/** A card's status under a chosen banlist. */
export type BanStatus = "Forbidden" | "Limited" | "Semi-Limited" | "Unlimited" | "Unreleased";

/** One contiguous stretch of a card's banlist history at a single status.
 *  Consecutive revisions with the same status are collapsed into one span. */
export interface BanSpan {
  status: "Forbidden" | "Limited" | "Semi-Limited";
  /** First revision date this status took effect (YYYY-MM-DD). */
  from: string;
  /** Last revision date this status was in effect (YYYY-MM-DD). */
  to: string;
  /** True if this span is the card's status on the most recent revision. */
  current: boolean;
}

// ---------------------------------------------------------------------------
// Genesys (points format)
// ---------------------------------------------------------------------------

/** One entry in genesys/index.json. */
export interface GenesysRevisionMeta {
  date: string; // YYYY-MM-DD
  file: string;
  cardCount: number;
  pointCap: number | null; // deck point cap in effect for this revision
}

/** A single change in a card's Genesys point cost. */
export interface GenesysChange {
  date: string; // YYYY-MM-DD the new value took effect
  delta: number; // signed change from the previous value (+ costs more, − costs less)
  points: number; // the value after the change
}

/** A card's Genesys cost: its current points plus every change over time. */
export interface GenesysHistory {
  current: number; // points on the most recent revision (0 = not listed)
  changes: GenesysChange[]; // chronological; empty if unchanged since first listed
}

/** A Genesys points-list revision (genesys/YYYY-MM-DD.json). */
export interface GenesysRevision {
  date: string;
  /** Deck point cap in effect for this revision (null if unknown). */
  pointCap: number | null;
  source: string;
  fetchedAt: string;
  /** Cards that carry a point value; unlisted cards cost 0. */
  cards: Array<{ id: number; name: string; points: number }>;
}

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------
//
// A saved deck. Each zone is a flat list of card passcodes — one entry per
// physical copy (so three Ash Blossom = the id three times). Persisted as JSON
// by @duel/local-backend; referenced by id only (no Konami data is stored in
// the deck file itself, just passcodes the running app resolves against db.json).

export interface Deck {
  /** Stable unique id (also the filename stem). */
  id: string;
  name: string;
  tags: string[];
  /** Main-deck passcodes (one per copy). */
  main: number[];
  /** Extra-deck passcodes (Fusion/Synchro/Xyz/Link + their pendulum forms). */
  extra: number[];
  /** Side-deck passcodes. */
  side: number[];
  /** Per-deck override: when false, the editor stops enforcing TCG limits. */
  enforceLimits: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight deck summary for the deck-list view (no card arrays). */
export interface DeckSummary {
  id: string;
  name: string;
  tags: string[];
  mainCount: number;
  extraCount: number;
  sideCount: number;
  updatedAt: string;
}

/**
 * Search criteria for the card browser. Every field is optional; an absent or
 * empty field means "no constraint on this dimension". All constraints are
 * AND-ed together.
 */
export interface CardQuery {
  /** Free text — matched against name AND card text (case-insensitive). */
  text?: string;
  attribute?: string;
  race?: string;
  archetype?: string;
  frameType?: string;
  supertype?: CardSupertype;
  /** Inclusive level/rank bounds. */
  levelMin?: number;
  levelMax?: number;
}
