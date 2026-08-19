import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CardData, DuelCard, DuelDifficulty, DuelEvent, DuelFormat, DuelOption, DuelPhase, DuelPrompt, DuelResponse, DuelState, DuelUpdate, PromptCard } from "@duel/shared";
import cardBack from "../../../../ui/assets/sleeves/original_card_sleeve.png";
import { toLogEntries } from "../cards/duel-log.ts";
import { CardViewer } from "./CardViewer.tsx";
import { useSettings } from "../settings.ts";
import { useTabActive } from "../tab-active.ts";
import { cardTilt } from "../card-tilt.ts";

const EMPTY_SET: Set<string> = new Set();

const RESPONSE_SECS = 5;

const PHASES: { key: DuelPhase; label: string }[] = [
  { key: "draw", label: "DP" },
  { key: "standby", label: "SP" },
  { key: "main1", label: "M1" },
  { key: "battle", label: "BP" },
  { key: "main2", label: "M2" },
  { key: "end", label: "EP" },
];

type Mods = { shift: boolean; meta: boolean; ctrl: boolean };
type DragState = { seq: number; code: number | null; isMonster: boolean; x: number; y: number; valid: boolean; mods: Mods; hint: string; overKey: string | null; fit: { scale: number; tilt: number; ox: number } | null };

const readMods = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): Mods =>
  ({ shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey });

function zoneAtPoint(x: number, y: number): { loc: string | undefined; seq: number; zone: HTMLElement | null } {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const z = el?.closest("[data-loc]") as HTMLElement | null;
  return { loc: z?.dataset.loc, seq: z ? Number(z.dataset.seq) : NaN, zone: z };
}

/** How the drag ghost should sit when the cursor is over the playfield: matched
 *  to the local card size AND leaned back into the board's perspective, so it
 *  reads as a card lying on the mat rather than a flat card that merely shrank.
 *
 *  Returns null when the cursor is not over the mat — the ghost then stays flat,
 *  the way a card held in front of you looks. Applies over the WHOLE field, not
 *  just legal drop zones: the tilt is about where the card is in space, which has
 *  nothing to do with whether the drop is allowed.
 *
 *  `scale` matches the ghost's width to a field card at that depth; the height
 *  foreshortening and the trapezoidal lean both come from rotateX(tilt) in CSS,
 *  exactly as they do for the real zones. The nearest zone supplies the local
 *  size so the ghost tracks near/far depth as it moves up and down the board;
 *  offsetWidth is used for the card:zone ratio so a Set rotation can't skew it. */
function fieldFit(x: number, y: number, tiltDeg: number): { scale: number; tilt: number; ox: number } | null {
  const mat = document.querySelector<HTMLElement>(".dfield__mat");
  const handSlot = document.querySelector<HTMLElement>(".dhandrow .dhand__slot");
  if (!mat || !handSlot) return null;
  const m = mat.getBoundingClientRect();
  if (x < m.left || x > m.right || y < m.top || y > m.bottom) return null;
  const hand = handSlot.getBoundingClientRect();
  if (!hand.width) return null;
  const zones = Array.from(document.querySelectorAll<HTMLElement>(".dzone--mon, .dzone--st, .dzone--fieldz"));
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const z of zones) {
    const r = z.getBoundingClientRect();
    const d = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
    if (d < bestD) { bestD = d; best = z; }
  }
  const slot = best?.querySelector<HTMLElement>(".dslot");
  if (!best || !slot || !best.offsetWidth) return null;
  const r = best.getBoundingClientRect();
  const cardW = r.width * (slot.offsetWidth / best.offsetWidth);
  // Horizontal parallax. The board's vanishing point is at the field's centre,
  // so a card off to one side is sheared toward it — its far (top) edge pulled
  // in more than its near (bottom) edge, exactly as the real zones are. Feeding
  // that horizontal offset into the ghost's perspective-origin reproduces the
  // shear (not a rotateY, which would instead make one vertical edge taller —
  // the board does no such thing). Zero dead centre, growing toward the edges,
  // flipping across the middle. The ghost rides the cursor, so cursor x is its
  // centre.
  const field = document.querySelector<HTMLElement>(".duelboard__field");
  const fr = field?.getBoundingClientRect();
  const ox = fr ? fr.left + fr.width / 2 - x : 0;
  return { scale: cardW / hand.width, tilt: tiltDeg, ox };
}

function gestureOption(opts: DuelOption[], isMonster: boolean, dropLoc: string | undefined, mods: Mods): DuelOption | undefined {
  const find = (prefix: string) => opts.find((o) => o.id.startsWith(prefix + ":"));
  if (isMonster) {
    if (dropLoc !== "mzone") return undefined;
    if (mods.shift) return find("mset");
    if (mods.meta || mods.ctrl) return find("spsummon");
    return find("summon") ?? find("spsummon");
  }
  if (dropLoc !== "szone" && dropLoc !== "fzone") return undefined;
  if (mods.shift) return find("sset");
  return find("activate");
}

function dragHint(handOpts: DuelOption[], isMonster: boolean, mods: Mods): string {
  const has = (prefix: string) => handOpts.some((o) => o.id.startsWith(prefix + ":"));
  if (isMonster) {
    if (mods.shift) return "Set";
    if (mods.meta || mods.ctrl) return "Special Summon";
    return has("summon") ? "Normal Summon" : has("spsummon") ? "Special Summon" : "Normal Summon";
  }
  return mods.shift ? "Set" : "Activate";
}

function placementKind(optionId: string, code: number | null | undefined, cards: Map<number, CardData>): "monster" | "spell" | null {
  const k = optionId.split(":")[0];
  if (k === "summon" || k === "mset") return "monster";
  const card = code != null ? cards.get(code) : undefined;
  if (k === "sset") return /Field/i.test(card?.race ?? "") ? null : "spell";
  if (k === "activate") {
    if (!/Spell|Trap/i.test(card?.type ?? "")) return null;
    if (/Field/i.test(card?.race ?? "")) return null;
    return "spell";
  }
  return null;
}

export function DuelBoard({ deckId, format = "advanced", seed, opponent = "goldfish", difficulty = "normal", aiDeckId, networked = false, onExit }: { deckId: string; format?: DuelFormat; seed?: string | undefined; opponent?: "goldfish" | "ai" | undefined; difficulty?: DuelDifficulty | undefined; aiDeckId?: string | undefined; networked?: boolean; onExit: () => void }): JSX.Element {
  const [rematch, setRematch] = useState(0);
  const [state, setState] = useState<DuelState | null>(null);
  const [prompt, setPrompt] = useState<DuelPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<number[]>([]);
  const [banner, setBanner] = useState<{ id: number; text: string; tone: string } | null>(null);
  const bannerSeq = useRef(0);
  const [preview, setPreview] = useState<CardData | null>(null);
  // When set, the hand area shows this pile instead of your hand — same layout
  // and the same Hand component, just not draggable.
  const [browse, setBrowse] = useState<
    {
      title: string;
      cards: DuelCard[];
      from: string;
      handSide: "left" | "right";
      /** The pile these cards came out of, so its zone can read as empty while
       *  you are holding them. It refills exactly as they land back. */
      pile: { kind: "grave" | "banish" | "extra" | "deck"; owner: 0 | 1 };
      extra?: boolean;
    } | null
  >(null);
  /**
   * Which way your hand slides to get out of the way: away from the pile being
   * opened. The extra deck sits left of the field, so the hand goes right; the
   * graveyard sits right, so it goes left. Measured rather than hardcoded,
   * because the opponent's rows are mirrored.
   */
  const handSideFor = useCallback((selector: string): "left" | "right" => {
    const pile = document.querySelector(selector);
    const play = playElRef.current;
    if (!pile || !play) return "right";
    const p = pile.getBoundingClientRect();
    const r = play.getBoundingClientRect();
    return p.left + p.width / 2 < r.left + r.width / 2 ? "right" : "left";
  }, []);
  const [browseClosing, setBrowseClosing] = useState(false);
  const browseTimer = useRef<number | null>(null);
  const browseRef = useRef<typeof browse>(null);
  browseRef.current = browse;
  /** Fly the pile back where it came from, then drop it. */
  const closeBrowse = useCallback(() => {
    setBrowse((b) => {
      if (b) setBrowseClosing(true);
      return b;
    });
    if (browseTimer.current) window.clearTimeout(browseTimer.current);
    const cards = browseRef.current?.cards.length ?? 0;
    browseTimer.current = window.setTimeout(() => {
      setBrowse(null);
      setBrowseClosing(false);
    }, exitDurationMs(cards));
  }, []);
  useEffect(() => () => { if (browseTimer.current) window.clearTimeout(browseTimer.current); }, []);
  const [tips, setTips] = useState(() => { try { return !localStorage.getItem("duel_tips_seen"); } catch { return false; } });
  const [coin, setCoin] = useState<{ id: number; results: number[] } | null>(null);
  const coinSeq = useRef(0);
  const [dice, setDice] = useState<{ id: number; results: number[] } | null>(null);
  const diceSeq = useRef(0);
  const [logRaw, setLogRaw] = useState<DuelEvent[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [placing, setPlacing] = useState<{ promptId: number; optionId: string; kind: "monster" | "spell" } | null>(null);

  const { boardTilt, boardScale, deckThickness, boardShiftX, boardShiftY } = useSettings();

  // The board stays mounted while another tab is on screen, so every global key
  // handler below must ignore keystrokes meant for that tab. A ref keeps the
  // listeners from re-registering on each switch.
  const tabActive = useTabActive();
  const tabActiveRef = useRef(tabActive);
  tabActiveRef.current = tabActive;

  const [zonePx, setZonePx] = useState(120);
  const roRef = useRef<ResizeObserver | null>(null);
  const playElRef = useRef<HTMLDivElement | null>(null);
  // Rows the mat actually draws (Genesys has no Extra Monster Zone row) plus the
  // two side headers. The hands float over the field, so they cost nothing here.
  const rowUnits = format === "genesys" ? 4.7 : 5.7;
  const playRefCb = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    playElRef.current = el;
    if (!el) return;
    const measure = () => {
      const P = el.clientHeight;
      const W = el.clientWidth;
      if (P <= 0 || W <= 0) return;
      const byH = (P - 16) / rowUnits;
      const byW = (W - 24) / 9;
      setZonePx(Math.max(56, Math.min(byW, byH, 260)));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
    measure();
  }, [rowUnits]);

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

  const onHover = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-code]") as HTMLElement | null;
    if (!el) return;
    const code = Number(el.getAttribute("data-code"));
    setPreview((cur) => (cur && cur.id === code ? cur : cardsRef.current.get(code) ?? cur));
  };

  const [menu, setMenu] = useState<{ promptId: number; options: DuelOption[]; x: number; y: number } | null>(null);
  useEffect(() => { setMenu(null); setPlacing(null); }, [prompt?.id]);

  const [drag, setDrag] = useState<DragState | null>(null);
  // A dropped card that found no play flies back to its slot instead of blinking
  // out. `at` starts on the cursor and is moved to the slot on the next frame so
  // the CSS transition has two positions to interpolate between.
  const [flyBack, setFlyBack] = useState<{ seq: number; code: number | null; at: { x: number; y: number } } | null>(null);
  const flyTimer = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [press, setPress] = useState<{ x: number; y: number; k: number } | null>(null);
  const pressRef = useRef<{ timer: number; raf: number; start: number; x: number; y: number } | null>(null);
  const pressCleanupRef = useRef<(() => void) | null>(null);
  const pendingPlaceRef = useRef<string | null>(null);
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
  const boardTargets = placing ? placingTargets : targets;

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

  useEffect(() => {
    if (!prompt || (prompt.kind !== "selectChain" && prompt.kind !== "effectyn" && prompt.kind !== "yesno")) return;
    const noId = prompt.options.find((o) => o.id === "pass" || o.id === "no")?.id;
    const yesId = prompt.options.find((o) => o.id === "yes" || o.id.startsWith("chain:"))?.id;
    const onKey = (e: KeyboardEvent) => {
      if (!tabActiveRef.current) return;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActiveRef.current) return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "g" && e.key !== "G") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const me = state?.players[0];
      if (!me) return;
      e.preventDefault();
      if (browse && browse.title === "Your Graveyard") closeBrowse();
      else {
        const from = '[data-pile="grave"][data-owner="0"]';
        setBrowse({ title: "Your Graveyard", cards: me.grave, from, handSide: handSideFor(from), pile: { kind: "grave", owner: 0 } });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActiveRef.current) return;
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

  useEffect(() => {
    if (!prompt || (prompt.kind !== "idle" && prompt.kind !== "battle")) return;
    const onKey = (e: KeyboardEvent) => {
      if (!tabActiveRef.current) return;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActiveRef.current) return;
      if (e.key !== "Escape") return;
      if (placing) { e.preventDefault(); setPlacing(null); return; }
      if (menu) { e.preventDefault(); setMenu(null); return; }
      if (browse) { e.preventDefault(); closeBrowse(); return; }
      if (logOpen) { e.preventDefault(); setLogOpen(false); return; }
      if (prompt?.cancelable) { e.preventDefault(); respond({ promptId: prompt.id, type: "cancel" }); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, menu, browse, closeBrowse, logOpen, prompt?.id, prompt?.cancelable]);

  const onBoardClick = (e: ReactMouseEvent) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
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
    if (browse) {
      const t = e.target as HTMLElement;
      // Reaching for your own hand puts the pile back and expands it again.
      if (t.closest(".dhand--collapsed")) { closeBrowse(); return; }
      // So does anything outside the strip (the pile itself is handled below).
      if (!t.closest(".dhand") && !t.closest(".dbrowse__bar") && !t.closest("[data-pile]") && !t.closest("[data-extra]")) {
        closeBrowse();
        return;
      }
    }
    if ((e.target as HTMLElement).closest('[data-extra="local"]')) {
      if (browse?.extra) closeBrowse();
      else {
        const from = '[data-extra="local"]';
        setBrowse({ title: "Extra Deck", cards: me.extra, from, handSide: handSideFor(from), pile: { kind: "extra", owner: 0 }, extra: true });
      }
      return;
    }
    const pileEl = (e.target as HTMLElement).closest("[data-pile]") as HTMLElement | null;
    if (pileEl && state) {
      const kind = pileEl.dataset.pile;
      const owner = (Number(pileEl.dataset.owner) || 0) as 0 | 1;
      const cards = kind === "grave" ? state.players[owner].grave : state.players[owner].banished;
      const whose = owner === 0 ? "Your" : "Opponent's";
      const title = `${whose} ${kind === "grave" ? "Graveyard" : "Banished"}`;
      if (browse && browse.title === title) closeBrowse();
      else {
        const from = `[data-pile="${kind}"][data-owner="${owner}"]`;
        setBrowse({ title, cards, from, handSide: handSideFor(from), pile: { kind: kind as "grave" | "banish", owner } });
      }
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

  useEffect(() => {
    if (!banner) return;
    const id = banner.id;
    const t = setTimeout(() => setBanner((cur) => (cur && cur.id === id ? null : cur)), 1400);
    return () => clearTimeout(t);
  }, [banner]);

  useEffect(() => {
    if (!tips) return;
    const t = setTimeout(() => setTips(false), 12000);
    return () => clearTimeout(t);
  }, [tips]);

  useEffect(() => {
    if (!coin) return;
    const t = setTimeout(() => setCoin(null), 2400);
    return () => clearTimeout(t);
  }, [coin]);

  useEffect(() => {
    if (!dice) return;
    const t = setTimeout(() => setDice(null), 2400);
    return () => clearTimeout(t);
  }, [dice]);

  useEffect(() => {
    setLogRaw([]);
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
    if (!networked) {
      window.duel.match.start({ deckId, goldfish: true, format, seed: rematch === 0 ? seed : undefined, opponent, difficulty, aiDeckId }).then((res) => {
        if (!res.ok) setError(res.error ?? "Failed to start duel.");
        setUnsupported(res.unsupported ?? []);
      });
    } else {
      window.duel.net.ready().catch(() => {});
    }
    return () => {
      off();
      window.duel.match.end();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, format, rematch, aiDeckId, networked]);

  const respond = (r: DuelResponse) => window.duel.match.respond(r);

  /** Animate a released card back to the hand slot it came from. */
  const returnToHand = (ds: DragState) => {
    const slot = document.querySelector<HTMLElement>(`[data-loc="hand"][data-seq="${ds.seq}"]`);
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    const home = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    setFlyBack({ seq: ds.seq, code: ds.code, at: { x: ds.x, y: ds.y } });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setFlyBack((f) => (f ? { ...f, at: home } : null)));
    });
    if (flyTimer.current) window.clearTimeout(flyTimer.current);
    flyTimer.current = window.setTimeout(() => setFlyBack(null), 260);
  };
  useEffect(() => () => { if (flyTimer.current) window.clearTimeout(flyTimer.current); }, []);

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

  const beginDrag = (e: ReactPointerEvent, seq: number, el: HTMLElement) => {
    const code = el.dataset.code ? Number(el.dataset.code) : null;
    const isMonster = code != null && /Monster/i.test(cardsRef.current.get(code)?.type ?? "");
    const start = { x: e.clientX, y: e.clientY };
    const handOpts = prompt?.kind === "idle" ? prompt.options.filter((o) => o.loc === "hand" && o.seq === seq) : [];
    dragRef.current = { seq, code, isMonster, x: start.x, y: start.y, valid: false, mods: readMods(e), hint: dragHint(handOpts, isMonster, readMods(e)), overKey: null, fit: null };
    let active = false;

    const onMove = (ev: PointerEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const mods = readMods(ev);
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) {
        dragRef.current = { ...ds, x: ev.clientX, y: ev.clientY, mods };
        return;
      }
      active = true;
      const { loc, seq: overSeq } = zoneAtPoint(ev.clientX, ev.clientY);
      const valid = !!gestureOption(handOpts, ds.isMonster, loc, mods);
      const next: DragState = {
        ...ds, x: ev.clientX, y: ev.clientY, valid, mods,
        hint: dragHint(handOpts, ds.isMonster, mods),
        overKey: valid && loc && Number.isFinite(overSeq) ? `${loc}:${overSeq}` : null,
        fit: fieldFit(ev.clientX, ev.clientY, boardTilt),
      };
      dragRef.current = next;
      setDrag(next);
    };
    // Shift/Ctrl/Cmd change what the drop will DO, so the highlight has to follow
    // the key itself. Reading modifiers only on pointermove meant releasing Shift
    // without moving the mouse left the board showing the old intent.
    const onModKey = (ev: KeyboardEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const mods = { shift: ev.shiftKey, meta: ev.metaKey, ctrl: ev.ctrlKey };
      if (mods.shift === ds.mods.shift && mods.meta === ds.mods.meta && mods.ctrl === ds.mods.ctrl) return;
      const { loc, seq: overSeq } = zoneAtPoint(ds.x, ds.y);
      const valid = !!gestureOption(handOpts, ds.isMonster, loc, mods);
      const next: DragState = {
        ...ds,
        mods,
        valid,
        hint: dragHint(handOpts, ds.isMonster, mods),
        overKey: valid && loc && Number.isFinite(overSeq) ? `${loc}:${overSeq}` : null,
        fit: fieldFit(ds.x, ds.y, boardTilt),
      };
      dragRef.current = next;
      if (active) setDrag(next);
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onModKey);
      window.removeEventListener("keyup", onModKey);
      const ds = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!ds || !active) return;
      suppressClickRef.current = true;
      if (!prompt || prompt.kind !== "idle") { returnToHand(ds); return; }
      const { loc, seq: dropSeq } = zoneAtPoint(ev.clientX, ev.clientY);
      const opts = prompt.options.filter((o) => o.loc === "hand" && o.seq === ds.seq);
      const opt = gestureOption(opts, ds.isMonster, loc, readMods(ev));
      if (!opt) { returnToHand(ds); return; }
      pendingPlaceRef.current = loc === "mzone" ? `m:${dropSeq}` : loc === "szone" ? `s:${dropSeq}` : "*";
      respond({ promptId: prompt.id, type: "option", id: opt.id });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onModKey);
    window.addEventListener("keyup", onModKey);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    const t = e.target as HTMLElement;
    if (placing) return;
    if (t.closest('[data-deck="local"]')) { beginPress(e); return; }
    if (!prompt || prompt.kind !== "idle") return;
    const handEl = t.closest('[data-loc="hand"]') as HTMLElement | null;
    if (!handEl) return;
    const seq = Number(handEl.dataset.seq);
    if (!actionable.has(`hand:${seq}`)) return;
    beginDrag(e, seq, handEl);
  };

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

  const dragCls =
    (drag ? (drag.isMonster ? " is-drag-mon" : " is-drag-st") : "") +
    (drag && drag.isMonster && drag.mods.shift ? " is-drag-setmon" : "");

  return (
    <div
      className={`duelboard${dragCls}`}
      style={{
        "--zone": `${zonePx}px`,
        "--tilt": `${boardTilt}deg`,
        "--field-scale": boardScale,
        "--stack-mult": deckThickness,
        "--shift-x": `${boardShiftX}px`,
        "--shift-y": `${boardShiftY}px`,
        // A rotated (set / defense) card is --card-h wide, 16px short of the
        // zone. Scaling by this makes it span the cell exactly, so two set
        // monsters in adjacent zones touch. CSS can't divide length by length,
        // so the ratio is computed here.
        "--rot-scale": zonePx / (zonePx - 16),
      } as CSSProperties}
      onMouseOver={onHover}
      onClick={onBoardClick}
      onPointerDown={onPointerDown}
    >
      {menu && (
        <CardMenu
          menu={menu}
          nameOf={nameOf}
          onPick={(o) => {
            const kind = placementKind(o.id, o.code, cardsRef.current);
            if (kind) setPlacing({ promptId: menu.promptId, optionId: o.id, kind });
            else respond({ promptId: menu.promptId, type: "option", id: o.id });
            setMenu(null);
          }}
        />
      )}
      {flyBack && flyBack.code != null && (
        <div className="ddrag ddrag--home" style={{ left: flyBack.at.x, top: flyBack.at.y }}>
          <div className="ddrag__card">
            <CardArt code={flyBack.code} alt="" />
          </div>
        </div>
      )}
      {drag && drag.code != null && (
        <div
          className="ddrag"
          style={{
            left: drag.x,
            top: drag.y,
            ...(drag.fit
              ? {
                  "--fit-scale": drag.fit.scale.toFixed(4),
                  "--fit-tilt": `${drag.fit.tilt}deg`,
                  "--fit-ox": `${drag.fit.ox.toFixed(1)}px`,
                }
              : {}),
          } as CSSProperties}
        >
          <div className="ddrag__persp">
            <div className={`ddrag__card${drag.valid ? " is-valid" : ""}`}>
              <CardArt code={drag.code} alt="" />
            </div>
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
          <button className="duel-tips__x" onClick={() => { setTips(false); try { localStorage.setItem("duel_tips_seen", "1"); } catch { } }}>✕</button>
        </div>
      )}
      <div className="duelboard__main">
        <CardViewer tile={preview ? { card: preview, imageId: preview.images[0] ?? preview.id } : null} />

        <div className="duelboard__play" ref={playRefCb}>
          <Hand cards={opp.hand} nameOf={nameOf} actionable={EMPTY_SET} opponent />

          <div className="duelboard__field">
            {banner && <div key={banner.id} className={`dbanner dbanner--${banner.tone}`}>{banner.text}</div>}
            <div className="dfield__mat">
              <div className="dfield__surface" aria-hidden="true" />
              <PlayerSide who="Opponent" p={opp} flip active={state.turnPlayer === 1} nameOf={nameOf} actionable={EMPTY_SET} targets={EMPTY_SET} emptyPile={browse && browse.pile.owner === 1 ? browse.pile.kind : null} />
              {format !== "genesys" && (
                <ExtraMonsterZones cards={[me.monsters[5] ?? null, me.monsters[6] ?? null]} actionable={actionable} targets={boardTargets} nameOf={nameOf} />
              )}
              <PlayerSide who="You" p={me} active={state.turnPlayer === 0} nameOf={nameOf} local actionable={actionable} targets={boardTargets} extraReady={extraSummon.size > 0} dropKey={drag ? drag.overKey : null} emptyPile={browse && browse.pile.owner === 0 ? browse.pile.kind : null} />
            </div>
            {state.over && (
              <div className="dfield-over">
                <div className="dfield-over__box">
                  <div className="dfield-over__title">
                    {state.winner === 0 ? "🏆 You win!" : state.winner === 1 ? "Defeat." : "Duel over."}
                  </div>
                  {state.winReason && <div className="dfield-over__reason">{state.winReason}</div>}
                  <div className="dfield-over__actions">
                    {}
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

          {/* ONE persistent hand. Opening a pile collapses it aside rather than
              swapping in a second instance — a fresh mount would re-run the
              draw animation and the cards would fly in off the deck again.
              It un-collapses the moment closing STARTS rather than when it
              finishes, so the hand fans back out while the pile flies home. */}
          {browse && (
            <div className={`dbrowse__bar${browseClosing ? " is-closing" : ""}`}>
              <span className="dbrowse__title">{browse.title}</span>
              <span className="dbrowse__count">{browse.cards.length}</span>
              {browse.extra && extraSummon.size > 0 && (
                <span className="dbrowse__hint">click a glowing card to summon</span>
              )}
              <button className="btn dbrowse__close" onClick={closeBrowse}>Close</button>
            </div>
          )}
          {/* Your hand and a browsed pile share one flex row, so the browser
              guarantees they can never overlap — no reserved padding to get
              wrong. `hand-left` / `hand-right` just decides the order. */}
          <div className={`dhandrow${browse ? ` is-browsing hand-${browse.handSide}` : ""}`}>
            <Hand
              cards={me.hand}
              nameOf={nameOf}
              actionable={browse ? EMPTY_SET : actionable}
              draggingSeq={browse ? null : drag ? drag.seq : flyBack ? flyBack.seq : null}
              collapsed={!!browse && !browseClosing}
              collapsedSide={browse ? browse.handSide : "left"}
              collapsedTitle="Click to put the cards back and pick your hand up"
            />
            {browse && (
              <Hand
                key={browse.title}
                flyFrom={browse.from}
                closing={browseClosing}
                cards={browse.cards}
                nameOf={nameOf}
                actionable={EMPTY_SET}
                browse
                tilt={boardTilt}
                {...(browse.extra
                  ? {
                      tagOf: (c: DuelCard) =>
                        c.code != null && extraSummon.has(c.code)
                          ? summonVerb(cardsRef.current.get(c.code)?.frameType)
                          : undefined,
                      onCardClick: (c: DuelCard, e: ReactMouseEvent<HTMLDivElement>) => {
                        const opts = c.code != null ? extraSummon.get(c.code) : undefined;
                        if (!opts || opts.length === 0 || !prompt) return;
                        const verb = summonVerb(cardsRef.current.get(c.code ?? -1)?.frameType);
                        const first = opts[0];
                        const display = opts.length === 1 && first ? [{ ...first, label: verb }] : opts;
                        closeBrowse();
                        setMenu({ promptId: prompt.id, options: display, x: e.clientX, y: e.clientY });
                      },
                    }
                  : {})}
              />
            )}
          </div>
        </div>
      </div>

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

function ExtraMonsterZones({ cards, actionable, targets, nameOf }: { cards: (DuelCard | null)[]; actionable: Set<string>; targets: Set<string>; nameOf: (c: number | null | undefined) => string }): JSX.Element {
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

function summonVerb(frameType: string | undefined): string {
  const f = (frameType ?? "").toLowerCase();
  if (f.includes("fusion")) return "Fusion Summon";
  if (f.includes("synchro")) return "Synchro Summon";
  if (f.includes("xyz")) return "Xyz Summon";
  if (f.includes("link")) return "Link Summon";
  if (f.includes("pendulum")) return "Pendulum Summon";
  return "Special Summon";
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

function PlayerSide({ who, p, flip, active, local = false, actionable, targets, nameOf, extraReady = false, dropKey = null, emptyPile = null }: { who: string; p: DuelState["players"][number]; flip?: boolean; active?: boolean; local?: boolean; actionable: Set<string>; targets: Set<string>; nameOf: (c: number | null | undefined) => string; extraReady?: boolean; dropKey?: string | null; emptyPile?: string | null }): JSX.Element {
  const rowCls = `duelboard__row${flip ? " duelboard__row--rev" : ""}`;
  const owner = local ? 0 : 1;
  const monsterRow = (
    <div className={rowCls}>
      <div className="dzone-spacer" aria-hidden="true" />
      <FieldZone card={p.field} nameOf={nameOf} local={local} actionable={actionable} />
      <ZoneCells kind="mon" cards={p.monsters.slice(0, 5)} nameOf={nameOf} local={local} actionable={actionable} targets={targets} dropKey={dropKey} />
      <Pile emptied={emptyPile === "grave"} kind="grave" label="Graveyard" count={p.graveCount} faceCode={p.graveTop} owner={owner} />
      <Pile emptied={emptyPile === "banish"} kind="banish" label="Banished Zone" count={p.banishCount} owner={owner} />
    </div>
  );
  const spellRow = (
    <div className={rowCls}>
      <div className="dzone-spacer" aria-hidden="true" />
      <Pile emptied={emptyPile === "extra"} kind="extra" label="Extra Deck" count={p.extraCount} extraLocal={local} summonReady={local && extraReady} />
      <ZoneCells kind="st" cards={p.spells} nameOf={nameOf} local={local} actionable={actionable} targets={targets} dropKey={dropKey} />
      <Pile emptied={emptyPile === "deck"} kind="deck" label="Deck" count={p.deckCount} deckLocal={local} />
      <div className="dzone-spacer" aria-hidden="true" />
    </div>
  );
  const header = (
    <header className="duelboard__sidehead">
      <span className="duelboard__who">{who}</span>
      <AnimatedLP value={p.lp} />
    </header>
  );
  return (
    <section className={`duelboard__side${active ? " is-active" : ""}`}>
      {flip ? (<>{header}{spellRow}{monsterRow}</>) : (<>{monsterRow}{spellRow}{header}</>)}
    </section>
  );
}

function ZoneCells({ kind, cards, local, actionable, targets, nameOf, dropKey = null }: { kind: "mon" | "st"; cards: (DuelCard | null)[]; local?: boolean; actionable: Set<string>; targets: Set<string>; nameOf: (c: number | null | undefined) => string; dropKey?: string | null }): JSX.Element {
  const loc = kind === "mon" ? "mzone" : "szone";
  return (
    <>
      {cards.map((c, i) => {
        const act = local && actionable.has(`${loc}:${i}`);
        const target = local && targets.has(`${loc}:${i}`);
        // The one zone the cursor is over and the card can legally land in.
        const isDrop = local && dropKey === `${loc}:${i}`;
        return (
          <div
            key={i}
            className={`dzone dzone--${kind}${act ? " is-actionable" : ""}${target ? " is-target" : ""}${isDrop ? " is-drop" : ""}`}
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

/**
 * A pile's thickness, built as real 3D geometry instead of a fake 2D shadow.
 *
 * The mat is rotated in 3D (transform-style: preserve-3d), so a stack rendered
 * with translateZ rises off the table and is foreshortened by the same camera as
 * everything else. A box-shadow offset in screen space cannot do that — it slid
 * diagonally out of the zone no matter what the board's tilt was, which is why
 * it looked wrong.
 *
 * Scale comes from the real card: 59 x 86 mm, 0.305 mm thick, so one card is
 * 0.305/59 = 0.517% of the card's WIDTH. EXAGGERATION lifts that to something
 * readable on screen; 1 is physically exact.
 */
const CARD_WIDTH_MM = 59;
const CARD_THICKNESS_MM = 0.305;
/** Physically exact per-card height, as a fraction of --card-w. The on-screen
 *  multiplier is the `deckThickness` setting, applied via --stack-mult so it
 *  can be dialled live without recomputing anything here. */
const STACK_PER_CARD = CARD_THICKNESS_MM / CARD_WIDTH_MM;
const stackHeight = (count: number): string =>
  `calc(var(--card-w) * ${(STACK_PER_CARD * Math.min(count, 60)).toFixed(5)} * var(--stack-mult, 1))`;

function StackLayers({ count }: { count: number }): JSX.Element | null {
  if (count <= 1) return null;
  // Stack height as a fraction of --card-w, straight from the real card.
  return (
    <div className="dstack" aria-hidden="true" style={{ "--stack-h": stackHeight(count) } as CSSProperties}>
      <div className="dstack__front" />
      {/* Both sides are drawn; backface culling shows only the one actually
          facing the camera, so a pile on the right of the board reveals its
          left face and one on the left reveals its right. */}
      <div className="dstack__side dstack__side--left" />
      <div className="dstack__side dstack__side--right" />
    </div>
  );
}

function Pile({ kind, label, count: rawCount, deckLocal, extraLocal, faceCode: rawFace, summonReady, owner, emptied = false }: { kind: string; label: string; count: number; deckLocal?: boolean; extraLocal?: boolean; faceCode?: number | null; summonReady?: boolean; owner?: number; emptied?: boolean }): JSX.Element {
  // While you're looking through this pile its cards are in the hand strip, so
  // the zone shows empty until they fly back.
  const count = emptied ? 0 : rawCount;
  const faceCode = emptied ? null : rawFace;
  const showCount = count > 0 && kind !== "deck" && kind !== "extra" && kind !== "grave";
  // Keyed off the REAL count: an emptied pile must keep its data-pile/data-owner
  // attributes, because the cards in the hand strip fly home by selecting them —
  // drop the attributes and the return animation has no target to aim at.
  const viewable = (kind === "grave" || kind === "banish") && rawCount > 0 && owner != null;
  const title =
    kind === "deck" && deckLocal ? `${label}: ${count} — hold to surrender`
    : kind === "extra" && extraLocal ? `${label}: ${count} — click to ${summonReady ? "summon / view" : "view"}`
    : viewable ? `${label}: ${count} — click to view`
    : `${label}: ${count}`;
  return (
    <div
      className={`dzone dzone--pile dzone--${kind}${(kind === "extra" && extraLocal) || viewable ? " is-browsable" : ""}${summonReady ? " is-summon-ready" : ""}`}
      title={title}
      data-deck={kind === "deck" ? (deckLocal ? "local" : "opp") : undefined}
      data-extra={kind === "extra" && extraLocal ? "local" : undefined}
      data-pile={viewable ? kind : undefined}
      data-owner={viewable ? owner : undefined}
    >
      <div
        className={`dslot dslot--${kind}${count > 1 ? " has-stack" : ""}`}
        style={{ "--stack-h": stackHeight(count) } as CSSProperties}
      >
        <StackLayers count={count} />
        {faceCode != null
          ? <CardArt code={faceCode} alt={label} />
          : count > 0 && <img className="dcard__art" src={cardBack} alt={label} />}
        {showCount && <span className="dslot__count">{count}</span>}
      </div>
    </div>
  );
}

function CardSlot({ card, kind }: { card: DuelCard | null; kind?: string }): JSX.Element {
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

/** How far apart consecutive draws fire, and how long each card is in flight.
 *  DRAW_FLIGHT_MS must match the `hand-draw` duration in the stylesheet. */
const DRAW_STAGGER_MS = 95;
const DRAW_FLIGHT_MS = 520;
/** Going home is tighter than dealing out, so a big graveyard doesn't drag. */
const EXIT_STAGGER_MS = 40;
const EXIT_FLIGHT_MS = 320;
/** Total time before a closing pile can be unmounted. */
export const exitDurationMs = (count: number): number =>
  EXIT_FLIGHT_MS + Math.max(0, count - 1) * EXIT_STAGGER_MS + 40;

type DrawAnim = { dx: number; dy: number; sx: number; sy: number; tilt: number; ox: number; delay: number };

/** The card inside a pile, not the square cell around it.
 *
 *  A `.dzone` is `--zone` square; the card in it is `--card-w` x `--card-h`. A
 *  draw that measures the cell starts at the wrong size, and the gap widens with
 *  tilt because the mat's rotateX foreshortens the card but not our arithmetic. */
const originCard = (selector: string): Element | null => {
  const zone = document.querySelector(selector);
  return zone?.querySelector(".dslot") ?? zone;
};

function Hand({ cards, actionable, nameOf, opponent = false, draggingSeq = null, browse = false, onCardClick, tagOf, flyFrom, closing = false, collapsed = false, collapsedSide = "left", collapsedTitle, avoidSide, tilt = 0 }: {
  cards: DuelCard[];
  actionable: Set<string>;
  nameOf: (c: number | null | undefined) => string;
  opponent?: boolean;
  draggingSeq?: number | null;
  /** Showing a pile (graveyard / banished / extra) in the hand's place: same
   *  layout, but the cards are not draggable into zones. */
  browse?: boolean;
  onCardClick?: (card: DuelCard, e: ReactMouseEvent<HTMLDivElement>) => void;
  tagOf?: (card: DuelCard) => string | undefined;
  /** Element the cards fly out of. Defaults to your deck (a normal draw); a
   *  browsed pile passes its own graveyard / banished / extra deck. */
  flyFrom?: string;
  /** Playing the exit: cards fly back to `flyFrom` before unmounting. */
  closing?: boolean;
  /** Your hand while a pile is being browsed — tucked aside, not interactive. */
  collapsed?: boolean;
  collapsedSide?: "left" | "right";
  collapsedTitle?: string;
  /** Side the collapsed hand is parked on — the browsed pile keeps clear of it. */
  avoidSide?: "left" | "right";
  /** Board tilt (deg). A browsed pile emerges leaning by this much, matching the
   *  mat, then flattens into the hand. */
  tilt?: number;
}): JSX.Element {
  const n = cards.length;

  // Cards that just entered the hand fly in from the deck instead of appearing.
  // The offset is measured from the real deck and slot boxes, so it stays right
  // at any board scale/tilt, and it is applied as state rather than an imperative
  // class — React re-renders the hand constantly and would wipe the latter.
  const rootRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  const [draws, setDraws] = useState<Map<number, DrawAnim>>(new Map());

  useLayoutEffect(() => {
    const grew = n - prevCount.current;
    prevCount.current = n;
    if (collapsed || grew <= 0 || !rootRef.current) return;
    const origin = originCard(flyFrom ?? (opponent ? '[data-deck="opp"]' : '[data-deck="local"]'));
    if (!origin) return;
    // The rect of a tilted element is the bounding box of the rendered quad, so
    // this already carries the mat's scale and its perspective foreshortening —
    // no need to know the tilt angle, and it stays right when the user changes it.
    const d = origin.getBoundingClientRect();
    const slots = rootRef.current.querySelectorAll<HTMLElement>(".dhand__slot");
    const next = new Map<number, DrawAnim>();
    const first = n - grew;
    // A browsed pile sits ON the mat, off to one side, so its cards emerge with
    // the board's full perspective: rotateX for the lean and an origin shifted
    // toward the field centre for the sideways shear (see fieldFit). Width alone
    // is scaled — rotateX supplies the height foreshortening — so a uniform
    // scale is right here, unlike the deck draw's per-axis squash.
    const field = browse ? document.querySelector(".duelboard__field")?.getBoundingClientRect() : undefined;
    for (let i = first; i < n; i++) {
      const el = slots[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const sx = d.width / r.width;
      next.set(i, {
        dx: d.left + d.width / 2 - (r.left + r.width / 2),
        dy: d.top + d.height / 2 - (r.top + r.height / 2),
        sx,
        sy: browse ? sx : d.height / r.height,
        tilt: browse ? tilt : 0,
        ox: browse && field ? field.left + field.width / 2 - (d.left + d.width / 2) : 0,
        delay: (i - first) * DRAW_STAGGER_MS,
      });
    }
    if (next.size === 0) return;
    setDraws(next);
    const total = DRAW_FLIGHT_MS + (next.size - 1) * DRAW_STAGGER_MS + 60;
    const t = window.setTimeout(() => setDraws(new Map()), total);
    return () => window.clearTimeout(t);
  }, [n, opponent, flyFrom, collapsed, browse, tilt]);

  // Disabled for the opponent's (non-interactive) hand and while dragging, so a
  // card being pulled out doesn't wobble.
  const tiltProps = opponent && !browse ? {} : draggingSeq !== null ? {} : cardTilt();

  // Leaving: pin every card where it currently sits, then fly it to the pile.
  // Pinning matters because the hand expands at the same moment — that reflows
  // the row and would drag these cards sideways mid-flight, so they'd appear to
  // launch from the wrong place. Fixed positioning takes them out of that flow,
  // and the destination is measured live rather than reused from the way in.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!closing || !root) return;
    const origin = originCard(flyFrom ?? '[data-deck="local"]');
    const o = origin?.getBoundingClientRect();
    // Measure every card BEFORE pinning any of them: taking one out of flow
    // reflows the row and shifts the rest, so measuring inside the loop reads
    // positions that have already moved.
    const slots = Array.from(root.querySelectorAll<HTMLElement>(".dhand__slot"));
    const rects = slots.map((el) => el.getBoundingClientRect());
    // The mirror of the entry: the card sinks back onto the mat, leaning into the
    // board's perspective (rotateX) and shearing toward the pile's side (origin
    // offset) as it goes, so it lands looking like a card in that zone rather
    // than a flat rectangle that merely shrank.
    const field = document.querySelector(".duelboard__field")?.getBoundingClientRect();
    slots.forEach((el, i) => {
      const r = rects[i]!;
      el.style.position = "fixed";
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      el.style.margin = "0";
      if (!o) return;
      // Perspective on the pinned slot; the card inside is what rotates in it.
      el.style.perspective = "1200px";
      el.style.perspectiveOrigin = `calc(50% + ${(field ? field.left + field.width / 2 - (o.left + o.width / 2) : 0).toFixed(1)}px) 50%`;
      const card = el.querySelector<HTMLElement>(".dhand__card");
      if (!card) return;
      const dx = o.left + o.width / 2 - (r.left + r.width / 2);
      const dy = o.top + o.height / 2 - (r.top + r.height / 2);
      // Uniform scale: rotateX takes care of the height foreshortening.
      const sc = (o.width / r.width).toFixed(4);
      card.animate(
        [
          { transform: "translate(0, 0) scale(1) rotateX(0deg)", opacity: 1, offset: 0 },
          { opacity: 1, offset: 0.88 },
          { transform: `translate(${dx}px, ${dy}px) scale(${sc}) rotateX(${tilt}deg)`, opacity: 0, offset: 1 },
        ],
        {
          duration: EXIT_FLIGHT_MS,
          delay: i * EXIT_STAGGER_MS,
          easing: "cubic-bezier(0.4, 0, 0.7, 1)",
          fill: "forwards",
        },
      );
    });
  }, [closing, flyFrom, tilt]);

  // FLIP. Collapsing changes flex alignment, gap and margins — none of which
  // the browser can tween, so the cards used to teleport. Measure where each
  // card was, let the layout change, then animate the difference away.
  const rectsRef = useRef<DOMRect[]>([]);
  const wasCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const slots = Array.from(root.querySelectorAll<HTMLElement>(".dhand__slot"));
    const before = rectsRef.current;
    const after = slots.map((el) => el.getBoundingClientRect());
    const toggled = wasCollapsed.current !== collapsed;
    rectsRef.current = after;
    wasCollapsed.current = collapsed;
    if (!toggled || before.length !== slots.length) return;
    slots.forEach((el, i) => {
      const p = before[i];
      const q = after[i];
      if (!p || !q) return;
      const dx = p.left - q.left;
      const dy = p.top - q.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 340, easing: "cubic-bezier(0.2, 0.8, 0.25, 1)", composite: "add" },
      );
    });
  }, [collapsed, collapsedSide, n]);

  return (
    <div
      className={`dhand${opponent ? " dhand--opp" : ""}${collapsed ? ` dhand--collapsed is-${collapsedSide}` : ""}${avoidSide ? ` dhand--avoid-${avoidSide}` : ""}`}
      ref={rootRef}
      {...(collapsed && collapsedTitle ? { title: collapsedTitle } : {})}
    >
      {n === 0 && <span className="dhand__empty">— empty hand —</span>}
      {cards.map((c, i) => {
        const act = !opponent && actionable.has(`hand:${i}`);
        // The card being dragged rides the cursor, so hide the one still in the
        // hand — otherwise it reads as a duplicate. The slot keeps its space, so
        // the rest of the hand doesn't shuffle sideways mid-drag.
        const lifted = draggingSeq === i;
        const draw = closing ? undefined : draws.get(i);
        const tag = browse && tagOf ? tagOf(c) : undefined;
        return (
          <div
            key={i}
            className={`dhand__slot${act ? " is-actionable" : ""}${lifted ? " is-lifted" : ""}${draw && !closing ? " is-drawing" : ""}${tag ? " is-summonable" : ""}${browse ? " is-browse" : ""}`}
            style={draw ? ({
              "--draw-dx": `${draw.dx}px`,
              "--draw-dy": `${draw.dy}px`,
              "--draw-sx": `${draw.sx.toFixed(4)}`,
              "--draw-sy": `${draw.sy.toFixed(4)}`,
              "--draw-tilt": `${draw.tilt}deg`,
              "--draw-ox": `${draw.ox.toFixed(1)}px`,
              "--draw-delay": `${closing ? i * EXIT_STAGGER_MS : draw.delay}ms`,
            } as CSSProperties) : undefined}
            {...tiltProps}
            title={tag ? `${nameOf(c.code)} — ${tag}` : nameOf(c.code)}
            data-code={c.code ?? undefined}
            data-loc={opponent || browse ? undefined : "hand"}
            data-seq={opponent || browse ? undefined : i}
            onClick={onCardClick ? (e) => onCardClick(c, e) : undefined}
          >
            <div className="dhand__card">
              <div className="dhand__flip">
                <div className="dhand__face">
                  <CardArt code={c.code} alt={nameOf(c.code)} />
                </div>
                <div className="dhand__face dhand__face--back">
                  <img className="dcard__art" src={cardBack} alt="" />
                </div>
              </div>
              {tag && <span className="dhand__tag">{tag}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

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

function PromptOverlay({
  prompt, nameOf, respond, searchCards,
}: {
  prompt: DuelPrompt | null;
  nameOf: (c: number | null | undefined) => string;
  respond: (r: DuelResponse) => void;
  searchCards: (q: string) => { code: number; name: string }[];
}): JSX.Element | null {
  const [sel, setSel] = useState<string[]>([]);
  const [counts, setCounts] = useState<number[]>([]);
  const [announceText, setAnnounceText] = useState("");
  const promptId = prompt?.id ?? -1;
  useEffect(() => { setSel([]); setCounts([]); setAnnounceText(""); }, [promptId]);

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
          {}
          <div
            key={promptId}
            className="dprompt__timerbar-fill"
            style={{ "--dur": `${RESPONSE_SECS}s` } as CSSProperties}
          />
        </div>
      )}
      <div className="dprompt__opts">
        {isResponse ? (
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

const DICE_PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
const DICE_SHOW: Record<number, [number, number]> = {
  1: [0, 0],
  2: [-90, 0],
  3: [0, -90],
  4: [0, 90],
  5: [90, 0],
  6: [0, 180],
};

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

function bannerFromEvents(events: import("@duel/shared").DuelEvent[]): { text: string; tone: string } | null {
  const win = events.find((e) => e.kind === "win");
  if (win && win.kind === "win") return { text: win.player === 0 ? "You Win!" : "Defeat", tone: win.player === 0 ? "win" : "lose" };
  const atk = events.find((e) => e.kind === "attack");
  if (atk && atk.kind === "attack") return { text: atk.target == null ? "Direct Attack!" : "Attack!", tone: "atk" };
  const turn = events.find((e) => e.kind === "turn");
  if (turn && turn.kind === "turn") return { text: `Turn ${turn.turn} — ${turn.player === 0 ? "Your Move" : "Opponent"}`, tone: "turn" };
  return null;
}

