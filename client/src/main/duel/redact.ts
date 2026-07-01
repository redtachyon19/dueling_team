// Per-viewer redaction of the display-event stream. Events feed banners and the
// duel log on the client; some carry information a player isn't entitled to see
// (the opponent's drawn cards, the identity of a face-down Set card). Strip those
// for the non-owner BEFORE the events leave the host, so they can never reach the
// opponent's client — the same principle as the redacted board state.

import type { DuelEvent, DuelPlayer } from "@duel/shared";

/** Sentinel for a hidden card code in an event (no real passcode is 0). */
export const HIDDEN_CODE = 0;

/** Return `events` with anything `viewer` shouldn't know stripped:
 *  - a draw by the opponent loses its card codes (count is still public);
 *  - a Set (face-down) by the opponent loses the set card's identity;
 *  - bare "move" events are dropped (no owner/context, and the raw code could
 *    reveal a card sent to a hidden zone; nothing in the UI consumes them). */
export function redactEvents(events: DuelEvent[], viewer: DuelPlayer): DuelEvent[] {
  const out: DuelEvent[] = [];
  for (const e of events) {
    if (e.kind === "move") continue;
    if (e.kind === "draw" && e.player !== viewer) { out.push({ ...e, codes: [] }); continue; }
    if (e.kind === "spellset" && e.player !== viewer) { out.push({ ...e, code: HIDDEN_CODE }); continue; }
    out.push(e);
  }
  return out;
}
