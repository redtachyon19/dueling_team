// scripts/update-genesys.ts
//
// BUILD-TIME ONLY. Run manually by Red.
//
//   pnpm import:genesys
//
// Archives the CURRENT Genesys points list as an immutable dated snapshot:
//
//   engine/genesys/YYYY-MM-DD.json
//
// Genesys is Konami's TCG points-based format: each listed card carries a
// point value (1–100) and a legal deck (Main+Extra+Side combined) must stay
// under the point cap (standard 100); cards not on the list cost 0 points.
//
// SOURCE: Konami's official Genesys page (yugioh-card.com/en/genesys/), which
// publishes the CURRENT list in full as an HTML table (Card Name | Points).
// This is the authority, so a snapshot is a straight scrape — no delta math.
//
// It replaced the third-party yugiohgenesysbuilder.com API this script used to
// read. That API drifted badly (verified 2026-08-16: 520 unique entries vs the
// official 751, missing staples like D.D. Crow and Terraforming, and serving
// point values from no single revision), so it is no longer trusted for the
// current list. `GENESYS_API` survives in _lib.ts only for the historical
// reconstruction in import-genesys-history.ts — see the warning in that file.
//
// Only the CURRENT list is published; older revisions are not machine-readable
// and cannot be back-filled the way the TCG banlists were. Each dated file is
// append-only, so re-running on the same revision is a no-op.
//
// TCG ONLY. Names are resolved to passcodes strictly against our TCG-only
// engine/cards/db.json — an entry that does not resolve there is reported, not
// invented. Network access is confined to importer scripts; the running app
// reads only the local files under engine/genesys/.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS, GENESYS_OFFICIAL, fetchText, readJson, writeJson, exists, ensureDir } from "./_lib.ts";

// Effective date of the current list. Konami's update articles publish the
// changes a few days ahead ("these point changes take effect on Monday"), so
// this is the EFFECTIVE Monday, not the article's publish date. Bump it when
// Konami publishes a new list so a new dated snapshot is written.
//   2026-08-03 — "Post Genesys Championships August Points Update"
//                (published 2026-07-30, effective the following Monday)
const EFFECTIVE_DATE = "2026-08-03";
// Genesys deck point cap (Konami's standard). Adjust if a revision changes it.
const POINT_CAP = 100;
const SOURCE = `${GENESYS_OFFICIAL} (Konami official, effective ${EFFECTIVE_DATE})`;

interface GItem {
  id: number;
  name: string;
  points: number;
}
interface Revision {
  date: string;
  format: "TCG";
  pointCap: number | null;
  source: string;
  fetchedAt: string;
  cards: GItem[];
}

/** Aggressive name key: lowercase, drop quotes, turn hyphens/dashes into
 *  spaces, collapse whitespace — so Konami's table spellings line up with db
 *  names ('"A Case for K9"' = "A Case for K9"). Kept in sync with the same
 *  helper in import-genesys-history.ts. */
const norm = (s: string) =>
  s.toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Genuine spelling differences between Konami's official table and db names,
// keyed by norm(officialName) -> norm(dbName). Our db names come from
// YGOPRODeck, which does not always match Konami's own English rendering; each
// mapping below was checked 1:1 against Konami's card database before landing.
const ALIASES: Record<string, string> = {
  // The official table transliterates the Greek capital omega as "O".
  "exstellarknight constellar ptolemy o7": "exstellarknight constellar ptolemy ω7",
  // Konami's list puts the Sacred Beast subtitle first and words it
  // differently; YGOPRODeck appends it. One retrain each, both dated
  // 2026-07-02, so the mapping is unambiguous.
  "calamity of the sacred beasts hamon, lord of striking thunder":
    "hamon, lord of striking thunder sacred beast of sinful catastrophe",
  "infinity of the sacred beasts raviel, lord of phantasms":
    "raviel, lord of phantasms sacred beast of endless eternity",
  // Konami's official name is "Stellarnova Binding"; YGOPRODeck calls the same
  // BLGG Spell "Stellarnova Bonds" (both sources list exactly three
  // Stellarnova cards, and Alpha/Wave match on each side).
  "stellarnova binding": "stellarnova bonds",
  // Same card, different English rendering (also aliased in the history importer).
  "the three champions of swordsoul": "the three brave swordsouls",
  // Konami's page serves this name as Latin-1 bytes inside a UTF-8 document, so
  // the "ØØ" arrives as two U+FFFD replacement chars. Keyed on the mojibake; if
  // Konami ever fixes the encoding the name resolves directly and this is
  // simply unused.
  "k9 �� lupis": "k9 øø lupis",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<");
}

/** Scrape the official page's single points table into [name, points] pairs. */
function parseOfficialTable(html: string): Array<[string, number]> {
  const table = html.match(/<table[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  const out: Array<[string, number]> = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      decodeEntities(m[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    );
    if (cells.length < 2) continue;
    const [name, pts] = [cells[0]!, cells[1]!];
    if (!/^\d+$/.test(pts)) continue; // skips the "Card Name | Points" header
    if (name) out.push([name, Number(pts)]);
  }
  return out;
}

async function regenerateIndex(): Promise<number> {
  await ensureDir(PATHS.genesys);
  const files = (await readdir(PATHS.genesys)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  files.sort().reverse();
  const revisions = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(PATHS.genesys, file), "utf8")) as Revision;
    revisions.push({
      date: data.date,
      file,
      cardCount: data.cards?.length ?? 0,
      pointCap: data.pointCap ?? null,
    });
  }
  await writeJson(PATHS.genesysIndex, {
    _comment: "Generated by scripts/update-genesys.ts. TCG only. Do not hand-edit.",
    revisions,
  });
  return revisions.length;
}

async function main() {
  const db = await readJson<{ cards: Array<{ id: number; name: string }> }>(PATHS.cardsDb);
  if (!db?.cards?.length) {
    console.error("✗ engine/cards/db.json not found. Run `pnpm import:cards` first.");
    process.exit(1);
  }
  const idByName = new Map<string, number>();
  const nameById = new Map<number, string>();
  for (const c of db.cards) {
    idByName.set(norm(c.name), c.id);
    nameById.set(c.id, c.name);
  }

  console.log("→ Fetching the official Genesys points list…");
  const entries = parseOfficialTable(await fetchText(GENESYS_OFFICIAL));
  if (entries.length === 0) {
    console.error(`✗ no Genesys table found at ${GENESYS_OFFICIAL} — the page layout may have changed.`);
    process.exit(1);
  }
  const pts = entries.map(([, p]) => p);
  console.log(`  ${entries.length} carded entries (points ${Math.min(...pts)}–${Math.max(...pts)})`);

  // Resolve every entry against the TCG-only db; report anything that misses
  // rather than trusting a name we can't tie to a passcode.
  const cards: GItem[] = [];
  const unresolved: string[] = [];
  for (const [rawName, points] of entries) {
    const key = norm(rawName);
    const id = idByName.get(ALIASES[key] ?? key);
    if (id == null) {
      unresolved.push(rawName);
      continue;
    }
    cards.push({ id, name: nameById.get(id)!, points });
  }
  cards.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  const file = join(PATHS.genesys, `${EFFECTIVE_DATE}.json`);
  if (await exists(file)) {
    console.log(`  ${EFFECTIVE_DATE}.json already archived — append-only, leaving it untouched.`);
  } else {
    const revision: Revision = {
      date: EFFECTIVE_DATE,
      format: "TCG",
      pointCap: POINT_CAP,
      source: SOURCE,
      fetchedAt: new Date().toISOString(),
      cards,
    };
    await writeJson(file, revision);
    console.log(`  wrote snapshot → engine/genesys/${EFFECTIVE_DATE}.json (${cards.length} cards, cap ${POINT_CAP})`);
  }

  if (unresolved.length) {
    console.log(`  ⚠ ${unresolved.length} entr(y/ies) not in the TCG db, skipped: ${unresolved.join(", ")}`);
    console.log("    (run `pnpm import:cards` first if a new set just dropped, then add an alias here)");
  }

  const total = await regenerateIndex();
  console.log(`✓ Done. ${total} Genesys revision(s) archived.`);
}

main().catch((err) => {
  console.error("✗ update-genesys failed:", err);
  process.exit(1);
});
