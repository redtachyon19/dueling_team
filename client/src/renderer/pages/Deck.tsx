import { useEffect, useMemo, useRef, useState } from "react";
import type { CardData, CardQuery, CardSupertype, Deck, DeckSummary } from "@duel/shared";
import { runQuery, prepareCards, deriveFacets, supertypeOf } from "../cards/search.ts";
import type { PreparedCard } from "../cards/search.ts";
import {
  addCard,
  validateDeck,
  copiesOf,
  buildBanlistLookup,
  banStatusOf,
  buildGenesysLookup,
  genesysCostOf,
  deckGenesysPoints,
  LIMITS,
  type Zone,
  type BanlistLookup,
  type GenesysLookup,
} from "../cards/deck.ts";
import type { BanStatus, BanlistRevisionMeta, GenesysRevisionMeta } from "@duel/shared";
import cardBack from "../../../../assets/cards/sleeves/original_card_sleeve.png";

const SUPERTYPES: CardSupertype[] = ["Monster", "Spell", "Trap"];
const RESULT_CAP = 120;

/** Which legality system is applied in the editor. */
type FormatMode = "none" | "tcg" | "genesys";
/** The currently selected format: an Advanced (TCG) banlist or a Genesys list. */
interface FormatSel {
  kind: "tcg" | "genesys";
  date: string;
}
const BASE_COLS = 10; // cards per row before overlap kicks in
const MAX_COLS = 15; // cards per row at full compression
const GAP = 6;
const CARD_RATIO = 1185 / 813; // height / width

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function uid(): string {
  return "deck-" + Math.abs(Date.now() ^ Math.floor(performance.now() * 1000)).toString(36);
}
function nowIso(): string {
  return new Date().toISOString();
}
function newDeck(): Deck {
  const t = nowIso();
  return { id: uid(), name: "New Deck", tags: [], main: [], extra: [], side: [], enforceLimits: true, createdAt: t, updatedAt: t };
}

/** Width of an element, kept current via ResizeObserver. */
function useElementWidth<T extends HTMLElement>(ref: React.RefObject<T | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function Deck(): JSX.Element {
  const [editing, setEditing] = useState<Deck | null>(null);
  if (editing) return <DeckEditor initial={editing} onExit={() => setEditing(null)} />;
  return <DeckList onOpen={setEditing} />;
}

// ---------------------------------------------------------------------------
// Deck list (no card viewer here)
// ---------------------------------------------------------------------------
function DeckList({ onOpen }: { onOpen: (d: Deck) => void }): JSX.Element {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);

  const refresh = () => {
    window.duel?.decks?.list().then(setDecks).catch(() => setDecks([]));
  };
  useEffect(refresh, []);

  const create = async () => {
    const d = newDeck();
    await window.duel.decks.save(d);
    onOpen(d);
  };
  const open = async (id: string) => {
    const d = await window.duel.decks.load(id);
    if (d) onOpen(d);
  };
  const remove = async (id: string) => {
    await window.duel.decks.delete(id);
    refresh();
  };

  return (
    <div className="decklist">
      <div className="decklist__head">
        <h1>Decks</h1>
        <button className="btn btn--primary" onClick={create}>+ New Deck</button>
      </div>

      {decks === null ? (
        <div className="decklist__msg">Loading…</div>
      ) : decks.length === 0 ? (
        <div className="decklist__msg">No decks yet. Create one to start building.</div>
      ) : (
        <div className="decklist__grid">
          {decks.map((d) => (
            <article key={d.id} className="deckcard" onDoubleClick={() => open(d.id)}>
              <div className="deckcard__name">{d.name}</div>
              <div className="deckcard__counts">
                Main {d.mainCount} · Extra {d.extraCount} · Side {d.sideCount}
              </div>
              {d.tags.length > 0 && (
                <div className="deckcard__tags">
                  {d.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                </div>
              )}
              <div className="deckcard__actions">
                <button className="btn" onClick={() => open(d.id)}>Edit</button>
                <button className="btn btn--danger" onClick={() => remove(d.id)}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deck editor (card viewer left · zones center · search right)
// ---------------------------------------------------------------------------
function DeckEditor({ initial, onExit }: { initial: Deck; onExit: () => void }): JSX.Element {
  const [deck, setDeck] = useState<Deck>(initial);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<CardData | null>(null);

  const [cards, setCards] = useState<CardData[] | null>(null);
  const byId = useMemo(() => {
    const m = new Map<number, CardData>();
    if (cards) for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  useEffect(() => {
    window.duel?.cards?.load().then((c) => setCards(c ?? [])).catch(() => setCards([]));
  }, []);

  // Format selector: the available revisions for each format + the selection.
  const [tcgRevs, setTcgRevs] = useState<BanlistRevisionMeta[]>([]);
  const [genesysRevs, setGenesysRevs] = useState<GenesysRevisionMeta[]>([]);
  const [format, setFormat] = useState<FormatSel | null>(null);
  const [tcgLookup, setTcgLookup] = useState<BanlistLookup | null>(null);
  const [genesysLookup, setGenesysLookup] = useState<GenesysLookup | null>(null);

  useEffect(() => {
    window.duel?.banlists?.list().then((revs) => setTcgRevs(revs ?? [])).catch(() => setTcgRevs([]));
    window.duel?.genesys?.list().then((revs) => setGenesysRevs(revs ?? [])).catch(() => setGenesysRevs([]));
  }, []);

  // Load (and build a lookup for) whichever format is selected; clear the other.
  useEffect(() => {
    setTcgLookup(null);
    setGenesysLookup(null);
    if (!format) return;
    let alive = true;
    if (format.kind === "tcg") {
      window.duel.banlists.load(format.date).then((rev) => {
        if (alive) setTcgLookup(rev ? buildBanlistLookup(rev) : null);
      });
    } else {
      window.duel.genesys.load(format.date).then((rev) => {
        if (alive) setGenesysLookup(rev ? buildGenesysLookup(rev) : null);
      });
    }
    return () => {
      alive = false;
    };
  }, [format]);

  const mode: FormatMode = tcgLookup ? "tcg" : genesysLookup ? "genesys" : "none";
  const statusOf = (card: CardData): BanStatus => banStatusOf(card, tcgLookup);
  const costOf = (card: CardData): number => genesysCostOf(card, genesysLookup);
  const genesysTotal = useMemo(
    () => deckGenesysPoints(deck, genesysLookup),
    [deck, genesysLookup],
  );
  const overCap =
    genesysLookup?.pointCap != null && genesysTotal > genesysLookup.pointCap;

  const mutate = (next: Deck) => {
    setDeck({ ...next, updatedAt: nowIso() });
    setDirty(true);
  };

  const save = async () => {
    const saved = { ...deck, updatedAt: nowIso() };
    await window.duel.decks.save(saved);
    setDeck(saved);
    setDirty(false);
  };

  const tryExit = () => {
    if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) return;
    onExit();
  };

  const add = (card: CardData, zone: Zone) => {
    const r = addCard(deck, card, zone);
    if (r.ok) mutate(r.deck);
  };
  const drop = (zone: Zone, e: React.DragEvent) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/card-id"));
    const card = byId.get(id);
    if (card) add(card, zone);
  };
  // Remove the specific copy at `index` in a zone (duplicates shown separately).
  const removeAt = (zone: Zone, index: number) => {
    mutate({ ...deck, [zone]: deck[zone].filter((_, i) => i !== index) });
  };

  const issues = useMemo(() => (deck.enforceLimits ? validateDeck(deck) : []), [deck]);

  return (
    <div className="editor">
      <div className="editor__bar">
        <button className="btn" onClick={tryExit}>← Decks</button>
        <input
          className="editor__name"
          value={deck.name}
          onChange={(e) => mutate({ ...deck, name: e.target.value })}
        />
        <TagEditor tags={deck.tags} onChange={(tags) => mutate({ ...deck, tags })} />
        <FormatPicker tcg={tcgRevs} genesys={genesysRevs} value={format} onChange={setFormat} />
        <label className="editor__toggle">
          <input
            type="checkbox"
            checked={deck.enforceLimits}
            onChange={(e) => mutate({ ...deck, enforceLimits: e.target.checked })}
          />
          Enforce limits
        </label>
        <div className="editor__spacer" />
        {mode === "genesys" && (
          <span className={`editor__points${overCap ? " editor__points--over" : ""}`}>
            {genesysTotal}
            {genesysLookup?.pointCap != null ? ` / ${genesysLookup.pointCap}` : ""} pts
          </span>
        )}
        {issues.length > 0 && (
          <span className="editor__issues">
            {issues.filter((i) => i.level === "error").length
              ? "⚠ " + issues.find((i) => i.level === "error")!.message
              : "• " + issues[0]!.message}
          </span>
        )}
        <button className="btn btn--primary" onClick={save} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>

      <div className="editor__body">
        <DeckViewerPanel
          card={preview} mode={mode}
          status={preview ? statusOf(preview) : null}
          cost={preview ? costOf(preview) : 0}
        />

        <div className="editor__zones">
          <DeckZone
            label="Main" zone="main" deck={deck} byId={byId} rows={4} mode={mode} statusOf={statusOf} costOf={costOf}
            limit={deck.enforceLimits ? `${deck.main.length} / ${LIMITS.mainMin}–${LIMITS.mainMax}` : `${deck.main.length}`}
            onHover={setPreview} onDrop={(e) => drop("main", e)} onRemoveAt={(i) => removeAt("main", i)}
          />
          <DeckZone
            label="Extra" zone="extra" deck={deck} byId={byId} rows={1} mode={mode} statusOf={statusOf} costOf={costOf}
            limit={deck.enforceLimits ? `${deck.extra.length} / ${LIMITS.extraMax}` : `${deck.extra.length}`}
            onHover={setPreview} onDrop={(e) => drop("extra", e)} onRemoveAt={(i) => removeAt("extra", i)}
          />
          <DeckZone
            label="Side" zone="side" deck={deck} byId={byId} rows={1} mode={mode} statusOf={statusOf} costOf={costOf}
            limit={deck.enforceLimits ? `${deck.side.length} / ${LIMITS.sideMax}` : `${deck.side.length}`}
            onHover={setPreview} onDrop={(e) => drop("side", e)} onRemoveAt={(i) => removeAt("side", i)}
          />
        </div>

        <SearchPanel
          cards={cards}
          onHover={setPreview}
          onAdd={(card) => add(card, "main")}
          copiesOf={(id) => copiesOf(deck, id)}
          mode={mode}
          statusOf={statusOf}
          costOf={costOf}
        />
      </div>
    </div>
  );
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }): JSX.Element {
  const [val, setVal] = useState("");
  const add = () => {
    const t = val.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setVal("");
  };
  return (
    <div className="tagedit">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
          <button className="tag__x" onClick={() => onChange(tags.filter((x) => x !== t))}>×</button>
        </span>
      ))}
      <input
        className="tagedit__input"
        value={val}
        placeholder="+ tag"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

/** Short label + class suffix for a ban status. */
function statusBadge(status: BanStatus): { label: string; cls: string } | null {
  switch (status) {
    case "Forbidden": return { label: "Forbidden", cls: "forbidden" };
    case "Limited": return { label: "Limited", cls: "limited" };
    case "Semi-Limited": return { label: "Semi", cls: "semi" };
    case "Unreleased": return { label: "Unreleased", cls: "unreleased" };
    default: return null; // Unlimited → no badge
  }
}

function DeckViewerPanel({ card, mode, status, cost }: { card: CardData | null; mode: FormatMode; status: BanStatus | null; cost: number }): JSX.Element {
  if (!card) {
    return (
      <aside className="editor__viewer">
        <img className="cards__viewer-art" src={cardBack} alt="Card back" />
      </aside>
    );
  }
  const stats =
    supertypeOf(card) === "Monster"
      ? [card.attribute, card.race, card.level != null ? `Lv ${card.level}` : null].filter(Boolean).join(" · ")
      : [card.type, card.race].filter(Boolean).join(" · ");
  const badge = status ? statusBadge(status) : null;
  return (
    <aside className="editor__viewer">
      <Art id={card.images[0] ?? card.id} name={card.name} cls="cards__viewer-art" />
      <div className="cards__viewer-info">
        <div className="cards__viewer-name">{card.name}</div>
        {mode === "tcg" && (
          <div className={`banbadge banbadge--${badge ? badge.cls : "unlimited"} banbadge--inline`}>
            {badge ? badge.label : "Unlimited"}
          </div>
        )}
        {mode === "genesys" && (
          <div className={`banbadge banbadge--${cost > 0 ? "genesys" : "unlimited"} banbadge--inline`}>
            {cost > 0 ? `${cost} pts` : "Free"}
          </div>
        )}
        <div className="cards__viewer-sub">{stats}</div>
        {supertypeOf(card) === "Monster" && card.atk != null && (
          <div className="cards__viewer-atk">ATK {card.atk} / DEF {card.def ?? "—"}</div>
        )}
        <p className="cards__viewer-desc">{card.desc}</p>
      </div>
    </aside>
  );
}

/** Small corner badge overlaid on a mini tile (zones + search). */
function MiniBadge({ status }: { status: BanStatus }): JSX.Element | null {
  const b = statusBadge(status);
  if (!b) return null;
  return <span className={`minibadge minibadge--${b.cls}`} title={status} />;
}

/** Genesys point cost as a corner chip on a mini tile (hidden when free). */
function MiniPoints({ points }: { points: number }): JSX.Element | null {
  if (points <= 0) return null;
  return <span className="minipts" title={`${points} points`}>{points}</span>;
}

/** Overlay the right badge for the active format on a mini tile. */
function MiniOverlay({ mode, status, cost }: { mode: FormatMode; status: BanStatus; cost: number }): JSX.Element | null {
  if (mode === "tcg") return <MiniBadge status={status} />;
  if (mode === "genesys") return <MiniPoints points={cost} />;
  return null;
}

function DeckZone({
  label, zone, deck, byId, rows, limit, onHover, onDrop, onRemoveAt, mode, statusOf, costOf,
}: {
  label: string; zone: Zone; deck: Deck; byId: Map<number, CardData>; rows: number; limit: string;
  onHover: (c: CardData) => void; onDrop: (e: React.DragEvent) => void; onRemoveAt: (index: number) => void;
  mode: FormatMode; statusOf: (c: CardData) => BanStatus; costOf: (c: CardData) => number;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const ids = deck[zone]; // each copy is its own tile — no grouping

  // Columns: Main keeps `rows` rows and grows columns 10→15; Extra/Side are a
  // single row that grows 10→15. Beyond BASE_COLS, cards overlap to fit.
  const need = rows > 1 ? Math.ceil(ids.length / rows) : ids.length;
  const cols = clamp(need, BASE_COLS, MAX_COLS);

  // Card size so BASE_COLS fill the measured width; overlap shrinks the step.
  const cw = width > 0 ? width / BASE_COLS - GAP : 70;
  const ch = cw * CARD_RATIO;
  const fullStep = cw + GAP; // no overlap (cols ≤ 10)
  const step = cols <= BASE_COLS ? fullStep : (width - cw) / (cols - 1);

  return (
    <section className="zone" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="zone__head">
        <span className="zone__label">{label}</span>
        <span className="zone__count">{limit}</span>
      </div>
      <div
        className="zone__grid"
        ref={ref}
        style={{
          gridTemplateColumns: `repeat(${cols}, ${Math.max(1, Math.round(step))}px)`,
          gridAutoRows: `${Math.round(ch)}px`,
          columnGap: 0,
          rowGap: `${GAP}px`,
        }}
      >
        {ids.map((id, index) => {
          const card = byId.get(id);
          return (
            <div
              key={`${id}-${index}`}
              className="mini mini--zone"
              style={{ width: `${Math.round(cw)}px`, height: `${Math.round(ch)}px` }}
              title={card?.name ?? String(id)}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/card-id", String(id))}
              onMouseEnter={() => card && onHover(card)}
              onClick={() => onRemoveAt(index)}
            >
              <Art id={card?.images[0] ?? id} name={card?.name ?? ""} cls="mini__art" />
              {card && <MiniOverlay mode={mode} status={statusOf(card)} cost={costOf(card)} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SearchPanel({
  cards, onHover, onAdd, copiesOf: copies, mode, statusOf, costOf,
}: {
  cards: CardData[] | null;
  onHover: (c: CardData) => void;
  onAdd: (c: CardData) => void;
  copiesOf: (id: number) => number;
  mode: FormatMode;
  statusOf: (c: CardData) => BanStatus;
  costOf: (c: CardData) => number;
}): JSX.Element {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [supertype, setSupertype] = useState("");
  const [attribute, setAttribute] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(t);
  }, [text]);

  const prepared: PreparedCard[] | null = useMemo(() => (cards ? prepareCards(cards) : null), [cards]);
  const facets = useMemo(() => (cards ? deriveFacets(cards) : null), [cards]);

  const query: CardQuery = useMemo(() => {
    const q: CardQuery = {};
    if (debounced) q.text = debounced;
    if (supertype) q.supertype = supertype as CardSupertype;
    if (attribute) q.attribute = attribute;
    return q;
  }, [debounced, supertype, attribute]);

  const results = useMemo(() => (prepared ? runQuery(prepared, query) : []), [prepared, query]);

  return (
    <div className="searchpanel">
      <div className="searchpanel__filters">
        <input
          className="cards__input"
          placeholder="Search name & text…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="searchpanel__row">
          <select className="cards__input" value={supertype} onChange={(e) => setSupertype(e.target.value)}>
            <option value="">Any type</option>
            {SUPERTYPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="cards__input" value={attribute} onChange={(e) => setAttribute(e.target.value)}>
            <option value="">Any attr</option>
            {facets?.attributes.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="searchpanel__meta">{results.length.toLocaleString()} results — drag or double-click to add</div>
      </div>
      <div className="searchpanel__grid">
        {results.slice(0, RESULT_CAP).map((c) => (
          <div
            key={c.id}
            className="mini"
            title={`${c.name}${copies(c.id) ? ` (in deck ×${copies(c.id)})` : ""}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/card-id", String(c.id))}
            onMouseEnter={() => onHover(c)}
            onDoubleClick={() => onAdd(c)}
          >
            <Art id={c.images[0] ?? c.id} name={c.name} cls="mini__art" />
            <MiniOverlay mode={mode} status={statusOf(c)} cost={costOf(c)} />
            {copies(c.id) > 0 && <span className="mini__count mini__count--dim">{copies(c.id)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Format picker: quick-pick the last 2 Advanced (TCG) + last 2 Genesys lists,
// with a clock that reveals the full history of each format on hover so the
// menu stays short.
// ---------------------------------------------------------------------------
interface FmtRow {
  date: string;
  detail: string;
}

function FormatPicker({
  tcg, genesys, value, onChange,
}: {
  tcg: BanlistRevisionMeta[]; // index.json order: newest-first
  genesys: GenesysRevisionMeta[]; // index.json order: newest-first
  value: FormatSel | null;
  onChange: (sel: FormatSel | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const label =
    !value ? "None" : value.kind === "tcg" ? `Advanced · ${value.date}` : `Genesys · ${value.date}`;

  const pick = (sel: FormatSel | null) => {
    onChange(sel);
    setOpen(false);
  };

  const tcgRows: FmtRow[] = tcg.map((r) => ({
    date: r.date,
    detail: `${r.forbidden}F · ${r.limited}L · ${r.semiLimited}S`,
  }));
  const genesysRows: FmtRow[] = genesys.map((r) => ({
    date: r.date,
    detail: r.pointCap != null ? `${r.pointCap} pts` : `${r.cardCount} cards`,
  }));

  return (
    <div className="fmtpick" ref={ref}>
      <span className="cards__label">Format</span>
      <button type="button" className="fmtpick__btn" onClick={() => setOpen((o) => !o)}>
        <span className="fmtpick__btn-label">{label}</span>
        <span className="fmtpick__caret">▾</span>
      </button>
      {open && (
        <div className="fmtpick__menu">
          <button
            type="button"
            className={`fmtpick__item${value === null ? " is-active" : ""}`}
            onClick={() => pick(null)}
          >
            None
          </button>
          <FormatGroup title="Advanced" kind="tcg" rows={tcgRows} value={value} onPick={pick} />
          <FormatGroup title="Genesys" kind="genesys" rows={genesysRows} value={value} onPick={pick} />
        </div>
      )}
    </div>
  );
}

function FormatGroup({
  title, kind, rows, value, onPick,
}: {
  title: string;
  kind: "tcg" | "genesys";
  rows: FmtRow[];
  value: FormatSel | null;
  onPick: (sel: FormatSel) => void;
}): JSX.Element {
  const [showHistory, setShowHistory] = useState(false);
  const recent = rows.slice(0, 2); // newest-first → the last 2 revisions

  const itemRow = (r: FmtRow) => (
    <button
      key={r.date}
      type="button"
      className={`fmtpick__item${value?.kind === kind && value.date === r.date ? " is-active" : ""}`}
      onClick={() => onPick({ kind, date: r.date })}
    >
      <span className="fmtpick__date">{r.date}</span>
      <span className="fmtpick__detail">{r.detail}</span>
    </button>
  );

  return (
    <div className="fmtpick__group">
      <div className="fmtpick__grouphead">
        <span className="fmtpick__grouptitle">{title}</span>
        {rows.length > recent.length && (
          <div
            className="fmtpick__history"
            onMouseEnter={() => setShowHistory(true)}
            onMouseLeave={() => setShowHistory(false)}
          >
            <button type="button" className="fmtpick__clock" title={`All ${title} lists`} aria-label={`All ${title} lists`}>
              🕘
            </button>
            {showHistory && <div className="fmtpick__flyout">{rows.map(itemRow)}</div>}
          </div>
        )}
      </div>
      {recent.map(itemRow)}
    </div>
  );
}

function Art({ id, name, cls }: { id: number; name: string; cls: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  if (failed || !window.duel?.cards) {
    // Art not downloaded (or bridge unavailable) → fall back to the card sleeve.
    return <img className={cls} src={cardBack} alt={name || "Card back"} loading="lazy" />;
  }
  return (
    <img className={cls} src={window.duel.cards.imageUrl(id)} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  );
}
