// scripts/import-banlists-legacy.ts
//
// BUILD-TIME ONLY. Run manually by Red.
//
//   pnpm import:banlists:legacy
//
// Backfills PRE-2013 historical TCG banlists that the comprehensive lflist
// source (used by update-banlists.ts) does not reach — it only goes back to
// 2013-10. Source: Yugipedia's "Historic TCG Limitations Chart/2002–2010"
// MediaWiki page, a single wikitable where each row is a card and each column
// is a list date.
//
// Wikitext row format (learned empirically):
//   ! scope="row" | [[Card Name]]
//   | colspan="K" | || {{#var: N}} || {{#var: N}} || ...
// where each {{#var: N}} is the card's status under one list (0=Forbidden,
// 1=Limited, 2=Semi-Limited, 3=Unlimited). The leading `colspan="K"` skips K
// columns (card not yet relevant), and the N values are right-aligned to the
// full column set: firstColumnIndex = totalColumns - varCount.
//
// We resolve card names → passcodes via engine/cards/db.json and write
// append-only engine/banlists/YYYY-MM-01.json (skipping any date that
// already exists, so the 2013+ lflist files are never touched), then
// regenerate index.json.
//
// TCG ONLY. Network access is confined to importer scripts.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS, fetchText, writeJson, readJson, exists, ensureDir, sleep } from "./_lib.ts";

// Two chart pages cover the pre-lflist era. The 2002–2010 page goes to
// 2010-09; the 2011–2020 page covers the 2011–2013 gap (we cut off at 2013
// where the lflist importer takes over).
const CHART_PAGES = [
  "Historic TCG Limitations Chart/2002–2010",
  "Historic TCG Limitations Chart/2011–2020",
];
const chartUrl = (page: string) =>
  "https://yugipedia.com/api.php?action=parse&prop=wikitext&format=json&page=" +
  encodeURIComponent(page);
const SOURCE = "Yugipedia: Historic TCG Limitations Chart";

// Only backfill lists strictly BEFORE this date (2013+ comes from lflist).
const CUTOFF = "2013-10-01";

interface Entry {
  id: number;
  name: string;
}
interface Revision {
  date: string;
  format: "TCG";
  source: string;
  fetchedAt: string;
  forbidden: Entry[];
  limited: Entry[];
  semiLimited: Entry[];
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/** "May 2002" → "2002-05-01". */
function monthYearToDate(label: string): string | null {
  const m = label.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[1]!.toLowerCase()];
  return mon ? `${m[2]}-${mon}-01` : null;
}

/** Normalize a card name for matching (case/whitespace/quotes-insensitive). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'") // curly apostrophes → '
    .replace(/[“”]/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  // name → id map from the card DB.
  const db = await readJson<{ cards: Entry[] }>(PATHS.cardsDb);
  if (!db?.cards?.length) {
    console.error("✗ cards/db.json not found. Run `pnpm import:cards` first.");
    process.exit(1);
  }
  const idByName = new Map<string, number>();
  for (const c of db.cards) idByName.set(norm(c.name), c.id);

  // Accumulate entries per list date across both chart pages.
  const perDate = new Map<string, { forbidden: Entry[]; limited: Entry[]; semiLimited: Entry[] }>();
  const bucketFor = (date: string) => {
    let b = perDate.get(date);
    if (!b) {
      b = { forbidden: [], limited: [], semiLimited: [] };
      perDate.set(date, b);
    }
    return b;
  };

  let unmatched = 0;
  const unmatchedNames = new Set<string>();

  for (const page of CHART_PAGES) {
    console.log(`→ Fetching ${page} from Yugipedia…`);
    const json = JSON.parse(await fetchText(chartUrl(page)));
    const wt: string = json?.parse?.wikitext?.["*"] ?? "";
    if (!wt) {
      console.warn(`  ⚠ empty wikitext for ${page} — skipping`);
      continue;
    }

    // Column dates, in order, from the header links: [[<Month Year> Lists…|n]].
    const colDates = [...wt.matchAll(/\[\[([A-Z][a-z]+ \d{4}) Lists[^\]]*\]\]/g)]
      .map((m) => monthYearToDate(m[1]!));
    const totalCols = colDates.length;
    console.log(`  ${totalCols} list columns (${colDates[0]} … ${colDates[totalCols - 1]})`);

    // Each table row begins with "|-"; split and find card rows.
    for (const row of wt.split(/\n\|-\s*/)) {
      const nameMatch = row.match(/!\s*scope="row"\s*\|\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
      if (!nameMatch) continue;
      const cardName = nameMatch[1]!.trim();

      const vars = [...row.matchAll(/\{\{\s*#var:\s*(\d)\s*\}\}/g)].map((m) => parseInt(m[1]!, 10));
      if (vars.length === 0) continue;

      const id = idByName.get(norm(cardName)) ?? null;
      if (id == null) {
        unmatched++;
        unmatchedNames.add(cardName);
        continue;
      }

      // Status values are right-aligned to the full column set.
      const start = totalCols - vars.length;
      for (let i = 0; i < vars.length; i++) {
        const date = colDates[start + i];
        if (!date) continue;
        const entry: Entry = { id, name: cardName };
        const b = bucketFor(date);
        if (vars[i] === 0) b.forbidden.push(entry);
        else if (vars[i] === 1) b.limited.push(entry);
        else if (vars[i] === 2) b.semiLimited.push(entry);
        // 3 = Unlimited → no entry
      }
    }
    await sleep(300); // be polite to Yugipedia between page fetches
  }

  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  let written = 0;
  let skipped = 0;
  const fetchedAt = new Date().toISOString();

  for (const [date, bucket] of [...perDate].sort()) {
    if (date >= CUTOFF) continue; // 2013-10+ handled by the lflist importer
    if (bucket.forbidden.length + bucket.limited.length + bucket.semiLimited.length === 0) continue;

    const file = join(PATHS.banlists, `${date}.json`);
    if (await exists(file)) {
      skipped++;
      continue;
    }
    const revision: Revision = {
      date,
      format: "TCG",
      source: SOURCE,
      fetchedAt,
      forbidden: bucket.forbidden.sort(byName),
      limited: bucket.limited.sort(byName),
      semiLimited: bucket.semiLimited.sort(byName),
    };
    await writeJson(file, revision);
    written++;
  }

  console.log(`  unmatched card names: ${unmatched}${unmatched ? " (e.g. " + [...unmatchedNames].slice(0, 8).join(", ") + ")" : ""}`);
  console.log(`✓ Wrote ${written} pre-2013 list(s), skipped ${skipped} existing.`);

  const total = await regenerateIndex();
  console.log(`  index now has ${total} revision(s).`);
}

async function regenerateIndex(): Promise<number> {
  await ensureDir(PATHS.banlists);
  const files = (await readdir(PATHS.banlists)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  files.sort().reverse();
  const revisions = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(PATHS.banlists, file), "utf8")) as Revision;
    revisions.push({
      date: data.date,
      file,
      forbidden: data.forbidden?.length ?? 0,
      limited: data.limited?.length ?? 0,
      semiLimited: data.semiLimited?.length ?? 0,
    });
  }
  await writeJson(PATHS.banlistIndex, {
    _comment: "Generated by scripts/update-banlists.ts + import-banlists-legacy.ts. TCG only. Do not hand-edit.",
    revisions,
  });
  return revisions.length;
}

main().catch((err) => {
  console.error("✗ import-banlists-legacy failed:", err);
  process.exit(1);
});
