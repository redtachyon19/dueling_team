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

const REF_OVERRIDE: string | null =
  process.argv.find((a) => a.startsWith("--ref="))?.slice("--ref=".length) || process.env.OCG_REF || null;

const WANT_LATEST = hasFlag("latest");

interface Manifest {
  scripts?: { commit?: string | null };
  carddata?: { commit?: string | null };
}

const UA = "dueling-team/0.0 (build-time importer)";

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

const TYPE_PENDULUM = 0x1000000;
const TYPE_LINK = 0x4000000;

function sh(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function fetchTarball(repo: string, ref: string, label: string): string {
  const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`;
  const dir = mkdtempSync(join(tmpdir(), `ocg-${label}-`));
  const tgz = join(dir, "src.tar.gz");
  console.log(`→ downloading ${label} (${repo}@${ref}) …`);
  sh("curl", ["-fsSL", "-o", tgz, url]);
  console.log(`→ extracting ${label} …`);
  sh("tar", ["xzf", tgz, "-C", dir]);
  const root = readdirSync(dir).map((n) => join(dir, n)).find((p) => {
    try { return readdirSync(p); } catch { return false; }
  })!;
  return root;
}

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
  race: string;
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

  const scriptsCommit = await resolveCommit(SCRIPTS_REPO, scriptsReq);
  const cdbCommit = await resolveCommit(CDB_REPO, cdbReq);
  const scriptsRef = scriptsCommit ?? scriptsReq;
  const cdbRef = cdbCommit ?? cdbReq;
  if (!scriptsCommit || !cdbCommit) {
    console.warn("  ! could not resolve commit SHAs (rate-limit/offline) — importing by ref, manifest SHA may be null");
  }

  const scriptsRoot = fetchTarball(SCRIPTS_REPO, scriptsRef, "scripts");
  const luaFiles = collectLua(scriptsRoot);
  rmSync(SCRIPT_DIR, { recursive: true, force: true });
  await ensureDir(SCRIPT_DIR);
  let copied = 0;
  for (const f of luaFiles) {
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

  const cdbRoot = fetchTarball(CDB_REPO, cdbRef, "cdb");
  const cdbs = collectCdb(cdbRoot);
  const allCdb = hasFlag("all-cdb");

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
      const rescued = rows.filter((r) => r.code > 0 && pool.has(r.code));
      const keep = new Set(rescued.map((r) => r.code));
      for (const row of rescued) byCode.set(row.code, row);
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

  if (pool.size) {
    const ledger = await readLedger();
    const res = reconcile(ledger, decisions, "ocgcore", { strict: hasFlag("strict") });
    await writeLedger(ledger);
    reportReconcile(res, ledger, "ocgcore");
  }

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
