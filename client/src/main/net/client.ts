import net from "node:net";
import {
  encodeNetMessage,
  createNetDecoder,
  type NetMessage,
  type NetRole,
} from "@duel/shared";

export interface NetClientHandlers {
  onPeerJoined?: () => void;
  onPeerLeft?: () => void;
  onMessage?: (m: NetMessage) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export class NetClient {
  private socket: net.Socket | null = null;
  private joined = false;

  constructor(private readonly h: NetClientHandlers = {}) {}

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
