// scripts/import-cards.ts
//
// BUILD-TIME ONLY. Run manually by Red.
//
//   pnpm import:cards
//
// Pulls the full card database from an external source (YGOPRODeck),
// normalizes it to a compact card-data shape, and writes:
//
//   assets/cards/db.json
//
// TCG ONLY. We keep every card EXCEPT those Yugipedia classifies as OCG-only
// (see fetchOcgOnly in _lib.ts) — matched by Konami passcode, or by name for
// cards with no official passcode (YGOPRODeck placeholder ids ≥ 1e8). We do
// NOT trust YGOPRODeck's own `formats`/`tcg_date` for this distinction: it has
// silently mis-flagged TCG-released cards (e.g. "Artmage Vandalism -Assault-")
// as OCG-only, dropping legitimate TCG cards. Where YGOPRODeck has no set list
// or release date for a kept card, we backfill both from Yugipedia. Do not
// store OCG-exclusive names, sets, or text. Output lands in assets/ — the
// hand-curated card data tracked in this private repo.
//
// This script is the only place in the project allowed to hit the network.
// The running app reads assets/cards/db.json directly and never
// fetches anything at runtime.
//
// NOTE: @duel/shared does not yet declare the frozen card-data shape (it lands
// with the first engine milestone). The normalized shape below is the working
// contract; when @duel/shared publishes `CardData`, update `normalize()` to
// produce exactly that and import the type here.

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
} from "./_lib.ts";

/** One printing of a card in a set (mirrors @duel/shared CardPrint). */
interface CardPrint {
  code: string; // full set code, e.g. "LOB-EN001"
  name: string; // set name, e.g. "Legend of Blue Eyes White Dragon"
  rarity: string | null;
}

/** A single artwork passcode + the card it belongs to. */
interface NormalizedCard {
  id: number; // primary passcode
  name: string;
  type: string; // e.g. "Effect Monster", "Spell Card"
  frameType: string; // e.g. "effect", "spell", "xyz", "link"
  desc: string;
  race: string; // monster type ("Dragon") or spell/trap kind ("Continuous")
  archetype: string | null;
  attribute: string | null;
  atk: number | null;
  def: number | null;
  level: number | null; // level / rank
  scale: number | null; // pendulum scale
  linkval: number | null;
  linkmarkers: string[] | null;
  /** every artwork passcode for this card (includes alternate arts) */
  images: number[];
  banlistTcg: string | null; // "Banned" | "Limited" | "Semi-Limited" | null
  tcgDate: string | null; // earliest TCG release (YYYY-MM-DD)
  sets: CardPrint[]; // every set this card was printed in
}

/** Every distinct printing from a card's card_sets[] (dedup by full set code). */
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

/**
 * Confirmed-wrong card names from YGOPRODeck, keyed by passcode. YGOPRODeck
 * sometimes carries an OCG-translated name instead of the official TCG name
 * (notably for Duelist's Advance). Yugipedia is authoritative for these.
 */
const NAME_OVERRIDE = new Map<number, string>([
  // DUAD-EN068 — YGOPRODeck had the OCG translation, not the TCG name.
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
    // Distinct artwork passcodes — YGOPRODeck sometimes repeats the same id in
    // card_images, which would render duplicate tiles in the grid.
    images: Array.isArray(card.card_images)
      ? [...new Set<number>(card.card_images.map((im: any) => im.id))]
      : [card.id],
    banlistTcg: card.banlist_info?.ban_tcg ?? null,
    tcgDate: card.misc_info?.[0]?.tcg_date ?? null,
    sets: setsOf(card),
  };
}

/**
 * Fill gaps YGOPRODeck leaves on cards it wrongly treats as OCG-only: it has
 * no `card_sets` and no `tcg_date` for them. Scrape each such card's Yugipedia
 * "TCG sets" table for its prints (and derive a release date from them), then
 * one bulk Yugipedia query backfills any release date still missing.
 */
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
  const limit = numFlag("limit", Infinity); // for testing: --limit=50

  console.log("→ Fetching OCG-only cards from Yugipedia (Medium::OCG-only)…");
  const ocgOnly = await fetchOcgOnly();
  console.log(`  ${ocgOnly.passcodes.size} with passcodes, ${ocgOnly.names.size} names (for passcode-less cards)`);

  console.log("→ Fetching full card database from YGOPRODeck (misc=yes)…");
  const json = await fetchJson(`${YGO.cardinfo}?misc=yes`);
  const all: any[] = json?.data ?? [];
  console.log(`  upstream returned ${all.length} cards`);

  // Drop OCG-only cards. Three ways, all rooted in Yugipedia's Medium::OCG-only
  // set: (1) by passcode for released cards; (2) by name for cards YGOPRODeck
  // gives a placeholder id (≥ 1e8 — no official passcode, so Yugipedia has no
  // Password either); (3) by name for OCG-only promos with a special sub-1e8
  // passcode that Yugipedia files under a different code (e.g. "Holactie the
  // Creator of Light", "Magi Magi ☆ Magician Gal") — gated on "no TCG presence"
  // (no printed sets, no TCG date, not a Token) so a real TCG card that merely
  // shares a name with an OCG-only variant (e.g. "Zera the Mant") is never hit.
  const PLACEHOLDER_ID = 100_000_000;
  const hasNoTcgPresence = (c: any): boolean =>
    c.type !== "Token" && (c.card_sets?.length ?? 0) === 0 && !c.misc_info?.[0]?.tcg_date;
  const isOcgOnly = (c: any): boolean =>
    ocgOnly.passcodes.has(c.id) ||
    (c.id >= PLACEHOLDER_ID && ocgOnly.names.has(c.name)) ||
    (ocgOnly.names.has(c.name) && hasNoTcgPresence(c));

  // Hand-curated removals (Red's call): types/cards that aren't OCG-only but we
  // don't want in a TCG card pool.
  //   - Skill Cards: Speed Duel skills; hundreds of them, not used here.
  //   - MANUAL_EXCLUDE: confirmed non-paper cards (e.g. video-game-only).
  const REMOVE_TYPES = new Set<string>(["Skill Card"]);
  const MANUAL_EXCLUDE = new Set<number>([
    100000101, // Ojamandala — video-game-only (Yugipedia Medium: Video game)
    101206080, // Fireworks Celebration — OCG version of "Summer Schoolwork Successful!"
    101304014, // "Elvennotes Regina" — OCG-romanization dupe of TCG "Elfnote Regina" (56651978)
    101303071, // "Elvennotes ~Oracle Alicetea~" — OCG dupe of TCG "Elfnotes: Aristeia of Trust" (50590801)
  ]);

  const tcg = all.filter(
    (c) => !isOcgOnly(c) && !REMOVE_TYPES.has(c.type) && !MANUAL_EXCLUDE.has(c.id),
  );
  const dropped = all.length - tcg.length;
  const skills = all.filter((c) => REMOVE_TYPES.has(c.type)).length;
  console.log(`  ${tcg.length} kept (dropped ${dropped}: ${skills} Skill Cards + OCG-only/curated)`);

  const sliced = Number.isFinite(limit) ? tcg.slice(0, limit) : tcg;
  const cards = sliced.map(normalize);

  await backfillFromYugipedia(cards);

  await writeJson(PATHS.cardsDb, {
    _comment: "Generated by scripts/import-cards.ts from YGOPRODeck. TCG only. Do not hand-edit.",
    source: YGO.source,
    generatedAt: new Date().toISOString(),
    count: cards.length,
    cards,
  });

  const artworkCount = cards.reduce((n, c) => n + c.images.length, 0);
  console.log(`✓ Wrote ${cards.length} cards (${artworkCount} artworks referenced) → assets/cards/db.json`);
  console.log("  Next: `pnpm build:images` to download the artwork.");
  if (hasFlag("limit")) console.log("  (ran with --limit; db.json is a partial sample)");
}

main().catch((err) => {
  console.error("✗ import-cards failed:", err);
  process.exit(1);
});
