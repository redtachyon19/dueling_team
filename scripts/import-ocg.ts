// scripts/import-ocg.ts
//
// Build-time importer for the ygopro-core (ocgcore) data the duel engine needs
// at runtime. Manual only; the running app reads the output from assets/ and
// never hits the network.
//
//   pnpm import:ocg
//
// Outputs (under assets/ocg/, gitignored-but-tracked like the rest of assets/):
//   script/*.lua        — ProjectIgnis CardScripts (constant/utility + c<code>.lua)
//   carddata.json       — code → OcgCardData, decoded from ProjectIgnis BabelCDB
//
// The Lua scripts are read by the core's scriptReader; carddata.json backs the
// cardReader, so no SQLite dependency ships at runtime — the .cdb files are
// decoded here with the sqlite3 CLI.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { ASSETS, ensureDir, writeJson, REPO_ROOT } from "./_lib.ts";

const OCG = join(ASSETS, "ocg");
const SCRIPT_DIR = join(OCG, "script");

const SCRIPTS_TARBALL = "https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/refs/heads/master";
const CDB_TARBALL = "https://codeload.github.com/ProjectIgnis/BabelCDB/tar.gz/refs/heads/master";

// EDOPro type bits we need for decoding the cdb `datas` table.
const TYPE_PENDULUM = 0x1000000;
const TYPE_LINK = 0x4000000;

function sh(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

/** Download a github tarball and extract it into a fresh temp dir; return the extracted root. */
function fetchTarball(url: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ocg-${label}-`));
  const tgz = join(dir, "src.tar.gz");
  console.log(`→ downloading ${label} …`);
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
  await ensureDir(SCRIPT_DIR);

  // --- 1. Lua scripts -------------------------------------------------------
  const scriptsRoot = fetchTarball(SCRIPTS_TARBALL, "scripts");
  const luaFiles = collectLua(scriptsRoot);
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
  const cdbRoot = fetchTarball(CDB_TARBALL, "cdb");
  const cdbs = collectCdb(cdbRoot);
  console.log(`→ decoding ${cdbs.length} .cdb files …`);
  const byCode = new Map<number, OcgCardDataJson>();
  for (const cdb of cdbs) {
    let rows: OcgCardDataJson[] = [];
    try {
      rows = readCdb(cdb);
    } catch (e) {
      console.warn(`  ! skipped ${basename(cdb)}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    for (const row of rows) if (row.code > 0) byCode.set(row.code, row);
    console.log(`  ${basename(cdb)}: ${rows.length} rows`);
  }

  const carddata: Record<string, OcgCardDataJson> = {};
  for (const [code, data] of byCode) carddata[code] = data;
  await writeJson(join(OCG, "carddata.json"), carddata);
  console.log(`✓ ${byCode.size} cards → ${join(OCG, "carddata.json")}`);
  console.log(`\nDone. assets/ocg ready (relative to ${REPO_ROOT}).`);
}

main().catch((e) => {
  console.error("import-ocg failed:", e);
  process.exit(1);
});
