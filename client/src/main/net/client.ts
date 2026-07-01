// TCP client for friends-only online play (main process). Connects to a relay
// (see @duel/relay-server), joins a room in a role, and exchanges newline-
// delimited JSON messages with the peer. No game logic lives here — it's a pipe.

import net from "node:net";
import {
  encodeNetMessage,
  createNetDecoder,
  type NetMessage,
  type NetRole,
} from "@duel/shared";

export interface NetClientHandlers {
  /** The other party connected; the duel can begin. */
  onPeerJoined?: () => void;
  /** The other party disconnected. */
  onPeerLeft?: () => void;
  /** A game message from the peer (deck / update / response / surrender). */
  onMessage?: (m: NetMessage) => void;
  /** A relay-level error (room full, bad role, …) or socket failure. */
  onError?: (message: string) => void;
  /** The socket closed. */
  onClose?: () => void;
}

export class NetClient {
  private socket: net.Socket | null = null;
  private joined = false;

  constructor(private readonly h: NetClientHandlers = {}) {}

  /** Connect to `host:port` and join `room` as `role`. Resolves once the relay
   *  acknowledges the join (or rejects on error / connection failure). */
  connect(host: string, port: number, room: string, role: NetRole): Promise<void> {
    return new Promise((resolve, reject) => {
      const decode = createNetDecoder();
      const socket = net.createConnection({ host, port }, () => {
        socket.write(encodeNetMessage({ t: "join", room, role }));
      });
      socket.setEncoding("utf8");
      this.socket = socket;

      let settled = false;
      const fail = (msg: string) => {
        if (!settled) { settled = true; reject(new Error(msg)); }
        this.h.onError?.(msg);
      };

      socket.on("data", (chunk: string) => {
        for (const m of decode(chunk)) {
          switch (m.t) {
            case "joined":
              this.joined = true;
              if (!settled) { settled = true; resolve(); }
              break;
            case "peer-joined":
              this.h.onPeerJoined?.();
              break;
            case "peer-left":
              this.h.onPeerLeft?.();
              break;
            case "error":
              fail(m.message);
              break;
            default:
              // Game message (deck / start / update / response / surrender).
              this.h.onMessage?.(m);
          }
        }
      });
      socket.on("error", (e) => fail(e.message));
      socket.on("close", () => {
        if (!settled) fail("connection closed before joining");
        this.h.onClose?.();
      });
    });
  }

  /** Send a game message to the peer (no-op until joined / after close). */
  send(m: NetMessage): void {
    if (this.socket && !this.socket.destroyed && this.joined) {
      this.socket.write(encodeNetMessage(m));
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.joined = false;
  }
}
