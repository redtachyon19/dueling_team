import {
  OcgLocation,
  OcgPosition,
  OcgProcessResult,
  OcgResponseType,
  OcgMessageType,
  OcgDuelMode,
  OcgQueryFlags,
  OcgRace,
  OcgAttribute,
  SelectIdleCMDAction,
  SelectBattleCMDAction,
  type OcgMessage,
  type OcgResponse,
  type OcgCoreSync,
  type OcgDuelHandle,
} from "@n1xx1/ocgcore-wasm";
import { phaseFromOcg, positionFromOcg } from "@duel/engine";
import type {
  CardPosition,
  DuelCard,
  DuelDifficulty,
  DuelEvent,
  DuelFormat,
  DuelOption,
  DuelPlayer,
  DuelPlayerState,
  DuelPrompt,
  DuelResponse,
  DuelState,
  DuelUpdate,
  PromptCard,
} from "@duel/shared";
import { getCore, buildReaders, partitionSupported, type OcgReaders } from "./ocg.ts";
import { shuffleDeck } from "./shuffle.ts";
import { aiDecide, setEvalWeights, getEvalWeights, type AiContext } from "./ai.ts";
import { buildAiContext, cardStats, type CoreView } from "./ai-context.ts";
import { loadEvalWeights } from "./weights.ts";
import { loadCardRoles } from "./card-roles.ts";
import { getSearchCore } from "./ocg.ts";
import type { ReplayHeader } from "./resim.ts";
import { createIdleSearcher, type IdleSearcher } from "./search.ts";
import { redactEvents } from "./redact.ts";

const QUERY_FLAGS = (OcgQueryFlags.CODE |
  OcgQueryFlags.POSITION |
  OcgQueryFlags.ATTACK |
  OcgQueryFlags.DEFENSE |
  OcgQueryFlags.LEVEL) as unknown as OcgQueryFlags;

const QUESTION_TYPES = new Set<number>([
  OcgMessageType.SELECT_BATTLECMD, OcgMessageType.SELECT_IDLECMD, OcgMessageType.SELECT_EFFECTYN,
  OcgMessageType.SELECT_YESNO, OcgMessageType.SELECT_OPTION, OcgMessageType.SELECT_CARD,
  OcgMessageType.SELECT_CHAIN, OcgMessageType.SELECT_PLACE, OcgMessageType.SELECT_POSITION,
  OcgMessageType.SELECT_TRIBUTE, OcgMessageType.SELECT_COUNTER, OcgMessageType.SELECT_SUM,
  OcgMessageType.SELECT_DISFIELD, OcgMessageType.SELECT_UNSELECT_CARD, OcgMessageType.SORT_CARD,
  OcgMessageType.SORT_CHAIN, OcgMessageType.ANNOUNCE_RACE, OcgMessageType.ANNOUNCE_ATTRIB,
  OcgMessageType.ANNOUNCE_CARD, OcgMessageType.ANNOUNCE_NUMBER, OcgMessageType.ROCK_PAPER_SCISSORS,
]);

const OCG_TYPE_PENDULUM = 0x1000000;

const RACE_LABELS: Array<[bigint, string]> = (Object.entries(OcgRace) as Array<[string, bigint]>)
  .map(([k, v]) => [v, k.charAt(0) + k.slice(1).toLowerCase()] as [bigint, string]);
const ATTR_LABELS: Array<[number, string]> = (Object.entries(OcgAttribute) as Array<[string, number]>)
  .map(([k, v]) => [v, k.charAt(0) + k.slice(1).toLowerCase()] as [number, string]);

const MSG_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(OcgMessageType).map(([k, v]) => [v as number, k]),
);

function winReasonText(loserLp: number, loserDeck: number): string {
  if (loserLp <= 0) return "Life points depleted";
  if (loserDeck <= 0) return "Deck out";
  return "Duel over";
}

const LOCATION_NAME: Record<number, string> = {
  [OcgLocation.DECK]: "deck", [OcgLocation.HAND]: "hand", [OcgLocation.MZONE]: "mzone",
  [OcgLocation.SZONE]: "szone", [OcgLocation.GRAVE]: "grave", [OcgLocation.REMOVED]: "banish",
  [OcgLocation.EXTRA]: "extra", [OcgLocation.FZONE]: "fzone",
};

function locOf(c: { location: number; sequence: number }): { loc: string; seq: number } {
  return { loc: LOCATION_NAME[c.location] ?? String(c.location), seq: c.sequence };
}

const flip = (p: DuelPlayer): DuelPlayer => (1 - p) as DuelPlayer;

function swapPerspective(s: DuelState): DuelState {
  return {
    ...s,
    players: [s.players[1], s.players[0]],
    turnPlayer: flip(s.turnPlayer),
    winner: s.winner == null ? null : flip(s.winner),
  };
}

function localizeEvent(e: DuelEvent): DuelEvent {
  switch (e.kind) {
    case "draw":
    case "summon":
    case "spellset":
    case "damage":
    case "recover":
    case "toss":
    case "turn":
    case "win":
      return { ...e, player: flip(e.player) };
    case "attack":
      return { ...e, attacker: flip(e.attacker), target: e.target == null ? null : flip(e.target) };
    default:
      return e;
  }
}

function localizePrompt(p: DuelPrompt): DuelPrompt {
  return {
    ...p,
    player: 0,
    ...(p.cards ? { cards: p.cards.map((c) => ({ ...c, controller: flip(c.controller) })) } : {}),
  };
}

export interface DuelDeck {
  main: number[];
  extra: number[];
}

export interface RemoteTransport {
  deck: DuelDeck;
  sendToGuest(update: DuelUpdate): void;
}

export class DuelSession {
  private core!: OcgCoreSync;
  private handle!: OcgDuelHandle;
  private readers!: OcgReaders;
  private lp: [number, number] = [8000, 8000];
  private turn = 0;
  private turnPlayer: DuelPlayer = 0;
  private phaseRaw = 0;
  private over = false;
  private destroyed = false;
  private winner: DuelPlayer | null = null;
  private winReason: string | null = null;
  private goldfish = true;
  private opponent: "goldfish" | "ai" | "remote" = "goldfish";
  private transport: RemoteTransport | null = null;
  private difficulty: DuelDifficulty = "normal";
  private aiAttackerAtk = 0;

  private replayHeader: ReplayHeader | null = null;
  private responseLog: OcgResponse[] = [];
  private idleSearch: IdleSearcher | null = null;

  private promptId = 0;
  private pendingPromptId: number | null = null;
  private pendingResolve: ((r: DuelResponse) => OcgResponse | null) | null = null;
  private pendingPlaceKind: "monster" | "spell" = "monster";

  constructor(
    private readonly onUpdate: (u: DuelUpdate) => void,
    private readonly startDirs: string[],
  ) {}

  async start(deck: DuelDeck, seed: bigint, goldfish = true, format: DuelFormat = "advanced", opponent: "goldfish" | "ai" | "remote" = "goldfish", difficulty: DuelDifficulty = "normal", aiDeck: DuelDeck | null = null, transport: RemoteTransport | null = null): Promise<{ ok: boolean; error?: string; unsupported: number[] }> {
    if (transport) { opponent = "remote"; goldfish = true; }
    this.goldfish = goldfish;
    this.opponent = opponent;
    this.difficulty = difficulty;
    this.transport = transport;
    try {
      this.core = await getCore();
      this.readers = buildReaders(this.startDirs);
    } catch (e) {
      return { ok: false, error: (e as Error).message, unsupported: [] };
    }

    if (opponent === "ai") {
      const { weights, source } = loadEvalWeights(this.startDirs);
      setEvalWeights(weights);
      const roles = loadCardRoles(this.startDirs);
      console.log(`[duel] DuelBot eval weights: ${source}; card roles: ${roles.count} (${roles.source})`);
      try {
        this.idleSearch = createIdleSearcher(await getSearchCore(), this.readers);
      } catch (e) {
        this.idleSearch = null;
        console.warn("[duel] search core unavailable; DuelBot uses heuristic only:", (e as Error).message);
      }
    }

    const mainPart = partitionSupported(deck.main, this.readers);
    const extraPart = partitionSupported(deck.extra, this.readers);
    const unsupported = [...mainPart.unsupported, ...extraPart.unsupported];

    const p1Deck = opponent === "remote" ? transport?.deck ?? null : opponent === "ai" ? aiDeck : null;
    let aiSupportedMain: number[] | null = null;
    let aiSupportedExtra: number[] = [];
    if (p1Deck) {
      const aiMain = partitionSupported(p1Deck.main, this.readers);
      const aiExtra = partitionSupported(p1Deck.extra, this.readers);
      unsupported.push(...aiMain.unsupported, ...aiExtra.unsupported);
      if (aiMain.supported.length < 40 || aiMain.supported.length > 60 || aiExtra.supported.length > 15) {
        const who = opponent === "remote" ? "Opponent" : "AI";
        return { ok: false, error: `${who} deck unusable: ${aiMain.supported.length} engine-supported main card(s) (need 40–60), ${aiExtra.supported.length} extra (max 15)`, unsupported };
      }
      aiSupportedMain = aiMain.supported;
      aiSupportedExtra = aiExtra.supported;
    }

    const seed4: [bigint, bigint, bigint, bigint] = [
      seed | 1n,
      (seed >> 16n) | 1n,
      (seed >> 32n) | 1n,
      (seed >> 48n) | 1n,
    ];

    const mode = format === "genesys" ? OcgDuelMode.MODE_MR2 : OcgDuelMode.MODE_MR5;
    const handle = this.core.createDuel({
      flags: mode,
      seed: seed4,
      team1: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
      team2: { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 },
      cardReader: this.readers.cardReader,
      scriptReader: this.readers.scriptReader,
      errorHandler: (_type, text) => console.log("[ocgcore]", text),
    });
    if (!handle) return { ok: false, error: "createDuel failed", unsupported };
    this.handle = handle;

    for (const { name, content } of this.readers.baseScripts) this.core.loadScript(handle, name, content);

    const p0Main = shuffleDeck(mainPart.supported, seed);
    const p0Extra = extraPart.supported;
    this.addDeck(0, p0Main, p0Extra);
    const aiSeed = seed ^ 0x9e3779b97f4a7c15n;
    const p1Main = aiSupportedMain ? shuffleDeck(aiSupportedMain, aiSeed) : shuffleDeck(this.dummyDeck(), aiSeed);
    const p1Extra = aiSupportedMain ? aiSupportedExtra : [];
    this.addDeck(1, p1Main, p1Extra);

    if (opponent === "ai") this.replayHeader = { seed4, mode, p0Main, p0Extra, p1Main, p1Extra };

    try {
      this.core.startDuel(handle);
    } catch (e) {
      return { ok: false, error: `startDuel: ${(e as Error).message}`, unsupported };
    }

    this.run();
    return { ok: true, unsupported };
  }

  respond(r: DuelResponse): void {
    if (this.destroyed || this.over || r.promptId !== this.pendingPromptId || !this.pendingResolve) return;
    const resp = this.pendingResolve(r);
    if (!resp) return;
    this.pendingResolve = null;
    this.pendingPromptId = null;
    this.send(resp);
    this.run();
  }

  private send(resp: OcgResponse): void {
    if (this.replayHeader) this.responseLog.push(resp);
    this.core.duelSetResponse(this.handle, resp);
  }

  surrender(): void {
    this.concede(1, "Surrender");
  }

  remoteSurrender(reason = "Opponent surrendered"): void {
    this.concede(0, reason);
  }

  private concede(winner: DuelPlayer, reason: string): void {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.winReason = reason;
    this.pendingResolve = null;
    this.pendingPromptId = null;
    this.emit(null, [{ kind: "win", player: winner }]);
    this.teardown();
  }

  end(): void {
    this.over = true;
    this.teardown();
  }

  private teardown(): void {
    if (this.destroyed || !this.handle) return;
    this.destroyed = true;
    try {
      this.core.destroyDuel(this.handle);
    } catch {
    }
  }

  private run(): void {
    if (this.destroyed || !this.handle) return;
    const events: DuelEvent[] = [];
    let guard = 0;
    while (guard++ < 100000) {
      const status = this.core.duelProcess(this.handle);
      const messages = this.core.duelGetMessage(this.handle);
      for (const m of messages) this.observe(m, events);

      if (this.over) {
        this.emit(null, events);
        return;
      }
      if (status === OcgProcessResult.END) {
        this.over = true;
        this.emit(null, events);
        return;
      }
      if (status === OcgProcessResult.WAITING) {
        const q = messages.find((m) => QUESTION_TYPES.has(m.type));
        if (!q) {
          console.warn("[duel] WAITING with no question message");
          return;
        }
        if (this.opponent !== "remote" && this.goldfish && (q as { player?: number }).player === 1) {
          let aiResp: OcgResponse | null = null;
          if (this.opponent === "ai") {
            if (q.type === OcgMessageType.SELECT_IDLECMD && this.idleSearch && this.replayHeader) {
              try {
                aiResp = this.idleSearch.search(this.replayHeader, this.responseLog, q, getEvalWeights());
              } catch (e) {
                console.warn("[duel] idle search error; using heuristic:", (e as Error).message);
              }
            }
            if (!aiResp) aiResp = aiDecide(q, this.aiContext(), this.difficulty);
            this.trackAiAttacker(q, aiResp);
          }
          const resp = aiResp ?? this.autoPass(q);
          if (resp) this.send(resp);
          continue;
        }
        const built = this.buildPrompt(q);
        if (!built) {
          const fallback = this.autoPass(q);
          if (fallback) this.send(fallback);
          else console.warn(`[duel] no handler for prompt ${MSG_NAME[q.type] ?? q.type} — duel may stall`);
          continue;
        }
        this.pendingPromptId = built.prompt.id;
        this.pendingResolve = built.resolve;
        this.emit(built.prompt, events);
        return;
      }
    }
    console.warn("[duel] run() guard tripped");
  }

  private emit(prompt: DuelPrompt | null, events: DuelEvent[]): void {
    this.onUpdate({ state: this.buildState(0), prompt: prompt?.player === 0 ? prompt : null, events: redactEvents(events, 0) });
    if (this.transport) {
      this.transport.sendToGuest({
        state: swapPerspective(this.buildState(1)),
        prompt: prompt?.player === 1 ? localizePrompt(prompt) : null,
        events: redactEvents(events, 1).map(localizeEvent),
      });
    }
  }

  private observe(m: OcgMessage, events: DuelEvent[]): void {
    switch (m.type) {
      case OcgMessageType.NEW_TURN:
        this.turn += 1;
        this.turnPlayer = (m.player as DuelPlayer) ?? 0;
        events.push({ kind: "turn", turn: this.turn, player: this.turnPlayer });
        break;
      case OcgMessageType.NEW_PHASE:
        this.phaseRaw = m.phase;
        events.push({ kind: "phase", phase: phaseFromOcg(m.phase) });
        break;
      case OcgMessageType.DRAW:
        events.push({ kind: "draw", player: m.player as DuelPlayer, count: m.drawn.length, codes: m.drawn.map((d) => d.code) });
        break;
      case OcgMessageType.SUMMONING:
      case OcgMessageType.SPSUMMONING:
      case OcgMessageType.FLIPSUMMONING:
        events.push({ kind: "summon", player: m.controller as DuelPlayer, code: m.code, position: this.pos(m.position) });
        break;
      case OcgMessageType.SET:
        events.push({ kind: "spellset", player: m.controller as DuelPlayer, code: m.code });
        break;
      case OcgMessageType.MOVE:
        events.push({ kind: "move", code: m.card });
        break;
      case OcgMessageType.ATTACK:
        events.push({ kind: "attack", attacker: m.card.controller as DuelPlayer, target: m.target ? (m.target.controller as DuelPlayer) : null });
        break;
      case OcgMessageType.DAMAGE:
        this.lp[m.player as DuelPlayer] = Math.max(0, this.lp[m.player as DuelPlayer] - m.amount);
        events.push({ kind: "damage", player: m.player as DuelPlayer, amount: m.amount });
        break;
      case OcgMessageType.PAY_LPCOST:
        this.lp[m.player as DuelPlayer] = Math.max(0, this.lp[m.player as DuelPlayer] - m.amount);
        events.push({ kind: "damage", player: m.player as DuelPlayer, amount: m.amount });
        break;
      case OcgMessageType.RECOVER:
        this.lp[m.player as DuelPlayer] += m.amount;
        events.push({ kind: "recover", player: m.player as DuelPlayer, amount: m.amount });
        break;
      case OcgMessageType.LPUPDATE:
        this.lp[m.player as DuelPlayer] = m.lp;
        break;
      case OcgMessageType.TOSS_COIN:
        events.push({ kind: "toss", player: m.player as DuelPlayer, dice: false, results: m.results.map((r) => (r ? 1 : 0)) });
        break;
      case OcgMessageType.TOSS_DICE:
        events.push({ kind: "toss", player: m.player as DuelPlayer, dice: true, results: [...m.results] });
        break;
      case OcgMessageType.WIN: {
        this.over = true;
        this.winner = m.player as DuelPlayer;
        const loser = (1 - this.winner) as DuelPlayer;
        if (!this.winReason) this.winReason = winReasonText(this.lp[loser], this.deckCount(loser));
        events.push({ kind: "win", player: this.winner });
        break;
      }
      default:
        break;
    }
  }

  private deckCount(player: DuelPlayer): number {
    try {
      return this.core.duelQueryCount(this.handle, player, OcgLocation.DECK);
    } catch {
      return 0;
    }
  }

  private pos(p: number): CardPosition {
    return positionFromOcg(p).position;
  }

  private buildState(viewer: DuelPlayer = 0): DuelState {
    const field = this.core.duelQueryField(this.handle);
    const players = ([0, 1] as DuelPlayer[]).map((p): DuelPlayerState => {
      const fp = field.players[p];
      const grave = this.queryLoc(p, OcgLocation.GRAVE).filter(Boolean) as Record<string, any>[];
      const graveTopCard = grave[grave.length - 1];
      const graveTop: number | null = graveTopCard?.code ?? null;
      const graveCards: DuelCard[] = grave.map((c, i) => this.toCard(c, i, p, "grave", viewer));
      const banished: DuelCard[] = (this.queryLoc(p, OcgLocation.REMOVED).filter(Boolean) as Record<string, any>[])
        .map((c, i) => this.toCard(c, i, p, "banish", viewer));
      const szone = this.queryLoc(p, OcgLocation.SZONE);
      const fieldCard = szone[5] ? this.toCard(szone[5] as Record<string, any>, 5, p, "szone", viewer) : null;
      const extra: DuelCard[] = p === viewer
        ? (this.queryLoc(p, OcgLocation.EXTRA).filter(Boolean) as Record<string, any>[]).map((c, i) => this.toCard(c, i, p, "extra", viewer))
        : [];
      return {
        lp: this.lp[p],
        hand: this.queryLoc(p, OcgLocation.HAND).filter(Boolean).map((c, i) => this.toCard(c!, i, p, "hand", viewer)),
        monsters: this.zoneArray(p, OcgLocation.MZONE, 7, "mzone", viewer),
        spells: this.zoneArray(p, OcgLocation.SZONE, 5, "szone", viewer),
        field: fieldCard,
        extra,
        grave: graveCards,
        banished,
        graveCount: fp.grave_size,
        graveTop,
        banishCount: fp.banish_size,
        extraCount: fp.extra_size,
        deckCount: fp.deck_size,
      };
    }) as [DuelPlayerState, DuelPlayerState];

    return {
      turn: this.turn,
      turnPlayer: this.turnPlayer,
      phase: phaseFromOcg(this.phaseRaw),
      players,
      over: this.over,
      winner: this.winner,
      winReason: this.winReason,
    };
  }

  private queryLoc(player: DuelPlayer, location: OcgLocation): (Record<string, any> | null)[] {
    try {
      return this.core.duelQueryLocation(this.handle, { flags: QUERY_FLAGS, controller: player, location }) as any[];
    } catch {
      return [];
    }
  }

  private zoneArray(player: DuelPlayer, location: OcgLocation, n: number, loc: string, viewer: DuelPlayer = 0): (DuelCard | null)[] {
    const raw = this.queryLoc(player, location);
    const out: (DuelCard | null)[] = [];
    for (let i = 0; i < n; i++) out.push(raw[i] ? this.toCard(raw[i]!, i, player, loc, viewer) : null);
    return out;
  }

  private toCard(info: Record<string, any>, seq: number, controller: DuelPlayer, loc: string, viewer: DuelPlayer = 0): DuelCard {
    const { position, faceUp } = positionFromOcg(info.position ?? OcgPosition.FACEUP_ATTACK);
    const hidden = controller !== viewer && (loc === "hand" || !faceUp);
    return {
      seq,
      code: hidden ? null : info.code ?? null,
      position,
      faceUp,
      atk: info.attack ?? null,
      def: info.defense ?? null,
      level: info.level ?? null,
    };
  }

  private nextPrompt(player: number, kind: DuelPrompt["kind"], title: string, options: DuelOption[], extra: Partial<DuelPrompt> = {}): DuelPrompt {
    return { id: ++this.promptId, player: player as DuelPlayer, kind, title, options, ...extra };
  }

  private buildPrompt(m: OcgMessage): { prompt: DuelPrompt; resolve: (r: DuelResponse) => OcgResponse | null } | null {
    switch (m.type) {
      case OcgMessageType.SELECT_IDLECMD: {
        const opts: DuelOption[] = [];
        m.summons.forEach((c, i) => opts.push({ id: `summon:${i}`, label: "Normal Summon", code: c.code, ...locOf(c) }));
        m.special_summons.forEach((c, i) => opts.push({ id: `spsummon:${i}`, label: "Special Summon", code: c.code, ...locOf(c) }));
        m.monster_sets.forEach((c, i) => opts.push({ id: `mset:${i}`, label: "Set Monster", code: c.code, ...locOf(c) }));
        m.spell_sets.forEach((c, i) => opts.push({ id: `sset:${i}`, label: "Set Spell/Trap", code: c.code, ...locOf(c) }));
        m.activates.forEach((c, i) => {
          const isPendScale = ((this.readers.cardReader(c.code)?.type ?? 0) & OCG_TYPE_PENDULUM) !== 0 && c.location === OcgLocation.HAND;
          opts.push({ id: `activate:${i}`, label: isPendScale ? "Pendulum Summon" : "Activate", code: c.code, ...locOf(c) });
        });
        m.pos_changes.forEach((c, i) => opts.push({ id: `pos:${i}`, label: "Change Position", code: c.code, ...locOf(c) }));
        if (m.to_bp) opts.push({ id: "bp", label: "Enter Battle Phase" });
        if (m.to_ep) opts.push({ id: "ep", label: "End Turn" });
        const prompt = this.nextPrompt(m.player, "idle", "Main Phase — choose an action", opts);
        return {
          prompt,
          resolve: (r) => {
            if (r.type !== "option") return null;
            const [kind, idx] = r.id.split(":");
            const i = Number(idx);
            const A = SelectIdleCMDAction;
            switch (kind) {
              case "summon": this.pendingPlaceKind = "monster"; return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SUMMON, index: i };
              case "spsummon": this.pendingPlaceKind = "monster"; return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SPECIAL_SUMMON, index: i };
              case "mset": this.pendingPlaceKind = "monster"; return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_MONSTER_SET, index: i };
              case "sset": this.pendingPlaceKind = "spell"; return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_SPELL_SET, index: i };
              case "activate": this.pendingPlaceKind = "spell"; return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_ACTIVATE, index: i };
              case "pos": return { type: OcgResponseType.SELECT_IDLECMD, action: A.SELECT_POS_CHANGE, index: i };
              case "bp": return { type: OcgResponseType.SELECT_IDLECMD, action: A.TO_BP, index: null };
              case "ep": return { type: OcgResponseType.SELECT_IDLECMD, action: A.TO_EP, index: null };
              default: return null;
            }
          },
        };
      }
      case OcgMessageType.SELECT_BATTLECMD: {
        const opts: DuelOption[] = [];
        m.attacks.forEach((c, i) => opts.push({ id: `atk:${i}`, label: "Attack", code: c.code, ...locOf(c) }));
        m.chains.forEach((c, i) => opts.push({ id: `activate:${i}`, label: "Activate", code: c.code, ...locOf(c) }));
        if (m.to_m2) opts.push({ id: "m2", label: "Main Phase 2" });
        if (m.to_ep) opts.push({ id: "ep", label: "End Turn" });
        const prompt = this.nextPrompt(m.player, "battle", "Battle Phase", opts);
        return {
          prompt,
          resolve: (r) => {
            if (r.type !== "option") return null;
            const [kind, idx] = r.id.split(":");
            const B = SelectBattleCMDAction;
            switch (kind) {
              case "atk": return { type: OcgResponseType.SELECT_BATTLECMD, action: B.SELECT_BATTLE, index: Number(idx) };
              case "activate": return { type: OcgResponseType.SELECT_BATTLECMD, action: B.SELECT_CHAIN, index: Number(idx) };
              case "m2": return { type: OcgResponseType.SELECT_BATTLECMD, action: B.TO_M2, index: null };
              case "ep": return { type: OcgResponseType.SELECT_BATTLECMD, action: B.TO_EP, index: null };
              default: return null;
            }
          },
        };
      }
      case OcgMessageType.SELECT_PLACE: {
        const opts: DuelOption[] = [];
        for (let seq = 0; seq < 7; seq++) {
          if ((m.field_mask & (1 << seq)) === 0) {
            opts.push({ id: `m:${seq}`, label: seq < 5 ? `Monster Zone ${seq + 1}` : `Extra Monster Zone ${seq - 4}` });
          }
        }
        for (let seq = 0; seq < 5; seq++) if ((m.field_mask & (1 << (8 + seq))) === 0) opts.push({ id: `s:${seq}`, label: `Spell/Trap Zone ${seq + 1}` });
        const prompt = this.nextPrompt(m.player, "selectPlace", "Choose a zone", opts);
        return {
          prompt,
          resolve: (r) => {
            if (r.type !== "option") return null;
            const [kind, seq] = r.id.split(":");
            const location = kind === "m" ? OcgLocation.MZONE : OcgLocation.SZONE;
            return { type: OcgResponseType.SELECT_PLACE, places: [{ player: m.player, location, sequence: Number(seq) }] };
          },
        };
      }
      case OcgMessageType.SELECT_POSITION: {
        const P = OcgPosition;
        const opts: DuelOption[] = [];
        if (m.positions & P.FACEUP_ATTACK) opts.push({ id: String(P.FACEUP_ATTACK), label: "Face-up Attack", code: m.code });
        if (m.positions & P.FACEUP_DEFENSE) opts.push({ id: String(P.FACEUP_DEFENSE), label: "Face-up Defense", code: m.code });
        if (m.positions & P.FACEDOWN_DEFENSE) opts.push({ id: String(P.FACEDOWN_DEFENSE), label: "Set (face-down)", code: m.code });
        const prompt = this.nextPrompt(m.player, "selectPosition", "Choose a position", opts);
        return {
          prompt,
          resolve: (r) => (r.type === "option" ? { type: OcgResponseType.SELECT_POSITION, position: Number(r.id) as OcgPosition } : null),
        };
      }
      case OcgMessageType.SELECT_CHAIN: {
        const opts: DuelOption[] = m.selects.map((c, i) => ({ id: `chain:${i}`, label: "Chain / Activate", code: c.code }));
        if (!m.forced) opts.push({ id: "pass", label: "No Response" });
        const prompt = this.nextPrompt(m.player, "selectChain", "Activate in response?", opts, { cancelable: !m.forced });
        return {
          prompt,
          resolve: (r) => {
            if (r.type === "cancel") return { type: OcgResponseType.SELECT_CHAIN, index: null };
            if (r.type !== "option") return null;
            if (r.id === "pass") return { type: OcgResponseType.SELECT_CHAIN, index: null };
            return { type: OcgResponseType.SELECT_CHAIN, index: Number(r.id.split(":")[1]) };
          },
        };
      }
      case OcgMessageType.SELECT_CARD: {
        const selects = m.selects ?? [];
        const cards: PromptCard[] = selects.map((c, i) => ({
          ref: String(i),
          code: c.code ?? null,
          location: LOCATION_NAME[c.location] ?? String(c.location),
          seq: c.sequence,
          controller: c.controller as DuelPlayer,
        }));
        const min = m.min ?? 1;
        const max = m.max ?? 1;
        const cancelable = !!m.can_cancel;
        const prompt = this.nextPrompt(m.player, "selectCard", `Select ${min === max ? min : `${min}–${max}`} card(s)`, [], { cards, min, max, cancelable });
        return {
          prompt,
          resolve: (r) => {
            if (r.type === "cancel" && cancelable) return { type: OcgResponseType.SELECT_CARD, indicies: null };
            if (r.type !== "cards") return null;
            return { type: OcgResponseType.SELECT_CARD, indicies: r.refs.map(Number) };
          },
        };
      }
      case OcgMessageType.SELECT_UNSELECT_CARD: {
        const sc = m.select_cards ?? [];
        const uc = m.unselect_cards ?? [];
        const toCard = (c: (typeof sc)[number], ref: string): PromptCard => ({
          ref,
          code: c.code ?? null,
          location: LOCATION_NAME[c.location] ?? String(c.location),
          seq: c.sequence,
          controller: c.controller as DuelPlayer,
        });
        const cards: PromptCard[] = [
          ...uc.map((c, i) => toCard(c, `u:${i}`)),
          ...sc.map((c, i) => toCard(c, `s:${i}`)),
        ];
        const opts: DuelOption[] = [];
        if (m.can_finish) opts.push({ id: "__finish", label: "Finish" });
        const title = uc.length > 0 ? `Select material(s) — ${uc.length} chosen` : "Select material(s)";
        const prompt = this.nextPrompt(m.player, "selectUnselect", title, opts, {
          cards,
          min: m.min,
          max: m.max,
          cancelable: m.can_cancel,
        });
        return {
          prompt,
          resolve: (r) => {
            if (r.type === "option" && r.id === "__finish") return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: null };
            if (r.type === "cancel") return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: null };
            if (r.type !== "cards" || r.refs.length === 0) return null;
            const ref = r.refs[0]!;
            const sep = ref.indexOf(":");
            const kind = ref.slice(0, sep);
            const i = Number(ref.slice(sep + 1));
            const index = kind === "u" ? sc.length + i : i;
            return { type: OcgResponseType.SELECT_UNSELECT_CARD, index };
          },
        };
      }
      case OcgMessageType.SELECT_EFFECTYN: {
        const prompt = this.nextPrompt(m.player, "effectyn", "Activate this effect?", [
          { id: "yes", label: "Yes", code: m.code },
          { id: "no", label: "No" },
        ]);
        return { prompt, resolve: (r) => (r.type === "option" ? { type: OcgResponseType.SELECT_EFFECTYN, yes: r.id === "yes" } : null) };
      }
      case OcgMessageType.SELECT_YESNO: {
        const prompt = this.nextPrompt(m.player, "yesno", "Yes or No?", [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]);
        return { prompt, resolve: (r) => (r.type === "option" ? { type: OcgResponseType.SELECT_YESNO, yes: r.id === "yes" } : null) };
      }
      case OcgMessageType.SELECT_OPTION: {
        const opts: DuelOption[] = m.options.map((_o, i) => ({ id: String(i), label: `Option ${i + 1}` }));
        const prompt = this.nextPrompt(m.player, "option", "Choose an option", opts);
        return { prompt, resolve: (r) => (r.type === "option" ? { type: OcgResponseType.SELECT_OPTION, index: Number(r.id) } : null) };
      }
      case OcgMessageType.SELECT_TRIBUTE: {
        const cards: PromptCard[] = m.selects.map((c, i) => ({
          ref: String(i),
          code: c.code ?? null,
          location: LOCATION_NAME[c.location] ?? String(c.location),
          seq: c.sequence,
          controller: c.controller as DuelPlayer,
        }));
        const cancelable = !!m.can_cancel;
        const prompt = this.nextPrompt(m.player, "selectCard", `Tribute ${m.min === m.max ? m.min : `${m.min}–${m.max}`} card(s)`, [], { cards, min: m.min, max: m.max, cancelable });
        return {
          prompt,
          resolve: (r) => {
            if (r.type === "cancel" && cancelable) return { type: OcgResponseType.SELECT_TRIBUTE, indicies: null };
            if (r.type !== "cards") return null;
            return { type: OcgResponseType.SELECT_TRIBUTE, indicies: r.refs.map(Number) };
          },
        };
      }
      case OcgMessageType.SELECT_SUM: {
        const cards: PromptCard[] = m.selects.map((c, i) => ({
          ref: String(i),
          code: c.code ?? null,
          location: LOCATION_NAME[c.location] ?? String(c.location),
          seq: c.sequence,
          controller: c.controller as DuelPlayer,
        }));
        const max = m.max || cards.length || 1;
        const prompt = this.nextPrompt(m.player, "selectCard", `Select materials (sum to ${m.amount})`, [], { cards, min: m.min, max });
        return {
          prompt,
          resolve: (r) => (r.type === "cards" ? { type: OcgResponseType.SELECT_SUM, indicies: r.refs.map(Number) } : null),
        };
      }
      case OcgMessageType.SELECT_COUNTER: {
        const cards: PromptCard[] = m.cards.map((c, i) => ({
          ref: String(i),
          code: c.code ?? null,
          location: LOCATION_NAME[c.location] ?? String(c.location),
          seq: c.sequence,
          controller: c.controller as DuelPlayer,
          max: c.count,
        }));
        const prompt = this.nextPrompt(m.player, "selectCounter", `Remove ${m.count} counter(s)`, [], { cards, min: m.count, max: m.count });
        return {
          prompt,
          resolve: (r) => (r.type === "counters" ? { type: OcgResponseType.SELECT_COUNTER, counters: r.counts } : null),
        };
      }
      case OcgMessageType.SELECT_DISFIELD: {
        const opts: DuelOption[] = [];
        for (let seq = 0; seq < 7; seq++) if ((m.field_mask & (1 << seq)) === 0) opts.push({ id: `m:${seq}`, label: seq < 5 ? `Monster Zone ${seq + 1}` : `Extra Monster Zone ${seq - 4}` });
        for (let seq = 0; seq < 5; seq++) if ((m.field_mask & (1 << (8 + seq))) === 0) opts.push({ id: `s:${seq}`, label: `Spell/Trap Zone ${seq + 1}` });
        const prompt = this.nextPrompt(m.player, "selectPlace", "Choose a zone", opts);
        return {
          prompt,
          resolve: (r) => {
            if (r.type !== "option") return null;
            const [kind, seq] = r.id.split(":");
            const location = kind === "m" ? OcgLocation.MZONE : OcgLocation.SZONE;
            return { type: OcgResponseType.SELECT_DISFIELD, places: [{ player: m.player, location, sequence: Number(seq) }] };
          },
        };
      }
      case OcgMessageType.ANNOUNCE_RACE: {
        const opts: DuelOption[] = RACE_LABELS.filter(([bit]) => (m.available & bit) !== 0n).map(([bit, label]) => ({ id: String(bit), label }));
        const prompt = this.nextPrompt(m.player, "announce", m.count > 1 ? `Declare ${m.count} Types` : "Declare a Type", opts, { min: m.count, max: m.count });
        return {
          prompt,
          resolve: (r) => (r.type === "cards" ? { type: OcgResponseType.ANNOUNCE_RACE, races: r.refs.map((x) => BigInt(x)) as OcgRace[] } : null),
        };
      }
      case OcgMessageType.ANNOUNCE_ATTRIB: {
        const opts: DuelOption[] = ATTR_LABELS.filter(([bit]) => (m.available & bit) !== 0).map(([bit, label]) => ({ id: String(bit), label }));
        const prompt = this.nextPrompt(m.player, "announce", m.count > 1 ? `Declare ${m.count} Attributes` : "Declare an Attribute", opts, { min: m.count, max: m.count });
        return {
          prompt,
          resolve: (r) => (r.type === "cards" ? { type: OcgResponseType.ANNOUNCE_ATTRIB, attributes: r.refs.map(Number) as OcgAttribute[] } : null),
        };
      }
      case OcgMessageType.ANNOUNCE_NUMBER: {
        const opts: DuelOption[] = m.options.map((v, i) => ({ id: String(i), label: String(v) }));
        const prompt = this.nextPrompt(m.player, "announce", "Declare a number", opts, { min: 1, max: 1 });
        return {
          prompt,
          resolve: (r) => (r.type === "cards" && r.refs[0] != null ? { type: OcgResponseType.ANNOUNCE_NUMBER, value: Number(r.refs[0]) } : null),
        };
      }
      case OcgMessageType.ANNOUNCE_CARD: {
        const prompt = this.nextPrompt(m.player, "announceCard", "Declare a card name", []);
        return {
          prompt,
          resolve: (r) => (r.type === "option" ? { type: OcgResponseType.ANNOUNCE_CARD, card: Number(r.id) } : null),
        };
      }
      default:
        return null;
    }
  }

  private aiContext(): AiContext {
    const reader = this.readers.cardReader;
    const view: CoreView = {
      queryLoc: (player, location) => this.queryLoc(player as DuelPlayer, location),
      queryCount: (player, location) => this.core.duelQueryCount(this.handle, player, location),
      lp: (player) => this.lp[player as DuelPlayer],
      stats: (code) => cardStats(reader(code)),
    };
    return buildAiContext(view, 1, this.aiAttackerAtk);
  }

  private trackAiAttacker(q: OcgMessage, resp: OcgResponse | null): void {
    if (q.type === OcgMessageType.SELECT_BATTLECMD && resp?.type === OcgResponseType.SELECT_BATTLECMD && resp.action === SelectBattleCMDAction.SELECT_BATTLE && resp.index != null) {
      const a = q.attacks[resp.index];
      this.aiAttackerAtk = a ? (this.readers.cardReader(a.code)?.attack ?? 0) : 0;
    } else if (q.type === OcgMessageType.SELECT_CARD || q.type === OcgMessageType.SELECT_IDLECMD) {
      this.aiAttackerAtk = 0;
    }
  }

  private autoPass(m: OcgMessage): OcgResponse | null {
    switch (m.type) {
      case OcgMessageType.SELECT_IDLECMD:
        return { type: OcgResponseType.SELECT_IDLECMD, action: m.to_ep ? SelectIdleCMDAction.TO_EP : SelectIdleCMDAction.TO_BP, index: null };
      case OcgMessageType.SELECT_BATTLECMD:
        return { type: OcgResponseType.SELECT_BATTLECMD, action: m.to_ep ? SelectBattleCMDAction.TO_EP : SelectBattleCMDAction.TO_M2, index: null };
      case OcgMessageType.SELECT_CHAIN:
        return { type: OcgResponseType.SELECT_CHAIN, index: m.forced ? 0 : null };
      case OcgMessageType.SELECT_EFFECTYN:
        return { type: OcgResponseType.SELECT_EFFECTYN, yes: false };
      case OcgMessageType.SELECT_YESNO:
        return { type: OcgResponseType.SELECT_YESNO, yes: false };
      case OcgMessageType.SELECT_OPTION:
        return { type: OcgResponseType.SELECT_OPTION, index: 0 };
      case OcgMessageType.SELECT_POSITION:
        return { type: OcgResponseType.SELECT_POSITION, position: OcgPosition.FACEUP_ATTACK };
      case OcgMessageType.SELECT_PLACE: {
        for (let seq = 0; seq < 7; seq++) if ((m.field_mask & (1 << seq)) === 0) return { type: OcgResponseType.SELECT_PLACE, places: [{ player: m.player, location: OcgLocation.MZONE, sequence: seq }] };
        for (let seq = 0; seq < 5; seq++) if ((m.field_mask & (1 << (8 + seq))) === 0) return { type: OcgResponseType.SELECT_PLACE, places: [{ player: m.player, location: OcgLocation.SZONE, sequence: seq }] };
        return { type: OcgResponseType.SELECT_PLACE, places: [] };
      }
      case OcgMessageType.SELECT_CARD: {
        const min = m.min ?? 1;
        return { type: OcgResponseType.SELECT_CARD, indicies: Array.from({ length: Math.max(1, min) }, (_, i) => i) };
      }
      case OcgMessageType.SELECT_UNSELECT_CARD: {
        if ((m.select_cards?.length ?? 0) > 0) return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: 0 };
        return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: null };
      }
      case OcgMessageType.SELECT_TRIBUTE: {
        const min = (m as any).min ?? 1;
        return { type: OcgResponseType.SELECT_TRIBUTE, indicies: Array.from({ length: Math.max(1, min) }, (_, i) => i) };
      }
      case OcgMessageType.SELECT_SUM: {
        const min = (m as any).min ?? 1;
        return { type: OcgResponseType.SELECT_SUM, indicies: Array.from({ length: Math.max(1, min) }, (_, i) => i) };
      }
      case OcgMessageType.SELECT_COUNTER: {
        let need = m.count;
        const counters = m.cards.map((c) => { const take = Math.min(need, c.count); need -= take; return take; });
        return { type: OcgResponseType.SELECT_COUNTER, counters };
      }
      case OcgMessageType.SELECT_DISFIELD: {
        for (let seq = 0; seq < 7; seq++) if ((m.field_mask & (1 << seq)) === 0) return { type: OcgResponseType.SELECT_DISFIELD, places: [{ player: m.player, location: OcgLocation.MZONE, sequence: seq }] };
        for (let seq = 0; seq < 5; seq++) if ((m.field_mask & (1 << (8 + seq))) === 0) return { type: OcgResponseType.SELECT_DISFIELD, places: [{ player: m.player, location: OcgLocation.SZONE, sequence: seq }] };
        return { type: OcgResponseType.SELECT_DISFIELD, places: [] };
      }
      case OcgMessageType.SORT_CARD:
      case OcgMessageType.SORT_CHAIN:
        return { type: OcgResponseType.SORT_CARD, order: null };
      case OcgMessageType.ANNOUNCE_RACE: {
        const first = RACE_LABELS.find(([bit]) => (m.available & bit) !== 0n);
        return { type: OcgResponseType.ANNOUNCE_RACE, races: (first ? [first[0]] : []) as OcgRace[] };
      }
      case OcgMessageType.ANNOUNCE_ATTRIB: {
        const first = ATTR_LABELS.find(([bit]) => (m.available & bit) !== 0);
        return { type: OcgResponseType.ANNOUNCE_ATTRIB, attributes: (first ? [first[0]] : []) as OcgAttribute[] };
      }
      case OcgMessageType.ANNOUNCE_NUMBER:
        return { type: OcgResponseType.ANNOUNCE_NUMBER, value: 0 };
      case OcgMessageType.ANNOUNCE_CARD:
        return { type: OcgResponseType.ANNOUNCE_CARD, card: 0 };
      case OcgMessageType.ROCK_PAPER_SCISSORS:
        return { type: OcgResponseType.ROCK_PAPER_SCISSORS, value: 1 };
      default:
        return null;
    }
  }

  private addDeck(team: 0 | 1, main: number[], extra: number[]): void {
    for (const code of main) {
      this.core.duelNewCard(this.handle, { team, duelist: 0, code, controller: team, location: OcgLocation.DECK, sequence: 1, position: OcgPosition.FACEDOWN_DEFENSE });
    }
    for (const code of extra) {
      this.core.duelNewCard(this.handle, { team, duelist: 0, code, controller: team, location: OcgLocation.EXTRA, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    }
  }

  private dummyDeck(): number[] {
    const monsters = [4148264, 14575467, 18108166, 24639891, 43096270, 47226949].filter((c) => this.readers.cardReader(c));
    const traps = [44095762, 56120475, 4206964, 70342110, 29401950, 62279055].filter((c) => this.readers.cardReader(c));
    const mPool = monsters.length ? monsters : [5053103];
    const deck: number[] = [];
    for (let i = 0; i < 30; i++) deck.push(mPool[i % mPool.length]!);
    for (let i = 0; i < 10 && traps.length; i++) deck.push(traps[i % traps.length]!);
    while (deck.length < 40) deck.push(mPool[deck.length % mPool.length]!);
    return deck;
  }
}
