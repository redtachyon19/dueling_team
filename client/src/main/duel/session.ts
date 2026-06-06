// Duel session host (main process). Wraps one ocgcore duel: drives the
// process/message/response loop, builds an authoritative DuelState by querying
// the core, derives the local player's DuelPrompt, and auto-passes for the
// goldfish opponent. ocgcore is the rules authority; nothing here re-implements
// rules — it only translates between the core and the @duel/shared contracts.

import {
  OcgLocation,
  OcgPosition,
  OcgProcessResult,
  OcgResponseType,
  OcgMessageType,
  OcgDuelMode,
  OcgQueryFlags,
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
  DuelEvent,
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

// Combined query flag bitmask (the lib types flags as a single-flag union, so
// the OR'd mask is asserted back to that type).
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
]);

const LOCATION_NAME: Record<number, string> = {
  [OcgLocation.DECK]: "deck", [OcgLocation.HAND]: "hand", [OcgLocation.MZONE]: "mzone",
  [OcgLocation.SZONE]: "szone", [OcgLocation.GRAVE]: "grave", [OcgLocation.REMOVED]: "banish",
  [OcgLocation.EXTRA]: "extra", [OcgLocation.FZONE]: "fzone",
};

/** Where a card-tied action lives, for the renderer to attach it to that card. */
function locOf(c: { location: number; sequence: number }): { loc: string; seq: number } {
  return { loc: LOCATION_NAME[c.location] ?? String(c.location), seq: c.sequence };
}

export interface DuelDeck {
  main: number[];
  extra: number[];
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
  // True once the ocgcore handle has been destroyed, so teardown is idempotent —
  // calling destroyDuel twice on the same handle is a WASM out-of-bounds crash
  // (hit by surrender→start-new-duel, and by HMR churn restarting the board).
  private destroyed = false;
  private winner: DuelPlayer | null = null;
  private goldfish = true;

  private promptId = 0;
  private pendingPromptId: number | null = null;
  private pendingResolve: ((r: DuelResponse) => OcgResponse | null) | null = null;
  private pendingPlaceKind: "monster" | "spell" = "monster";

  constructor(
    private readonly onUpdate: (u: DuelUpdate) => void,
    private readonly startDirs: string[],
  ) {}

  /** Start a duel with the local player's deck. Returns unsupported passcodes. */
  async start(deck: DuelDeck, seed: bigint, goldfish = true): Promise<{ ok: boolean; error?: string; unsupported: number[] }> {
    this.goldfish = goldfish;
    try {
      this.core = await getCore();
      this.readers = buildReaders(this.startDirs);
    } catch (e) {
      return { ok: false, error: (e as Error).message, unsupported: [] };
    }

    const mainPart = partitionSupported(deck.main, this.readers);
    const extraPart = partitionSupported(deck.extra, this.readers);
    const unsupported = [...mainPart.unsupported, ...extraPart.unsupported];

    const seed4: [bigint, bigint, bigint, bigint] = [
      seed | 1n,
      (seed >> 16n) | 1n,
      (seed >> 32n) | 1n,
      (seed >> 48n) | 1n,
    ];

    const handle = this.core.createDuel({
      flags: OcgDuelMode.MODE_MR5,
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

    // Player 0 = local deck; player 1 = goldfish dummy (vanilla) deck. The main
    // deck is shuffled here (seeded from the duel seed) and loaded in that order;
    // ocgcore's insert-shuffle isn't relied on. The Extra deck isn't shuffled.
    this.addDeck(0, shuffleDeck(mainPart.supported, seed), extraPart.supported);
    this.addDeck(1, this.dummyDeck(), []);

    try {
      this.core.startDuel(handle);
    } catch (e) {
      return { ok: false, error: `startDuel: ${(e as Error).message}`, unsupported };
    }

    this.run();
    return { ok: true, unsupported };
  }

  /** The local player answers the current prompt. */
  respond(r: DuelResponse): void {
    if (this.destroyed || this.over || r.promptId !== this.pendingPromptId || !this.pendingResolve) return;
    const resp = this.pendingResolve(r);
    if (!resp) return; // invalid choice — ignore, leave prompt up
    this.pendingResolve = null;
    this.pendingPromptId = null;
    this.core.duelSetResponse(this.handle, resp);
    this.run();
  }

  /** The local player concedes: opponent wins, the duel ends immediately. */
  surrender(): void {
    if (this.over) return;
    this.over = true;
    this.winner = 1;
    this.pendingResolve = null;
    this.pendingPromptId = null;
    // Build the final state from the still-live handle before tearing it down,
    // then push a win event so the board flashes "Defeat" like any other loss.
    const update: DuelUpdate = {
      state: this.buildState(),
      prompt: null,
      events: [{ kind: "win", player: 1 }],
    };
    this.teardown();
    this.onUpdate(update);
  }

  end(): void {
    this.over = true;
    this.teardown();
  }

  /** Destroy the ocgcore handle exactly once. Safe to call repeatedly. */
  private teardown(): void {
    if (this.destroyed || !this.handle) return;
    this.destroyed = true;
    try {
      this.core.destroyDuel(this.handle);
    } catch {
      /* ignore */
    }
  }

  // --- core driver ----------------------------------------------------------
  private run(): void {
    if (this.destroyed || !this.handle) return; // never drive a torn-down duel
    // Accumulate events across all CONTINUE batches until the next pause
    // (prompt or END), so nothing that happened between prompts is dropped.
    const events: DuelEvent[] = [];
    let guard = 0;
    while (guard++ < 100000) {
      const status = this.core.duelProcess(this.handle);
      const messages = this.core.duelGetMessage(this.handle);
      for (const m of messages) this.observe(m, events);

      if (status === OcgProcessResult.END) {
        this.over = true;
        this.onUpdate({ state: this.buildState(), prompt: null, events });
        return;
      }
      if (status === OcgProcessResult.WAITING) {
        const q = messages.find((m) => QUESTION_TYPES.has(m.type));
        if (!q) {
          console.warn("[duel] WAITING with no question message");
          return;
        }
        if (this.goldfish && (q as { player?: number }).player === 1) {
          const resp = this.autoPass(q);
          if (resp) this.core.duelSetResponse(this.handle, resp);
          continue;
        }
        const built = this.buildPrompt(q);
        if (!built) {
          // Unsupported question type — pass/cancel to keep the duel alive.
          const fallback = this.autoPass(q);
          if (fallback) this.core.duelSetResponse(this.handle, fallback);
          continue;
        }
        this.pendingPromptId = built.prompt.id;
        this.pendingResolve = built.resolve;
        this.onUpdate({ state: this.buildState(), prompt: built.prompt, events });
        return;
      }
      // CONTINUE → loop again
    }
    console.warn("[duel] run() guard tripped");
  }

  // --- message observation (LP / phase / turn / events) ---------------------
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
      case OcgMessageType.WIN:
        this.over = true;
        this.winner = m.player as DuelPlayer;
        events.push({ kind: "win", player: this.winner });
        break;
      default:
        break;
    }
  }

  private pos(p: number): CardPosition {
    return positionFromOcg(p).position;
  }

  // --- authoritative board state (queried) ----------------------------------
  private buildState(): DuelState {
    const field = this.core.duelQueryField(this.handle);
    const players = ([0, 1] as DuelPlayer[]).map((p): DuelPlayerState => {
      const fp = field.players[p];
      // The graveyard is public — surface the top (most recent) card so it can
      // be shown face-up. Query returns cards in sequence order; last = newest.
      const grave = this.queryLoc(p, OcgLocation.GRAVE).filter(Boolean) as Record<string, any>[];
      const graveTopCard = grave[grave.length - 1];
      const graveTop: number | null = graveTopCard?.code ?? null;
      // Full GY / banished lists (both public) so either pile can be browsed.
      const graveCards: DuelCard[] = grave.map((c, i) => this.toCard(c, i, p, "grave"));
      const banished: DuelCard[] = (this.queryLoc(p, OcgLocation.REMOVED).filter(Boolean) as Record<string, any>[])
        .map((c, i) => this.toCard(c, i, p, "banish"));
      // The Field Spell lives in the spell array at index 5 (NOT OcgLocation.FZONE,
      // which this core leaves empty). Spell/Trap zones are indices 0–4.
      const szone = this.queryLoc(p, OcgLocation.SZONE);
      const fieldCard = szone[5] ? this.toCard(szone[5] as Record<string, any>, 5, p, "szone") : null;
      // Surface the local player's Extra Deck so it can be browsed (it's public
      // to its owner). The opponent's stays hidden.
      const extra: DuelCard[] = p === 0
        ? (this.queryLoc(p, OcgLocation.EXTRA).filter(Boolean) as Record<string, any>[]).map((c, i) => this.toCard(c, i, p, "extra"))
        : [];
      return {
        lp: this.lp[p],
        hand: this.queryLoc(p, OcgLocation.HAND).filter(Boolean).map((c, i) => this.toCard(c!, i, p, "hand")),
        monsters: this.zoneArray(p, OcgLocation.MZONE, 7, "mzone"), // 0–4 main + 5–6 Extra Monster Zones
        spells: this.zoneArray(p, OcgLocation.SZONE, 5, "szone"),
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
    };
  }

  private queryLoc(player: DuelPlayer, location: OcgLocation): (Record<string, any> | null)[] {
    try {
      return this.core.duelQueryLocation(this.handle, { flags: QUERY_FLAGS, controller: player, location }) as any[];
    } catch {
      return [];
    }
  }

  private zoneArray(player: DuelPlayer, location: OcgLocation, n: number, loc: string): (DuelCard | null)[] {
    const raw = this.queryLoc(player, location);
    const out: (DuelCard | null)[] = [];
    for (let i = 0; i < n; i++) out.push(raw[i] ? this.toCard(raw[i]!, i, player, loc) : null);
    return out;
  }

  private toCard(info: Record<string, any>, seq: number, controller: DuelPlayer, loc: string): DuelCard {
    const { position, faceUp } = positionFromOcg(info.position ?? OcgPosition.FACEUP_ATTACK);
    // Hide the opponent's hidden information from the local viewer — but the
    // hand IS revealed (this is a practice tool, so seeing it is the point);
    // only their face-down field cards (set monsters / spells) stay concealed.
    const hidden = controller === 1 && loc !== "hand" && !faceUp;
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

  // --- prompt building (local player) --------------------------------------
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
        m.activates.forEach((c, i) => opts.push({ id: `activate:${i}`, label: "Activate", code: c.code, ...locOf(c) }));
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
        // Monster bits 0–6 = main zones 0–4 plus the 2 Extra Monster Zones (5–6).
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
      // Synchro/Xyz/Link material selection and other "pick until valid" choices.
      // Unlike SELECT_CARD this is ITERATIVE: each response selects OR unselects a
      // single card (by `index`), and the core re-prompts with refreshed lists
      // until the selection is complete. `select_cards` are the addable candidates;
      // `unselect_cards` are already-chosen (refs prefixed "u:" so the UI can show
      // them as picked and let you take them back).
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
            // index < select_cards.length → select; else unselect at index-len.
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
        // Pick from `selects` (the optional pool); the core auto-includes any
        // `selects_must` and validates that the values reach `amount`.
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
      default:
        return null;
    }
  }

  // --- goldfish opponent (auto-pass) ---------------------------------------
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
        // Iterative: select the first candidate, or finish when none remain.
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
      default:
        return null;
    }
  }

  // --- deck loading ---------------------------------------------------------
  private addDeck(team: 0 | 1, main: number[], extra: number[]): void {
    // sequence 1 = add to the bottom, so the cards keep the order we pass in
    // (we shuffle beforehand). sequence ≥2 would let the core reorder them.
    for (const code of main) {
      this.core.duelNewCard(this.handle, { team, duelist: 0, code, controller: team, location: OcgLocation.DECK, sequence: 1, position: OcgPosition.FACEDOWN_DEFENSE });
    }
    for (const code of extra) {
      this.core.duelNewCard(this.handle, { team, duelist: 0, code, controller: team, location: OcgLocation.EXTRA, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    }
  }

  /** A minimal legal vanilla deck for the passive goldfish opponent. */
  private dummyDeck(): number[] {
    const vanillas = [5053103, 15025844, 76184692, 71625222, 46362044]; // Battle Ox, Mystical Elf, Hitotsu-Me Giant, etc.
    const supported = vanillas.filter((c) => this.readers.cardReader(c));
    const pool = supported.length ? supported : [5053103];
    const deck: number[] = [];
    for (let i = 0; i < 40; i++) deck.push(pool[i % pool.length]!);
    return deck;
  }
}
