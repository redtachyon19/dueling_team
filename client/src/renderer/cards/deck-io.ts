import type { CardData, Deck } from "@duel/shared";
import { groupZone, LIMITS } from "./deck.ts";

export interface DeckZones {
  main: number[];
  extra: number[];
  side: number[];
}

export function parseYdk(text: string): DeckZones {
  const zones: DeckZones = { main: [], extra: [], side: [] };
  let section: keyof DeckZones | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      if (line === "#main") section = "main";
      else if (line === "#extra") section = "extra";
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

export function serializeYdk(deck: DeckZones, author = "Dueling Team"): string {
  const lines = [
    `#created by ${author}`,
    "#main", ...deck.main.map(String),
    "#extra", ...deck.extra.map(String),
    "!side", ...deck.side.map(String),
  ];
  return lines.join("\n") + "\n";
}

export function safeFilename(name: string): string {
  const base = name.trim().replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  return base || "deck";
}

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
