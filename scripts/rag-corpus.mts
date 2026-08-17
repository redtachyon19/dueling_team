import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildReaders, type OcgReaders } from "../client/src/main/duel/ocg.ts";
import type { DbCard } from "./card-encoder.mts";

export interface CorpusEntry {
  id: number;
  name: string;
  type: string;
  race: string;
  archetype: string | null;
  desc: string;
  tokens: string[];
  bucket: "monster" | "spell" | "trap";
  scriptPath: string;
}

const STOP = new Set("a an the of to from in on with your you can be is are this that it its as by for and or if then also each other one when while during into up".split(" "));

export function tokenize(desc: string, name: string): string[] {
  let s = ` ${desc} `.toLowerCase();
  if (name) s = s.split(name.toLowerCase()).join(" @self ");
  s = s
    .replace(/"[^"]*"/g, " @named ")
    .replace(/[0-9]+/g, " @n ")
    .replace(/[^a-z@ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = s.split(" ").filter((w) => w && !STOP.has(w));
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    out.push(words[i]!);
    if (i + 1 < words.length) out.push(`${words[i]}_${words[i + 1]}`);
  }
  return out;
}

const bucketOf = (type: string): CorpusEntry["bucket"] =>
  /Spell Card/.test(type) ? "spell" : /Trap Card/.test(type) ? "trap" : "monster";

export interface Corpus {
  entries: CorpusEntry[];
  readers: OcgReaders;
  retrieve: (query: DbCard, k: number, opts?: { excludeId?: number }) => Array<{ entry: CorpusEntry; score: number }>;
  scriptOf: (e: CorpusEntry) => string;
}

export function loadCorpus(): Corpus {
  const readers = buildReaders([process.cwd()]);
  const db = JSON.parse(readFileSync(path.join(process.cwd(), "assets/cards/db.json"), "utf8")) as { cards: (DbCard & { desc: string })[] };
  const scriptCodes = new Set<number>();
  for (const f of readdirSync(readers.scriptDir)) {
    const m = /^c(\d+)\.lua$/.exec(f);
    if (m) scriptCodes.add(Number(m[1]));
  }

  const entries: CorpusEntry[] = [];
  for (const c of db.cards) {
    if (!c.desc || !scriptCodes.has(c.id)) continue;
    entries.push({
      id: c.id, name: c.name, type: c.type, race: c.race, archetype: c.archetype ?? null,
      desc: c.desc, tokens: tokenize(c.desc, c.name), bucket: bucketOf(c.type),
      scriptPath: path.join(readers.scriptDir, `c${c.id}.lua`),
    });
  }

  const df = new Map<string, number>();
  let totalLen = 0;
  for (const e of entries) {
    totalLen += e.tokens.length;
    for (const t of new Set(e.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = entries.length;
  const avgdl = totalLen / N;
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const k1 = 1.5, b = 0.75;

  const tf: Array<Map<string, number>> = entries.map((e) => {
    const m = new Map<string, number>();
    for (const t of e.tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });

  const retrieve = (query: DbCard & { desc?: string }, k: number, opts?: { excludeId?: number }) => {
    const qTokens = new Set(tokenize(query.desc ?? "", query.name));
    const qBucket = bucketOf(query.type);
    const scored: Array<{ entry: CorpusEntry; score: number }> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (opts?.excludeId === e.id) continue;
      const dl = e.tokens.length;
      let s = 0;
      const m = tf[i]!;
      for (const t of qTokens) {
        const f = m.get(t);
        if (!f) continue;
        s += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
      }
      if (s <= 0) continue;
      if (e.bucket === qBucket) s *= 1.6; else s *= 0.5;
      if (e.type === query.type) s *= 1.15;
      if (query.archetype && e.archetype === query.archetype) s *= 1.25;
      scored.push({ entry: e, score: s });
    }
    scored.sort((a, z) => z.score - a.score);
    return scored.slice(0, k);
  };

  const scriptOf = (e: CorpusEntry) => readFileSync(e.scriptPath, "utf8");
  return { entries, readers, retrieve, scriptOf };
}

function main() {
  const [codeArg, kArg] = process.argv.slice(2);
  const code = Number(codeArg);
  const k = Number(kArg) || 6;
  const db = JSON.parse(readFileSync(path.join(process.cwd(), "assets/cards/db.json"), "utf8")) as { cards: (DbCard & { desc: string })[] };
  const query = db.cards.find((c) => c.id === code);
  if (!query) { console.error(`no card ${code} in db.json`); process.exit(1); }
  const corpus = loadCorpus();
  console.log(`corpus: ${corpus.entries.length} (card → script) pairs\n`);
  console.log(`query  c${query.id}  ${query.name}  [${query.type} / ${query.race}]`);
  console.log(`  ${query.desc.replace(/\s+/g, " ").slice(0, 180)}…\n`);
  const hits = corpus.retrieve(query, k, { excludeId: code });
  console.log(`nearest ${hits.length} exemplars:`);
  for (const { entry, score } of hits) {
    console.log(`  ${score.toFixed(2).padStart(7)}  c${entry.id}  ${entry.name}  [${entry.type}]`);
    console.log(`           ${entry.desc.replace(/\s+/g, " ").slice(0, 130)}…`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
