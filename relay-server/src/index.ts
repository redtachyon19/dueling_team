// @duel/relay-server
//
// Thin relay for friends-only online play. It pairs two clients (a "host" and a
// "guest") by a shared room code and forwards every game message between them
// verbatim. It never inspects payloads, never runs game logic, and never holds
// any Konami data — the authoritative engine (ocgcore) lives only on the host
// client. Transport is newline-delimited JSON over plain TCP.

import net from "node:net";
import {
  DEFAULT_RELAY_PORT,
  encodeNetMessage,
  createNetDecoder,
  type NetMessage,
  type NetRole,
} from "@duel/shared";

interface Client {
  socket: net.Socket;
  room: string;
  role: NetRole;
}

interface Room {
  host?: Client;
  guest?: Client;
}

export interface RelayHandle {
  port: number;
  close: () => Promise<void>;
}

/** Start the relay on `port`. Resolves once it's listening. */
export function startRelay(port = DEFAULT_RELAY_PORT, host = "0.0.0.0"): Promise<RelayHandle> {
  const rooms = new Map<string, Room>();

  const send = (c: Client | undefined, m: NetMessage) => {
    if (c && !c.socket.destroyed) c.socket.write(encodeNetMessage(m));
  };
  const peerOf = (c: Client): Client | undefined => {
    const room = rooms.get(c.room);
    if (!room) return undefined;
    return c.role === "host" ? room.guest : room.host;
  };

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    const decode = createNetDecoder();
    let client: Client | null = null;

    const cleanup = () => {
      if (!client) return;
      const room = rooms.get(client.room);
      if (room) {
        // Tell the peer we're gone, then free our slot.
        send(peerOf(client), { t: "peer-left" });
        if (room.host === client) delete room.host;
        if (room.guest === client) delete room.guest;
        if (!room.host && !room.guest) rooms.delete(client.room);
      }
      client = null;
    };

    socket.on("data", (chunk: string) => {
      for (const msg of decode(chunk)) {
        if (msg.t === "join") {
          if (client) continue; // already joined on this socket
          const role = msg.role;
          if (role !== "host" && role !== "guest") {
            socket.write(encodeNetMessage({ t: "error", message: "bad role" }));
            continue;
          }
          const room = rooms.get(msg.room) ?? {};
          if (room[role]) {
            socket.write(encodeNetMessage({ t: "error", message: `room already has a ${role}` }));
            continue;
          }
          client = { socket, room: msg.room, role };
          room[role] = client;
          rooms.set(msg.room, room);
          send(client, { t: "joined", role });
          // If both seats are filled, tell each side the other is here.
          if (room.host && room.guest) {
            send(room.host, { t: "peer-joined" });
            send(room.guest, { t: "peer-joined" });
          }
          continue;
        }
        // Any non-join message is a game message: forward it opaquely to the peer.
        if (!client) continue; // must join first
        send(peerOf(client), msg);
      }
    });

    socket.on("error", cleanup);
    socket.on("close", cleanup);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            for (const room of rooms.values()) {
              room.host?.socket.destroy();
              room.guest?.socket.destroy();
            }
            server.close(() => res());
          }),
      });
    });
  });
}

// Run directly: `tsx relay-server/src/index.ts [port]`
const invokedDirectly = process.argv[1] && /relay-server[\\/]src[\\/]index\.(ts|js|mts|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  const port = Number(process.argv[2]) || DEFAULT_RELAY_PORT;
  startRelay(port)
    .then((h) => console.log(`[relay] listening on :${h.port}`))
    .catch((e) => {
      console.error("[relay] failed to start:", e);
      process.exit(1);
    });
}
