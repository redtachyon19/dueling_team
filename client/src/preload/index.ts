import { contextBridge, ipcRenderer } from "electron";
import type { Deck } from "@duel/shared";

contextBridge.exposeInMainWorld("duel", {
  version: "0.0.0",
  cards: {
    load: () => ipcRenderer.invoke("cards:load"),
    imageUrl: (id: number) => `card://card/${id}`,
  },
  sets: {
    load: () => ipcRenderer.invoke("sets:load"),
  },
  decks: {
    list: () => ipcRenderer.invoke("decks:list"),
    load: (id: string) => ipcRenderer.invoke("decks:load", id),
    save: (deck: Deck) => ipcRenderer.invoke("decks:save", deck),
    delete: (id: string) => ipcRenderer.invoke("decks:delete", id),
  },
  io: {
    save: (opts: {
      defaultName: string;
      data: string;
      encoding?: "utf8" | "base64";
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => ipcRenderer.invoke("io:save", opts),
    open: (opts?: { filters?: Array<{ name: string; extensions: string[] }> }) =>
      ipcRenderer.invoke("io:open", opts),
  },
  banlists: {
    list: () => ipcRenderer.invoke("banlists:list"),
    load: (date: string) => ipcRenderer.invoke("banlists:load", date),
    history: (id: number) => ipcRenderer.invoke("banlists:history", id),
  },
  genesys: {
    list: () => ipcRenderer.invoke("genesys:list"),
    load: (date: string) => ipcRenderer.invoke("genesys:load", date),
    history: (id: number) => ipcRenderer.invoke("genesys:history", id),
  },
  match: {
    start: (opts: unknown) => ipcRenderer.invoke("match:start", opts),
    respond: (r: unknown) => ipcRenderer.invoke("match:respond", r),
    surrender: () => ipcRenderer.invoke("match:surrender"),
    end: () => ipcRenderer.invoke("match:end"),
    onUpdate: (cb: (u: unknown) => void) => {
      const listener = (_e: unknown, u: unknown) => cb(u);
      ipcRenderer.on("match:update", listener);
      return () => ipcRenderer.removeListener("match:update", listener);
    },
  },
  net: {
    host: (opts: unknown) => ipcRenderer.invoke("net:host", opts),
    join: (opts: unknown) => ipcRenderer.invoke("net:join", opts),
    leave: () => ipcRenderer.invoke("net:leave"),
    ready: () => ipcRenderer.invoke("net:ready"),
    onStatus: (cb: (s: unknown) => void) => {
      const listener = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on("net:status", listener);
      return () => ipcRenderer.removeListener("net:status", listener);
    },
  },
});
