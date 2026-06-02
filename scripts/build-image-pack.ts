// scripts/build-image-pack.ts
//
// BUILD-TIME ONLY. Run manually by Red.
//
//   pnpm build:images
//   pnpm build:images --concurrency=12 --force --limit=200
//   pnpm build:images --variant=full       # only full card images
//   pnpm build:images --variant=cropped    # only cropped artwork
//   pnpm build:images --sets-only          # only set logos
//   pnpm build:images --no-sets            # skip set logos
//
// Downloads, for every passcode in cards/db.json:
//   - full card art (frame baked in, 813×1185)
//                    → assets/cards/images/{passcode}.jpg
//   - cropped artwork only (no frame, 624×624)
//                    → assets/cards/images_cropped/{passcode}.jpg
// and for every set in sets/db.json:
//   - set logo / box art
//                    → assets/sets/images/{CODE}.jpg
//
// Resumable (skip-if-exists). TCG ONLY — db.json already excludes OCG-only
// prints. All output lives inside the gitignored assets/.

import { join } from "node:path";
import {
  PATHS,
  YGO,
  readJson,
  downloadFile,
  pLimit,
  ensureDir,
  numFlag,
  hasFlag,
} from "./_lib.ts";

interface CardDb {
  cards: Array<{ id: number; images: number[] }>;
}
interface SetDb {
  sets: Array<{ code: string }>;
}

type VariantKey = "full" | "cropped";
interface Variant {
  key: VariantKey;
  label: string;
  dir: string;
  url: (id: number) => string;
}

const VARIANTS: Variant[] = [
  { key: "full", label: "full card", dir: PATHS.cardImages, url: YGO.cardImage },
  { key: "cropped", label: "cropped art", dir: PATHS.cardImagesCropped, url: YGO.cardImageCropped },
];

function selectedVariants(): Variant[] {
  const arg = process.argv.find((a) => a.startsWith("--variant="));
  if (!arg) return VARIANTS;
  const want = arg.slice("--variant=".length).split(",").map((s) => s.trim());
  return VARIANTS.filter((v) => want.includes(v.key));
}

async function downloadCardVariant(variant: Variant, ids: number[], force: boolean, concurrency: number) {
  await ensureDir(variant.dir);
  console.log(`→ ${variant.label}: ${ids.length} image(s), concurrency ${concurrency}${force ? ", force" : ""}`);
  const run = pLimit(concurrency);
  const stats = { ok: 0, skip: 0, missing: 0, error: 0 };
  let done = 0;
  await Promise.all(
    ids.map((id) =>
      run(async () => {
        try {
          stats[await downloadFile(variant.url(id), join(variant.dir, `${id}.jpg`), { force })]++;
        } catch {
          stats.error++;
        }
        if (++done % 250 === 0 || done === ids.length) {
          console.log(`  [${variant.key}] ${done}/${ids.length}  (ok ${stats.ok}, skip ${stats.skip}, missing ${stats.missing}, error ${stats.error})`);
        }
      }),
    ),
  );
  console.log(`✓ ${variant.label} done: ok ${stats.ok}, skip ${stats.skip}, missing ${stats.missing}, error ${stats.error}`);
}

async function downloadSetImages(force: boolean, concurrency: number, limit: number) {
  const db = await readJson<SetDb>(PATHS.setsDb);
  if (!db || !Array.isArray(db.sets) || db.sets.length === 0) {
    console.log("ℹ No sets/db.json yet — skipping set logos. Run `pnpm import:sets` first.");
    return;
  }
  await ensureDir(PATHS.setImages);
  const codes = (Number.isFinite(limit) ? db.sets.slice(0, limit) : db.sets).map((s) => s.code);
  console.log(`→ set logos: ${codes.length} image(s), concurrency ${concurrency}`);
  const run = pLimit(concurrency);
  const stats = { ok: 0, skip: 0, missing: 0, error: 0 };
  let done = 0;
  await Promise.all(
    codes.map((code) =>
      run(async () => {
        try {
          stats[await downloadFile(YGO.setImage(code), join(PATHS.setImages, `${code}.jpg`), { force })]++;
        } catch {
          stats.error++;
        }
        if (++done % 100 === 0 || done === codes.length) {
          console.log(`  [sets] ${done}/${codes.length}  (ok ${stats.ok}, skip ${stats.skip}, missing ${stats.missing}, error ${stats.error})`);
        }
      }),
    ),
  );
  console.log(`✓ set logos done: ok ${stats.ok}, skip ${stats.skip}, missing ${stats.missing}, error ${stats.error}`);
}

async function main() {
  const force = hasFlag("force");
  const concurrency = numFlag("concurrency", 8);
  const limit = numFlag("limit", Infinity);
  const setsOnly = hasFlag("sets-only");
  const noSets = hasFlag("no-sets");

  if (!setsOnly) {
    const db = await readJson<CardDb>(PATHS.cardsDb);
    if (!db || !Array.isArray(db.cards)) {
      console.error("✗ assets/cards/db.json not found. Run `pnpm import:cards` first.");
      process.exit(1);
    }
    const allIds = [...new Set(db.cards.flatMap((c) => c.images ?? [c.id]))];
    const ids = Number.isFinite(limit) ? allIds.slice(0, limit) : allIds;
    const variants = selectedVariants();
    console.log(`Card art variants: ${variants.map((v) => v.key).join(", ")} for ${ids.length} passcode(s).`);
    for (const v of variants) await downloadCardVariant(v, ids, force, concurrency);
  }

  if (!noSets) await downloadSetImages(force, concurrency, limit);
}

main().catch((err) => {
  console.error("✗ build-image-pack failed:", err);
  process.exit(1);
});
