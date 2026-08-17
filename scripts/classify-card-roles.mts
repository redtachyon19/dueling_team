// Build-time effect-role classifier. MANUAL, like the other importers; never
// imported by the running app. It mines the LOCAL ProjectIgnis Lua scripts
// (assets/ocgcore/script/cNNN.lua) for coarse effect roles — what a card DOES —
// because the numeric card DB has no text and the evaluation otherwise can't
// tell a negate/handtrap/searcher from any other effect monster.
//
// This is a HEURISTIC over Lua source: it greps for the stable EDOPro engine
// API tokens (Duel.NegateEffect, SearchMatchingCard, …) and constant flags
// (EFFECT_DISABLE, LOCATION_HAND, EFFECT_TYPE_QUICK_O, …). It is approximate by
// nature — the run prints coverage + a spot-check on well-known cards so its
// accuracy is visible. Output: assets/ocgcore/card-roles.json (gitignored).
//
// Usage:  pnpm classify:roles

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildReaders } from "../client/src/main/duel/ocg.ts";
import { classifyScript, type CardRole } from "../client/src/main/duel/card-roles.ts";

const { scriptDir } = buildReaders([process.cwd()]);
const files = readdirSync(scriptDir).filter((f) => /^c\d+\.lua$/.test(f));
const roles: Record<string, CardRole[]> = {};
const tally: Record<string, number> = {};
for (const f of files) {
  const code = Number(f.slice(1, -4));
  const r = classifyScript(readFileSync(path.join(scriptDir, f), "utf8"));
  if (r.length) { roles[String(code)] = r; for (const x of r) tally[x] = (tally[x] ?? 0) + 1; }
}

console.log(`Scanned ${files.length} card scripts; ${Object.keys(roles).length} classified with >=1 role.`);
console.log("Role tallies:", tally);
console.log("\nSpot-check (expected role in parens):");
const checks: [number, string, string][] = [
  [14558127, "Ash Blossom", "negate+handtrap"],
  [97268402, "Effect Veiler", "negate+handtrap"],
  [23434538, 'Maxx "C"', "draw+handtrap"],
  [10045474, "Infinite Impermanence", "negate"],
  [26202165, "Sangan", "search"],
  [55144522, "Pot of Greed", "draw"],
  [14087893, "Ghost Ogre", "removal/negate+handtrap"],
  [4148264, "vanilla beater", "(none — no script)"],
];
for (const [code, name, exp] of checks) console.log(`  ${name} (${code}): [${(roles[String(code)] ?? []).join(", ") || "—"}]  expected ~${exp}`);

const outDir = path.join(process.cwd(), "assets", "ocgcore");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "card-roles.json");
writeFileSync(outFile, JSON.stringify(roles));
console.log(`\nWrote ${outFile} (${Object.keys(roles).length} cards, ${(JSON.stringify(roles).length / 1024).toFixed(0)} KB)`);
