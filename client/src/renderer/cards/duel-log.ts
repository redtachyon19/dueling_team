// Pure formatting of the duel event stream into human-readable log lines.
// Events arrive already redacted + perspective-localized by the host, so player
// 0 is always "You" and player 1 is "Opponent", and any hidden card codes have
// been stripped (drawn cards show as a count; a Set card shows as "a card").

import type { DuelEvent, DuelPlayer } from "@duel/shared";

type NameOf = (code: number | null | undefined) => string;

const who = (p: DuelPlayer): string => (p === 0 ? "You" : "Opponent");
/** "You" → "draw" / Opponent → "draws" (so lines read naturally). */
const verb = (p: DuelPlayer, you: string, other: string): string => (p === 0 ? you : other);

/** Format a single event into a log line, or null to skip (noise / no info). */
export function logLine(e: DuelEvent, nameOf: NameOf): string | null {
  switch (e.kind) {
    case "turn":
      return `— Turn ${e.turn} · ${who(e.player)} —`;
    case "draw": {
      const names = e.codes.filter((c) => c).map((c) => nameOf(c)).filter(Boolean);
      const n = e.count;
      const drew = verb(e.player, "draw", "draws");
      return names.length ? `${who(e.player)} ${drew} ${names.join(", ")}` : `${who(e.player)} ${drew} ${n} card${n === 1 ? "" : "s"}`;
    }
    case "summon": {
      const v = verb(e.player, e.position === "set" ? "Set" : "Summon", e.position === "set" ? "Sets" : "Summons");
      const suffix = e.position === "def" ? " in Defense" : "";
      return `${who(e.player)} ${v} ${nameOf(e.code) || "a monster"}${suffix}`;
    }
    case "spellset":
      return `${who(e.player)} ${verb(e.player, "Set", "Sets")} ${e.code ? nameOf(e.code) : "a card"}`;
    case "attack":
      return e.target == null
        ? `${who(e.attacker)} ${verb(e.attacker, "attack", "attacks")} directly`
        : `${who(e.attacker)} ${verb(e.attacker, "attack", "attacks")} ${who(e.target)}`;
    case "damage":
      return `${who(e.player)} ${verb(e.player, "take", "takes")} ${e.amount} damage`;
    case "recover":
      return `${who(e.player)} ${verb(e.player, "gain", "gains")} ${e.amount} LP`;
    case "toss":
      return `${who(e.player)} tossed ${e.dice ? "dice" : "a coin"}: ${e.results.join(", ")}`;
    case "win":
      return e.player === 0 ? "You win the duel." : "You lose the duel.";
    case "log":
      return e.text;
    case "phase":
    case "move":
    default:
      return null; // phase noise / bare moves carry no useful line
  }
}

/** Map a batch of events to log entries (with stable ids), dropping skipped ones. */
export function toLogEntries(events: DuelEvent[], nameOf: NameOf, startId: number): { id: number; text: string }[] {
  const out: { id: number; text: string }[] = [];
  let id = startId;
  for (const e of events) {
    const text = logLine(e, nameOf);
    if (text) out.push({ id: id++, text });
  }
  return out;
}
