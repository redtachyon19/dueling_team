import { contextBridge, ipcRenderer } from "electron";
import type { Deck } from "@duel/shared";

// Bridge exposed to the renderer as `window.duel`. The renderer has no direct
// file-system or network access (contextIsolation); everything goes through
// here. The shape is declared for TypeScript in src/renderer/duel.d.ts — keep
// the two in sync.
contextBridge.exposeInMainWorld("duel", {
  version: "0.0.0",
  cards: {
    /** Load the local card database (null if not imported yet). */
    load: () => ipcRenderer.invoke("cards:load"),
    /** URL for a card's local artwork, served by the card:// protocol. */
    imageUrl: (id: number) => `card://card/${id}`,
  },
  sets: {
    /** Load the local set database (null if not imported yet). */
    load: () => ipcRenderer.invoke("sets:load"),
  },
  decks: {
    list: () => ipcRenderer.invoke("decks:list"),
    load: (id: string) => ipcRenderer.invoke("decks:load", id),
    save: (deck: Deck) => ipcRenderer.invoke("decks:save", deck),
    delete: (id: string) => ipcRenderer.invoke("decks:delete", id),
  },
  banlists: {
    list: () => ipcRenderer.invoke("banlists:list"),
    load: (date: string) => ipcRenderer.invoke("banlists:load", date),
    /** A single card's banlist history, as collapsed status spans. */
    history: (id: number) => ipcRenderer.invoke("banlists:history", id),
  },
  genesys: {
    /** The Genesys point-list revisions (index.json), newest-first. */
    list: () => ipcRenderer.invoke("genesys:list"),
    /** Load a single dated Genesys revision file. */
    load: (date: string) => ipcRenderer.invoke("genesys:load", date),
    /** A single card's Genesys point history (revisions where it had a cost). */
    history: (id: number) => ipcRenderer.invoke("genesys:history", id),
  },
  match: {
    /** Start a duel (ocgcore) from a saved deck; goldfish opponent by default. */
    start: (opts: unknown) => ipcRenderer.invoke("match:start", opts),
    /** Answer the current prompt. */
    respond: (r: unknown) => ipcRenderer.invoke("match:respond", r),
    /** Tear down the active duel. */
    end: () => ipcRenderer.invoke("match:end"),
    /** Subscribe to duel updates (state + prompt + events). Returns an unsubscribe fn. */
    onUpdate: (cb: (u: unknown) => void) => {
      const listener = (_e: unknown, u: unknown) => cb(u);
      ipcRenderer.on("match:update", listener);
      return () => ipcRenderer.removeListener("match:update", listener);
    },
  },
});
