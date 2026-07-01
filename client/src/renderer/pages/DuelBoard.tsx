import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CardData, DuelCard, DuelDifficulty, DuelEvent, DuelFormat, DuelOption, DuelPhase, DuelPrompt, DuelResponse, DuelState, DuelUpdate, PromptCard } from "@duel/shared";
import cardBack from "../../../../assets/cards/sleeves/original_card_sleeve.png";
import { toLogEntries } from "../cards/duel-log.ts";
import { CardViewer } from "./CardViewer.tsx";

const EMPTY_SET: Set<string> = new Set();

// Response windows (chain / yes-no / activate-effect) auto-decline after this
// many seconds, matching the Shift ("No") keybind, so a duel can't stall waiting.
const RESPONSE_SECS = 5; // seconds

const PHASES: { key: DuelPhase; label: string }[] = [
  { key: "draw", label: "DP" },
  { key: "standby", label: "SP" },
  { key: "main1", label: "M1" },
  { key: "battle", label: "BP" },
  { key: "main2", label: "M2" },
  { key: "end", label: "EP" },
];

// --- Gesture support --------------------------------------------------------
// Drag a hand card onto the board to play it; modifiers pick the mode. The
// gesture just selects the matching idle-prompt option (the engine already
// offers "Normal Summon" / "Set" / "Activate" per card), then auto-answers the
// follow-up zone placement with the zone the card was dropped on.
type Mods = { shift: boolean; meta: boolean; ctrl: boolean };
type DragState = { seq: number; code: number | null; isMonster: boolean; x: number; y: number; valid: boolean; mods: Mods; hint: string };

const readMods = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): Mods =>
  ({ shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey });

/** The board zone (data-loc/data-seq) under a screen point, if any. */
function zoneAtPoint(x: number, y: number): { loc: string | undefined; seq: number } {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const z = el?.closest("[data-loc]") as HTMLElement | null;
  return { loc: z?.dataset.loc, seq: z ? Number(z.dataset.seq) : NaN };
}

/**
 * Pick the idle option a drop maps to. Monsters go to the monster row (Normal
 * Summon / Set with Shift / Special Summon with ⌘/Ctrl); spells & traps go to
 * the spell/trap row (Activate / Set with Shift). Returns undefined when the
 * drop zone or the requested mode doesn't apply to this card.
 */
function gestureOption(opts: DuelOption[], isMonster: boolean, dropLoc: string | undefined, mods: Mods): DuelOption | undefined {
  const find = (prefix: string) => opts.find((o) => o.id.startsWith(prefix + ":"));
  if (isMonster) {
    if (dropLoc !== "mzone") return undefined;
    if (mods.shift) return find("mset");
    if (mods.meta || mods.ctrl) return find("spsummon"); // ⌘/Ctrl forces a Special Summon
    // Plain drag: Normal Summon if possible, otherwise fall back to a Special
    // Summon — so a monster that can ONLY be Special Summoned (its conditions
    // are met) still plays with a simple drag onto the monster row.
    return find("summon") ?? find("spsummon");
  }
  if (dropLoc !== "szone" && dropLoc !== "fzone") return undefined;
  if (mods.shift) return find("sset");
  return find("activate");
}

/** Label shown under the drag ghost — reflects the actual play this card+mods
 *  will perform (e.g. "Special Summon" for a monster that can only be SS'd). */
function dragHint(handOpts: DuelOption[], isMonster: boolean, mods: Mods): string {
  const has = (prefix: string) => handOpts.some((o) => o.id.startsWith(prefix + ":"));
  if (isMonster) {
    if (mods.shift) return "Set";
    if (mods.meta || mods.ctrl) return "Special Summon";
    return has("summon") ? "Normal Summon" : has("spsummon") ? "Special Summon" : "Normal Summon";
  }
  return mods.shift ? "Set" : "Activate";
}

/** Whether a chosen idle action needs a pre-commit zone pick, and on which row.
 *  summon/set → monster row; spell/trap activate or set → spell row. Monster
 *  effect activations, Field Spells (auto-placed), and special summons return
 *  null — they keep the engine's normal placement flow. */
function placementKind(optionId: string, code: number | null | undefined, cards: Map<number, CardData>): "monster" | "spell" | null {
  const k = optionId.split(":")[0];
  if (k === "summon" || k === "mset") return "monster";
  const card = code != null ? cards.get(code) : undefined;
  if (k === "sset") return /Field/i.test(card?.race ?? "") ? null : "spell";
  if (k === "activate") {
    if (!/Spell|Trap/i.test(card?.type ?? "")) return null; // monster effect — no zone
    if (/Field/i.test(card?.race ?? "")) return null; // field spell auto-places
    return "spell";
  }
  return null;
}

export function DuelBoard({ deckId, format = "advanced", seed, opponent = "goldfish", difficulty = "normal", aiDeckId, networked = false, onExit }: { deckId: string; format?: DuelFormat; seed?: string | undefined; opponent?: "goldfish" | "ai" | undefined; difficulty?: DuelDifficulty | undefined; aiDeckId?: string | undefined; networked?: boolean; onExit: () => void }): JSX.Element {
  // Bumped by "Play again" to restart the same deck with a fresh (random) hand.
  const [rematch, setRematch] = useState(0);
  const [state, setState] = useState<DuelState | null>(null);
  const [prompt, setPrompt] = useState<DuelPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<number[]>([]);
  const [banner, setBanner] = useState<{ id: number; text: string; tone: string } | null>(null);
  const bannerSeq = useRef(0);
  const [preview, setPreview] = useState<CardData | null>(null);
  const [extraOpen, setExtraOpen] = useState(false); // browsing the local Extra Deck
  const [viewer, setViewer] = useState<{ title: string; cards: DuelCard[] } | null>(null); // GY/banish browser
  const [tips, setTips] = useState(() => { try { return !localStorage.getItem("duel_tips_seen"); } catch { return false; } });
  const [coin, setCoin] = useState<{ id: number; results: number[] } | null>(null); // coin-flip animation
  const coinSeq = useRef(0);
  const [dice, setDice] = useState<{ id: number; results: number[] } | null>(null); // dice-roll animation
  const diceSeq = useRef(0);
  const [logRaw, setLogRaw] = useState<DuelEvent[]>([]); // running event history for the duel log
  const [logOpen, setLogOpen] = useState(false);
  // Pre-commit zone picker: a chosen idle action awaiting a zone click. Nothing
  // is sent to the engine until a zone is picked, so Escape can cancel cleanly.
  const [placing, setPlacing] = useState<{ promptId: number; optionId: string; kind: "monster" | "spell" } | null>(null);

  // Size the board zones to the ACTUAL play area (not a 100vh guess): the play
  // region is a stable flex child, so measuring it and solving for --zone fits
  // the 5 zone-rows + both hands exactly, on any window/DPI, without clipping.
  const [zonePx, setZonePx] = useState(120);
  const roRef = useRef<ResizeObserver | null>(null);
  // Callback ref so measurement starts when the play element actually mounts —
  // the board renders only AFTER the duel state loads, so a mount-effect would
  // run too early (ref still null) and never measure.
  const playRefCb = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    const measure = () => {
      const P = el.clientHeight;
      const W = el.clientWidth;
      if (P <= 0 || W <= 0) return;
      const byH = (P - 140) / 6.6; // 5 zone-rows + both hands + headers/gaps
      const byW = (W - 48) / 9; // 9 columns + gaps
      setZonePx(Math.max(56, Math.min(byW, byH, 176)));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
    measure();
  }, []);

  // Full card data, kept in a ref so the (once-subscribed) update handler reads
  // the latest map even though it loads asynchronously; drives names + hover preview.
  const [, bump] = useState(0);
  const cardsRef = useRef<Map<number, CardData>>(new Map());
  const nameOf = (code: number | null | undefined): string =>
    code == null ? "" : cardsRef.current.get(code)?.name ?? `#${code}`;

  useEffect(() => {
    window.duel?.cards?.load().then((cards: CardData[] | null) => {
      const m = new Map<number, CardData>();
      for (const c of cards ?? []) m.set(c.id, c);
      cardsRef.current = m;
      bump((n) => n + 1);
    }).catch(() => {});
  }, []);

  // Hover preview: only updates state when the hovered card changes (cheap).
  const onHover = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-code]") as HTMLElement | null;
    if (!el) return; // keep the last previewed card in the panel
    const code = Number(el.getAttribute("data-code"));
    setPreview((cur) => (cur && cur.id === code ? cur : cardsRef.current.get(code) ?? cur));
  };

  // Per-card action menu (idle / battle): click a card → popup of its actions.
  const [menu, setMenu] = useState<{ promptId: number; options: DuelOption[]; x: number; y: number } | null>(null);
  useEffect(() => { setMenu(null); setPlacing(null); }, [prompt?.id]);

  // --- Gestures: drag-to-play + long-press-to-surrender ---------------------
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [press, setPress] = useState<{ x: number; y: number; k: number } | null>(null);
  const pressRef = useRef<{ timer: number; raf: number; start: number; x: number; y: number } | null>(null);
  const pressCleanupRef = useRef<(() => void) | null>(null);
  // The zone option id ("m:2" / "s:1", or "*" for any) to auto-pick on the next
  // SELECT_PLACE prompt that a gesture triggers.
  const pendingPlaceRef = useRef<string | null>(null);
  // Set true after a completed drag so the trailing synthetic click is ignored.
  const suppressClickRef = useRef(false);

  const cardOptions = prompt && (prompt.kind === "idle" || prompt.kind === "battle")
    ? prompt.options.filter((o) => o.loc != null)
    : [];
  const actionable = useMemo(() => {
    const s = new Set<string>();
    for (const o of cardOptions) s.add(`${o.loc}:${o.seq}`);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);

  // SELECT_PLACE: map each placeable zone option ("m:3" / "s:1") to a board key
  // ("mzone:3" / "szone:1") so the zone itself is clickable.
  const placeTargets = useMemo(() => {
    const m = new Map<string, string>();
    if (prompt?.kind === "selectPlace") {
      for (const o of prompt.options) {
        const [k, seq] = o.id.split(":");
        const loc = k === "m" ? "mzone" : k === "s" ? "szone" : null;
        if (loc) m.set(`${loc}:${seq}`, o.id);
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);
  const targets = useMemo(() => new Set(placeTargets.keys()), [placeTargets]);

  // While picking a zone pre-commit, highlight the open zones for that row.
  const placingTargets = useMemo(() => {
    const s = new Set<string>();
    if (!placing || !state) return s;
    const me = state.players[0];
    if (placing.kind === "monster") {
      for (let i = 0; i < 5; i++) if (me.monsters[i] == null) s.add(`mzone:${i}`);
    } else {
      for (let i = 0; i < 5; i++) if (me.spells[i] == null) s.add(`szone:${i}`);
    }
    return s;
  }, [placing, state]);
  // The highlight set the board actually uses: the pre-commit picker takes over.
  const boardTargets = placing ? placingTargets : targets;

  // Extra Deck special summons currently on offer (Fusion / Synchro / Xyz / Link
  // / Pendulum). Keyed by card code so a clicked Extra Deck card maps to its
  // summon option(s) — summonability is per card-code, so duplicate copies are
  // equivalent. Only populated during an idle (Main Phase) decision; empty
  // otherwise, so the Extra Deck stays view-only when you can't summon.
  const extraSummon = useMemo(() => {
    const m = new Map<number, DuelOption[]>();
    if (prompt?.kind === "idle") {
      for (const o of prompt.options) {
        if (o.loc === "extra" && o.code != null) {
          const arr = m.get(o.code);
          if (arr) arr.push(o);
          else m.set(o.code, [o]);
        }
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);

  // A drag that picked a summon/set/activate is followed by a SELECT_PLACE
  // prompt; auto-answer it with the dropped zone (falling back to any open one)
  // so the whole play happens in one gesture. Clears once the turn returns to
  // an idle/battle decision.
  useEffect(() => {
    if (!prompt) return;
    if (prompt.kind === "idle" || prompt.kind === "battle") { pendingPlaceRef.current = null; return; }
    if (prompt.kind === "selectPlace" && pendingPlaceRef.current != null) {
      const want = pendingPlaceRef.current;
      pendingPlaceRef.current = null;
      const pick = (want !== "*" && prompt.options.find((o) => o.id === want)) || prompt.options[0];
      if (pick) respond({ promptId: prompt.id, type: "option", id: pick.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);

  // Keyboard gestures for response popups (chain / activate-effect / yes-no):
  // Space = respond / activate, Shift = decline ("No Response" / No).
  useEffect(() => {
    if (!prompt || (prompt.kind !== "selectChain" && prompt.kind !== "effectyn" && prompt.kind !== "yesno")) return;
    const noId = prompt.options.find((o) => o.id === "pass" || o.id === "no")?.id;
    const yesId = prompt.options.find((o) => o.id === "yes" || o.id.startsWith("chain:"))?.id;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "Shift" && noId) {
        e.preventDefault();
        respond({ promptId: prompt.id, type: "option", id: noId });
      } else if ((e.code === "Space" || e.key === " ") && yesId) {
        e.preventDefault();
        respond({ promptId: prompt.id, type: "option", id: yesId });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);

  // Press G to open (toggle) your Graveyard, like clicking the GY pile. Works any
  // time; ignores typing fields and modifier combos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "g" && e.key !== "G") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const me = state?.players[0];
      if (!me) return;
      e.preventDefault();
      setViewer((v) => (v && v.title === "Your Graveyard" ? null : { title: "Your Graveyard", cards: me.grave }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  // Press L to toggle the duel log.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "l" && e.key !== "L") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      setLogOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Phase shortcuts during your Main/Battle decisions: B = Battle Phase,
  // M = Main Phase 2, E = End Turn. Maps to the matching global idle/battle option.
  useEffect(() => {
    if (!prompt || (prompt.kind !== "idle" && prompt.kind !== "battle")) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      const want = k === "b" ? "bp" : k === "m" ? "m2" : k === "e" ? "ep" : null;
      if (!want) return;
      const opt = prompt.options.find((o) => o.id === want);
      if (opt) { e.preventDefault(); respond({ promptId: prompt.id, type: "option", id: opt.id }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);

  // Escape backs out of whatever you were about to do: close an open card menu
  // or browser overlay, or cancel the current cancelable prompt (material /
  // target / tribute selection, or a chain response → No Response).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (placing) { e.preventDefault(); setPlacing(null); return; } // cancel pre-commit zone pick
      if (menu) { e.preventDefault(); setMenu(null); return; }
      if (viewer) { e.preventDefault(); setViewer(null); return; }
      if (logOpen) { e.preventDefault(); setLogOpen(false); return; }
      if (extraOpen) { e.preventDefault(); setExtraOpen(false); return; }
      if (prompt?.cancelable) { e.preventDefault(); respond({ promptId: prompt.id, type: "cancel" }); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, menu, viewer, extraOpen, logOpen, prompt?.id, prompt?.cancelable]);

  const onBoardClick = (e: ReactMouseEvent) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    // Pre-commit zone picker: a click on a highlighted open zone commits the
    // pending action (auto-answering the engine's upcoming placement); a click
    // anywhere else cancels it. Nothing was sent until now, so this is safe.
    if (placing) {
      const z = (e.target as HTMLElement).closest("[data-loc]") as HTMLElement | null;
      const key = z ? `${z.dataset.loc}:${z.dataset.seq}` : "";
      if (key && placingTargets.has(key)) {
        pendingPlaceRef.current = z!.dataset.loc === "mzone" ? `m:${z!.dataset.seq}` : `s:${z!.dataset.seq}`;
        respond({ promptId: placing.promptId, type: "option", id: placing.optionId });
      }
      setPlacing(null);
      return;
    }
    // Clicking the local Extra Deck opens its browser (works any time, no prompt needed).
    if ((e.target as HTMLElement).closest('[data-extra="local"]')) { setExtraOpen(true); return; }
    // Clicking a Graveyard / Banished pile (either player's — both are public)
    // opens a read-only browser of its cards. Works any time, no prompt needed.
    const pileEl = (e.target as HTMLElement).closest("[data-pile]") as HTMLElement | null;
    if (pileEl && state) {
      const kind = pileEl.dataset.pile; // "grave" | "banish"
      const owner = (Number(pileEl.dataset.owner) || 0) as 0 | 1;
      const cards = kind === "grave" ? state.players[owner].grave : state.players[owner].banished;
      const whose = owner === 0 ? "Your" : "Opponent's";
      setViewer({ title: `${whose} ${kind === "grave" ? "Graveyard" : "Banished"}`, cards });
      return;
    }
    if (!prompt) return;
    const el = (e.target as HTMLElement).closest("[data-loc]") as HTMLElement | null;
    if (prompt.kind === "idle" || prompt.kind === "battle") {
      if (!el) { setMenu(null); return; }
      const key = `${el.dataset.loc}:${el.dataset.seq}`;
      const options = cardOptions.filter((o) => `${o.loc}:${o.seq}` === key);
      if (!options.length) { setMenu(null); return; }
      setMenu({ promptId: prompt.id, options, x: e.clientX, y: e.clientY });
      return;
    }
    if (prompt.kind === "selectPlace" && el) {
      const id = placeTargets.get(`${el.dataset.loc}:${el.dataset.seq}`);
      if (id) respond({ promptId: prompt.id, type: "option", id });
    }
  };

  // Transient announcer banner (turn / attack / win), auto-clears.
  useEffect(() => {
    if (!banner) return;
    const id = banner.id;
    const t = setTimeout(() => setBanner((cur) => (cur && cur.id === id ? null : cur)), 1400);
    return () => clearTimeout(t);
  }, [banner]);

  // Auto-dismiss the first-load tips bar after a while.
  useEffect(() => {
    if (!tips) return;
    const t = setTimeout(() => setTips(false), 12000);
    return () => clearTimeout(t);
  }, [tips]);

  // Clear the coin-flip overlay once the spin + result hold has played.
  useEffect(() => {
    if (!coin) return;
    const t = setTimeout(() => setCoin(null), 2400);
    return () => clearTimeout(t);
  }, [coin]);

  // Clear the dice-roll overlay once the tumble + result hold has played.
  useEffect(() => {
    if (!dice) return;
    const t = setTimeout(() => setDice(null), 2400);
    return () => clearTimeout(t);
  }, [dice]);

  // Subscribe first, then start — so the opening update isn't missed.
  useEffect(() => {
    setLogRaw([]); // fresh log per game (mount / rematch)
    const off = window.duel.match.onUpdate((u: DuelUpdate) => {
      setState(u.state);
      setPrompt(u.prompt);
      if (u.events.length) setLogRaw((prev) => { const next = prev.concat(u.events); return next.length > 600 ? next.slice(-600) : next; });
      const b = bannerFromEvents(u.events);
      if (b) setBanner({ id: ++bannerSeq.current, ...b });
      const flip = u.events.find((e) => e.kind === "toss" && e.dice === false);
      if (flip && flip.kind === "toss") setCoin({ id: ++coinSeq.current, results: flip.results });
      const roll = u.events.find((e) => e.kind === "toss" && e.dice === true);
      if (roll && roll.kind === "toss") setDice({ id: ++diceSeq.current, results: roll.results });
    });
    // Online play: the session is started by the host's net:host flow (and the
    // guest has no local session at all), so the board only listens — it never
    // calls match.start. Local play starts the duel here.
    if (!networked) {
      // First game honors the chosen seed (reproducible); "Play again" omits it
      // so each rematch deals a fresh random hand.
      window.duel.match.start({ deckId, goldfish: true, format, seed: rematch === 0 ? seed : undefined, opponent, difficulty, aiDeckId }).then((res) => {
        if (!res.ok) setError(res.error ?? "Failed to start duel.");
        setUnsupported(res.unsupported ?? []);
      });
    } else {
      // Online: the duel is already running on the host; now that we're
      // subscribed, pull the current board state (the opening update predates us).
      window.duel.net.ready().catch(() => {});
    }
    return () => {
      off();
      window.duel.match.end();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, format, rematch, aiDeckId, networked]);

  const respond = (r: DuelResponse) => window.duel.match.respond(r);

  // Long-press the deck for 3s to surrender. A ring fills around the press
  // point; moving away or releasing early cancels.
  const cancelPress = () => {
    const p = pressRef.current;
    if (p) { clearTimeout(p.timer); cancelAnimationFrame(p.raf); pressRef.current = null; }
    pressCleanupRef.current?.();
    pressCleanupRef.current = null;
    setPress(null);
  };
  const beginPress = (e: ReactPointerEvent) => {
    cancelPress();
    const x = e.clientX, y = e.clientY;
    const DUR = 3000;
    const tick = () => {
      const p = pressRef.current;
      if (!p) return;
      const k = Math.min(1, (performance.now() - p.start) / DUR);
      setPress({ x: p.x, y: p.y, k });
      if (k < 1) p.raf = requestAnimationFrame(tick);
    };
    const timer = window.setTimeout(() => { cancelPress(); window.duel.match.surrender(); }, DUR);
    pressRef.current = { timer, raf: requestAnimationFrame(tick), start: performance.now(), x, y };
    setPress({ x, y, k: 0 });
    const onMove = (ev: PointerEvent) => {
      const p = pressRef.current;
      if (p && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 16) cancelPress();
    };
    const onEnd = () => cancelPress();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    pressCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  };

  // Drag a hand card; on release, map the drop (+ modifiers) to an idle option.
  // The ghost only appears once the pointer travels past a small threshold, so a
  // plain click still falls through to the card's action menu.
  const beginDrag = (e: ReactPointerEvent, seq: number, el: HTMLElement) => {
    const code = el.dataset.code ? Number(el.dataset.code) : null;
    const isMonster = code != null && /Monster/i.test(cardsRef.current.get(code)?.type ?? "");
    const start = { x: e.clientX, y: e.clientY };
    // This card's available idle actions (Normal/Special Summon, Set, Activate),
    // captured once — drives both the live "valid drop" highlight and the ghost
    // label so the hint matches what the drop will actually do.
    const handOpts = prompt?.kind === "idle" ? prompt.options.filter((o) => o.loc === "hand" && o.seq === seq) : [];
    dragRef.current = { seq, code, isMonster, x: start.x, y: start.y, valid: false, mods: readMods(e), hint: dragHint(handOpts, isMonster, readMods(e)) };
    let active = false;

    const onMove = (ev: PointerEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const mods = readMods(ev);
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) {
        dragRef.current = { ...ds, x: ev.clientX, y: ev.clientY, mods };
        return; // not yet a drag — keep it clickable
      }
      active = true;
      const loc = zoneAtPoint(ev.clientX, ev.clientY).loc;
      // Valid only when over a row this card+mods can actually play onto.
      const valid = !!gestureOption(handOpts, ds.isMonster, loc, mods);
      const next: DragState = { ...ds, x: ev.clientX, y: ev.clientY, valid, mods, hint: dragHint(handOpts, ds.isMonster, mods) };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      const ds = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!ds || !active) return; // a click, not a drag → let the menu handle it
      suppressClickRef.current = true; // swallow the synthetic click after a real drag
      if (!prompt || prompt.kind !== "idle") return;
      const { loc, seq: dropSeq } = zoneAtPoint(ev.clientX, ev.clientY);
      const opts = prompt.options.filter((o) => o.loc === "hand" && o.seq === ds.seq);
      const opt = gestureOption(opts, ds.isMonster, loc, readMods(ev));
      if (!opt) return; // dropped on the wrong row, or that mode isn't available
      pendingPlaceRef.current = loc === "mzone" ? `m:${dropSeq}` : loc === "szone" ? `s:${dropSeq}` : "*";
      respond({ promptId: prompt.id, type: "option", id: opt.id });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    const t = e.target as HTMLElement;
    if (placing) return; // mid zone-pick: let the click place/cancel, no drag
    if (t.closest('[data-deck="local"]')) { beginPress(e); return; }
    if (!prompt || prompt.kind !== "idle") return;
    const handEl = t.closest('[data-loc="hand"]') as HTMLElement | null;
    if (!handEl) return;
    const seq = Number(handEl.dataset.seq);
    if (!actionable.has(`hand:${seq}`)) return; // no playable action on this card
    beginDrag(e, seq, handEl);
  };

  // Cancel a held long-press if the board unmounts mid-gesture.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelPress(), []);

  if (error) {
    return (
      <div className="duelboard">
        <div className="duelboard__bar">
          <button className="btn" onClick={onExit}>← Duel</button>
          <span className="editor__issues">⚠ {error}</span>
        </div>
      </div>
    );
  }
  if (!state) return <div className="duelboard"><div className="decklist__msg">Starting duel…</div></div>;

  const me = state.players[0];
  const opp = state.players[1];

  const dragCls = drag ? (drag.isMonster ? " is-drag-mon" : " is-drag-st") : "";

  return (
    <div className={`duelboard${dragCls}`} style={{ "--zone": `${zonePx}px` } as CSSProperties} onMouseOver={onHover} onClick={onBoardClick} onPointerDown={onPointerDown}>
      {menu && (
        <CardMenu
          menu={menu}
          nameOf={nameOf}
          onPick={(o) => {
            // Actions that drop a card into a zone (summon / set / spell-activate)
            // enter the pre-commit zone picker; everything else commits now.
            const kind = placementKind(o.id, o.code, cardsRef.current);
            if (kind) setPlacing({ promptId: menu.promptId, optionId: o.id, kind });
            else respond({ promptId: menu.promptId, type: "option", id: o.id });
            setMenu(null);
          }}
        />
      )}
      {drag && drag.code != null && (
        <div className="ddrag" style={{ left: drag.x, top: drag.y }}>
          <div className={`ddrag__card${drag.valid ? " is-valid" : ""}`}>
            <CardArt code={drag.code} alt="" />
          </div>
          <span className={`ddrag__hint${drag.valid ? " is-valid" : ""}`}>{drag.hint}</span>
        </div>
      )}
      {press && (
        <div className="dsurrender" style={{ left: press.x, top: press.y }}>
          <svg className="dsurrender__ring" viewBox="0 0 48 48" aria-hidden="true">
            <circle className="dsurrender__track" cx="24" cy="24" r="20" />
            <circle
              className="dsurrender__fill"
              cx="24" cy="24" r="20"
              strokeDasharray={2 * Math.PI * 20}
              strokeDashoffset={2 * Math.PI * 20 * (1 - press.k)}
            />
          </svg>
          <span className="dsurrender__label">Surrender</span>
        </div>
      )}
      <div className="duelboard__bar">
        <button className="btn" onClick={onExit}>← Duel</button>
        <span className="duelboard__turn">Turn {state.turn} · {state.turnPlayer === 0 ? "You" : "Opponent"}</span>
        <PhaseTrack phase={state.phase} />
        <div className="editor__spacer" />
        <button className={`btn duelboard__logbtn${logOpen ? " is-on" : ""}`} onClick={() => setLogOpen((o) => !o)} title="Toggle the duel log (L)">Duel Log</button>
        {unsupported.length > 0 && <span className="duelboard__warn" title={unsupported.join(", ")}>{unsupported.length} card(s) unsupported</span>}
        {prompt && (prompt.kind === "idle" || prompt.kind === "battle") &&
          prompt.options.filter((o) => o.loc == null).map((o) => (
            <button key={o.id} className="btn btn--primary" onClick={() => respond({ promptId: prompt.id, type: "option", id: o.id })}>
              {o.label}
            </button>
          ))}
      </div>

      {tips && (
        <div className="duel-tips">
          <span>Drag a card to play it · ⌘/Ctrl-drag = Special Summon · Space/Shift = chain Yes/No · G = Graveyard · B/M/E = phases · click GY/Banished/Extra to browse</span>
          <button className="duel-tips__x" onClick={() => { setTips(false); try { localStorage.setItem("duel_tips_seen", "1"); } catch { /* ignore */ } }}>✕</button>
        </div>
      )}
      <div className="duelboard__main">
        <CardViewer tile={preview ? { card: preview, imageId: preview.images[0] ?? preview.id } : null} />

        <div className="duelboard__play" ref={playRefCb}>
          <Hand cards={opp.hand} nameOf={nameOf} actionable={EMPTY_SET} opponent />

          <div className="duelboard__field">
            {banner && <div key={banner.id} className={`dbanner dbanner--${banner.tone}`}>{banner.text}</div>}
            <PlayerSide who="Opponent" p={opp} flip active={state.turnPlayer === 1} nameOf={nameOf} actionable={EMPTY_SET} targets={EMPTY_SET} />
            {format !== "genesys" && (
              <ExtraMonsterZones cards={[me.monsters[5] ?? null, me.monsters[6] ?? null]} actionable={actionable} targets={boardTargets} nameOf={nameOf} />
            )}
            <PlayerSide who="You" p={me} active={state.turnPlayer === 0} nameOf={nameOf} local actionable={actionable} targets={boardTargets} extraReady={extraSummon.size > 0} />
            {state.over && (
              <div className="dfield-over">
                <div className="dfield-over__box">
                  <div className="dfield-over__title">
                    {state.winner === 0 ? "🏆 You win!" : state.winner === 1 ? "Defeat." : "Duel over."}
                  </div>
                  {state.winReason && <div className="dfield-over__reason">{state.winReason}</div>}
                  <div className="dfield-over__actions">
                    {/* No rematch online — the host owns the duel lifecycle. */}
                    {!networked && (
                      <button className="btn btn--primary" onClick={() => { setState(null); setPrompt(null); setRematch((n) => n + 1); }}>Play again</button>
                    )}
                    <button className="btn" onClick={onExit}>{networked ? "← Leave" : "← Duel"}</button>
                  </div>
                </div>
              </div>
            )}
            {coin && <CoinToss key={coin.id} results={coin.results} />}
            {dice && <DiceRoll key={dice.id} results={dice.results} />}
          </div>

          <Hand cards={me.hand} nameOf={nameOf} actionable={actionable} />
        </div>
      </div>

      {extraOpen && (
        <ExtraDeckOverlay
          cards={me.extra}
          summonable={extraSummon}
          nameOf={nameOf}
          frameOf={(code) => cardsRef.current.get(code ?? -1)?.frameType}
          onHover={onHover}
          onClose={() => setExtraOpen(false)}
          onSummon={(options, x, y) => {
            if (!prompt) return;
            setExtraOpen(false);
            setMenu({ promptId: prompt.id, options, x, y });
          }}
        />
      )}
      {viewer && (
        <CardListOverlay title={viewer.title} cards={viewer.cards} nameOf={nameOf} onHover={onHover} onClose={() => setViewer(null)} />
      )}
      {logOpen && <DuelLog entries={toLogEntries(logRaw, nameOf, 0)} onClose={() => setLogOpen(false)} />}
      <PromptOverlay
        prompt={prompt}
        nameOf={nameOf}
        respond={respond}
        searchCards={(q) => {
          const ql = q.toLowerCase();
          const out: { code: number; name: string }[] = [];
          for (const c of cardsRef.current.values()) {
            if (c.name.toLowerCase().includes(ql)) { out.push({ code: c.id, name: c.name }); if (out.length >= 60) break; }
          }
          return out;
        }}
      />
    </div>
  );
}

/**
 * The 2 shared Extra Monster Zones, between the two players' monster rows. They
 * align with the 2nd and 4th Main Monster Zones — so this is a full 9-column row
 * matching the board's `[spacer, field, M1–M5, grave, banish]` layout, with the
 * EMZ at column indices 3 (under M2) and 5 (under M4) and spacers elsewhere.
 */
function ExtraMonsterZones({ cards, actionable, targets, nameOf }: { cards: (DuelCard | null)[]; actionable: Set<string>; targets: Set<string>; nameOf: (c: number | null | undefined) => string }): JSX.Element {
  // column index → which EMZ slot (0 → seq 5, 1 → seq 6)
  const emzAtCol: Record<number, number> = { 3: 0, 5: 1 };
  return (
    <div className="duelboard__row duelboard__emz">
      {Array.from({ length: 9 }, (_, col) => {
        const slot = emzAtCol[col];
        if (slot === undefined) return <div key={col} className="dzone-spacer" aria-hidden="true" />;
        const c = cards[slot] ?? null;
        const seq = 5 + slot;
        const act = actionable.has(`mzone:${seq}`);
        const target = targets.has(`mzone:${seq}`);
        return (
          <div
            key={col}
            className={`dzone dzone--mon${act ? " is-actionable" : ""}${target ? " is-target" : ""}`}
            title={c ? nameOf(c.code) : "Extra Monster Zone"}
            data-code={c?.code ?? undefined}
            data-loc="mzone"
            data-seq={seq}
          >
            <CardSlot card={c} kind="mon" />
          </div>
        );
      })}
    </div>
  );
}

/** The duel log: a right-side panel of human-readable event lines (newest at the
 *  bottom; auto-scrolls). Built from the redacted event stream, so it never shows
 *  the opponent's drawn cards or face-down Set card identities. */
function DuelLog({ entries, onClose }: { entries: { id: number; text: string }[]; onClose: () => void }): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  return (
    <div className="duel-log">
      <div className="duel-log__head">
        <span>Duel Log</span>
        <button className="duel-log__x" onClick={onClose} title="Close (L / Esc)">✕</button>
      </div>
      <div className="duel-log__body" ref={bodyRef}>
        {entries.length === 0 ? (
          <div className="duel-log__empty">No actions yet.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className={`duel-log__line${e.text.startsWith("—") ? " is-turn" : ""}`}>{e.text}</div>
          ))
        )}
      </div>
    </div>
  );
}

/** Read-only browser for a public pile (Graveyard / Banished, either player).
 *  Hover previews each card in the side viewer; click outside or Close to dismiss. */
function CardListOverlay({ title, cards, nameOf, onHover, onClose }: {
  title: string;
  cards: DuelCard[];
  nameOf: (c: number | null | undefined) => string;
  onHover: (e: ReactMouseEvent) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="dprompt-overlay dprompt" onClick={onClose} onMouseOver={onHover}>
      <div className="dprompt__title">{title} ({cards.length})</div>
      <div className="dprompt__cards">
        {cards.length === 0 && <span className="dhand__empty">— empty —</span>}
        {cards.map((c, i) => (
          <button key={i} className="dprompt__card" data-code={c.code ?? undefined} title={nameOf(c.code)} onClick={(e) => e.stopPropagation()}>
            <CardArt code={c.code} alt={nameOf(c.code)} />
          </button>
        ))}
      </div>
      <div className="dprompt__actions">
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/** Name the summon by the card's frame, so the action reads "Synchro Summon"
 *  rather than a generic "Special Summon". Fusion/Synchro/Xyz/Link take priority
 *  over the Pendulum variant (e.g. a Synchro Pendulum is a Synchro Summon). */
function summonVerb(frameType: string | undefined): string {
  const f = (frameType ?? "").toLowerCase();
  if (f.includes("fusion")) return "Fusion Summon";
  if (f.includes("synchro")) return "Synchro Summon";
  if (f.includes("xyz")) return "Xyz Summon";
  if (f.includes("link")) return "Link Summon";
  if (f.includes("pendulum")) return "Pendulum Summon";
  return "Special Summon";
}

/**
 * Browse the local Extra Deck (face-up to its owner). Click the pile to open.
 * When the Main-Phase prompt offers a summon for a card here (materials are on
 * the field / requirements met), that card glows and is tagged with its summon
 * type — clicking it opens the action menu to summon it, mirroring hand cards.
 */
function ExtraDeckOverlay({ cards, summonable, nameOf, frameOf, onHover, onClose, onSummon }: {
  cards: DuelCard[];
  summonable: Map<number, DuelOption[]>;
  nameOf: (c: number | null | undefined) => string;
  frameOf: (c: number | null | undefined) => string | undefined;
  onHover: (e: ReactMouseEvent) => void;
  onClose: () => void;
  onSummon: (options: DuelOption[], x: number, y: number) => void;
}): JSX.Element {
  const anySummon = cards.some((c) => c.code != null && summonable.has(c.code));
  return (
    <div className="dprompt-overlay dprompt" onClick={onClose} onMouseOver={onHover}>
      <div className="dprompt__title">
        Extra Deck ({cards.length})
        {anySummon && <span className="dprompt__hint">  ·  click a glowing card to summon</span>}
      </div>
      <div className="dprompt__cards">
        {cards.length === 0 && <span className="dhand__empty">— empty —</span>}
        {cards.map((c, i) => {
          const opts = c.code != null ? summonable.get(c.code) : undefined;
          const canSummon = !!opts && opts.length > 0;
          const verb = canSummon ? summonVerb(frameOf(c.code)) : "";
          return (
            <button
              key={i}
              className={`dprompt__card${canSummon ? " is-summonable" : ""}`}
              data-code={c.code ?? undefined}
              title={canSummon ? `${nameOf(c.code)} — ${verb}` : nameOf(c.code)}
              onClick={(e) => {
                e.stopPropagation();
                if (!canSummon || !opts) return;
                // Relabel a lone option with its summon type; keep originals when
                // a card offers more than one distinct summon.
                const first = opts[0];
                const display = opts.length === 1 && first ? [{ ...first, label: verb }] : opts;
                onSummon(display, e.clientX, e.clientY);
              }}
            >
              <CardArt code={c.code} alt={nameOf(c.code)} />
              {canSummon && <span className="dprompt__cardtag">{verb}</span>}
            </button>
          );
        })}
      </div>
      <div className="dprompt__actions">
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function PhaseTrack({ phase }: { phase: DuelPhase }): JSX.Element {
  return (
    <div className="dphase">
      {PHASES.map((p) => (
        <span key={p.key} className={`dphase__step${phase === p.key ? " is-active" : ""}`}>{p.label}</span>
      ))}
    </div>
  );
}

function PlayerSide({ who, p, flip, active, local = false, actionable, targets, nameOf, extraReady = false }: { who: string; p: DuelState["players"][number]; flip?: boolean; active?: boolean; local?: boolean; actionable: Set<string>; targets: Set<string>; nameOf: (c: number | null | undefined) => string; extraReady?: boolean }): JSX.Element {
  // Monster row: Field Spell (left), 5 monsters, Banished, then Graveyard as the
  // outermost flank. Spell/trap row: Extra Deck (left), 5 S/T, Deck, spacer.
  // The opponent's side is a true 180° flip: rows in reverse order (S/T on the
  // back) AND mirrored left-right (row-reverse), so their Graveyard lines up
  // over our Field Spell zone.
  const rowCls = `duelboard__row${flip ? " duelboard__row--rev" : ""}`;
  const owner = local ? 0 : 1; // which player's public piles these are
  // 9 columns: a leading spacer (col 0), the 7 main columns, then Banished (col 8,
  // right of the Graveyard). The opponent's rows are row-reversed, so their
  // Banished ends up on the left and their Graveyard lines up over our Field.
  const monsterRow = (
    <div className={rowCls}>
      <div className="dzone-spacer" aria-hidden="true" />
      <FieldZone card={p.field} nameOf={nameOf} local={local} actionable={actionable} />
      <ZoneCells kind="mon" cards={p.monsters.slice(0, 5)} nameOf={nameOf} local={local} actionable={actionable} targets={targets} />
      <Pile kind="grave" label="Graveyard" count={p.graveCount} faceCode={p.graveTop} owner={owner} />
      <Pile kind="banish" label="Banished Zone" count={p.banishCount} owner={owner} />
    </div>
  );
  const spellRow = (
    <div className={rowCls}>
      <div className="dzone-spacer" aria-hidden="true" />
      <Pile kind="extra" label="Extra Deck" count={p.extraCount} extraLocal={local} summonReady={local && extraReady} />
      <ZoneCells kind="st" cards={p.spells} nameOf={nameOf} local={local} actionable={actionable} targets={targets} />
      <Pile kind="deck" label="Deck" count={p.deckCount} deckLocal={local} />
      <div className="dzone-spacer" aria-hidden="true" />
    </div>
  );
  const header = (
    <header className="duelboard__sidehead">
      <span className="duelboard__who">{who}</span>
      <AnimatedLP value={p.lp} />
    </header>
  );
  // Opponent's header sits on top; the local player's header sits at the bottom
  // (near their hand). This keeps the two monster rows meeting directly in the
  // middle with no info bar wedged between the fields.
  return (
    <section className={`duelboard__side${active ? " is-active" : ""}`}>
      {flip ? (<>{header}{spellRow}{monsterRow}</>) : (<>{monsterRow}{spellRow}{header}</>)}
    </section>
  );
}

function ZoneCells({ kind, cards, local, actionable, targets, nameOf }: { kind: "mon" | "st"; cards: (DuelCard | null)[]; local?: boolean; actionable: Set<string>; targets: Set<string>; nameOf: (c: number | null | undefined) => string }): JSX.Element {
  const loc = kind === "mon" ? "mzone" : "szone";
  return (
    <>
      {cards.map((c, i) => {
        const act = local && actionable.has(`${loc}:${i}`);
        const target = local && targets.has(`${loc}:${i}`);
        return (
          <div
            key={i}
            className={`dzone dzone--${kind}${act ? " is-actionable" : ""}${target ? " is-target" : ""}`}
            title={c ? nameOf(c.code) : ""}
            data-code={c?.code ?? undefined}
            data-loc={local ? loc : undefined}
            data-seq={local ? i : undefined}
          >
            <CardSlot card={c} kind={kind} />
          </div>
        );
      })}
    </>
  );
}

function FieldZone({ card, local, actionable, nameOf }: { card: DuelCard | null; local?: boolean; actionable: Set<string>; nameOf: (c: number | null | undefined) => string }): JSX.Element {
  const act = local && actionable.has("fzone:0");
  return (
    <div
      className={`dzone dzone--fieldz${act ? " is-actionable" : ""}`}
      title={card ? nameOf(card.code) : "Field Spell"}
      data-code={card?.code ?? undefined}
      data-loc={local ? "fzone" : undefined}
      data-seq={local ? 0 : undefined}
    >
      <CardSlot card={card} kind="field" />
    </div>
  );
}

/** A face-down pile (deck / extra / graveyard / banished). Deck & Extra hide
 *  their count; Graveyard & Banished still show theirs. */
function Pile({ kind, label, count, deckLocal, extraLocal, faceCode, summonReady, owner }: { kind: string; label: string; count: number; deckLocal?: boolean; extraLocal?: boolean; faceCode?: number | null; summonReady?: boolean; owner?: number }): JSX.Element {
  // The graveyard shows its top card face-up and hides its count; the other
  // piles show a face-down card back (deck/extra also hide their count).
  const showCount = count > 0 && kind !== "deck" && kind !== "extra" && kind !== "grave";
  // GY / banished (either player) are public — click to browse when non-empty.
  const viewable = (kind === "grave" || kind === "banish") && count > 0 && owner != null;
  const title =
    kind === "deck" && deckLocal ? `${label}: ${count} — hold to surrender`
    : kind === "extra" && extraLocal ? `${label}: ${count} — click to ${summonReady ? "summon / view" : "view"}`
    : viewable ? `${label}: ${count} — click to view`
    : `${label}: ${count}`;
  return (
    <div
      className={`dzone dzone--pile dzone--${kind}${(kind === "extra" && extraLocal) || viewable ? " is-browsable" : ""}${summonReady ? " is-summon-ready" : ""}`}
      title={title}
      data-deck={kind === "deck" && deckLocal ? "local" : undefined}
      data-extra={kind === "extra" && extraLocal ? "local" : undefined}
      data-pile={viewable ? kind : undefined}
      data-owner={viewable ? owner : undefined}
    >
      <div className={`dslot dslot--${kind}`}>
        {faceCode != null
          ? <CardArt code={faceCode} alt={label} />
          : count > 0 && <img className="dcard__art" src={cardBack} alt={label} />}
        {showCount && <span className="dslot__count">{count}</span>}
      </div>
    </div>
  );
}

/**
 * The card-shaped (portrait) dashed slot that lives inside a square zone. A
 * card laid in defense/set rotates 90° and still fits inside the square — so
 * the card art is never cropped.
 */
function CardSlot({ card, kind }: { card: DuelCard | null; kind?: string }): JSX.Element {
  // The dashed slot outline is ALWAYS rendered — an occupied card sits inside the
  // frame rather than replacing it, so the dashed zone outline stays visible even
  // when a monster is set/summoned. Only monsters lie horizontal (defense /
  // face-down defense); the card rotates while the dashed frame stays portrait.
  const rot = card != null && kind === "mon" && (card.position === "def" || card.position === "set");
  return (
    <div className={`dslot${kind ? ` dslot--${kind}` : ""}`}>
      {card && (
        <div className={`dcard${rot ? " dcard--rot" : ""}`}>
          <CardArt code={card.faceUp ? card.code : null} alt="" />
          {card.faceUp && card.atk != null && (
            <span className="dcard__stats">{card.atk}/{card.def ?? "—"}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Hand({ cards, actionable, nameOf, opponent = false }: { cards: DuelCard[]; actionable: Set<string>; nameOf: (c: number | null | undefined) => string; opponent?: boolean }): JSX.Element {
  const n = cards.length;
  const center = (n - 1) / 2;
  const step = n > 1 ? Math.min(8, 42 / (n - 1)) : 0; // degrees between adjacent cards
  return (
    <div className={`dhand${opponent ? " dhand--opp" : ""}`}>
      {n === 0 && <span className="dhand__empty">— empty hand —</span>}
      {cards.map((c, i) => {
        const act = !opponent && actionable.has(`hand:${i}`);
        const rot = (i - center) * step;
        return (
          <div
            key={i}
            className={`dhand__slot${act ? " is-actionable" : ""}`}
            style={{ "--rot": `${rot}deg` } as CSSProperties}
            title={nameOf(c.code)}
            data-code={c.code ?? undefined}
            // The opponent hand is view-only: no hand drop/drag target attrs.
            data-loc={opponent ? undefined : "hand"}
            data-seq={opponent ? undefined : i}
          >
            <div className="dhand__card">
              <CardArt code={c.code} alt={nameOf(c.code)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Popup of a clicked card's available actions (idle / battle). */
function CardMenu({
  menu, nameOf, onPick,
}: {
  menu: { promptId: number; options: DuelOption[]; x: number; y: number };
  nameOf: (c: number | null | undefined) => string;
  onPick: (o: DuelOption) => void;
}): JSX.Element {
  const W = 168;
  const left = menu.x + W > window.innerWidth ? Math.max(8, menu.x - W) : menu.x;
  const top = Math.min(menu.y, Math.max(8, window.innerHeight - 40 - menu.options.length * 34));
  return (
    <div className="dmenu" style={{ left, top, width: W }} onClick={(e) => e.stopPropagation()}>
      {menu.options.map((o) => (
        <button key={o.id} className="dmenu__item" onClick={() => onPick(o)}>
          {o.label}
          {o.code ? <em className="dmenu__name">{nameOf(o.code)}</em> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Floating overlay for the occasional sub-prompts (select target / position /
 * chain / yes-no / option) and the game-over message. Idle/Battle global actions
 * live in the top bar; summon placement is done by clicking a board zone — so
 * this renders nothing for those (no persistent bottom panel).
 */
function PromptOverlay({
  prompt, nameOf, respond, searchCards,
}: {
  prompt: DuelPrompt | null;
  nameOf: (c: number | null | undefined) => string;
  respond: (r: DuelResponse) => void;
  searchCards: (q: string) => { code: number; name: string }[];
}): JSX.Element | null {
  const [sel, setSel] = useState<string[]>([]);
  const [counts, setCounts] = useState<number[]>([]); // per-card counter picker
  const [announceText, setAnnounceText] = useState(""); // announce-card name search
  const promptId = prompt?.id ?? -1;
  useEffect(() => { setSel([]); setCounts([]); setAnnounceText(""); }, [promptId]);

  // Response timer for quick-effect windows (chain / yes-no / activate-effect).
  // On expiry it auto-declines (the "No"/"No Response" choice — same as the Shift
  // keybind in DuelBoard), so the duel never stalls on a response window.
  const isResponse = prompt != null && (prompt.kind === "selectChain" || prompt.kind === "yesno" || prompt.kind === "effectyn");
  const [secsLeft, setSecsLeft] = useState(RESPONSE_SECS);
  useEffect(() => {
    if (!isResponse || !prompt) return;
    setSecsLeft(RESPONSE_SECS);
    const start = performance.now();
    const tick = setInterval(() => {
      const left = RESPONSE_SECS - (performance.now() - start) / 1000;
      if (left <= 0) {
        clearInterval(tick);
        setSecsLeft(0);
        const decline = prompt.options.find((o) => o.id === "no" || o.id === "pass")?.id ?? prompt.options[0]?.id;
        if (decline != null) respond({ promptId: prompt.id, type: "option", id: decline });
        else respond({ promptId: prompt.id, type: "cancel" });
      } else {
        setSecsLeft(left);
      }
    }, 100);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId, isResponse]);

  // The game-over result is rendered on the duel field itself (see DuelBoard),
  // so it stays centered on the field rather than the whole window.
  // Nothing floating for idle / battle (top bar) or placement (board click).
  if (!prompt || prompt.kind === "idle" || prompt.kind === "battle" || prompt.kind === "selectPlace") return null;

  if (prompt.kind === "selectCard") {
    const cards = prompt.cards ?? [];
    const min = prompt.min ?? 1;
    const max = prompt.max ?? 1;
    const toggle = (ref: string) =>
      setSel((cur) => (cur.includes(ref) ? cur.filter((x) => x !== ref) : cur.length < max ? [...cur, ref] : cur));
    const ok = sel.length >= min && sel.length <= max;
    return (
      <div className="dprompt-overlay dprompt">
        <div className="dprompt__title">{prompt.title}</div>
        <div className="dprompt__cards">
          {cards.map((c: PromptCard) => (
            <button
              key={c.ref}
              className={`dprompt__card${sel.includes(c.ref) ? " is-sel" : ""}`}
              onClick={() => toggle(c.ref)}
              title={`${nameOf(c.code)} (${c.location})`}
            >
              <CardArt code={c.code} alt={nameOf(c.code)} />
            </button>
          ))}
        </div>
        <div className="dprompt__actions">
          <button className="btn btn--primary" disabled={!ok} onClick={() => respond({ promptId: prompt.id, type: "cards", refs: sel })}>
            Confirm ({sel.length}/{min === max ? min : `${min}–${max}`})
          </button>
          {prompt.cancelable && (
            <button className="btn" onClick={() => respond({ promptId: prompt.id, type: "cancel" })}>Cancel</button>
          )}
        </div>
      </div>
    );
  }

  // Synchro/Xyz/Link materials: pick one card at a time (the core re-prompts
  // after each pick). Already-chosen cards (ref "u:") show highlighted and can
  // be clicked again to take them back.
  if (prompt.kind === "selectUnselect") {
    const cards = prompt.cards ?? [];
    const finish = prompt.options.find((o) => o.id === "__finish");
    return (
      <div className="dprompt-overlay dprompt">
        <div className="dprompt__title">{prompt.title}</div>
        <div className="dprompt__cards">
          {cards.map((c: PromptCard) => (
            <button
              key={c.ref}
              className={`dprompt__card${c.ref.startsWith("u:") ? " is-sel" : ""}`}
              onClick={() => respond({ promptId: prompt.id, type: "cards", refs: [c.ref] })}
              title={`${nameOf(c.code)} (${c.location})`}
            >
              <CardArt code={c.code} alt={nameOf(c.code)} />
            </button>
          ))}
        </div>
        <div className="dprompt__actions">
          {finish && (
            <button className="btn btn--primary" onClick={() => respond({ promptId: prompt.id, type: "option", id: finish.id })}>
              Finish
            </button>
          )}
          {prompt.cancelable && (
            <button className="btn" onClick={() => respond({ promptId: prompt.id, type: "cancel" })}>Cancel</button>
          )}
        </div>
      </div>
    );
  }

  // Declare a Type / Attribute / Number — pick from the option buttons.
  if (prompt.kind === "announce") {
    const min = prompt.min ?? 1;
    const max = prompt.max ?? 1;
    const toggle = (id: string) =>
      setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < max ? [...cur, id] : cur));
    const ok = sel.length >= min && sel.length <= max;
    return (
      <div className="dprompt-overlay dprompt">
        <div className="dprompt__title">{prompt.title}</div>
        <div className="dprompt__opts">
          {prompt.options.map((o) => (
            <button key={o.id} className={`dprompt__opt${sel.includes(o.id) ? " is-sel" : ""}`} onClick={() => toggle(o.id)}>
              <span className="dprompt__optlabel">{o.label}</span>
            </button>
          ))}
        </div>
        <div className="dprompt__actions">
          <button className="btn btn--primary" disabled={!ok} onClick={() => respond({ promptId: prompt.id, type: "cards", refs: sel })}>
            Confirm ({sel.length}/{min === max ? min : `${min}–${max}`})
          </button>
        </div>
      </div>
    );
  }

  // Remove N counters across the listed cards (per-card steppers).
  if (prompt.kind === "selectCounter") {
    const cards = prompt.cards ?? [];
    const total = prompt.min ?? 0;
    const sum = cards.reduce((a, _c, i) => a + (counts[i] ?? 0), 0);
    const setAt = (i: number, v: number) =>
      setCounts((cur) => cards.map((c, j) => (j === i ? Math.max(0, Math.min(c.max ?? 0, v)) : cur[j] ?? 0)));
    return (
      <div className="dprompt-overlay dprompt">
        <div className="dprompt__title">{prompt.title} — {sum}/{total}</div>
        <div className="dprompt__cards">
          {cards.map((c: PromptCard, i) => (
            <div key={c.ref} className="dcounter" title={`${nameOf(c.code)} (${c.location})`}>
              <CardArt code={c.code} alt={nameOf(c.code)} />
              <div className="dcounter__step">
                <button className="btn" onClick={() => setAt(i, (counts[i] ?? 0) - 1)}>−</button>
                <span>{counts[i] ?? 0}/{c.max ?? 0}</span>
                <button className="btn" onClick={() => setAt(i, (counts[i] ?? 0) + 1)}>+</button>
              </div>
            </div>
          ))}
        </div>
        <div className="dprompt__actions">
          <button className="btn btn--primary" disabled={sum !== total} onClick={() => respond({ promptId: prompt.id, type: "counters", counts: cards.map((_c, i) => counts[i] ?? 0) })}>
            Remove
          </button>
        </div>
      </div>
    );
  }

  // Declare a card by name — type to search, click the card to declare it.
  if (prompt.kind === "announceCard") {
    const matches = announceText.trim().length >= 2 ? searchCards(announceText.trim()).slice(0, 24) : [];
    return (
      <div className="dprompt-overlay dprompt">
        <div className="dprompt__title">{prompt.title}</div>
        <input
          className="cards__input dprompt__search"
          autoFocus
          placeholder="Type a card name…"
          value={announceText}
          onChange={(e) => setAnnounceText(e.target.value)}
        />
        <div className="dprompt__cards">
          {matches.length === 0 && <span className="dhand__empty">{announceText.trim().length < 2 ? "Type at least 2 letters" : "No matches"}</span>}
          {matches.map((mc) => (
            <button key={mc.code} className="dprompt__card" data-code={mc.code} title={mc.name} onClick={() => respond({ promptId: prompt.id, type: "option", id: String(mc.code) })}>
              <CardArt code={mc.code} alt={mc.name} />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // position / chain / yes-no / option / effectyn
  return (
    <div className="dprompt-overlay dprompt">
      <div className="dprompt__title">
        {prompt.title}
        {isResponse && (
          <span className="dprompt__timer"> · {Math.ceil(secsLeft)}s</span>
        )}
      </div>
      {isResponse && (
        <div className="dprompt__timerbar">
          {/* Continuous CSS animation (keyed to the prompt so it restarts each
              time) — smooth, instead of stepping with the JS interval. */}
          <div
            key={promptId}
            className="dprompt__timerbar-fill"
            style={{ "--dur": `${RESPONSE_SECS}s` } as CSSProperties}
          />
        </div>
      )}
      <div className="dprompt__opts">
        {isResponse ? (
          // A response window is just Yes / No — don't reveal which card/effect
          // is on offer. Yes = activate / chain the available option; No = decline.
          [
            { id: prompt.options.find((o) => o.id === "yes" || o.id.startsWith("chain:"))?.id, label: "Yes" },
            { id: prompt.options.find((o) => o.id === "no" || o.id === "pass")?.id, label: "No" },
          ].map((b) => b.id == null ? null : (
            <button key={b.label} className="dprompt__opt" onClick={() => respond({ promptId: prompt.id, type: "option", id: b.id! })}>
              <span className="dprompt__optlabel">{b.label}</span>
            </button>
          ))
        ) : (
          prompt.options.map((o) => (
            <button
              key={o.id}
              className="dprompt__opt"
              onClick={() => respond({ promptId: prompt.id, type: "option", id: o.id })}
              title={o.code ? nameOf(o.code) : o.label}
            >
              {o.code ? (
                <span className="dprompt__optcard"><CardArt code={o.code} alt="" /></span>
              ) : null}
              <span className="dprompt__optlabel">
                {o.label}
                {o.code ? <em className="dprompt__optname">{nameOf(o.code)}</em> : null}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** A centered coin-flip animation. Each coin spins on the X axis and lands on
 *  its real result (1 = Heads, 0 = Tails); the result label fades in after. */
function CoinToss({ results }: { results: number[] }): JSX.Element {
  return (
    <div className="dcoins" aria-hidden="true">
      {results.map((r, i) => (
        <div className="dcoin-wrap" key={i}>
          <div className="dcoin">
            <div className="dcoin__inner" style={{ "--end": `${1800 + (r ? 0 : 180)}deg`, animationDelay: `${i * 130}ms` } as CSSProperties}>
              <div className="dcoin__face dcoin__face--f" />
              <div className="dcoin__face dcoin__face--b" />
            </div>
          </div>
          <span className="dcoin__label" style={{ animationDelay: `${i * 130 + 950}ms` } as CSSProperties}>{r ? "Heads" : "Tails"}</span>
        </div>
      ))}
    </div>
  );
}

/** Pip layout (3×3 grid cells, 0–8) for each die value. */
const DICE_PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
/** Cube rotation (deg) that brings each value's face to the front. */
const DICE_SHOW: Record<number, [number, number]> = {
  1: [0, 0],
  2: [-90, 0],
  3: [0, -90],
  4: [0, 90],
  5: [90, 0],
  6: [0, 180],
};

/** A centered 3D dice-roll animation. Each cube tumbles and lands on its real
 *  result (1–6); the result number fades in after. */
function DiceRoll({ results }: { results: number[] }): JSX.Element {
  return (
    <div className="ddice" aria-hidden="true">
      {results.map((r, i) => {
        const [rx, ry] = DICE_SHOW[r] ?? [0, 0];
        return (
          <div className="ddie-wrap" key={i}>
            <div className="ddie">
              <div
                className="ddie__inner"
                style={{ "--rx": `${1080 + rx}deg`, "--ry": `${1440 + ry}deg`, animationDelay: `${i * 130}ms` } as CSSProperties}
              >
                {[1, 2, 3, 4, 5, 6].map((v) => (
                  <div className={`ddie__face ddie__face--${v}`} key={v}>
                    {Array.from({ length: 9 }, (_, c) => (
                      <span className={(DICE_PIPS[v] ?? []).includes(c) ? "ddie__pip is-on" : "ddie__pip"} key={c} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <span className="ddie__label" style={{ animationDelay: `${i * 130 + 950}ms` } as CSSProperties}>{r}</span>
          </div>
        );
      })}
    </div>
  );
}

function CardArt({ code, alt, cls = "dcard__art" }: { code: number | null | undefined; alt: string; cls?: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [code]);
  if (code == null || failed || !window.duel?.cards) {
    return <img className={cls} src={cardBack} alt={alt || "card"} loading="lazy" />;
  }
  return (
    <img
      className={cls}
      src={window.duel.cards.imageUrl(code)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** Life points that count toward the target and flash on change. */
function AnimatedLP({ value }: { value: number }): JSX.Element {
  const [disp, setDisp] = useState(value);
  const [flash, setFlash] = useState<"" | "down" | "up">("");
  const prev = useRef(value);
  useEffect(() => {
    if (value === prev.current) return;
    const from = prev.current;
    prev.current = value;
    setFlash(value < from ? "down" : "up");
    const start = performance.now();
    const dur = 450;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      setDisp(Math.round(from + (value - from) * k));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const ft = setTimeout(() => setFlash(""), 650);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(ft);
    };
  }, [value]);
  return <span className={`dlp${flash ? ` dlp--${flash}` : ""}`}>LP {disp}</span>;
}

/** Pick the most salient event in a batch to flash as an announcer banner. */
function bannerFromEvents(events: import("@duel/shared").DuelEvent[]): { text: string; tone: string } | null {
  const win = events.find((e) => e.kind === "win");
  if (win && win.kind === "win") return { text: win.player === 0 ? "You Win!" : "Defeat", tone: win.player === 0 ? "win" : "lose" };
  const atk = events.find((e) => e.kind === "attack");
  if (atk && atk.kind === "attack") return { text: atk.target == null ? "Direct Attack!" : "Attack!", tone: "atk" };
  const turn = events.find((e) => e.kind === "turn");
  if (turn && turn.kind === "turn") return { text: `Turn ${turn.turn} — ${turn.player === 0 ? "Your Move" : "Opponent"}`, tone: "turn" };
  return null;
}

