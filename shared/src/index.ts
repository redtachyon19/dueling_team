export * from "./duel";
export * from "./net";

export type CardSupertype = "Monster" | "Spell" | "Trap";

export interface CardPrint {
  code: string;
  name: string;
  rarity: string | null;
}

export interface CardData {
  id: number;
  name: string;
  type: string;
  frameType: string;
  desc: string;
  race: string;
  archetype: string | null;
  attribute: string | null;
  atk: number | null;
  def: number | null;
  level: number | null;
  scale: number | null;
  linkval: number | null;
  linkmarkers: string[] | null;
  images: number[];
  banlistTcg: string | null;
  tcgDate: string | null;
  sets: CardPrint[];
}

export interface CardDatabaseFile {
  source: string;
  generatedAt: string;
  count: number;
  cards: CardData[];
}

export interface SetData {
  code: string;
  name: string;
  tcgDate: string | null;
  numCards: number;
  cards: number[];
}

export interface SetDatabaseFile {
  source: string;
  generatedAt: string;
  count: number;
  sets: SetData[];
}

export interface BanlistRevisionMeta {
  date: string;
  file: string;
  forbidden: number;
  limited: number;
  semiLimited: number;
}

export interface BanlistRevision {
  date: string;
  format: string;
  source: string;
  fetchedAt: string;
  forbidden: Array<{ id: number; name: string }>;
  limited: Array<{ id: number; name: string }>;
  semiLimited: Array<{ id: number; name: string }>;
}

export type BanStatus = "Forbidden" | "Limited" | "Semi-Limited" | "Unlimited" | "Unreleased";

export interface BanSpan {
  status: "Forbidden" | "Limited" | "Semi-Limited";
  from: string;
  to: string;
  current: boolean;
}

export interface GenesysRevisionMeta {
  date: string;
  file: string;
  cardCount: number;
  pointCap: number | null;
}

export interface GenesysChange {
  date: string;
  delta: number;
  points: number;
}

export interface GenesysHistory {
  current: number;
  changes: GenesysChange[];
}

export interface GenesysRevision {
  date: string;
  pointCap: number | null;
  source: string;
  fetchedAt: string;
  cards: Array<{ id: number; name: string; points: number }>;
}

export interface Deck {
  id: string;
  name: string;
  tags: string[];
  main: number[];
  extra: number[];
  side: number[];
  enforceLimits: boolean;
  createdAt: string;
  updatedAt: string;
  /** Deck-box tint (hex) shown on the deck thumbnail. */
  boxColor?: string;
  /** Card id whose art is revealed when the deck box opens. */
  coverCardId?: number;
}

export interface DeckSummary {
  id: string;
  name: string;
  tags: string[];
  mainCount: number;
  extraCount: number;
  sideCount: number;
  updatedAt: string;
  boxColor?: string;
  coverCardId?: number;
}

export type CardSort =
  | "relevance"
  | "name"
  | "atk-desc"
  | "atk-asc"
  | "def-desc"
  | "def-asc"
  | "level-desc"
  | "level-asc"
  | "type"
  | "newest";

export interface CardQuery {
  text?: string;
  attribute?: string;
  race?: string;
  archetype?: string;
  frameType?: string;
  supertype?: CardSupertype;
  supertypes?: CardSupertype[];
  frames?: string[];
  attributes?: string[];
  levelMin?: number;
  levelMax?: number;
  atkMin?: number;
  atkMax?: number;
  defMin?: number;
  defMax?: number;
  sort?: CardSort;
}
