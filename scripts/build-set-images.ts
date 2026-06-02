// scripts/build-set-images.ts
//
// BUILD-TIME ONLY. Run manually by Red.
//
//   pnpm build:set-images                          (gentle: 1 req at a time)
//   pnpm build:set-images --force --limit=20
//   pnpm build:set-images --concurrency=2 --delay=600   (only if the site allows)
//
// NOTE: the product site has a WAF that 403-blocks aggressive scraping for a
// while. Defaults are intentionally slow (concurrency 1, ~1.2s between pages).
// It's resumable — if the run gets blocked partway, just run it again later and
// it picks up the missing sets.
//
// Scrapes the official Yu-Gi-Oh! product site for each set's top box/pack image
// and saves it as:
//
//   assets/sets/<type>/{CODE}.png    (official box/pack art, bucketed by set
//                                     type — boosters/, structure-decks/, tins/,
//                                     etc. — separate from the YGOPRODeck set
//                                     logos in sets/images/)
//
// For every set code in assets/sets/db.json it requests
//   https://www.yugioh-card.com/en/products/{code-lowercased}/
// and takes the FIRST product image in document order (the hero/box art),
// skipping site chrome (logos, icons) and WordPress responsive thumbnails
// (the "-WIDTHxHEIGHT" variants). Naming of the source file varies a lot
// ("DUAD_550.png", "LOB_25th_550.png", "blzd_foil_550x550.png",
// "LEDE-Foil-550x550-1.png"), so we rely on document order, not the filename.
//
// Resumable (skip-if-exists). Sets without a code-slug product page (older /
// OCG / promo sets) are reported as misses. TCG only — output lives inside the
// gitignored-no-more, private assets/.

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { PATHS, readJson, ensureDir, exists, pLimit, sleep, numFlag, hasFlag } from "./_lib.ts";

// The product pages sit behind a CDN/WAF that wants a browser-like UA.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SITE = "https://www.yugioh-card.com";
const PRODUCT = `${SITE}/en/products/`;

const CHROME = /logo|nav-menu|icon-|legal|cardlist_button|remote_duel|share|placeholder/i;
const THUMB = /-\d+x\d+\.(?:png|jpe?g)$/i; // WordPress responsive variant
// Paths on the page are under /en/wp-content/… — keep the /en prefix so the
// reconstructed download URL is correct (without it the image 404s).
const UPLOAD = /(?:\/en)?\/wp-content\/uploads\/\d{4}\/\d{2}\/[A-Za-z0-9_.\-]+\.(?:png|jpe?g)/gi;

interface SetDb {
  sets: Array<{ code: string; name: string }>;
}

/** Folder a set's box art belongs in, by set type inferred from its name. */
function bucketForName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("speed duel")) return "speed-duel";
  if (n.includes("structure deck")) return "structure-decks";
  if (n.includes("starter deck")) return "starter-decks";
  if (/\btin\b/.test(n)) return "tins";
  if (n.includes("tournament pack")) return "tournament-packs";
  if (n.includes("duelist pack")) return "duelist-packs";
  if (n.includes("legendary collection")) return "legendary-collections";
  return "boosters";
}

// Statuses the site's WAF returns when throttling (not just 429). A 404 is a
// real "no page" and returned immediately; these get backed off and retried.
const BLOCKED = new Set([429, 403, 503, 502, 520, 521, 522, 523, 524]);

async function get(url: string): Promise<Response | null> {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,image/*,*/*" },
      });
      if (BLOCKED.has(res.status)) {
        await sleep(3000 * (i + 1)); // throttled — back off
        continue;
      }
      return res;
    } catch {
      await sleep(1000 * (i + 1));
    }
  }
  return null;
}

/** The top (hero/box) product image URL for a set code, or null if no page. */
async function topImageUrl(code: string): Promise<string | null> {
  const res = await get(`${PRODUCT}${code.toLowerCase()}/`);
  if (!res || !res.ok) return null;
  const html = await res.text();
  const seen = new Set<string>();
  for (const path of html.match(UPLOAD) ?? []) {
    if (seen.has(path)) continue;
    seen.add(path);
    const file = path.split("/").pop()!;
    if (CHROME.test(file) || THUMB.test(file)) continue;
    return path.startsWith("http") ? path : `${SITE}${path}`;
  }
  return null;
}

async function main() {
  // Gentle by default: the product site's WAF blocks aggressive scraping (and
  // will 403 your IP for a while if you trip it). Override only if you know the
  // site is tolerating it: --concurrency=2 --delay=600
  const force = hasFlag("force");
  const concurrency = numFlag("concurrency", 1);
  const limit = numFlag("limit", Infinity);

  const db = await readJson<SetDb>(PATHS.setsDb);
  if (!db || !Array.isArray(db.sets)) {
    console.error("✗ assets/sets/db.json not found. Run `pnpm import:sets` first.");
    process.exit(1);
  }
  const targets = Number.isFinite(limit) ? db.sets.slice(0, limit) : db.sets;
  console.log(`→ Scraping top set image for ${targets.length} set(s), concurrency ${concurrency}${force ? ", force" : ""}…`);

  const run = pLimit(concurrency);
  const delay = numFlag("delay", 1200); // polite gap before each page request (ms)
  const stats = { ok: 0, skip: 0, missing: 0, error: 0 };
  const misses: string[] = [];
  let done = 0;

  await Promise.all(
    targets.map(({ code, name }) =>
      run(async () => {
        // Box art is filed under assets/sets/<type>/<CODE>.png (boosters,
        // structure-decks, tins, …), by the set's type inferred from its name.
        const dir = join(PATHS.sets, bucketForName(name));
        const dest = join(dir, `${code}.png`);
        try {
          if (!force && (await exists(dest))) {
            stats.skip++;
          } else {
            if (delay) await sleep(delay);
            const imgUrl = await topImageUrl(code);
            if (!imgUrl) {
              stats.missing++;
              misses.push(code);
            } else {
              const res = await get(imgUrl);
              const buf = res && res.ok ? Buffer.from(await res.arrayBuffer()) : null;
              if (buf && buf.length > 0) {
                await ensureDir(dir);
                await writeFile(dest, buf);
                stats.ok++;
              } else {
                stats.missing++;
                misses.push(code);
              }
            }
          }
        } catch {
          stats.error++;
        }
        if (++done % 50 === 0 || done === targets.length) {
          console.log(`  ${done}/${targets.length}  (ok ${stats.ok}, skip ${stats.skip}, missing ${stats.missing}, error ${stats.error})`);
        }
      }),
    ),
  );

  console.log(`✓ Done: ok ${stats.ok}, skip ${stats.skip}, missing ${stats.missing}, error ${stats.error}`);
  if (misses.length) {
    console.log(`  No code-slug product page for ${misses.length} set(s):`);
    console.log("  " + misses.sort().join(", "));
  }
}

main().catch((err) => {
  console.error("✗ build-set-images failed:", err);
  process.exit(1);
});
