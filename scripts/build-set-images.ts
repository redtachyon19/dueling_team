import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { PATHS, readJson, ensureDir, exists, pLimit, sleep, numFlag, hasFlag, listFlag } from "./_lib.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SITE = "https://www.yugioh-card.com";
const PRODUCT = `${SITE}/en/products/`;

const CHROME = /logo|nav-menu|icon-|legal|cardlist_button|remote_duel|share|placeholder/i;
const THUMB = /-\d+x\d+\.(?:png|jpe?g)$/i;
const UPLOAD = /(?:\/en)?\/wp-content\/uploads\/\d{4}\/\d{2}\/[A-Za-z0-9_.\-]+\.(?:png|jpe?g)/gi;

interface SetDb {
  sets: Array<{ code: string; name: string }>;
}

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

const BLOCKED = new Set([429, 403, 503, 502, 520, 521, 522, 523, 524]);

async function get(url: string): Promise<Response | null> {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,image/*,*/*" },
      });
      if (BLOCKED.has(res.status)) {
        await sleep(3000 * (i + 1));
        continue;
      }
      return res;
    } catch {
      await sleep(1000 * (i + 1));
    }
  }
  return null;
}

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
  const force = hasFlag("force");
  const concurrency = numFlag("concurrency", 1);
  const limit = numFlag("limit", Infinity);
  const codes = new Set(listFlag("codes").map((c) => c.toUpperCase()));

  const db = await readJson<SetDb>(PATHS.setsDb);
  if (!db || !Array.isArray(db.sets)) {
    console.error("✗ engine/sets/db.json not found. Run `pnpm import:sets` first.");
    process.exit(1);
  }
  const selected = codes.size ? db.sets.filter((s) => codes.has(s.code.toUpperCase())) : db.sets;
  if (codes.size) {
    const unknown = [...codes].filter((c) => !db.sets.some((s) => s.code.toUpperCase() === c));
    if (unknown.length) console.log(`  ⚠ not in sets/db.json, ignored: ${unknown.join(", ")}`);
  }
  const targets = Number.isFinite(limit) ? selected.slice(0, limit) : selected;
  console.log(`→ Scraping top set image for ${targets.length} set(s), concurrency ${concurrency}${force ? ", force" : ""}…`);

  const run = pLimit(concurrency);
  const delay = numFlag("delay", 1200);
  const stats = { ok: 0, skip: 0, missing: 0, error: 0 };
  const misses: string[] = [];
  let done = 0;

  await Promise.all(
    targets.map(({ code, name }) =>
      run(async () => {
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
