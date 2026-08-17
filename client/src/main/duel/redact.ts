import type { DuelEvent, DuelPlayer } from "@duel/shared";

export const HIDDEN_CODE = 0;

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
