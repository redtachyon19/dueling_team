import type { CardData, Deck, BanlistRevision, BanStatus, GenesysRevision, DuelFormat } from "@duel/shared";

export type Zone = "main" | "extra" | "side";

export interface BanlistLookup {
  date: string;
  status: Map<number, "Forbidden" | "Limited" | "Semi-Limited">;
}

export function buildBanlistLookup(rev: BanlistRevision): BanlistLookup {
  const status = new Map<number, "Forbidden" | "Limited" | "Semi-Limited">();
  for (const c of rev.forbidden) status.set(c.id, "Forbidden");
  for (const c of rev.limited) status.set(c.id, "Limited");
  for (const c of rev.semiLimited) status.set(c.id, "Semi-Limited");
  return { date: rev.date, status };
}

export function banStatusOf(card: CardData, lookup: BanlistLookup | null): BanStatus {
  if (!lookup) return "Unlimited";
  if (card.tcgDate && card.tcgDate > lookup.date) return "Unreleased";
  return lookup.status.get(card.id) ?? "Unlimited";
}

export interface GenesysLookup {
  date: string;
  pointCap: number | null;
  points: Map<number, number>;
}

export function buildGenesysLookup(rev: GenesysRevision): GenesysLookup {
  const points = new Map<number, number>();
  for (const c of rev.cards) points.set(c.id, c.points);
  return { date: rev.date, pointCap: rev.pointCap, points };
}

export function genesysCostOf(card: CardData, lookup: GenesysLookup | null): number {
  if (!lookup) return 0;
  return lookup.points.get(card.id) ?? 0;
}

export function deckGenesysPoints(deck: Deck, lookup: GenesysLookup | null): number {
  if (!lookup) return 0;
  let sum = 0;
  for (const zone of ["main", "extra", "side"] as Zone[]) {
    for (const id of deck[zone]) sum += lookup.points.get(id) ?? 0;
  }
  return sum;
}

const EXTRA_FRAMES = new Set([
  "fusion",
  "synchro",
  "xyz",
  "link",
  "fusion_pendulum",
  "synchro_pendulum",
  "xyz_pendulum",
]);

export function isExtraDeckCard(card: CardData): boolean {
  return EXTRA_FRAMES.has(card.frameType);
}

export function defaultZone(card: CardData): Zone {
  return isExtraDeckCard(card) ? "extra" : "main";
}

export const LIMITS = {
  copies: 3,
  mainMin: 40,
  mainMax: 60,
  extraMax: 15,
  sideMax: 15,
} as const;

export function copiesOf(deck: Deck, id: number): number {
  const count = (a: number[]) => a.filter((x) => x === id).length;
  return count(deck.main) + count(deck.extra) + count(deck.side);
}

export interface AddResult {
  ok: boolean;
  reason?: string;
  deck: Deck;
}

export function addCard(deck: Deck, card: CardData, requestedZone: Zone): AddResult {
  let zone: Zone = requestedZone;
  if (requestedZone !== "side") zone = defaultZone(card);

  if (deck.enforceLimits) {
    if (copiesOf(deck, card.id) >= LIMITS.copies) {
      return { ok: false, reason: `Max ${LIMITS.copies} copies of a card`, deck };
    }
    if (zone === "main" && deck.main.length >= LIMITS.mainMax) {
      return { ok: false, reason: `Main deck max ${LIMITS.mainMax}`, deck };
    }
    if (zone === "extra" && deck.extra.length >= LIMITS.extraMax) {
      return { ok: false, reason: `Extra deck max ${LIMITS.extraMax}`, deck };
    }
    if (zone === "side" && deck.side.length >= LIMITS.sideMax) {
      return { ok: false, reason: `Side deck max ${LIMITS.sideMax}`, deck };
    }
  }

  return { ok: true, deck: { ...deck, [zone]: [...deck[zone], card.id] } };
}

export function removeCard(deck: Deck, zone: Zone, id: number): Deck {
  const i = deck[zone].indexOf(id);
  if (i === -1) return deck;
  const next = [...deck[zone]];
  next.splice(i, 1);
  return { ...deck, [zone]: next };
}

export interface DeckIssue {
  level: "error" | "warn";
  message: string;
}

export function validateDeck(deck: Deck): DeckIssue[] {
  const issues: DeckIssue[] = [];
  if (deck.main.length < LIMITS.mainMin)
    issues.push({ level: "warn", message: `Main deck has ${deck.main.length} (min ${LIMITS.mainMin})` });
  if (deck.main.length > LIMITS.mainMax)
    issues.push({ level: "error", message: `Main deck has ${deck.main.length} (max ${LIMITS.mainMax})` });
  if (deck.extra.length > LIMITS.extraMax)
    issues.push({ level: "error", message: `Extra deck has ${deck.extra.length} (max ${LIMITS.extraMax})` });
  if (deck.side.length > LIMITS.sideMax)
    issues.push({ level: "error", message: `Side deck has ${deck.side.length} (max ${LIMITS.sideMax})` });
  return issues;
}

export interface FormatLegalityCtx {
  cards: Map<number, CardData>;
  banlist: BanlistLookup | null;
  genesys: GenesysLookup | null;
}

function nameList(names: string[]): string {
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

export function validateDeckForFormat(deck: Deck, format: DuelFormat, ctx: FormatLegalityCtx): DeckIssue[] {
  const { cards, banlist, genesys } = ctx;
  const issues: DeckIssue[] = [];
  const nameOf = (id: number) => cards.get(id)?.name ?? `#${id}`;

  if (deck.main.length < LIMITS.mainMin) issues.push({ level: "error", message: `Main deck has ${deck.main.length} cards (min ${LIMITS.mainMin})` });
  if (deck.main.length > LIMITS.mainMax) issues.push({ level: "error", message: `Main deck has ${deck.main.length} cards (max ${LIMITS.mainMax})` });
  if (deck.extra.length > LIMITS.extraMax) issues.push({ level: "error", message: `Extra deck has ${deck.extra.length} cards (max ${LIMITS.extraMax})` });
  if (deck.side.length > LIMITS.sideMax) issues.push({ level: "error", message: `Side deck has ${deck.side.length} cards (max ${LIMITS.sideMax})` });

  const distinct = [...new Set<number>([...deck.main, ...deck.extra, ...deck.side])];

  if (format === "genesys") {
    const links: string[] = [];
    const pendulums: string[] = [];
    for (const id of distinct) {
      const n = copiesOf(deck, id);
      if (n > LIMITS.copies) issues.push({ level: "error", message: `${nameOf(id)}: ${n} copies (max ${LIMITS.copies})` });
      const frame = cards.get(id)?.frameType ?? "";
      if (frame.includes("link")) links.push(nameOf(id));
      else if (frame.includes("pendulum")) pendulums.push(nameOf(id));
    }
    if (links.length) issues.push({ level: "error", message: `Link monsters aren't allowed in Genesys: ${nameList(links)}` });
    if (pendulums.length) issues.push({ level: "error", message: `Pendulum monsters aren't allowed in Genesys: ${nameList(pendulums)}` });
    if (genesys?.pointCap != null) {
      const pts = deckGenesysPoints(deck, genesys);
      if (pts > genesys.pointCap) issues.push({ level: "error", message: `Genesys points: ${pts} / ${genesys.pointCap} — over the cap` });
    }
  } else {
    for (const id of distinct) {
      const n = copiesOf(deck, id);
      const card = cards.get(id);
      const status = card ? banStatusOf(card, banlist) : "Unlimited";
      const cap = status === "Forbidden" ? 0 : status === "Limited" ? 1 : status === "Semi-Limited" ? 2 : LIMITS.copies;
      if (n > cap) {
        issues.push({
          level: "error",
          message: status === "Forbidden" ? `${nameOf(id)} is Forbidden` : `${nameOf(id)}: ${n} copies (max ${cap} — ${status})`,
        });
      }
    }
  }
  return issues;
}

export function groupZone(ids: number[]): Array<[number, number]> {
  const order: number[] = [];
  const counts = new Map<number, number>();
  for (const id of ids) {
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return order.map((id) => [id, counts.get(id)!]);
}
