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
  NetHostOptions,
  NetJoinOptions,
  NetResult,
  NetStatus,
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
  io: {
    save(opts: {
      defaultName: string;
      data: string;
      encoding?: "utf8" | "base64";
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    open(opts?: {
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ ok: boolean; canceled?: boolean; name?: string; text?: string; error?: string }>;
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
    surrender(): Promise<void>;
    end(): Promise<void>;
    onUpdate(cb: (u: DuelUpdate) => void): () => void;
  };
  net: {
    host(opts: NetHostOptions): Promise<NetResult>;
    join(opts: NetJoinOptions): Promise<NetResult>;
    leave(): Promise<void>;
    ready(): Promise<void>;
    onStatus(cb: (s: NetStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    duel: DuelBridge;
  }
}
