import { readFileSync } from "node:fs";
import path from "node:path";
import type { OcgCardData } from "@n1xx1/ocgcore-wasm";
import { buildReaders } from "../client/src/main/duel/ocg.ts";

export interface DbCard {
  id: number;
  name: string;
  type: string;
  frameType?: string;
  race: string;
  archetype: string | null;
  attribute: string | null;
  atk: number | null;
  def: number | null;
  level: number | null;
  scale: number | null;
  linkval: number | null;
  linkmarkers: string[] | null;
}

export function parseConstants(constantLua: string): Map<string, bigint> {
  const raw = new Map<string, string>();
  for (const line of constantLua.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)\s*=\s*([^\-\n]+?)\s*(?:--.*)?$/.exec(line.trim());
    if (m) raw.set(m[1]!, m[2]!.trim());
  }
  const cache = new Map<string, bigint>();
  const resolve = (name: string, seen = new Set<string>()): bigint => {
    if (cache.has(name)) return cache.get(name)!;
    const expr = raw.get(name);
    if (expr === undefined || seen.has(name)) return 0n;
    seen.add(name);
    let val = 0n;
    for (const tok of expr.split("|").map((t) => t.trim())) {
      if (/^0x[0-9a-fA-F]+$/.test(tok)) val |= BigInt(tok);
      else if (/^\d+$/.test(tok)) val |= BigInt(tok);
      else if (/^[A-Z][A-Z0-9_]*$/.test(tok)) val |= resolve(tok, seen);
    }
    cache.set(name, val);
    return val;
  };
  for (const k of raw.keys()) resolve(k);
  return cache;
}

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const markerKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

const RACE_ALIAS: Record<string, string> = {
  DIVINEBEAST: "DIVINE",
};
const MONSTER_SUBTYPES: Array<[RegExp, string]> = [
  [/\bNormal\b/, "NORMAL"], [/\bEffect\b/, "EFFECT"], [/\bFusion\b/, "FUSION"],
  [/\bRitual\b/, "RITUAL"], [/\bSynchro\b/, "SYNCHRO"], [/\bXyz\b/i, "XYZ"],
  [/\bLink\b/, "LINK"], [/\bPendulum\b/, "PENDULUM"], [/\bTuner\b/, "TUNER"],
  [/\bFlip\b/, "FLIP"], [/\bUnion\b/, "UNION"], [/\bGemini\b/, "GEMINI"],
  [/\bSpirit\b/, "SPIRIT"], [/\bToon\b/, "TOON"],
];
const ST_PROPERTY: Record<string, string> = {
  CONTINUOUS: "CONTINUOUS", QUICKPLAY: "QUICKPLAY", FIELD: "FIELD",
  EQUIP: "EQUIP", RITUAL: "RITUAL", COUNTER: "COUNTER",
};

export interface Encoder {
  encode: (c: DbCard) => OcgCardData;
  constants: Map<string, bigint>;
}

export function buildEncoder(scriptDir: string, archetypeSetcodes?: Map<string, number[]>): Encoder {
  const C = parseConstants(readFileSync(path.join(scriptDir, "constant.lua"), "utf8"));
  const bit = (suffix: string) => C.get(suffix) ?? 0n;

  const encode = (c: DbCard): OcgCardData => {
    const t = c.type;
    let type = 0n;
    let race = 0n;
    let attribute = 0n;
    let level = 0;
    let lscale = 0, rscale = 0;
    let linkMarker = 0;
    let defense = 0;

    if (/Spell Card/.test(t)) {
      type = bit("TYPE_SPELL");
      const suf = ST_PROPERTY[key(c.race)];
      if (suf) type |= bit(`TYPE_${suf}`);
    } else if (/Trap Card/.test(t)) {
      type = bit("TYPE_TRAP");
      const suf = ST_PROPERTY[key(c.race)];
      if (suf) type |= bit(`TYPE_${suf}`);
    } else {
      type = bit("TYPE_MONSTER");
      const isToken = /Token/.test(t);
      if (isToken) type |= bit("TYPE_TOKEN");
      for (const [re, suf] of MONSTER_SUBTYPES) if (re.test(t)) type |= bit(`TYPE_${suf}`);
      const hasNorm = (type & bit("TYPE_NORMAL")) !== 0n;
      const hasEff = (type & bit("TYPE_EFFECT")) !== 0n;
      if (!isToken && !hasNorm && !hasEff) {
        type |= /^normal/.test(c.frameType ?? "") ? bit("TYPE_NORMAL") : bit("TYPE_EFFECT");
      }
      const isLink = /\bLink\b/.test(t);
      const rk = RACE_ALIAS[key(c.race)] ?? key(c.race);
      race = bit(`RACE_${rk}`);
      if (c.attribute) attribute = bit(`ATTRIBUTE_${key(c.attribute)}`);
      level = (isLink ? c.linkval : c.level) ?? 0;
      if (/Pendulum/.test(t)) { lscale = c.scale ?? 0; rscale = c.scale ?? 0; }
      if (isLink) {
        for (const m of c.linkmarkers ?? []) linkMarker |= Number(bit(`LINK_MARKER_${markerKey(m)}`));
      } else {
        defense = c.def ?? 0;
      }
    }

    const setcodes = (c.archetype && archetypeSetcodes?.get(c.archetype)) || [];
    return {
      code: c.id,
      alias: 0,
      setcodes,
      type: Number(type),
      level,
      attribute: Number(attribute),
      race,
      attack: c.atk ?? 0,
      defense,
      lscale,
      rscale,
      link_marker: linkMarker,
    };
  };

  return { encode, constants: C };
}

export function learnArchetypeSetcodes(
  db: { cards: DbCard[] },
  carddata: Record<string, { setcodes: number[] }>,
): Map<string, number[]> {
  const tally = new Map<string, Map<number, number>>();
  for (const c of db.cards) {
    if (!c.archetype) continue;
    const entry = carddata[String(c.id)];
    if (!entry?.setcodes?.length) continue;
    const counts = tally.get(c.archetype) ?? new Map<number, number>();
    for (const sc of entry.setcodes) counts.set(sc, (counts.get(sc) ?? 0) + 1);
    tally.set(c.archetype, counts);
  }
  const out = new Map<string, number[]>();
  for (const [arch, counts] of tally) {
    const total = Math.max(...counts.values());
    const keep = [...counts.entries()].filter(([, n]) => n >= total * 0.5).map(([sc]) => sc);
    if (keep.length) out.set(arch, keep);
  }
  return out;
}

async function main() {
  const readers = buildReaders([process.cwd()]);
  const db = JSON.parse(readFileSync(path.join(process.cwd(), "assets/cards/db.json"), "utf8")) as { cards: DbCard[] };
  const carddata = JSON.parse(readFileSync(path.join(path.dirname(readers.scriptDir), "carddata.json"), "utf8")) as Record<string, any>;
  const archSet = learnArchetypeSetcodes(db, carddata);
  const enc = buildEncoder(readers.scriptDir, archSet);

  const fields: Array<keyof OcgCardData> = ["type", "level", "attribute", "race", "attack", "defense", "lscale", "rscale", "link_marker"];
  const miss: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
  let n = 0, perfect = 0, setcodeOk = 0;
  const examples: string[] = [];
  for (const c of db.cards) {
    const truth = carddata[String(c.id)];
    if (!truth) continue;
    n++;
    const got = enc.encode(c);
    let ok = true;
    for (const f of fields) {
      const a = f === "race" ? BigInt(got.race) : got[f];
      const b = f === "race" ? BigInt(truth.race) : truth[f];
      if (a !== b) { miss[f]!++; ok = false; if (examples.length < 12 && f !== "attack") examples.push(`${c.name} .${f}: got ${a} want ${b} [${c.type} / ${c.race}]`); }
    }
    if (ok) perfect++;
    const gsc = [...got.setcodes].sort(), tsc = [...(truth.setcodes ?? [])].sort();
    if (JSON.stringify(gsc) === JSON.stringify(tsc)) setcodeOk++;
  }
  console.log(`Card encoder validation vs carddata.json (${n} cards):`);
  console.log(`  exact match on all core fields: ${perfect} (${(100 * perfect / n).toFixed(2)}%)`);
  console.log(`  per-field mismatches:`, fields.map((f) => `${f}:${miss[f]}`).join("  "));
  console.log(`  setcodes exact (approximate by design): ${setcodeOk} (${(100 * setcodeOk / n).toFixed(1)}%)`);
  if (examples.length) { console.log(`  sample mismatches:`); for (const e of examples) console.log(`     ${e}`); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("encode:card failed:", e); process.exit(1); });
}
