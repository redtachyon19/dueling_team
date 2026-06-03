import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CardData, DuelCard, DuelOption, DuelPhase, DuelPrompt, DuelResponse, DuelState, DuelUpdate, PromptCard } from "@duel/shared";
import cardBack from "../../../../assets/cards/sleeves/original_card_sleeve.png";

const EMPTY_SET: Set<string> = new Set();

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
type DragState = { seq: number; code: number | null; isMonster: boolean; x: number; y: number; valid: boolean; mods: Mods };

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
    if (mods.meta || mods.ctrl) return find("activate"); // special summon, if the card offers one
    return find("summon");
  }
  if (dropLoc !== "szone" && dropLoc !== "fzone") return undefined;
  if (mods.shift) return find("sset");
  return find("activate");
}

/** Label shown under the drag ghost for the current modifier state. */
function dragHint(d: DragState): string {
  if (d.isMonster) {
    if (d.mods.shift) return "Set";
    if (d.mods.meta || d.mods.ctrl) return "Special Summon";
    return "Normal Summon";
  }
  return d.mods.shift ? "Set" : "Activate";
}

export function DuelBoard({ deckId, onExit }: { deckId: string; onExit: () => void }): JSX.Element {
  const [state, setState] = useState<DuelState | null>(null);
  const [prompt, setPrompt] = useState<DuelPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<number[]>([]);
  const [banner, setBanner] = useState<{ id: number; text: string; tone: string } | null>(null);
  const bannerSeq = useRef(0);
  const [preview, setPreview] = useState<CardData | null>(null);

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
  useEffect(() => setMenu(null), [prompt?.id]);

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

  const onBoardClick = (e: ReactMouseEvent) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
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

  // Subscribe first, then start — so the opening update isn't missed.
  useEffect(() => {
    const off = window.duel.match.onUpdate((u: DuelUpdate) => {
      setState(u.state);
      setPrompt(u.prompt);
      const b = bannerFromEvents(u.events);
      if (b) setBanner({ id: ++bannerSeq.current, ...b });
    });
    window.duel.match.start({ deckId, goldfish: true }).then((res) => {
      if (!res.ok) setError(res.error ?? "Failed to start duel.");
      setUnsupported(res.unsupported ?? []);
    });
    return () => {
      off();
      window.duel.match.end();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

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
    dragRef.current = { seq, code, isMonster, x: start.x, y: start.y, valid: false, mods: readMods(e) };
    let active = false;

    const onMove = (ev: PointerEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) {
        dragRef.current = { ...ds, x: ev.clientX, y: ev.clientY, mods: readMods(ev) };
        return; // not yet a drag — keep it clickable
      }
      active = true;
      const loc = zoneAtPoint(ev.clientX, ev.clientY).loc;
      const valid = ds.isMonster ? loc === "mzone" : (loc === "szone" || loc === "fzone");
      const next: DragState = { ...ds, x: ev.clientX, y: ev.clientY, valid, mods: readMods(ev) };
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
          <button className="btn" onClick={onExit}>← Decks</button>
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
    <div className={`duelboard${dragCls}`} onMouseOver={onHover} onClick={onBoardClick} onPointerDown={onPointerDown}>
      {menu && (
        <CardMenu
          menu={menu}
          nameOf={nameOf}
          onPick={(o) => { respond({ promptId: menu.promptId, type: "option", id: o.id }); setMenu(null); }}
        />
      )}
      {drag && drag.code != null && (
        <div className="ddrag" style={{ left: drag.x, top: drag.y }}>
          <div className={`ddrag__card${drag.valid ? " is-valid" : ""}`}>
            <CardArt code={drag.code} alt="" />
          </div>
          <span className={`ddrag__hint${drag.valid ? " is-valid" : ""}`}>{dragHint(drag)}</span>
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
        <button className="btn" onClick={onExit}>← Decks</button>
        <span className="duelboard__turn">Turn {state.turn} · {state.turnPlayer === 0 ? "You" : "Opponent"}</span>
        <PhaseTrack phase={state.phase} />
        <div className="editor__spacer" />
        {unsupported.length > 0 && <span className="duelboard__warn" title={unsupported.join(", ")}>{unsupported.length} card(s) unsupported</span>}
        {prompt && (prompt.kind === "idle" || prompt.kind === "battle") &&
          prompt.options.filter((o) => o.loc == null).map((o) => (
            <button key={o.id} className="btn btn--primary" onClick={() => respond({ promptId: prompt.id, type: "option", id: o.id })}>
              {o.label}
            </button>
          ))}
      </div>

      <div className="duelboard__main">
        <DuelViewer card={preview} />

        <div className="duelboard__play">
          <div className="duelboard__field">
            {banner && <div key={banner.id} className={`dbanner dbanner--${banner.tone}`}>{banner.text}</div>}
            <PlayerSide who="Opponent" p={opp} flip active={state.turnPlayer === 1} nameOf={nameOf} actionable={EMPTY_SET} targets={EMPTY_SET} />
            <PlayerSide who="You" p={me} active={state.turnPlayer === 0} nameOf={nameOf} local actionable={actionable} targets={targets} />
          </div>

          <Hand cards={me.hand} nameOf={nameOf} actionable={actionable} />
        </div>
      </div>

      <PromptOverlay prompt={prompt} over={state.over} winner={state.winner} nameOf={nameOf} respond={respond} />
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

function PlayerSide({ who, p, flip, active, local = false, actionable, targets, nameOf }: { who: string; p: DuelState["players"][number]; flip?: boolean; active?: boolean; local?: boolean; actionable: Set<string>; targets: Set<string>; nameOf: (c: number | null | undefined) => string }): JSX.Element {
  // Monster row: Field Spell (left), 5 monsters, Banished, then Graveyard as the
  // outermost flank. Spell/trap row: Extra Deck (left), 5 S/T, Deck, spacer.
  // The opponent's side is a true 180° flip: rows in reverse order (S/T on the
  // back) AND mirrored left-right (row-reverse), so their Graveyard lines up
  // over our Field Spell zone.
  const rowCls = `duelboard__row${flip ? " duelboard__row--rev" : ""}`;
  // 9 columns: a leading spacer (col 0), the 7 main columns, then Banished (col 8,
  // right of the Graveyard). The opponent's rows are row-reversed, so their
  // Banished ends up on the left and their Graveyard lines up over our Field.
  const monsterRow = (
    <div className={rowCls}>
      <div className="dzone-spacer" aria-hidden="true" />
      <FieldZone card={p.field} nameOf={nameOf} local={local} actionable={actionable} />
      <ZoneCells kind="mon" cards={p.monsters} nameOf={nameOf} local={local} actionable={actionable} targets={targets} />
      <Pile kind="grave" label="GY" count={p.graveCount} />
      <Pile kind="banish" label="Banish" count={p.banishCount} />
    </div>
  );
  const spellRow = (
    <div className={rowCls}>
      <div className="dzone-spacer" aria-hidden="true" />
      <Pile kind="extra" label="Extra" count={p.extraCount} />
      <ZoneCells kind="st" cards={p.spells} nameOf={nameOf} local={local} actionable={actionable} targets={targets} />
      <Pile kind="deck" label="Deck" count={p.deckCount} deckLocal={local} />
      <div className="dzone-spacer" aria-hidden="true" />
    </div>
  );
  return (
    <section className={`duelboard__side${active ? " is-active" : ""}`}>
      <header className="duelboard__sidehead">
        <span className="duelboard__who">{who}</span>
        <AnimatedLP value={p.lp} />
      </header>
      {flip ? (<>{spellRow}{monsterRow}</>) : (<>{monsterRow}{spellRow}</>)}
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
      {!card && <span className="dzone__tag">Field</span>}
    </div>
  );
}

/** A face-down pile (deck / extra / graveyard / banished). Deck & Extra hide
 *  their count; Graveyard & Banished still show theirs. */
function Pile({ kind, label, count, deckLocal }: { kind: string; label: string; count: number; deckLocal?: boolean }): JSX.Element {
  const showCount = count > 0 && kind !== "deck" && kind !== "extra";
  return (
    <div
      className={`dzone dzone--pile dzone--${kind}`}
      title={kind === "deck" && deckLocal ? `${label}: ${count} — hold to surrender` : `${label}: ${count}`}
      data-deck={kind === "deck" && deckLocal ? "local" : undefined}
    >
      <div className={`dslot dslot--${kind}`}>
        {count > 0 && <img className="dcard__art" src={cardBack} alt={label} />}
        {showCount && <span className="dslot__count">{count}</span>}
      </div>
      <span className="dzone__label">{label}</span>
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

function Hand({ cards, actionable, nameOf }: { cards: DuelCard[]; actionable: Set<string>; nameOf: (c: number | null | undefined) => string }): JSX.Element {
  const n = cards.length;
  const center = (n - 1) / 2;
  const step = n > 1 ? Math.min(8, 42 / (n - 1)) : 0; // degrees between adjacent cards
  return (
    <div className="dhand">
      {n === 0 && <span className="dhand__empty">— empty hand —</span>}
      {cards.map((c, i) => {
        const act = actionable.has(`hand:${i}`);
        const rot = (i - center) * step;
        return (
          <div
            key={i}
            className={`dhand__slot${act ? " is-actionable" : ""}`}
            style={{ "--rot": `${rot}deg` } as CSSProperties}
            title={nameOf(c.code)}
            data-code={c.code ?? undefined}
            data-loc="hand"
            data-seq={i}
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
  prompt, over, winner, nameOf, respond,
}: {
  prompt: DuelPrompt | null;
  over: boolean;
  winner: number | null;
  nameOf: (c: number | null | undefined) => string;
  respond: (r: DuelResponse) => void;
}): JSX.Element | null {
  const [sel, setSel] = useState<string[]>([]);
  const promptId = prompt?.id ?? -1;
  useEffect(() => setSel([]), [promptId]);

  if (over) {
    return (
      <div className="dprompt-overlay dprompt dprompt--over">
        <div className="dprompt__title">{winner === 0 ? "🏆 You win!" : winner === 1 ? "Defeat." : "Duel over."}</div>
      </div>
    );
  }
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

  // position / chain / yes-no / option / effectyn
  return (
    <div className="dprompt-overlay dprompt">
      <div className="dprompt__title">{prompt.title}</div>
      <div className="dprompt__opts">
        {prompt.options.map((o) => (
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
        ))}
      </div>
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

/** Fixed left-side card viewer — the same panel as the Cards search. Shows the
 *  currently/last-hovered card. */
function DuelViewer({ card }: { card: CardData | null }): JSX.Element {
  if (!card) {
    return (
      <aside className="duelboard__viewer">
        <img className="cards__viewer-art" src={cardBack} alt="Card back" />
        <div className="cards__viewer-info"><div className="cards__viewer-sub">Hover a card to preview it.</div></div>
      </aside>
    );
  }
  const monster = /Monster/i.test(card.type);
  const sub = monster
    ? [card.attribute, card.race, card.level != null ? `Lv ${card.level}` : null].filter(Boolean).join(" · ")
    : [card.type, card.race].filter(Boolean).join(" · ");
  return (
    <aside className="duelboard__viewer">
      <CardArt code={card.images[0] ?? card.id} alt={card.name} cls="cards__viewer-art" />
      <div className="cards__viewer-info">
        <div className="cards__viewer-name">{card.name}</div>
        <div className="cards__viewer-sub">{sub}</div>
        {monster && card.atk != null && <div className="cards__viewer-atk">ATK {card.atk} / DEF {card.def ?? "—"}</div>}
        <p className="cards__viewer-desc">{card.desc}</p>
      </div>
    </aside>
  );
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

