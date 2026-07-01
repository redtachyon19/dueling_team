// scripts/import-genesys-history.ts
//
// BUILD-TIME ONLY. Run manually by Red.
//
//   pnpm import:genesys:history
//
// Reconstructs EVERY historical Genesys points list by starting from the
// current list (the yugiohgenesysbuilder.com API) and walking BACKWARDS,
// reverse-applying the point changes published in Konami's official Genesys
// update articles. Each article lists deltas as "Card Name OLD->NEW" (the
// arrow may be ASCII "->" or the Unicode "→"); the cards are matched to
// passcodes via assets/cards/db.json.
//
// Output: one append-only snapshot per list under
//   assets/genesys/YYYY-MM-DD.json
// plus a regenerated index.json. The launch list (initial points, frozen end
// of August 2025) is dated 2025-08-31.
//
// WHY REVERSE: Konami only publishes *changes*, never full historical lists,
// and there is no machine-readable archive of past lists. The current list IS
// available, so current minus each successive change = each prior list. The
// reconstruction is article-authoritative: when snapshotting an era it forces
// that era's published NEW values, so a card the third-party API happens to be
// missing is still correct.
//
// NOTE: Konami's blog serves an incomplete TLS chain that Node's fetch rejects,
// so the article HTML is pulled with rejectUnauthorized disabled for those
// requests only (public blog data, build-time only). The card API uses normal
// TLS via the shared fetch helper.
//
// To add a new list when Konami posts one: append it to UPDATES (oldest→newest)
// and re-run. Append-only: existing dated files are not overwritten except the
// current-list file, which is refreshed from the live API.

import { Agent } from "node:https";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS, GENESYS_API, fetchJson, readJson, writeJson, ensureDir, sleep } from "./_lib.ts";

// Chronological list of Konami Genesys point-update articles (oldest → newest).
// `date` is the effective date used for the resulting snapshot file.
const UPDATES: Array<{ date: string; url: string }> = [
  { date: "2025-09-24", url: "https://yugiohblog.konami.com/2025/genesys/first-point-adjustments/" },
  { date: "2025-10-27", url: "https://yugiohblog.konami.com/2025/genesys/october-27-2025-genesys-points-update/" },
  { date: "2025-12-15", url: "https://yugiohblog.konami.com/2025/genesys/genesys-december-points-update/" },
  { date: "2026-01-29", url: "https://yugiohblog.konami.com/2026/genesys/burst-protocol-pre-release-points/" },
  { date: "2026-03-05", url: "https://yugiohblog.konami.com/2026/genesys/genesys-march-points-update/" },
  { date: "2026-04-30", url: "https://yugiohblog.konami.com/2026/genesys/blazing-dominion-genesys-points-update/" },
  { date: "2026-06-08", url: "https://yugiohblog.konami.com/2026/genesys/genesys-june-points-update/" },
  { date: "2026-06-22", url: "https://yugiohblog.konami.com/2026/genesys/chaos-origins-glorious-gallery-points-update/" },
];
const LAUNCH_DATE = "2025-08-31"; // initial points list (frozen end of August)
const POINT_CAP = 100;

type Delta = [name: string, oldV: number, newV: number];

// Aggressive name key: lowercase, drop quotes, turn hyphens/dashes into spaces,
// collapse whitespace. Makes Konami's article spellings line up with db names
// in the common cases ('Flying "C"' = "Flying C", "Champion - Rhongo" = "Champion Rhongo").
const norm = (s: string) =>
  s.toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Genuine spelling differences between Konami's articles and our db names,
// keyed by norm(articleName) -> norm(dbName).
const ALIASES: Record<string, string> = {
  "union hanger": "union hangar",
  "gem knight lapis lazuli": "gem knight lady lapis lazuli",
  "exosister mikalis": "exosister mikailis",
  "ichika sayori hime": "ichiki sayori hime",
  "sky striker mobilize engage": "sky striker mobilize engage!",
  "clown crew matinee operactics": "clown crew matinee operatics", // Konami typo "Operactics"
  // June 2026 articles spell these without the comma / with a misplaced
  // apostrophe; earlier articles used the db spelling, so these only affect June.
  "nibiru the primal being": "nibiru, the primal being",
  "magician's souls": "magicians' souls",
  // June 22 (Chaos Origins / Glorious Gallery) article spellings vs db names.
  "hideout in the sky, columb": "hideout in the sky, coulomb", // Konami "Columb"
  "the phantom knights of doomed sorelet": "the phantom knights of doomed soleret", // Konami "Sorelet"
  "the three champions of swordsoul": "the three brave swordsouls", // db/YGOPRODeck name differs
};

// db names of the five Barrier Statue cards; "All 6 Barrier Statues" expands to these.
const BARRIER_STATUES = [
  "Barrier Statue of the Abyss",
  "Barrier Statue of the Drought",
  "Barrier Statue of the Heavens",
  "Barrier Statue of the Inferno",
  "Barrier Statue of the Stormwinds",
];

/** Map an article delta name to the canonical db key(s) it affects. */
function resolveKeys(rawName: string): string[] {
  const n = norm(rawName);
  if (n.startsWith("all ") && n.includes("barrier statue")) {
    return BARRIER_STATUES.map(norm);
  }
  return [ALIASES[n] ?? n];
}

/** Konami blog has an incomplete cert chain that Node's fetch rejects; pull the
 *  HTML via the https module with cert verification relaxed (build-time only,
 *  public blog data). */
const blogAgent = new Agent({ rejectUnauthorized: false });
function fetchArticle(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    import("node:https").then((https) => {
      https
        .get(url, { agent: blogAgent, headers: { "User-Agent": "dueling-team/0.0 (build-time importer)" } }, (r) => {
          // Follow one level of redirect if present.
          if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            fetchArticle(new URL(r.headers.location, url).toString()).then(resolve, reject);
            r.resume();
            return;
          }
          let data = "";
          r.setEncoding("utf8");
          r.on("data", (d) => (data += d));
          r.on("end", () => resolve(data));
        })
        .on("error", reject);
    }, reject);
  });
}

function decode(s: string): string {
  return s
    // Decode ALL numeric entities to their real characters first, so arrows
    // (→ = &#8594; or &#x2192;), apostrophes, and dashes survive — a catch-all
    // strip would otherwise eat e.g. the hex arrow some posts use.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rarr;/g, "→")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<") // some posts write the arrow as "-&gt;"
    .replace(/&[a-z]+;/gi, " "); // drop any remaining named entities
}
function bodyText(h: string): string {
  const m = h.match(/entry-content[^>]*>([\s\S]*?)<\/article/i) ?? h.match(/<article[\s\S]*?<\/article>/i);
  let b = m ? (m[1] ?? m[0]) : h;
  b = b.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  b = b.replace(/<(li|tr|p|h[1-6]|br|div|td|th)[^>]*>/gi, "\n");
  return decode(b.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ");
}
/** Normalize ASCII "->", Unicode "→/⟶", and dash+">" arrows to "->". */
function parseDeltas(html: string): Delta[] {
  // Normalize the arrow GLYPH only (keep surrounding spaces so we can tell a
  // two-number "Name 0->100" change from a one-number "Name -> 30" pre-release).
  const txt = bodyText(html).replace(/(?:->|→|⟶|[–—]>)/g, "->");
  const out: Delta[] = [];
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    // Standard change: "<name> <old>->-<new>"
    let m = line.match(/^(.+?)\s+(\d+)\s*->\s*(\d+)$/);
    if (m) { out.push([m[1]!.trim(), +m[2]!, +m[3]!]); continue; }
    // Pre-release post: "<name> -> <new>"  (implied old value 0)
    m = line.match(/^(.+?)\s+->\s*(\d+)$/);
    if (m) out.push([m[1]!.trim(), 0, +m[2]!]);
  }
  return out;
}

async function fetchCurrentList(): Promise<Array<{ id: number; name: string; points: number }>> {
  const out: Array<{ id: number; name: string; points: number }> = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = await fetchJson(`${GENESYS_API}?offset=${offset}&limit=100`);
    if (!page) break;
    for (const c of page.items ?? []) {
      if (typeof c?.id === "number" && typeof c?.points === "number") out.push({ id: c.id, name: c.name ?? "", points: c.points });
    }
    if (!page.hasMore) break;
    offset = page.nextOffset;
    await sleep(150);
  }
  return out;
}

async function main() {
  const db = await readJson<{ cards: Array<{ id: number; name: string }> }>(PATHS.cardsDb);
  if (!db?.cards?.length) {
    console.error("✗ cards/db.json not found. Run `pnpm import:cards` first.");
    process.exit(1);
  }
  // Resolve EVERY card strictly against the local TCG-only database. A card not
  // present here is OCG/Master-Duel-exclusive and is excluded by design (the db
  // is built TCG-only). We map both by name and by alternate image-id so old
  // passcodes still resolve, but never invent ids from the API itself.
  const idByName = new Map<string, number>();
  const nameById = new Map<number, string>();
  const tcgIds = new Set<number>();
  for (const c of db.cards) {
    idByName.set(norm(c.name), c.id);
    nameById.set(c.id, c.name);
    tcgIds.add(c.id);
    for (const im of (c as any).images ?? []) idByName.set(`#img:${im}`, c.id);
  }
  /** TCG card id for an API entry (by passcode or by name); null if non-TCG. */
  const tcgIdOf = (apiId: number, apiName: string): number | null =>
    (tcgIds.has(apiId) ? apiId : undefined) ??
    idByName.get(`#img:${apiId}`) ??
    idByName.get(norm(apiName)) ??
    null;

  console.log("→ Fetching current Genesys list…");
  const current = await fetchCurrentList();
  console.log(`  ${current.length} current carded entries`);

  console.log("→ Fetching Konami update articles…");
  const deltasByDate = new Map<string, Delta[]>();
  for (const u of UPDATES) {
    const html = await fetchArticle(u.url);
    const d = parseDeltas(html);
    deltasByDate.set(u.date, d);
    console.log(`  ${u.date}: ${d.length} deltas`);
    await sleep(300);
  }

  // Seed the anchor state from the API, but ONLY for cards that exist in the
  // TCG database. Non-TCG (OCG/Master Duel) entries are dropped and reported.
  const droppedNonTcg = new Map<string, number>(); // name → points (anchor)
  const seedAnchor = (target: Map<number, number>) => {
    target.clear();
    for (const c of current) {
      const id = tcgIdOf(c.id, c.name);
      if (id == null) { droppedNonTcg.set(c.name, c.points); continue; }
      target.set(id, c.points);
    }
  };
  const pts = new Map<number, number>();
  seedAnchor(pts);

  const unresolved = new Set<string>();
  // Apply one article's deltas in a direction: "new" = forward (set to new
  // value), "old" = reverse (set back to pre-update value). 0 means the card is
  // off the list for that era → remove it.
  const apply = (date: string, dir: "new" | "old") => {
    for (const [name, oldV, newV] of deltasByDate.get(date) ?? []) {
      const v = dir === "new" ? newV : oldV;
      for (const nn of resolveKeys(name)) {
        const id = idByName.get(nn);
        if (id == null) { unresolved.add(name); continue; }
        if (v === 0) pts.delete(id); else pts.set(id, v);
      }
    }
  };
  const snapshot = (date: string) => {
    const cards = [];
    for (const [id, p] of pts) {
      if (p <= 0) continue;
      cards.push({ id, name: nameById.get(id) ?? "", points: p });
    }
    cards.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    return {
      date,
      format: "TCG" as const,
      pointCap: POINT_CAP,
      source: "Konami Genesys point-update articles, anchored on the published 2025-09-24 list (TCG cards only)",
      fetchedAt: new Date().toISOString(),
      cards,
    };
  };

  // IMPORTANT: the third-party API snapshot is NOT today's list — diagnostics
  // show it equals the state right AFTER the 2025-09-24 update (it matches the
  // NEW values of that article and the OLD values of every later one). So we
  // anchor on 2025-09-24 = the API, reverse-apply that update to get the launch
  // list, and forward-apply each later update to get every subsequent list.
  const eraDates = [LAUNCH_DATE, ...UPDATES.map((u) => u.date)]; // oldest→newest
  const ANCHOR = 0; // index into UPDATES of the article the API state reflects
  const snaps = new Map<string, ReturnType<typeof snapshot>>();

  // Anchor era = state after UPDATES[ANCHOR] = eraDates[ANCHOR+1].
  snaps.set(eraDates[ANCHOR + 1]!, snapshot(eraDates[ANCHOR + 1]!));

  // Forward from the anchor: apply each later update's NEW values.
  for (let i = ANCHOR + 1; i < UPDATES.length; i++) {
    apply(UPDATES[i]!.date, "new");
    snaps.set(eraDates[i + 1]!, snapshot(eraDates[i + 1]!));
  }

  // Backward from the anchor: reset to anchor state, then reverse-apply down to
  // (and including) the launch list.
  seedAnchor(pts);
  for (let i = ANCHOR; i >= 0; i--) {
    apply(UPDATES[i]!.date, "old");
    snaps.set(eraDates[i]!, snapshot(eraDates[i]!));
  }

  const newest = eraDates[UPDATES.length]!;

  await ensureDir(PATHS.genesys);
  for (const [date, snap] of snaps) {
    await writeJson(join(PATHS.genesys, `${date}.json`), snap);
  }

  // Regenerate index (newest first).
  const files = (await readdir(PATHS.genesys)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  const revisions = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(PATHS.genesys, file), "utf8"));
    revisions.push({ date: data.date, file, cardCount: data.cards?.length ?? 0, pointCap: data.pointCap ?? null });
  }
  await writeJson(PATHS.genesysIndex, {
    _comment: "Generated by scripts/import-genesys-history.ts. TCG only. Do not hand-edit.",
    revisions,
  });

  console.log(`✓ Wrote ${snaps.size} TCG Genesys lists (${eraDates[0]} … ${newest}).`);
  if (droppedNonTcg.size) {
    console.log(`  excluded ${droppedNonTcg.size} non-TCG (OCG/Master Duel) card(s) from the anchor: ${[...droppedNonTcg.keys()].join(", ")}`);
  }
  if (unresolved.size) {
    console.log(`  delta names not in TCG db (non-TCG or unmatched), skipped: ${[...unresolved].join(", ")}`);
  }
}

main().catch((err) => {
  console.error("✗ import-genesys-history failed:", err);
  process.exit(1);
});
