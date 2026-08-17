// scripts/check-script-coverage.ts
//
// BUILD-TIME ONLY. No network. Run manually or in a refresh/CI step.
//
//   pnpm check:scripts            # human report, exits non-zero if real gaps
//   pnpm check:scripts --list     # also print every real gap
//   pnpm check:scripts --json     # machine-readable report on stdout
//   pnpm check:scripts --quiet    # only print on real gaps (good for cron)
//
// The duel engine (ocgcore) needs two things for every card it plays, both
// produced by `pnpm import:ocg` from ProjectIgnis:
//   - an entry in assets/ocgcore/carddata.json   (cardReader — metadata)
//   - assets/ocgcore/script/c<code>.lua          (scriptReader — effects)
//
// Those are a snapshot of a moving upstream, while engine/cards/db.json grows
// every time `pnpm import:cards` runs. This check is the drift signal between
// the two: it reports cards in db.json that the engine can't fully represent,
// so a stale script set can never go unnoticed again.
//
// Two independent axes, because they fail differently:
//   1. MISSING CARDDATA — the engine can't even load the card. Affects every
//      type (a vanilla monster still needs carddata).
//   2. MISSING SCRIPT   — the card loads but its effects can't resolve. Only
//      matters for cards that HAVE effects; vanilla Normal monsters and Tokens
//      legitimately ship no script, so those are reported as "expected" and do
//      not count as gaps.
//
// Exit code: 0 when there are no real gaps, 1 otherwise — so it can gate a
// release or drive a notify-only scheduled job. `--json`/`--quiet` never change
// the exit code, only the output.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS, readJson, hasFlag } from "./_lib.ts";

const OCG = PATHS.ocgcore;
const SCRIPT_DIR = PATHS.ocgcoreScripts;
const CARDDATA = join(OCG, "carddata.json");

interface DbCard {
  id: number;
  name: string;
  type: string;
  images?: number[];
}

/** Card types that carry no effect, so the absence of a Lua script is expected
 *  and correct (ocgcore plays them from carddata alone). */
const NO_SCRIPT_TYPES = new Set<string>([
  "Normal Monster",
  "Normal Tuner Monster",
  "Token",
]);
const isExpectedScriptless = (c: DbCard): boolean => NO_SCRIPT_TYPES.has(c.type);

/** Passcodes ProjectIgnis won't ship under our TCG code (anime/event cards that
 *  slip past db.json's TCG filter because YGOPRODeck dates them; upstream scripts
 *  them only under anime passcodes, e.g. c50100008x). Listed explicitly so they
 *  don't perpetually fail the gate — a NEW gap still trips it. Re-check with
 *  `--all`; remove an entry if upstream adds it (or once aliased into carddata).
 *  Hand-written, engine-verified draft scripts for these live in ocg/generated/. */
const KNOWN_UNSUPPORTED = new Map<number, string>([
  [662853, "Sanctity of Dragon — anime (no ProjectIgnis script)"],
  [662854, "Noritoshi in Darkest Rainment — anime"],
  [662855, "Amatsu-Okami of the Divine Peaks — anime"],
  [662857, "Iron Knight of Revolution — anime"],
  [111000561, "Get Your Game On! — anime/event promo"],
]);

interface Gap {
  id: number;
  name: string;
  type: string;
  /** present in carddata.json (engine can load it) */
  carddata: boolean;
  /** has a c<code>.lua script (or doesn't need one) */
  script: boolean;
}

async function main() {
  const db = await readJson<{ cards: DbCard[] }>(PATHS.cardsDb);
  if (!db?.cards?.length) {
    console.error("✗ engine/cards/db.json not found. Run `pnpm import:cards` first.");
    process.exit(2);
  }

  // Engine data: a set of every script passcode and every carddata code.
  const scriptIds = new Set<number>();
  for (const f of await readdir(SCRIPT_DIR).catch(() => [] as string[])) {
    const m = /^c(\d+)\.lua$/.exec(f);
    if (m) scriptIds.add(Number(m[1]));
  }
  const carddata = (await readJson<Record<string, unknown>>(CARDDATA)) ?? {};
  const cardIds = new Set<number>(Object.keys(carddata).map(Number));
  if (scriptIds.size === 0 || cardIds.size === 0) {
    console.error(
      `✗ assets/ocgcore looks empty (scripts: ${scriptIds.size}, carddata: ${cardIds.size}). Run \`pnpm import:ocg\`.`,
    );
    process.exit(2);
  }

  // A card's engine data may be keyed by its primary passcode OR any alternate
  // artwork passcode (alts share a script/carddata entry via `alias`).
  const idsOf = (c: DbCard): number[] => [c.id, ...(c.images ?? [])];
  const hasCarddata = (c: DbCard) => idsOf(c).some((i) => cardIds.has(i));
  const hasScript = (c: DbCard) => idsOf(c).some((i) => scriptIds.has(i));

  const missingCarddata: Gap[] = [];
  const missingScript: Gap[] = []; // effect-bearing cards only
  let expectedScriptless = 0; // vanilla + tokens with no script (fine)
  let knownUnsupported = 0; // documented anime/event cards (KNOWN_UNSUPPORTED)
  const showAll = hasFlag("all"); // surface known-unsupported as gaps too

  for (const c of db.cards) {
    const carddataOk = hasCarddata(c);
    const scriptOk = hasScript(c);
    if (carddataOk && scriptOk) continue;
    if (!showAll && KNOWN_UNSUPPORTED.has(c.id)) {
      knownUnsupported++;
      continue;
    }
    if (!carddataOk) {
      missingCarddata.push({ id: c.id, name: c.name, type: c.type, carddata: false, script: scriptOk });
    }
    if (!scriptOk) {
      if (isExpectedScriptless(c)) expectedScriptless++;
      else missingScript.push({ id: c.id, name: c.name, type: c.type, carddata: carddataOk, script: false });
    }
  }

  // Which gaps are actually playable right now? Cross-reference the newest
  // Genesys list — a missing script there blocks a legal, current-format card.
  const genesysIdx = await readJson<{ revisions: Array<{ file: string }> }>(PATHS.genesysIndex);
  let genesysIds = new Set<number>();
  let genesysDate = "";
  const latest = genesysIdx?.revisions?.[0]?.file;
  if (latest) {
    const rev = await readJson<{ date: string; cards: Array<{ id: number }> }>(join(PATHS.genesys, latest));
    if (rev) {
      genesysDate = rev.date;
      genesysIds = new Set(rev.cards.map((c) => c.id));
    }
  }
  const onGenesys = (g: Gap) => genesysIds.has(g.id);
  const playableGaps = [...new Set([...missingCarddata, ...missingScript].filter(onGenesys).map((g) => g.id))];

  // Count DISTINCT cards with at least one gap — a card missing both carddata
  // and a script is one unsupported card, not two.
  const realGaps = new Set([...missingCarddata, ...missingScript].map((g) => g.id)).size;
  const byType = (gaps: Gap[]) => {
    const m: Record<string, number> = {};
    for (const g of gaps) m[g.type] = (m[g.type] ?? 0) + 1;
    return m;
  };

  if (hasFlag("json")) {
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          dbCards: db.cards.length,
          scriptFiles: scriptIds.size,
          carddataEntries: cardIds.size,
          missingCarddata: missingCarddata.map((g) => ({ id: g.id, name: g.name, type: g.type, hasScript: g.script })),
          missingScript: missingScript.map((g) => ({ id: g.id, name: g.name, type: g.type, hasCarddata: g.carddata })),
          expectedScriptless,
          knownUnsupported,
          genesysList: genesysDate,
          playableGapIds: playableGaps,
          realGaps,
        },
        null,
        2,
      ),
    );
    process.exit(realGaps > 0 ? 1 : 0);
  }

  const quiet = hasFlag("quiet");
  if (!quiet || realGaps > 0) {
    console.log(`Engine-data coverage  (engine/cards/db.json ↔ assets/ocgcore)`);
    console.log(`  ${db.cards.length} cards · ${cardIds.size} carddata entries · ${scriptIds.size} scripts`);
    console.log(
      `  carddata: ${db.cards.length - missingCarddata.length} present, ${missingCarddata.length} missing` +
        `   (engine can't load these)`,
    );
    console.log(
      `  scripts : ${missingScript.length} effect card(s) missing a script` +
        `   (ignored ${expectedScriptless} vanilla/token with no effect — expected)`,
    );
    if (knownUnsupported > 0) {
      console.log(`  ignored : ${knownUnsupported} known anime/event card(s) upstream will never script (see --all)`);
    }

    if (realGaps === 0) {
      console.log(`\n✅ In sync — every db.json card has the engine data it needs${knownUnsupported ? " (modulo documented anime cards)" : ""}.`);
    } else {
      if (missingCarddata.length) {
        console.log(`\n⚠ ${missingCarddata.length} card(s) MISSING FROM carddata.json — by type: ${fmtTypes(byType(missingCarddata))}`);
      }
      if (missingScript.length) {
        console.log(`⚠ ${missingScript.length} effect card(s) MISSING A SCRIPT — by type: ${fmtTypes(byType(missingScript))}`);
      }
      if (genesysDate) {
        console.log(
          playableGaps.length
            ? `⚠ ${playableGaps.length} of these are on the current Genesys list (${genesysDate}) — playable but unsupported`
            : `✓ none of the gaps are on the current Genesys list (${genesysDate})`,
        );
      }
      console.log(`\n→ Fix: \`pnpm import:ocg\` (pulls the latest scripts + carddata from ProjectIgnis).`);
      console.log(`  Most gaps are brand-new cards upstream has likely already scripted.`);

      if (hasFlag("list")) {
        const dump = (label: string, gaps: Gap[]) => {
          if (!gaps.length) return;
          console.log(`\n--- ${label} (${gaps.length}) ---`);
          for (const g of gaps.sort((a, b) => Number(onGenesys(b)) - Number(onGenesys(a)) || a.name.localeCompare(b.name))) {
            console.log(`  ${g.id}  ${g.name}  [${g.type}]${onGenesys(g) ? "  ← Genesys" : ""}`);
          }
        };
        dump("missing from carddata.json", missingCarddata);
        dump("effect cards missing a script", missingScript);
      } else {
        console.log(`  (run with --list to see every gap)`);
      }
    }
  }

  process.exit(realGaps > 0 ? 1 : 0);
}

function fmtTypes(m: Record<string, number>): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
}

main().catch((err) => {
  console.error("✗ check-script-coverage failed:", err);
  process.exit(2);
});
