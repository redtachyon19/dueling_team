import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Deck, DeckSummary } from "@duel/shared";

const FILE_RE = /\.json$/i;

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function summarize(d: Deck): DeckSummary {
  return {
    id: d.id,
    name: d.name,
    tags: d.tags ?? [],
    mainCount: d.main?.length ?? 0,
    extraCount: d.extra?.length ?? 0,
    sideCount: d.side?.length ?? 0,
    updatedAt: d.updatedAt,
  };
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe deck id: ${id}`);
  return id;
}

export async function listDecks(dir: string): Promise<DeckSummary[]> {
  await ensureDir(dir);
  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f));
  const out: DeckSummary[] = [];
  for (const f of files) {
    try {
      const deck = JSON.parse(await readFile(join(dir, f), "utf8")) as Deck;
      out.push(summarize(deck));
    } catch {
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function loadDeck(dir: string, id: string): Promise<Deck | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${safeId(id)}.json`), "utf8")) as Deck;
  } catch {
    return null;
  }
}

export async function saveDeck(dir: string, deck: Deck): Promise<Deck> {
  await ensureDir(dir);
  safeId(deck.id);
  await writeFile(join(dir, `${deck.id}.json`), JSON.stringify(deck, null, 2) + "\n");
  return deck;
}

export async function deleteDeck(dir: string, id: string): Promise<void> {
  await rm(join(dir, `${safeId(id)}.json`), { force: true });
}
