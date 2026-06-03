import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
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

  const onBoardClick = (e: ReactMouseEvent) => {
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

  return (
    <div className="duelboard" onMouseOver={onHover} onClick={onBoardClick}>
      {menu && (
        <CardMenu
          menu={menu}
          nameOf={nameOf}
          onPick={(o) => { respond({ promptId: menu.promptId, type: "option", id: o.id }); setMenu(null); }}
        />
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
      <Pile kind="deck" label="Deck" count={p.deckCount} />
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
function Pile({ kind, label, count }: { kind: string; label: string; count: number }): JSX.Element {
  const showCount = count > 0 && kind !== "deck" && kind !== "extra";
  return (
    <div className={`dzone dzone--pile dzone--${kind}`} title={`${label}: ${count}`}>
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
  // Empty zone: just the static dashed outline (never rotates).
  if (!card) return <div className={`dslot${kind ? ` dslot--${kind}` : ""}`} />;
  // Occupied: the card itself. Only monsters lie horizontal (defense / face-down
  // defense); the card rotates independently of the zone frame.
  const rot = kind === "mon" && (card.position === "def" || card.position === "set");
  return (
    <div className={`dcard${rot ? " dcard--rot" : ""}`}>
      <CardArt code={card.faceUp ? card.code : null} alt="" />
      {card.faceUp && card.atk != null && (
        <span className="dcard__stats">{card.atk}/{card.def ?? "—"}</span>
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
            className={`dhand__card${act ? " is-actionable" : ""}`}
            style={{ "--rot": `${rot}deg` } as CSSProperties}
            title={nameOf(c.code)}
            data-code={c.code ?? undefined}
            data-loc="hand"
            data-seq={i}
          >
            <CardArt code={c.code} alt={nameOf(c.code)} />
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

