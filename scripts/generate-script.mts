import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getCore } from "../client/src/main/duel/ocg.ts";
import { buildReaders } from "../client/src/main/duel/ocg.ts";
import { loadCorpus, type CorpusEntry } from "./rag-corpus.mts";
import { buildEncoder, learnArchetypeSetcodes, type DbCard } from "./card-encoder.mts";
import { verifyCardScript, type VerifyResult } from "./verify-script.mts";

const MODEL_DEFAULT = "claude-opus-4-8";

const SYSTEM = `You are an expert Yu-Gi-Oh! card scripter for the EDOPro / ocgcore engine, writing in the style and conventions of the ProjectIgnis CardScripts repository.

Your job: given one card's printed text, output the Lua script that implements its effect(s) so the ocgcore engine can play it.

Rules:
- Output ONLY the raw Lua source. No markdown fences, no comments explaining your reasoning, no prose before or after.
- The file must start with "local s,id=GetID()" and define "function s.initial_effect(c) ... end".
- Use only the real ocgcore API (Effect.CreateEffect, Effect.SetType/SetCode/SetCategory/SetTarget/SetOperation, aux.* helpers, Duel.*, Card.*, Group.*, and the EFFECT_TYPE_*, EVENT_*, CATEGORY_*, LOCATION_*, RESET_*, TIMING_* constants). Do not invent functions.
- Match the structure, helper usage, and idioms of the worked examples provided — they are real, engine-verified scripts for mechanically similar cards.
- Implement exactly the printed effect(s). Do not add, omit, or "improve" effects. Enforce once-per-turn and targeting exactly as written.
- For archetype membership checks, use the setcode-based helpers as the examples do.`;

interface CardWithDesc extends DbCard {
  desc: string;
  attribute: string | null;
  atk: number | null;
  def: number | null;
  level: number | null;
  scale: number | null;
  linkval: number | null;
  frameType?: string;
}

function cardBlock(c: CardWithDesc): string {
  const stats: string[] = [`Type: ${c.type}`];
  if (/Monster|Token/.test(c.type)) {
    stats.push(`Race/Attribute: ${c.race}/${c.attribute ?? "?"}`);
    const lvl = c.linkval != null ? `LINK-${c.linkval}` : `Level/Rank ${c.level ?? "?"}`;
    stats.push(`${lvl}  ATK ${c.atk ?? "?"}${c.linkval == null ? ` / DEF ${c.def ?? "?"}` : ""}`);
    if (c.scale != null) stats.push(`Pendulum Scale ${c.scale}`);
  } else {
    stats.push(`Property: ${c.race}`);
  }
  if (c.archetype) stats.push(`Archetype: ${c.archetype}`);
  return `Passcode: ${c.id}\nName: ${c.name}\n${stats.join(" | ")}\nEffect:\n${c.desc}`;
}

function extractLua(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:lua)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  const start = t.search(/^\s*local\s+s\s*,\s*id\s*=\s*GetID\(\)/m);
  if (start > 0) t = t.slice(start);
  return t.trim() + "\n";
}

function buildUserPrompt(target: CardWithDesc, exemplars: Array<{ entry: CorpusEntry; script: string }>): string {
  const ex = exemplars
    .map(({ entry, script }, i) => `### Example ${i + 1}: ${entry.name} [${entry.type}]\nEffect:\n${entry.desc}\n\nScript (c${entry.id}.lua):\n${script.trim()}`)
    .join("\n\n---\n\n");
  return `Here are ${exemplars.length} existing cards whose effects are mechanically similar to the target, with their engine-verified scripts:\n\n${ex}\n\n===\n\nNow write the script for THIS card:\n\n${cardBlock(target)}\n\nOutput only the Lua for c${target.id}.lua.`;
}

export interface GenResult {
  code: number;
  lua: string;
  ok: boolean;
  attempts: number;
  verify: VerifyResult;
}

export async function generateCardScript(
  client: Anthropic,
  target: CardWithDesc,
  deps: {
    exemplars: Array<{ entry: CorpusEntry; script: string }>;
    verify: (lua: string) => VerifyResult;
    model: string;
    maxRepairs: number;
    log?: (m: string) => void;
  },
): Promise<GenResult> {
  const log = deps.log ?? (() => {});
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildUserPrompt(target, deps.exemplars) },
  ];

  let lua = "";
  let verify: VerifyResult = { ok: false, loaded: false, errors: [], notes: [] };
  for (let attempt = 1; attempt <= deps.maxRepairs + 1; attempt++) {
    const res = await client.messages.create({
      model: deps.model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM,
      messages,
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    lua = extractLua(text);
    verify = deps.verify(lua);
    log(`  attempt ${attempt}: ${verify.ok ? "PASS" : `FAIL (${verify.errors.length} engine error(s))`}`);
    if (verify.ok) return { code: target.id, lua, ok: true, attempts: attempt, verify };
    if (attempt === deps.maxRepairs + 1) break;
    const errText = verify.threw
      ? `The engine threw: ${verify.threw}`
      : verify.errors.map((e) => e.text.trim()).join("\n") || "the card did not load";
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `That script failed to load in the ocgcore engine:\n\n${errText}\n\nFix the script. Output only the corrected Lua for c${target.id}.lua.`,
    });
  }
  return { code: target.id, lua, ok: false, attempts: deps.maxRepairs + 1, verify };
}

function flag(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

async function main() {
  const code = Number(process.argv[2]);
  if (!Number.isFinite(code)) {
    console.error("usage: pnpm gen:script <passcode> [--k=6] [--repairs=3] [--model=claude-opus-4-8]");
    process.exit(2);
  }
  const k = Number(flag("k", "6"));
  const maxRepairs = Number(flag("repairs", "3"));
  const model = flag("model", MODEL_DEFAULT);

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      "✗ No Anthropic credentials found.\n" +
        "  Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment, then re-run:\n" +
        "    ANTHROPIC_API_KEY=sk-ant-... pnpm gen:script " + code + "\n" +
        "  Everything else (retrieval, verifier, encoder) is wired and ready.",
    );
    process.exit(3);
  }

  const db = JSON.parse(readFileSync(path.join(process.cwd(), "assets/cards/db.json"), "utf8")) as { cards: CardWithDesc[] };
  const target = db.cards.find((c) => c.id === code);
  if (!target) {
    console.error(`✗ no card ${code} in db.json. Add it first (pnpm import:cards).`);
    process.exit(2);
  }
  if (!target.desc) {
    console.error(`✗ card ${code} (${target.name}) has no effect text — nothing to script (vanilla?).`);
    process.exit(2);
  }

  console.log(`Generating script for c${code}  ${target.name}  [${target.type}]`);

  const corpus = loadCorpus();
  const hits = corpus.retrieve(target, k, { excludeId: code });
  const exemplars = hits.map((h) => ({ entry: h.entry, script: corpus.scriptOf(h.entry) }));
  console.log(`  retrieved ${exemplars.length} exemplars: ${exemplars.map((e) => e.entry.name).join(", ")}`);

  const readers = buildReaders([process.cwd()]);
  const carddata = JSON.parse(readFileSync(path.join(path.dirname(readers.scriptDir), "carddata.json"), "utf8")) as Record<string, any>;
  const encoder = buildEncoder(readers.scriptDir, learnArchetypeSetcodes(db, carddata));
  const cardData = encoder.encode(target);
  const core = await getCore();
  const verify = (lua: string) => verifyCardScript(core, readers, { code, lua, cardData });

  const client = new Anthropic();
  const result = await generateCardScript(client, target, { exemplars, verify, model, maxRepairs, log: (m) => console.log(m) });

  const outDir = path.join(path.dirname(readers.scriptDir), "generated");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `c${code}.lua`);
  writeFileSync(outFile, result.lua);

  console.log(`\n${result.ok ? "✅ PASS" : "❌ FAIL"} after ${result.attempts} attempt(s).`);
  console.log(`  draft → ${path.relative(process.cwd(), outFile)}`);
  if (!result.ok) {
    console.log(`  engine still rejects it:`);
    for (const e of result.verify.errors.slice(0, 6)) console.log(`     ${e.text.trim()}`);
  }
  console.log(
    result.ok
      ? `  Review it, then move it into assets/ocgcore/script/ to ship (check:scripts will then see the gap closed).`
      : `  Left as a draft for a human to finish. Do NOT ship as-is.`,
  );
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("✗ generate-script failed:", e);
    process.exit(2);
  });
}
