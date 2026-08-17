import {
  PATHS,
  YGO,
  fetchJson,
  fetchOcgOnly,
  fetchTcgDebutDates,
  fetchTcgPrints,
  writeJson,
  hasFlag,
  numFlag,
  isoDate,
} from "./_lib.ts";
import {
  readLedger, reconcile, writeLedger, reportReconcile, includedCodes,
  type Decision, type LedgerReason,
} from "./ledger.ts";

interface CardPrint {
  code: string;
  name: string;
  rarity: string | null;
}

interface NormalizedCard {
  id: number;
  name: string;
  type: string;
  frameType: string;
  desc: string;
  race: string;
  archetype: string | null;
  attribute: string | null;
  atk: number | null;
  def: number | null;
  level: number | null;
  scale: number | null;
  linkval: number | null;
  linkmarkers: string[] | null;
  images: number[];
  banlistTcg: string | null;
  tcgDate: string | null;
  sets: CardPrint[];
}

function setsOf(card: any): CardPrint[] {
  const out: CardPrint[] = [];
  const seen = new Set<string>();
  for (const cs of card?.card_sets ?? []) {
    const code: string | undefined = cs?.set_code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: cs?.set_name ?? "", rarity: cs?.set_rarity || null });
  }
  return out;
}

const NAME_OVERRIDE = new Map<number, string>([
  [98349765, 'Layer 19 "Sudden Incursion! Super Quantum Black!!"'],
]);

function normalize(card: any): NormalizedCard {
  return {
    id: card.id,
    name: NAME_OVERRIDE.get(card.id) ?? card.name,
    type: card.type,
    frameType: card.frameType,
    desc: card.desc,
    race: card.race,
    archetype: card.archetype ?? null,
    attribute: card.attribute ?? null,
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? null,
    scale: card.scale ?? null,
    linkval: card.linkval ?? null,
    linkmarkers: card.linkmarkers ?? null,
    images: Array.isArray(card.card_images)
      ? [...new Set<number>(card.card_images.map((im: any) => im.id))]
      : [card.id],
    banlistTcg: card.banlist_info?.ban_tcg ?? null,
    tcgDate: card.misc_info?.[0]?.tcg_date ?? null,
    sets: setsOf(card),
  };
}

async function backfillFromYugipedia(cards: NormalizedCard[]): Promise<void> {
  const needSets = cards.filter((c) => c.sets.length === 0);
  console.log(`→ Backfilling sets from Yugipedia for ${needSets.length} card(s) with none…`);
  let setsFilled = 0;
  for (const card of needSets) {
    const prints = await fetchTcgPrints(card.name, card.id);
    if (prints.length === 0) continue;
    card.sets = prints.map((p) => ({ code: p.code, name: p.name, rarity: p.rarity }));
    if (card.tcgDate == null) {
      const dates = prints.map((p) => p.date).filter((d): d is string => !!d).sort();
      if (dates[0]) card.tcgDate = dates[0];
    }
    setsFilled++;
  }
  console.log(`  recovered sets for ${setsFilled} card(s)`);

  const needDate = cards.filter((c) => c.tcgDate == null);
  if (needDate.length) {
    console.log(`→ Backfilling release date from Yugipedia for ${needDate.length} card(s)…`);
    const dates = await fetchTcgDebutDates(needDate.map((c) => c.id));
    let dateFilled = 0;
    for (const card of needDate) {
      const d = dates.get(card.id);
      if (d) {
        card.tcgDate = d;
        dateFilled++;
      }
    }
    console.log(`  recovered release date for ${dateFilled} card(s)`);
  }
}

async function main() {
  const limit = numFlag("limit", Infinity);
  const includeUnreleased = hasFlag("include-unreleased");

  console.log("→ Fetching OCG-only cards from Yugipedia (Medium::OCG-only)…");
  const ocgOnly = await fetchOcgOnly();
  console.log(`  ${ocgOnly.passcodes.size} with passcodes, ${ocgOnly.names.size} names (for passcode-less cards)`);

  console.log("→ Fetching full card database from YGOPRODeck (misc=yes)…");
  const json = await fetchJson(`${YGO.cardinfo}?misc=yes`);
  const all: any[] = json?.data ?? [];
  console.log(`  upstream returned ${all.length} cards`);

  const PLACEHOLDER_ID = 100_000_000;
  const hasNoTcgPresence = (c: any): boolean =>
    c.type !== "Token" && (c.card_sets?.length ?? 0) === 0 && !c.misc_info?.[0]?.tcg_date;
  const isOcgOnly = (c: any): boolean =>
    ocgOnly.passcodes.has(c.id) ||
    (c.id >= PLACEHOLDER_ID && ocgOnly.names.has(c.name)) ||
    (ocgOnly.names.has(c.name) && hasNoTcgPresence(c));

  const REMOVE_TYPES = new Set<string>(["Skill Card"]);
  const MANUAL_EXCLUDE = new Set<number>([
    100000101,
    101206080,
    101304014,
    101303071,
  ]);

  const MANUAL_INCLUDE = new Set<number>([
    83566725,
    97462632,
    82344137,
    24461358,
  ]);

  const reasonFor = (c: any): LedgerReason | null => {
    if (MANUAL_INCLUDE.has(c.id)) return null;
    if (REMOVE_TYPES.has(c.type)) return "skill-card";
    if (MANUAL_EXCLUDE.has(c.id)) return "manual";
    if (isOcgOnly(c)) return "ocg-only";
    return null;
  };
  const rejected = new Map<number, LedgerReason>();
  const tcg: any[] = [];
  for (const c of all) {
    const why = reasonFor(c);
    if (why) rejected.set(c.id, why);
    else tcg.push(c);
  }
  const skills = [...rejected.values()].filter((r) => r === "skill-card").length;
  console.log(`  ${tcg.length} kept (dropped ${rejected.size}: ${skills} Skill Cards + OCG-only/curated)`);

  const sliced = Number.isFinite(limit) ? tcg.slice(0, limit) : tcg;
  const allCards = sliced.map(normalize);

  await backfillFromYugipedia(allCards);

  const today = isoDate();
  const isUnreleased = (c: NormalizedCard) => !includeUnreleased && !!c.tcgDate && c.tcgDate > today;
  const unreleasedCards = allCards.filter(isUnreleased);
  if (unreleasedCards.length) {
    const bySet = new Map<string, number>();
    for (const c of unreleasedCards) {
      for (const code of new Set(c.sets.map((p) => p.code.split("-")[0]!))) {
        bySet.set(code, (bySet.get(code) ?? 0) + 1);
      }
    }
    const summary = [...bySet].sort().map(([code, n]) => `${code} ${n}`).join(", ");
    console.log(`  dropped ${unreleasedCards.length} unreleased card(s) (TCG date after ${today}): ${summary}`);
    console.log("    (--include-unreleased keeps them; they carry unofficial translations until release)");
  }

  const decisions: Decision[] = [];
  for (const c of allCards) {
    const unreleasedNow = isUnreleased(c);
    decisions.push({
      code: c.id,
      name: c.name,
      status: unreleasedNow ? "exclude" : "include",
      reason: unreleasedNow ? "unreleased" : "tcg",
      ...(unreleasedNow && c.sets[0] ? { source: c.sets[0].code.split("-")[0]! } : {}),
    });
  }
  const upstreamName = new Map<number, string>(all.map((c) => [c.id as number, c.name as string]));
  for (const [code, reason] of rejected) {
    const nm = upstreamName.get(code);
    decisions.push({ code, status: "exclude", reason, ...(nm ? { name: nm } : {}) });
  }

  const ledger = await readLedger();
  const res = reconcile(ledger, decisions, "cards", { strict: hasFlag("strict") });
  await writeLedger(ledger);
  reportReconcile(res, ledger, "cards");

  const included = includedCodes(ledger);
  const cards = allCards.filter((c) => included.has(c.id));
  const heldBack = allCards.length - cards.length - unreleasedCards.length;
  if (heldBack > 0) {
    console.log(`  ${heldBack} card(s) upstream offered are excluded by the ledger (see engine/cards/ledger.json)`);
  }
  await writeJson(PATHS.cardsDb, {
    _comment: "Generated by scripts/import-cards.ts from YGOPRODeck. TCG only. Do not hand-edit.",
    source: YGO.source,
    generatedAt: new Date().toISOString(),
    count: cards.length,
    cards,
  });

  const artworkCount = cards.reduce((n, c) => n + c.images.length, 0);
  console.log(`✓ Wrote ${cards.length} cards (${artworkCount} artworks referenced) → engine/cards/db.json`);
  console.log("  Next: `pnpm build:images` to download the artwork.");
  if (hasFlag("limit")) console.log("  (ran with --limit; db.json is a partial sample)");
}

main().catch((err) => {
  console.error("✗ import-cards failed:", err);
  process.exit(1);
});
