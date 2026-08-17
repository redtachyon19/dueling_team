import type { DuelUpdate, DuelResponse, DuelFormat } from "./duel";

export type NetRole = "host" | "guest";

export interface NetDeck {
  main: number[];
  extra: number[];
}

export type NetMessage =
  | { t: "join"; room: string; role: NetRole }
  | { t: "joined"; role: NetRole }
  | { t: "peer-joined" }
  | { t: "peer-left" }
  | { t: "error"; message: string }
  | { t: "deck"; deck: NetDeck }
  | { t: "start"; ok: boolean; error?: string | undefined; format: DuelFormat }
  | { t: "update"; update: DuelUpdate }
  | { t: "response"; response: DuelResponse }
  | { t: "surrender" };

export const DEFAULT_RELAY_PORT = 41923;

export interface NetHostOptions {
  deckId: string;
  format?: DuelFormat;
  seed?: string | undefined;
  relayHost: string;
  relayPort: number;
  room?: string | undefined;
}

export interface NetJoinOptions {
  deckId: string;
  relayHost: string;
  relayPort: number;
  room: string;
}

export type NetPhase = "waiting" | "connecting" | "playing" | "error" | "peer-left" | "ended";

export interface NetStatus {
  phase: NetPhase;
  room?: string;
  format?: DuelFormat;
  message?: string;
}

export interface NetResult {
  ok: boolean;
  error?: string;
  room?: string;
}

export function encodeNetMessage(m: NetMessage): string {
  return JSON.stringify(m) + "\n";
}

export function createNetDecoder(): (chunk: string) => NetMessage[] {
  let buf = "";
  return (chunk: string): NetMessage[] => {
    buf += chunk;
    const out: NetMessage[] = [];
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as NetMessage);
      } catch {
      }
    }
    return out;
  };
}
