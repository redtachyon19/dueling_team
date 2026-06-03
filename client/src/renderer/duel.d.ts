// Ambient declaration of the preload bridge (window.duel). Mirrors the object
// exposed in src/preload/index.ts.
import type {
  CardData,
  SetData,
  Deck,
  DeckSummary,
  BanlistRevisionMeta,
  BanlistRevision,
  BanSpan,
  GenesysHistory,
  GenesysRevisionMeta,
  GenesysRevision,
  DuelStartOptions,
  DuelStartResult,
  DuelResponse,
  DuelUpdate,
} from "@duel/shared";

export interface DuelBridge {
  version: string;
  cards: {
    load(): Promise<CardData[] | null>;
    imageUrl(id: number): string;
  };
  sets: {
    load(): Promise<SetData[] | null>;
  };
  decks: {
    list(): Promise<DeckSummary[]>;
    load(id: string): Promise<Deck | null>;
    save(deck: Deck): Promise<Deck>;
    delete(id: string): Promise<void>;
  };
  banlists: {
    list(): Promise<BanlistRevisionMeta[]>;
    load(date: string): Promise<BanlistRevision | null>;
    history(id: number): Promise<BanSpan[]>;
  };
  genesys: {
    list(): Promise<GenesysRevisionMeta[]>;
    load(date: string): Promise<GenesysRevision | null>;
    history(id: number): Promise<GenesysHistory>;
  };
  match: {
    start(opts: DuelStartOptions): Promise<DuelStartResult>;
    respond(r: DuelResponse): Promise<void>;
    end(): Promise<void>;
    onUpdate(cb: (u: DuelUpdate) => void): () => void;
  };
}

declare global {
  interface Window {
    duel: DuelBridge;
  }
}
