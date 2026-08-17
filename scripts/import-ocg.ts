// scripts/import-ocg.ts
//
// Build-time importer for the ygopro-core (ocgcore) data the duel engine needs
// at runtime. Manual only; the running app reads the output from assets/ocgcore/
// and never hits the network.
//
//   pnpm import:ocg                 # reproduce the commits pinned in the lockfile
//   pnpm import:ocg --latest        # bump both upstreams to master, re-pin
//   pnpm import:ocg --ref=<branch|tag>   # both repos at a shared ref
//
// Outputs (all of assets/ is gitignored — this is 22k Lua files and ~98 MB that
// GitHub does not need to carry):
//   assets/ocgcore/script/*.lua    — ProjectIgnis CardScripts (c<code>.lua + utils)
//   assets/ocgcore/carddata.json   — code → OcgCardData, decoded from BabelCDB
//
// The one tracked piece is the lockfile, which is why the rest can be thrown
// away safely:
//   engine/ocgcore.lock.json       — the exact upstream commit SHAs + counts
//
// A fresh clone runs `pnpm import:ocg` and gets byte-identical engine data. Do
// NOT pass a commit SHA to --ref: it applies to both repos and a SHA only
// exists in one of them (codeload 404s on the other).
//
// SCOPE: BabelCDB ships far more than the TCG card game — Rush Duel, anime and
// video-game-only cards, Speed Duel Skills, Goat-format entries, unreleased
// prereleases. None of those are playable here (the pool is engine/cards/db.json,
// which is TCG-only and released-only), so their .cdb files are skipped; see
// CDB_EXCLUDE. Pass --all-cdb to import every file upstream ships.
//
// The Lua scripts are read by the core's scriptReader; carddata.json backs the
// cardReader, so no SQLite dependency ships at runtime — the .cdb files are
// decoded here with the sqlite3 CLI.
//
// PROVENANCE / REPRODUCIBILITY: each run resolves its ref PER REPO to a concrete
// commit, downloads exactly that commit, and records both in the lockfile. The
// default is the lockfile itself, so rebuilding the identical engine data is
// just `pnpm import:ocg`. This is what keeps "what scripts do we have?"
// answerable — pair it with `pnpm check:scripts`, which reports any db.json card
// the resulting engine data can't represent.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { PATHS, ensureDir, writeJson, readJson, REPO_ROOT, hasFlag } from "./_lib.ts";
import {
  readLedger, reconcile, writeLedger, reportReconcile,
  type Decision, type LedgerReason,
} from "./ledger.ts";

const OCG = PATHS.ocgcore;
const SCRIPT_DIR = PATHS.ocgcoreScripts;

/** BabelCDB files to skip, with the reason. Matched on file basename.
 *  `cards.cdb` — the real card game, OCG + TCG — is the one we want; our own
 *  TCG-only filtering happens upstream of this, in engine/cards/db.json. */
/** CDB_EXCLUDE explanation → the ledger reason recorded for those passcodes. */
const REASON_FOR: Record<string, LedgerReason> = {
  "Rush Duel — a different game": "rush-duel",
  "anime / manga / video-game-only cards": "anime-unofficial",
  "Speed Duel Skill Cards (db.json drops Skill Cards too)": "skill-card",
  "Goat-format alternate entries": "goat",
  "unreleased cards — no official English text yet": "prerelease",
};

const CDB_EXCLUDE: Array<[test: RegExp, why: string]> = [
  [/^cards-rush\.cdb$/, "Rush Duel — a different game"],
  [/^cards-unofficial\.cdb$/, "anime / manga / video-game-only cards"],
  [/^cards-skills(-unofficial)?\.cdb$/, "Speed Duel Skill Cards (db.json drops Skill Cards too)"],
  [/^goat-entries\.cdb$/, "Goat-format alternate entries"],
  [/^prerelease-/, "unreleased cards — no official English text yet"],
];

const SCRIPTS_REPO = "ProjectIgnis/CardScripts";
const CDB_REPO = "ProjectIgnis/BabelCDB";

/** Explicit ref override. Applies to BOTH repos, so pass only a ref they share
 *  — a branch or tag, never a commit SHA (a SHA exists in one repo only, and
 *  codeload 404s on the other). To reproduce an exact build, run with no flags:
 *  the manifest pins each repo separately. */
const REF_OVERRIDE: string | null =
  process.argv.find((a) => a.startsWith("--ref="))?.slice("--ref=".length) || process.env.OCG_REF || null;

/** `--latest` bumps both repos to master and rewrites the manifest. */
const WANT_LATEST = hasFlag("latest");

interface Manifest {
  scripts?: { commit?: string | null };
  carddata?: { commit?: string | null };
}

const UA = "dueling-team/0.0 (build-time importer)";

/** Resolve a ref to its concrete commit SHA via the GitHub API (best-effort —
 *  returns null on rate-limit/offline so the import still proceeds by ref). */
async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
      headers: { "User-Agent": UA, Accept: "application/vnd.github.sha" },
    });
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// EDOPro type bits we need for decoding the cdb `datas` table.
const TYPE_PENDULUM = 0x1000000;
const TYPE_LINK = 0x4000000;

function sh(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

/** Download a github repo tarball at `ref` and extract it into a fresh temp dir;
 *  return the extracted root. codeload accepts a branch, tag, or commit SHA. */
function fetchTarball(repo: string, ref: string, label: string): string {
  const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`;
  const dir = mkdtempSync(join(tmpdir(), `ocg-${label}-`));
  const tgz = join(dir, "src.tar.gz");
  console.log(`→ downloading ${label} (${repo}@${ref}) …`);
  sh("curl", ["-fsSL", "-o", tgz, url]);
  console.log(`→ extracting ${label} …`);
  sh("tar", ["xzf", tgz, "-C", dir]);
  // tarball extracts to a single <repo>-<branch>/ root.
  const root = readdirSync(dir).map((n) => join(dir, n)).find((p) => {
    try { return readdirSync(p); } catch { return false; }
  })!;
  return root;
}

/** Recursively collect *.lua paths under a dir. */
function collectLua(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) collectLua(p, out);
    else if (name.name.endsWith(".lua")) out.push(p);
  }
  return out;
}

function collectCdb(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) collectCdb(p, out);
    else if (name.name.endsWith(".cdb")) out.push(p);
  }
  return out;
}

interface OcgCardDataJson {
  code: number;
  alias: number;
  setcodes: number[];
  type: number;
  level: number;
  attribute: number;
  race: string; // bigint as decimal string (race is 64-bit in modern cores)
  attack: number;
  defense: number;
  lscale: number;
  rscale: number;
  link_marker: number;
}

function decodeRow(r: any): OcgCardDataJson {
  const type = Number(r.type);
  const rawLevel = Number(r.level) >>> 0;
  const isLink = (type & TYPE_LINK) !== 0;
  const isPend = (type & TYPE_PENDULUM) !== 0;
  // setcode: up to four packed 16-bit archetype codes.
  const setcode = BigInt(r.setcode ?? 0);
  const setcodes: number[] = [];
  for (let i = 0n; i < 4n; i++) {
    const sc = Number((setcode >> (i * 16n)) & 0xffffn);
    if (sc !== 0) setcodes.push(sc);
  }
  return {
    code: Number(r.id),
    alias: Number(r.alias ?? 0),
    setcodes,
    type,
    level: rawLevel & 0xff,
    attribute: Number(r.attribute ?? 0),
    race: BigInt(r.race ?? 0).toString(),
    attack: Number(r.atk ?? 0),
    defense: isLink ? 0 : Number(r.def ?? 0),
    lscale: isPend ? (rawLevel >> 24) & 0xff : 0,
    rscale: isPend ? (rawLevel >> 16) & 0xff : 0,
    link_marker: isLink ? Number(r.def ?? 0) : 0,
  };
}

/** Card names from a .cdb's `texts` table. Used ONLY to label ledger blacklist
 *  entries — carddata.json stays text-free (it is engine data, not card text),
 *  but a blacklist you can't search by name is not much of a blacklist. */
function readCdbNames(file: string): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const raw = execFileSync("sqlite3", ["-json", file, "SELECT id,name FROM texts"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
    if (!raw) return out;
    for (const r of JSON.parse(raw) as Array<{ id: number; name?: string }>) {
      if (r.name) out.set(Number(r.id), r.name);
    }
  } catch {
    // No texts table (or unreadable) — names are a nicety, not a requirement.
  }
  return out;
}

function readCdb(file: string): OcgCardDataJson[] {
  const out = execFileSync(
    "sqlite3",
    ["-json", file, "SELECT id,alias,setcode,type,atk,def,level,race,attribute FROM datas"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  ).trim();
  if (!out) return [];
  return (JSON.parse(out) as any[]).map(decodeRow);
}

async function main() {
  // engine/ocgcore.lock.json is the LOCKFILE: the only tracked piece of this
  // import, pinning each upstream separately. With no flags we re-import exactly
  // those commits, so a fresh clone rebuilds byte-identical engine data from a
  // 4 KB file instead of 93 MB of tracked Lua.
  const pinned = await readJson<Manifest>(PATHS.ocgcoreLock);
  const pinnedScripts = pinned?.scripts?.commit ?? null;
  const pinnedCdb = pinned?.carddata?.commit ?? null;
  const scriptsReq = REF_OVERRIDE ?? (WANT_LATEST ? "master" : pinnedScripts ?? "master");
  const cdbReq = REF_OVERRIDE ?? (WANT_LATEST ? "master" : pinnedCdb ?? "master");
  if (!REF_OVERRIDE && !WANT_LATEST && pinnedScripts) {
    console.log(`→ reproducing the pinned build (scripts ${scriptsReq.slice(0, 7)}, cdb ${cdbReq.slice(0, 7)}) — \`--latest\` to bump`);
  } else {
    console.log(`→ resolving scripts@${scriptsReq}, cdb@${cdbReq} …`);
  }

  // Resolve each ref to a concrete commit so the manifest's SHA matches the
  // imported tree. Resolved PER REPO — the two never share a commit SHA.
  const scriptsCommit = await resolveCommit(SCRIPTS_REPO, scriptsReq);
  const cdbCommit = await resolveCommit(CDB_REPO, cdbReq);
  const scriptsRef = scriptsCommit ?? scriptsReq;
  const cdbRef = cdbCommit ?? cdbReq;
  if (!scriptsCommit || !cdbCommit) {
    console.warn("  ! could not resolve commit SHAs (rate-limit/offline) — importing by ref, manifest SHA may be null");
  }

  // --- 1. Lua scripts -------------------------------------------------------
  const scriptsRoot = fetchTarball(SCRIPTS_REPO, scriptsRef, "scripts");
  const luaFiles = collectLua(scriptsRoot);
  // Replace the tree rather than merging into it: copying over a previous
  // import leaves behind scripts upstream has since renamed or deleted, which
  // then linger forever and can be loaded by the core. Done only after the
  // download succeeded, so a failed fetch never leaves us with no scripts.
  rmSync(SCRIPT_DIR, { recursive: true, force: true });
  await ensureDir(SCRIPT_DIR);
  let copied = 0;
  for (const f of luaFiles) {
    // Flatten into script/ — the core's scriptReader resolves by basename.
    copyFileSync(f, join(SCRIPT_DIR, basename(f)));
    copied++;
  }
  console.log(`✓ ${copied} Lua scripts → ${SCRIPT_DIR}`);
  for (const base of ["constant.lua", "utility.lua"]) {
    try {
      readFileSync(join(SCRIPT_DIR, base));
    } catch {
      throw new Error(`Missing base script ${base} after import — CardScripts layout changed?`);
    }
  }

  // --- 2. Card data from BabelCDB ------------------------------------------
  const cdbRoot = fetchTarball(CDB_REPO, cdbRef, "cdb");
  const cdbs = collectCdb(cdbRoot);
  const allCdb = hasFlag("all-cdb");

  // Every passcode our TCG pool actually needs (primary id + alternate-artwork
  // ids, which share an entry via `alias`). An EXCLUDED cdb still gets mined for
  // these: some real TCG cards have no official Konami passcode and so are only
  // filed in cards-unofficial.cdb — the World Championship promos (WCS/WCPS
  // 2004-2007) are physical TCG prints living at 501000xxx. Dropping their file
  // wholesale silently made them unplayable, so we rescue by code instead.
  const db = await readJson<{ cards: Array<{ id: number; images?: number[] }> }>(PATHS.cardsDb);
  const pool = new Set<number>();
  for (const c of db?.cards ?? []) {
    pool.add(c.id);
    for (const im of c.images ?? []) pool.add(im);
  }
  if (!pool.size) {
    console.warn("  ! cards/db.json not found — importing every .cdb (run `pnpm import:cards` first for a trimmed set)");
  }

  console.log(`→ decoding ${cdbs.length} .cdb files …`);
  const byCode = new Map<number, OcgCardDataJson>();
  /** Blacklist entries contributed to the ledger by this importer. */
  const decisions: Decision[] = [];
  for (const cdb of cdbs) {
    const name = basename(cdb);
    const excluded = allCdb || !pool.size ? undefined : CDB_EXCLUDE.find(([re]) => re.test(name));
    let rows: OcgCardDataJson[] = [];
    try {
      rows = readCdb(cdb);
    } catch (e) {
      console.warn(`  ! skipped ${name}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    if (excluded) {
      // Out of scope: take only the codes our TCG pool references.
      const rescued = rows.filter((r) => r.code > 0 && pool.has(r.code));
      const keep = new Set(rescued.map((r) => r.code));
      for (const row of rescued) byCode.set(row.code, row);
      // Everything genuinely skipped becomes a ledger blacklist entry, so every
      // one of these ~10k passcodes is greppable with a reason attached.
      const names = readCdbNames(cdb);
      for (const row of rows) {
        if (row.code > 0 && !keep.has(row.code)) {
          const nm = names.get(row.code);
          decisions.push({
            code: row.code,
            status: "exclude",
            reason: REASON_FOR[excluded[1]] ?? "manual",
            source: name,
            ...(nm ? { name: nm } : {}),
          });
        }
      }
      const detail = rescued.length ? `kept ${rescued.length} in our TCG pool` : "nothing in our TCG pool";
      console.log(`  – ${name}: skipped ${rows.length} rows (${excluded[1]}) — ${detail}`);
      continue;
    }
    for (const row of rows) if (row.code > 0) byCode.set(row.code, row);
    console.log(`  ${name}: ${rows.length} rows`);
  }

  const carddata: Record<string, OcgCardDataJson> = {};
  for (const [code, data] of byCode) carddata[code] = data;
  await writeJson(join(OCG, "carddata.json"), carddata);
  console.log(`✓ ${byCode.size} cards → ${join(OCG, "carddata.json")}`);

  // --- Blacklist → the ledger ----------------------------------------------
  // Only this importer's own entries are touched; the `cards` half written by
  // import-cards is left exactly as it is.
  if (pool.size) {
    const ledger = await readLedger();
    const res = reconcile(ledger, decisions, "ocgcore", { strict: hasFlag("strict") });
    await writeLedger(ledger);
    reportReconcile(res, ledger, "ocgcore");
  }

  // --- 3. Provenance manifest ----------------------------------------------
  await writeJson(PATHS.ocgcoreLock, {
    _comment:
      "LOCKFILE for assets/ocgcore/. All of assets/ is gitignored; this file is tracked so " +
      "`pnpm import:ocg` with no flags re-downloads exactly these commits. `--latest` bumps to master.",
    requestedRef: { scripts: scriptsReq, carddata: cdbReq },
    fetchedAt: new Date().toISOString(),
    scripts: { repo: SCRIPTS_REPO, commit: scriptsCommit, fileCount: copied },
    carddata: { repo: CDB_REPO, commit: cdbCommit, cardCount: byCode.size },
  });
  console.log(`✓ lockfile → ${PATHS.ocgcoreLock}  (scripts ${scriptsCommit?.slice(0, 7) ?? "?"}, cdb ${cdbCommit?.slice(0, 7) ?? "?"})`);
  console.log(`\nDone. assets/ocgcore ready (relative to ${REPO_ROOT}). Next: \`pnpm check:scripts\`.`);
}

main().catch((e) => {
  console.error("import-ocg failed:", e);
  process.exit(1);
});
