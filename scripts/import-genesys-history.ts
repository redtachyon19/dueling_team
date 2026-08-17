import { Agent } from "node:https";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS, GENESYS_API, fetchJson, readJson, writeJson, ensureDir, sleep } from "./_lib.ts";

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
const LAUNCH_DATE = "2025-08-31";
const POINT_CAP = 100;

type Delta = [name: string, oldV: number, newV: number];

const norm = (s: string) =>
  s.toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const ALIASES: Record<string, string> = {
  "union hanger": "union hangar",
  "gem knight lapis lazuli": "gem knight lady lapis lazuli",
  "exosister mikalis": "exosister mikailis",
  "ichika sayori hime": "ichiki sayori hime",
  "sky striker mobilize engage": "sky striker mobilize engage!",
  "clown crew matinee operactics": "clown crew matinee operatics",
  "nibiru the primal being": "nibiru, the primal being",
  "magician's souls": "magicians' souls",
  "hideout in the sky, columb": "hideout in the sky, coulomb",
  "the phantom knights of doomed sorelet": "the phantom knights of doomed soleret",
  "the three champions of swordsoul": "the three brave swordsouls",
};

const BARRIER_STATUES = [
  "Barrier Statue of the Abyss",
  "Barrier Statue of the Drought",
  "Barrier Statue of the Heavens",
  "Barrier Statue of the Inferno",
  "Barrier Statue of the Stormwinds",
];

function resolveKeys(rawName: string): string[] {
  const n = norm(rawName);
  if (n.startsWith("all ") && n.includes("barrier statue")) {
    return BARRIER_STATUES.map(norm);
  }
  return [ALIASES[n] ?? n];
}

const blogAgent = new Agent({ rejectUnauthorized: false });
function fetchArticle(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    import("node:https").then((https) => {
      https
        .get(url, { agent: blogAgent, headers: { "User-Agent": "dueling-team/0.0 (build-time importer)" } }, (r) => {
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rarr;/g, "→")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<")
    .replace(/&[a-z]+;/gi, " ");
}
function bodyText(h: string): string {
  const m = h.match(/entry-content[^>]*>([\s\S]*?)<\/article/i) ?? h.match(/<article[\s\S]*?<\/article>/i);
  let b = m ? (m[1] ?? m[0]) : h;
  b = b.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  b = b.replace(/<(li|tr|p|h[1-6]|br|div|td|th)[^>]*>/gi, "\n");
  return decode(b.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ");
}
function parseDeltas(html: string): Delta[] {
  const txt = bodyText(html).replace(/(?:->|→|⟶|[–—]>)/g, "->");
  const out: Delta[] = [];
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    let m = line.match(/^(.+?)\s+(\d+)\s*->\s*(\d+)$/);
    if (m) { out.push([m[1]!.trim(), +m[2]!, +m[3]!]); continue; }
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
  const idByName = new Map<string, number>();
  const nameById = new Map<number, string>();
  const tcgIds = new Set<number>();
  for (const c of db.cards) {
    idByName.set(norm(c.name), c.id);
    nameById.set(c.id, c.name);
    tcgIds.add(c.id);
    for (const im of (c as any).images ?? []) idByName.set(`#img:${im}`, c.id);
  }
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

  const droppedNonTcg = new Map<string, number>();
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

  const eraDates = [LAUNCH_DATE, ...UPDATES.map((u) => u.date)];
  const ANCHOR = 0;
  const snaps = new Map<string, ReturnType<typeof snapshot>>();

  snaps.set(eraDates[ANCHOR + 1]!, snapshot(eraDates[ANCHOR + 1]!));

  for (let i = ANCHOR + 1; i < UPDATES.length; i++) {
    apply(UPDATES[i]!.date, "new");
    snaps.set(eraDates[i + 1]!, snapshot(eraDates[i + 1]!));
  }

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
