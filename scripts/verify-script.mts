import { readFileSync } from "node:fs";
import path from "node:path";
import type { OcgCardData, OcgCoreSync, OcgNewCardInfo } from "@n1xx1/ocgcore-wasm";
import { getCore, buildReaders, type OcgReaders } from "../client/src/main/duel/ocg.ts";
import { drive, autoPass, OcgDuelMode, OcgLocation, OcgPosition } from "../client/src/main/duel/resim.ts";
import { buildEncoder, learnArchetypeSetcodes, type DbCard } from "./card-encoder.mts";

const OCG_LOG_ERROR = 0;
const OCG_LOG_FROM_SCRIPT = 1;
const FILLER_CODE = 89631139;
const FILLER_PER_DECK = 8;

const LUA_FAULT = /attempt to|nil value|stack traceback|bad argument|syntax error|unexpected symbol|'<eof>'|not enough|error/i;

export interface VerifyError {
  type: number;
  text: string;
}
export interface VerifyResult {
  ok: boolean;
  loaded: boolean;
  errors: VerifyError[];
  notes: VerifyError[];
  threw?: string | undefined;
}

function overlayReaders(base: OcgReaders, code: number, lua: string, cardData?: OcgCardData) {
  const scriptName = `c${code}.lua`;
  return {
    scriptReader: (name: string) =>
      path.basename(name) === scriptName ? lua : base.scriptReader(name),
    cardReader: (c: number) =>
      c === code ? (cardData ?? base.cardReader(code)) : base.cardReader(c),
  };
}

export function verifyCardScript(
  core: OcgCoreSync,
  base: OcgReaders,
  opts: { code: number; lua: string; cardData?: OcgCardData | undefined; stepCap?: number },
): VerifyResult {
  const { code, lua, cardData } = opts;
  const errors: VerifyError[] = [];
  const notes: VerifyError[] = [];
  const { scriptReader, cardReader } = overlayReaders(base, code, lua, cardData);
  const loaded = !!cardReader(code);

  let handle: ReturnType<OcgCoreSync["createDuel"]> = null;
  let threw: string | undefined;
  try {
    handle = core.createDuel({
      flags: OcgDuelMode.MODE_MR5,
      seed: [1n, 2n, 3n, 4n],
      team1: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 1 },
      team2: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 1 },
      cardReader,
      scriptReader,
      errorHandler: (type: number, text: string) => {
        const isFault = type === OCG_LOG_ERROR || (type === OCG_LOG_FROM_SCRIPT && LUA_FAULT.test(text));
        (isFault ? errors : notes).push({ type, text });
      },
    });
    if (!handle) return { ok: false, loaded, errors, notes, threw: "createDuel returned null" };

    for (const { name, content } of base.baseScripts) core.loadScript(handle, name, content);

    const newCard = (info: Partial<OcgNewCardInfo> & { code: number; team: 0 | 1; location: number }) =>
      core.duelNewCard(handle!, {
        duelist: 0,
        controller: info.team,
        sequence: info.sequence ?? 0,
        position: info.position ?? OcgPosition.FACEDOWN_DEFENSE,
        ...info,
      } as OcgNewCardInfo);

    for (const team of [0, 1] as const)
      for (let i = 0; i < FILLER_PER_DECK; i++)
        newCard({ team, code: FILLER_CODE, location: OcgLocation.DECK, sequence: 1 });
    newCard({ team: 0, code, location: OcgLocation.HAND });

    core.startDuel(handle);
    drive(core, handle, {
      lp: [8000, 8000],
      respond: (q) => autoPass(q),
      stop: () => false,
      stepCap: opts.stepCap ?? 120,
    });
  } catch (e) {
    threw = (e as Error)?.message ?? String(e);
  } finally {
    if (handle) {
      try {
        core.destroyDuel(handle);
      } catch {
      }
    }
  }

  const ok = !threw && loaded && errors.length === 0;
  return { ok, loaded, errors, notes, threw };
}

async function main() {
  const [codeArg, luaPath] = process.argv.slice(2);
  const code = Number(codeArg);
  if (!Number.isFinite(code)) {
    console.error("usage: pnpm verify:script <passcode> [path/to/script.lua]");
    process.exit(2);
  }
  const base = buildReaders([process.cwd()]);
  const lua = luaPath
    ? readFileSync(luaPath, "utf8")
    : (base.scriptReader(`c${code}.lua`) ?? "");
  if (!lua) {
    console.error(`✗ no script to verify for ${code} (pass a file, or import:ocg first).`);
    process.exit(2);
  }
  let cardData: OcgCardData | undefined;
  let synthesized = false;
  if (!base.cardReader(code)) {
    const db = JSON.parse(readFileSync(path.join(process.cwd(), "assets/cards/db.json"), "utf8")) as { cards: DbCard[] };
    const target = db.cards.find((c) => c.id === code);
    if (target) {
      const carddata = JSON.parse(readFileSync(path.join(path.dirname(base.scriptDir), "carddata.json"), "utf8")) as Record<string, any>;
      cardData = buildEncoder(base.scriptDir, learnArchetypeSetcodes(db, carddata)).encode(target);
      synthesized = true;
    }
  }

  const core = await getCore();
  const r = verifyCardScript(core, base, { code, lua, cardData });

  console.log(`verify c${code}.lua  (${lua.split("\n").length} lines)`);
  console.log(`  card data loaded: ${r.loaded ? "yes" : "NO"}${synthesized ? " (synthesized from db.json)" : ""}`);
  if (r.threw) console.log(`  threw: ${r.threw}`);
  if (r.notes.length) console.log(`  notes: ${r.notes.length} script message(s)`);
  if (r.errors.length) {
    console.log(`  ✗ ${r.errors.length} engine error(s):`);
    for (const e of r.errors.slice(0, 10)) console.log(`     [${e.type}] ${e.text.trim()}`);
  }
  console.log(r.ok ? "\n✅ PASS — the engine accepts this script." : "\n❌ FAIL — engine rejected the script.");
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("✗ verify-script failed:", e);
    process.exit(2);
  });
}
