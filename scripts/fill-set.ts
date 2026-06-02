// scripts/fill-set.ts
//
// BUILD-TIME ONLY. Run manually by Red.
//
//   pnpm fill:set RA05          (or: pnpm fill:set --set=RA05)
//
// Repairs a set whose card count is short of what Yugipedia lists. For the
// given set code it reads Yugipedia's TCG-EN set card list, finds every print
// number missing from assets/cards/db.json, and ADDS it:
//   - if the card already exists (by name) → attaches the missing print to it
//     (e.g. an alternate/"stamp artwork" reprint YGOPRODeck didn't record);
//   - if the card is missing entirely → fetches it from YGOPRODeck, normalizes
//     it, adds it, and downloads its art.
// Purely additive — never overwrites existing card data. Re-runnable.

import { join } from "node:path";
import {
  PATHS,
  YGO,
  YUGIPEDIA,
  fetchJson,
  readJson,
  writeJson,
  downloadFile,
  ensureDir,
  sleep,
} from "./_lib.ts";

interface CardPrint {
  code: string;
  name: string;
  rarity: string | null;
}
interface Card {
  id: number;
  name: string;
  sets: CardPrint[];
  images: number[];
  [k: string]: unknown;
}

const prefixOf = (code: string): string => code.split("-")[0]!;
const cleanName = (raw: string): string =>
  raw
    .split("//")[0]!
    .replace(/\[\[|\]\]/g, "")
    .replace(/\{\{=\}\}/g, "=")
    .trim();

/** Parse a Yugipedia "Set Card Lists" page into { fullCode → {name, rarity} }. */
function parseSetList(wikitext: string, code: string): Map<string, { name: string; rarity: string | null }> {
  const out = new Map<string, { name: string; rarity: string | null }>();
  const codeRe = new RegExp(`^\\s*(${code}-[A-Za-z0-9]+)\\s*;\\s*([^;\\n]+?)\\s*(?:;\\s*([^\\n]+))?\\s*$`);
  for (const block of wikitext.match(/\{\{Set list[\s\S]*?\}\}/g) ?? []) {
    const def = block.match(/rarities=([^\n|]+)/);
    const sectionRarity = def ? def[1]!.split(",")[0]!.trim() : null;
    for (const line of block.split("\n")) {
      const m = line.match(codeRe);
      if (!m) continue;
      const rarity = (m[3]?.split(",")[0]?.trim() || sectionRarity) ?? null;
      out.set(m[1]!.toUpperCase(), { name: cleanName(m[2]!), rarity });
    }
  }
  return out;
}

/** Normalize a YGOPRODeck card to our on-disk shape (mirrors import-cards). */
function normalize(c: any): Card {
  const seen = new Set<string>();
  const sets: CardPrint[] = [];
  for (const cs of c.card_sets ?? []) {
    if (!cs?.set_code || seen.has(cs.set_code)) continue;
    seen.add(cs.set_code);
    sets.push({ code: cs.set_code, name: cs.set_name ?? "", rarity: cs.set_rarity || null });
  }
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    frameType: c.frameType,
    desc: c.desc,
    race: c.race,
    archetype: c.archetype ?? null,
    attribute: c.attribute ?? null,
    atk: c.atk ?? null,
    def: c.def ?? null,
    level: c.level ?? null,
    scale: c.scale ?? null,
    linkval: c.linkval ?? null,
    linkmarkers: c.linkmarkers ?? null,
    images: Array.isArray(c.card_images) ? [...new Set<number>(c.card_images.map((im: any) => im.id))] : [c.id],
    banlistTcg: c.banlist_info?.ban_tcg ?? null,
    tcgDate: c.misc_info?.[0]?.tcg_date ?? null,
    sets,
  };
}

async function main() {
  const db = await readJson<{ cards: Card[]; count?: number }>(PATHS.cardsDb);
  const setsDb = await readJson<{ sets: Array<{ code: string; name: string }> }>(PATHS.setsDb);
  if (!db?.cards || !setsDb?.sets) {
    console.error("✗ db.json / sets db.json not found. Run the importers first.");
    process.exit(1);
  }
  const setByCode = new Map(setsDb.sets.map((s) => [s.code, s]));
  const flagSet = process.argv.find((a) => a.startsWith("--set="))?.slice(6);
  const code = (flagSet ?? process.argv.find((a) => setByCode.has(a.toUpperCase())))?.toUpperCase();
  if (!code) {
    console.error("✗ Pass a set code: pnpm fill:set RA05");
    process.exit(1);
  }
  const setName = setByCode.get(code)?.name ?? code;
  console.log(`→ Filling ${code} (${setName})`);

  // Yugipedia's authoritative TCG-EN list for this set.
  const page = `Set Card Lists:${setName} (TCG-EN)`;
  const parse = await fetchJson(
    `${YUGIPEDIA.api}?action=parse&prop=wikitext&format=json&page=${encodeURIComponent(page)}`,
  );
  const wikitext: string = parse?.parse?.wikitext?.["*"] ?? "";
  if (!wikitext) {
    console.error(`✗ Could not load "${page}". Check the set name.`);
    process.exit(1);
  }
  const listed = parseSetList(wikitext, code);
  console.log(`  Yugipedia lists ${listed.size} print(s)`);

  const byName = new Map(db.cards.map((c) => [c.name, c]));
  const have = new Set<string>();
  for (const c of db.cards) for (const s of c.sets) if (prefixOf(s.code) === code) have.add(s.code.toUpperCase());

  const missing = [...listed.entries()].filter(([fullCode]) => !have.has(fullCode));
  if (missing.length === 0) {
    console.log("✓ Nothing missing — set is already complete.");
    return;
  }
  console.log(`  ${missing.length} print(s) missing — filling…`);

  const newArt: number[] = [];
  const addedPrints: string[] = [];
  const addedCards: string[] = [];
  const unresolved: string[] = [];

  for (const [fullCode, { name, rarity }] of missing) {
    const existing = byName.get(name);
    if (existing) {
      if (!existing.sets.some((s) => s.code.toUpperCase() === fullCode)) {
        existing.sets.push({ code: fullCode, name: setName, rarity });
        addedPrints.push(`${fullCode} → ${name}`);
      }
      continue;
    }
    // Card not in DB at all — fetch it from YGOPRODeck by name and add it.
    try {
      const res = await fetchJson(`${YGO.cardinfo}?misc=yes&name=${encodeURIComponent(name)}`);
      const raw = res?.data?.[0];
      if (!raw) {
        unresolved.push(`${fullCode} (${name})`);
        continue;
      }
      const card = normalize(raw);
      if (!card.sets.some((s) => s.code.toUpperCase() === fullCode)) {
        card.sets.push({ code: fullCode, name: setName, rarity });
      }
      db.cards.push(card);
      byName.set(card.name, card);
      newArt.push(...card.images);
      addedCards.push(`${fullCode} → ${name} (#${card.id})`);
    } catch {
      unresolved.push(`${fullCode} (${name})`);
    }
    await sleep(150);
  }

  db.count = db.cards.length;
  await writeJson(PATHS.cardsDb, db);

  console.log(`✓ Added ${addedPrints.length} print(s) to existing cards, ${addedCards.length} new card(s).`);
  for (const a of addedPrints) console.log(`    print: ${a}`);
  for (const a of addedCards) console.log(`    card:  ${a}`);
  if (unresolved.length) console.log(`  ⚠ Unresolved (not found on YGOPRODeck): ${unresolved.join(", ")}`);

  // Download art only for newly-added cards (existing ones already have it).
  if (newArt.length) {
    await ensureDir(PATHS.cardImages);
    await ensureDir(PATHS.cardImagesCropped);
    for (const id of [...new Set(newArt)]) {
      await downloadFile(YGO.cardImage(id), join(PATHS.cardImages, `${id}.jpg`));
      await downloadFile(YGO.cardImageCropped(id), join(PATHS.cardImagesCropped, `${id}.jpg`));
    }
    console.log(`  Downloaded art for ${new Set(newArt).size} artwork(s).`);
  }
}

main().catch((err) => {
  console.error("✗ fill-set failed:", err);
  process.exit(1);
});
