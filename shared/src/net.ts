// Friends-only online-play wire protocol.
//
// Two clients connect to a thin relay (see @duel/relay-server) by a shared room
// code: one "host" (runs ocgcore, the rules authority) and one "guest" (a thin
// client with no game logic). The relay only pairs them and forwards messages
// verbatim — it never inspects or runs game logic, so no Konami IP ever touches
// the relay. The host sends each player only their OWN view of the board
// (redacted), so the guest can never see the host's hand or face-down cards.
//
// Transport is newline-delimited JSON over a plain TCP socket: every message is
// `JSON.stringify(msg) + "\n"`. JSON escapes embedded newlines, so splitting on
// "\n" is a safe framing.

import type { DuelUpdate, DuelResponse, DuelFormat } from "./duel";

export type NetRole = "host" | "guest";

/** A deck on the wire: passcodes only — never any Konami card data. */
export interface NetDeck {
  main: number[];
  extra: number[];
}

export type NetMessage =
  // --- lobby control (client ↔ relay) ---
  /** Join (or create) a room in a given role. First in wins each role slot. */
  | { t: "join"; room: string; role: NetRole }
  /** Relay → client: your join was accepted. */
  | { t: "joined"; role: NetRole }
  /** Relay → client: the other party is now connected; the duel can begin. */
  | { t: "peer-joined" }
  /** Relay → client: the other party disconnected. */
  | { t: "peer-left" }
  /** Relay → client: something went wrong (room full, bad role, …). */
  | { t: "error"; message: string }
  // --- game (relayed opaquely between host and guest) ---
  /** Guest → host: the guest's deck (passcodes only). Sent once before start. */
  | { t: "deck"; deck: NetDeck }
  /** Host → guest: the duel has started (or failed to). */
  | { t: "start"; ok: boolean; error?: string | undefined; format: DuelFormat }
  /** Host → guest: the guest's own redacted view of the board + any prompt. */
  | { t: "update"; update: DuelUpdate }
  /** Guest → host: the guest's answer to its pending prompt. */
  | { t: "response"; response: DuelResponse }
  /** Either side: I concede / I'm leaving the duel. */
  | { t: "surrender" };

/** Default relay port (override per deployment). */
export const DEFAULT_RELAY_PORT = 41923;

// --- renderer ↔ main IPC payloads for online play ---------------------------

/** Host a room: run ocgcore locally and wait for a guest to join. */
export interface NetHostOptions {
  deckId: string;
  format?: DuelFormat;
  /** Decimal seed string for a reproducible shuffle; omit for OS-random. */
  seed?: string | undefined;
  relayHost: string;
  relayPort: number;
  /** Room code; if empty the host generates one (returned in NetResult). */
  room?: string | undefined;
}

/** Join an existing room as the thin (guest) client. */
export interface NetJoinOptions {
  deckId: string;
  relayHost: string;
  relayPort: number;
  room: string;
}

export type NetPhase = "waiting" | "connecting" | "playing" | "error" | "peer-left" | "ended";

/** Pushed main → renderer so the lobby can reflect connection state. */
export interface NetStatus {
  phase: NetPhase;
  room?: string;
  /** Set when phase is "playing" so the guest renders the right field. */
  format?: DuelFormat;
  message?: string;
}

export interface NetResult {
  ok: boolean;
  error?: string;
  /** The room code (echoed for join, generated for host when none was given). */
  room?: string;
}

/** Serialize a message for the wire (newline-delimited JSON). */
export function encodeNetMessage(m: NetMessage): string {
  return JSON.stringify(m) + "\n";
}

/** A line-buffered decoder: feed it raw socket chunks, get back whole messages.
 *  Tolerates messages split across chunks and multiple messages per chunk. */
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
        /* drop malformed frame */
      }
    }
    return out;
  };
}
