// client/src/renderer/cards/deck-io.ts
//
// Pure deck import/export helpers: the community `.ydk` interchange format
// (EDOPro / YGOPro compatible) plus a human-readable text list and structured
// JSON. No React, no I/O — the caller resolves card names and writes the
// returned string to disk (via the io bridge), so these stay unit-testable.

import type { CardData, Deck } from "@duel/shared";
import { groupZone, LIMITS } from "./deck.ts";

/** The three zones of a deck as flat passcode lists (one entry per copy). */
export interface DeckZones {
  main: number[];
  extra: number[];
  side: number[];
}

/**
 * Parse the community `.ydk` format:
 *
 *   #created by ...
 *   #main
 *   89631139
 *   ...
 *   #extra
 *   ...
 *   !side
 *   ...
 *
 * Lines beginning with `#` are section headers or comments; `!side` opens the
 * side deck; everything else is one card passcode per line. Unknown passcodes
 * are kept as-is (the editor renders them as a card back).
 */
export function parseYdk(text: string): DeckZones {
  const zones: DeckZones = { main: [], extra: [], side: [] };
  let section: keyof DeckZones | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      if (line === "#main") section = "main";
      else if (line === "#extra") section = "extra";
      // any other #... line (e.g. "#created by") is a comment
      continue;
    }
    if (line.startsWith("!")) {
      if (line === "!side") section = "side";
      continue;
    }
    const code = Number.parseInt(line, 10);
    if (Number.isFinite(code) && section) zones[section].push(code);
  }
  return zones;
}

/** Serialize a deck's zones to `.ydk` text. */
export function serializeYdk(deck: DeckZones, author = "Dueling Team"): string {
  const lines = [
    `#created by ${author}`,
    "#main", ...deck.main.map(String),
    "#extra", ...deck.extra.map(String),
    "!side", ...deck.side.map(String),
  ];
  return lines.join("\n") + "\n";
}

/** A filesystem-safe base name (no extension) derived from a deck name. */
export function safeFilename(name: string): string {
  const base = name.trim().replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  return base || "deck";
}

/**
 * A human-readable decklist: a count per distinct card, grouped per zone in
 * first-seen order (matching the on-screen ordering, not sorted).
 */
export function toDeckListText(deck: Deck, nameOf: (id: number) => string): string {
  const lines: string[] = [];
  const title = deck.name || "Untitled Deck";
  lines.push(title, "=".repeat(Math.max(title.length, 16)), "");

  const section = (label: string, ids: number[], cap: string): void => {
    lines.push(`${label} (${ids.length}${cap ? `/${cap}` : ""})`, "-".repeat(20));
    if (ids.length === 0) lines.push("(empty)");
    else for (const [id, count] of groupZone(ids)) lines.push(`${count}x ${nameOf(id)}`);
    lines.push("");
  };
  section("Main Deck", deck.main, `${LIMITS.mainMin}-${LIMITS.mainMax}`);
  section("Extra Deck", deck.extra, String(LIMITS.extraMax));
  section("Side Deck", deck.side, String(LIMITS.sideMax));
  return lines.join("\n");
}

/**
 * Structured JSON: the deck plus a per-card name/type so the file is legible on
 * its own. `exportedAt` is passed in (rather than read here) to keep this pure.
 */
export function toDeckJson(
  deck: Deck,
  cardOf: (id: number) => CardData | undefined,
  exportedAt: string,
): string {
  const enrich = (id: number): { id: number; name?: string; type?: string; frameType?: string } => {
    const c = cardOf(id);
    return c ? { id, name: c.name, type: c.type, frameType: c.frameType } : { id };
  };
  const payload = {
    name: deck.name || "Untitled Deck",
    tags: deck.tags,
    exportedAt,
    main: deck.main.map(enrich),
    extra: deck.extra.map(enrich),
    side: deck.side.map(enrich),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}
