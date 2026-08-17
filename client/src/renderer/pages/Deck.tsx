import { useEffect, useMemo, useRef, useState } from "react";
import type { CardData, CardQuery, CardSort, CardSupertype, Deck, DeckSummary } from "@duel/shared";
import { runQuery, prepareCards, deriveFacets } from "../cards/search.ts";
import type { PreparedCard } from "../cards/search.ts";
import { parseYdk, serializeYdk, safeFilename, toDeckListText, toDeckJson } from "../cards/deck-io.ts";
import { stepIndex, rangeInclusive, type ArrowKey } from "../cards/grid-nav.ts";
import { CardViewer } from "./CardViewer.tsx";
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
import cardBack from "../../../../ui/assets/sleeves/original_card_sleeve.png";

const RESULT_CAP = 120;

const SORTS: Array<{ value: CardSort; label: string }> = [
  { value: "name", label: "Sort: Name" },
  { value: "atk-desc", label: "Sort: ATK ↓" },
  { value: "atk-asc", label: "Sort: ATK ↑" },
  { value: "level-desc", label: "Sort: Level ↓" },
  { value: "level-asc", label: "Sort: Level ↑" },
  { value: "type", label: "Sort: Type" },
  { value: "newest", label: "Sort: Newest" },
];

const TYPE_CHIPS: Array<{ value: CardSupertype; label: string }> = [
  { value: "Monster", label: "Monster" },
  { value: "Spell", label: "Spell" },
  { value: "Trap", label: "Trap" },
];
const FRAME_CHIPS: Array<{ value: string; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "effect", label: "Effect" },
  { value: "ritual", label: "Ritual" },
  { value: "fusion", label: "Fusion" },
  { value: "synchro", label: "Synchro" },
  { value: "xyz", label: "Xyz" },
  { value: "link", label: "Link" },
  { value: "pendulum", label: "Pendulum" },
];
const ATTRIBUTE_CHIPS = ["LIGHT", "DARK", "EARTH", "WATER", "FIRE", "WIND", "DIVINE"];
const LEVELS = Array.from({ length: 13 }, (_, i) => i + 1);

function toggleValue<T>(arr: readonly T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

type ExportFormat = "ydk" | "txt" | "json" | "png";

type GridKey = Zone | "pool";

interface Selection {
  grid: GridKey;
  anchor: number;
  focus: number;
  indices: number[];
}

const EMPTY_SELECTION: ReadonlySet<number> = new Set();
const ARROW_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function gridColumns(el: Element): number {
  const tpl = getComputedStyle(el).gridTemplateColumns;
  if (!tpl || tpl === "none") return 1;
  return tpl.split(" ").filter(Boolean).length;
}

type FormatMode = "none" | "tcg" | "genesys";
interface FormatSel {
  kind: "tcg" | "genesys";
  date: string;
}
const BASE_COLS = 10;
const MAX_COLS = 15;
const GAP = 6;
const CARD_RATIO = 1185 / 813;

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

function DeckEditor({ initial, onExit }: { initial: Deck; onExit: () => void }): JSX.Element {
  const [deck, setDeck] = useState<Deck>(initial);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<CardData | null>(null);
  const [pinned, setPinned] = useState<CardData | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [flash, setFlash] = useState("");

  const shown = pinned ?? preview;

  const selectedFor = (grid: GridKey): ReadonlySet<number> =>
    sel && sel.grid === grid ? new Set(sel.indices) : EMPTY_SELECTION;

  const selectCard = (grid: GridKey, index: number, card: CardData, e: React.MouseEvent) => {
    if (e.shiftKey && sel && sel.grid === grid) {
      setPinned(card);
      setSel({ grid, anchor: sel.anchor, focus: index, indices: rangeInclusive(sel.anchor, index) });
      return;
    }
    if (sel && sel.grid === grid && sel.indices.length === 1 && sel.focus === index) {
      setPinned(null);
      setSel(null);
      return;
    }
    setPinned(card);
    setSel({ grid, anchor: index, focus: index, indices: [index] });
  };

  const [cards, setCards] = useState<CardData[] | null>(null);
  const byId = useMemo(() => {
    const m = new Map<number, CardData>();
    if (cards) for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  useEffect(() => {
    window.duel?.cards?.load().then((c) => setCards(c ?? [])).catch(() => setCards([]));
  }, []);

  const [tcgRevs, setTcgRevs] = useState<BanlistRevisionMeta[]>([]);
  const [genesysRevs, setGenesysRevs] = useState<GenesysRevisionMeta[]>([]);
  const [format, setFormat] = useState<FormatSel | null>(null);
  const [tcgLookup, setTcgLookup] = useState<BanlistLookup | null>(null);
  const [genesysLookup, setGenesysLookup] = useState<GenesysLookup | null>(null);

  useEffect(() => {
    window.duel?.banlists?.list().then((revs) => setTcgRevs(revs ?? [])).catch(() => setTcgRevs([]));
    window.duel?.genesys?.list().then((revs) => setGenesysRevs(revs ?? [])).catch(() => setGenesysRevs([]));
  }, []);

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

  const flashMsg = (msg: string) => {
    setFlash(msg);
    if (msg) window.setTimeout(() => setFlash((cur) => (cur === msg ? "" : cur)), 2600);
  };

  const nameOf = (id: number): string => byId.get(id)?.name ?? `#${id}`;
  const YDK_FILTERS = [{ name: "YDK Deck", extensions: ["ydk"] }];

  const doImport = async () => {
    if (!window.duel?.io) return;
    const res = await window.duel.io.open({ filters: YDK_FILTERS });
    if (!res.ok || res.text == null) {
      if (!res.canceled) flashMsg("Import failed");
      return;
    }
    const zones = parseYdk(res.text);
    const base = (res.name ?? "").replace(/\.ydk$/i, "").trim();
    mutate({
      ...deck,
      main: zones.main,
      extra: zones.extra,
      side: zones.side,
      ...(base ? { name: base } : {}),
    });
    flashMsg(`Imported ${zones.main.length}+${zones.extra.length}+${zones.side.length}`);
  };

  const exportDeck = async (fmt: ExportFormat) => {
    if (!window.duel?.io) return;
    const base = safeFilename(deck.name);
    try {
      let data: string;
      let encoding: "utf8" | "base64" = "utf8";
      let filter: { name: string; extensions: string[] };
      if (fmt === "ydk") {
        data = serializeYdk(deck);
        filter = { name: "YDK Deck", extensions: ["ydk"] };
      } else if (fmt === "txt") {
        data = toDeckListText(deck, nameOf);
        filter = { name: "Text", extensions: ["txt"] };
      } else if (fmt === "json") {
        data = toDeckJson(deck, (id) => byId.get(id), nowIso());
        filter = { name: "JSON", extensions: ["json"] };
      } else {
        flashMsg("Rendering image…");
        const dataUrl = await renderDeckPng(deck, byId);
        data = dataUrl.split(",")[1] ?? "";
        encoding = "base64";
        filter = { name: "PNG Image", extensions: ["png"] };
      }
      const res = await window.duel.io.save({
        defaultName: `${base}.${fmt}`,
        data,
        encoding,
        filters: [filter],
      });
      if (res.ok) flashMsg(`Exported ${base}.${fmt}`);
      else if (res.canceled) flashMsg("");
      else flashMsg("Export failed");
    } catch (err) {
      flashMsg("Export failed");
      console.error("[deck export]", err);
    }
  };

  const add = (card: CardData, zone: Zone) => {
    const r = addCard(deck, card, zone);
    if (r.ok) mutate(r.deck);
  };

  const addManyTo = (cards: CardData[], zone: Zone) => {
    let d = deck;
    for (const c of cards) {
      const r = addCard(d, c, zone);
      if (r.ok) d = r.deck;
    }
    if (d !== deck) mutate(d);
  };

  const dragRef = useRef<{ from: GridKey; indices: number[]; cards: CardData[] } | null>(null);
  const droppedHandledRef = useRef(false);

  const pickUp = (zone: Zone, index: number, id: number, e: React.DragEvent) => {
    e.dataTransfer.setData("text/card-id", String(id));
    e.dataTransfer.effectAllowed = "move";
    const inSel = !!sel && sel.grid === zone && sel.indices.includes(index);
    const indices = inSel ? [...sel.indices].sort((a, b) => a - b) : [index];
    const cards = indices.map((i) => byId.get(deck[zone][i]!)).filter((c): c is CardData => !!c);
    dragRef.current = { from: zone, indices, cards };
    droppedHandledRef.current = false;
  };

  const beginPoolDrag = (cards: CardData[]) => {
    dragRef.current = { from: "pool", indices: [], cards };
    droppedHandledRef.current = false;
  };

  const removeDragged = () => {
    const d = dragRef.current;
    if (!d || d.from === "pool") return;
    const gone = new Set(d.indices);
    mutate({ ...deck, [d.from]: deck[d.from].filter((_, i) => !gone.has(i)) });
  };

  const dropOutside = (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragRef.current || dragRef.current.from === "pool") return;
    droppedHandledRef.current = true;
    removeDragged();
  };

  const endDrag = () => {
    if (!droppedHandledRef.current) removeDragged();
    dragRef.current = null;
    droppedHandledRef.current = false;
    setSel(null);
  };

  const drop = (zone: Zone, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    droppedHandledRef.current = true;
    const payload = dragRef.current;
    if (payload && payload.from === zone) {
      const arr = deck[zone];
      const tile = (e.target as HTMLElement).closest("[data-index]") as HTMLElement | null;
      let insertAt = arr.length;
      if (tile?.dataset.index != null) {
        const i = Number(tile.dataset.index);
        const rect = tile.getBoundingClientRect();
        insertAt = e.clientX > rect.left + rect.width / 2 ? i + 1 : i;
      }
      const src = payload.indices;
      const movingSet = new Set(src);
      const moved = src.map((i) => arr[i]).filter((x): x is number => x != null);
      const remaining = arr.filter((_, i) => !movingSet.has(i));
      const adj = Math.max(0, insertAt - src.filter((i) => i < insertAt).length);
      const next = [...remaining.slice(0, adj), ...moved, ...remaining.slice(adj)];
      if (next.join() !== arr.join()) mutate({ ...deck, [zone]: next });
      return;
    }
    if (!payload) {
      const id = Number(e.dataTransfer.getData("text/card-id"));
      const card = byId.get(id);
      if (card) add(card, zone);
      return;
    }
    if (payload.from === "pool") {
      addManyTo(payload.cards, zone);
      return;
    }
    let d = deck;
    for (const c of payload.cards) {
      const at = d[payload.from].indexOf(c.id);
      if (at < 0) continue;
      const afterRemove: Deck = { ...d, [payload.from]: d[payload.from].filter((_, i) => i !== at) };
      const r = addCard(afterRemove, c, zone);
      if (r.ok) d = r.deck;
    }
    if (d !== deck) mutate(d);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) {
        return;
      }

      if (ARROW_KEYS.has(e.key)) {
        if (!sel) return;
        const gridEl = document.querySelector(`[data-grid="${sel.grid}"]`);
        if (!gridEl || gridEl.children.length === 0) return;
        e.preventDefault();
        const next = stepIndex(sel.focus, e.key as ArrowKey, gridColumns(gridEl), gridEl.children.length);
        const tile = gridEl.children[next] as HTMLElement | undefined;
        setPinned(tile ? byId.get(Number(tile.dataset.cardId)) ?? null : null);
        if (e.shiftKey) setSel({ grid: sel.grid, anchor: sel.anchor, focus: next, indices: rangeInclusive(sel.anchor, next) });
        else setSel({ grid: sel.grid, anchor: next, focus: next, indices: [next] });
        return;
      }

      if (e.key === "Escape") {
        if (sel) { setSel(null); setPinned(null); }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (!sel || sel.grid === "pool") return;
        e.preventDefault();
        const drop = new Set(sel.indices);
        mutate({ ...deck, [sel.grid]: deck[sel.grid].filter((_, i) => !drop.has(i)) });
        setSel(null);
        setPinned(null);
        return;
      }

      if (e.key === "Enter") {
        if (!sel || sel.grid !== "pool") return;
        const gridEl = document.querySelector('[data-grid="pool"]');
        if (!gridEl) return;
        e.preventDefault();
        const cards: CardData[] = [];
        for (const i of sel.indices) {
          const tile = gridEl.children[i] as HTMLElement | undefined;
          const c = tile ? byId.get(Number(tile.dataset.cardId)) : undefined;
          if (c) cards.push(c);
        }
        addManyTo(cards, "main");
        setSel(null);
        setPinned(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, sel, byId]);

  const issues = useMemo(() => (deck.enforceLimits ? validateDeck(deck) : []), [deck]);

  return (
    <div className="editor" onDragOver={(e) => e.preventDefault()} onDrop={dropOutside}>
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
        {flash && <span className="editor__flash">{flash}</span>}
        <button className="btn" onClick={doImport} title="Import a .ydk deck">Import</button>
        <ExportMenu onExport={exportDeck} />
        <button className="btn btn--primary" onClick={save} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>

      <div className="editor__body">
        <DeckViewerPanel
          card={shown} mode={mode} isPinned={pinned != null}
          selectedCount={sel?.indices.length ?? 0}
          status={shown ? statusOf(shown) : null}
          cost={shown ? costOf(shown) : 0}
        />

        <div className="editor__zones" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.stopPropagation()}>
          <DeckZone
            label="Main" zone="main" deck={deck} byId={byId} rows={4} mode={mode} statusOf={statusOf} costOf={costOf}
            limit={deck.enforceLimits ? `${deck.main.length} / ${LIMITS.mainMin}–${LIMITS.mainMax}` : `${deck.main.length}`}
            onHover={setPreview} onSelect={selectCard} selected={selectedFor("main")} onDrop={(e) => drop("main", e)} onPickUp={pickUp} onTileDragEnd={endDrag}
          />
          <DeckZone
            label="Extra" zone="extra" deck={deck} byId={byId} rows={1} mode={mode} statusOf={statusOf} costOf={costOf}
            limit={deck.enforceLimits ? `${deck.extra.length} / ${LIMITS.extraMax}` : `${deck.extra.length}`}
            onHover={setPreview} onSelect={selectCard} selected={selectedFor("extra")} onDrop={(e) => drop("extra", e)} onPickUp={pickUp} onTileDragEnd={endDrag}
          />
          <DeckZone
            label="Side" zone="side" deck={deck} byId={byId} rows={1} mode={mode} statusOf={statusOf} costOf={costOf}
            limit={deck.enforceLimits ? `${deck.side.length} / ${LIMITS.sideMax}` : `${deck.side.length}`}
            onHover={setPreview} onSelect={selectCard} selected={selectedFor("side")} onDrop={(e) => drop("side", e)} onPickUp={pickUp} onTileDragEnd={endDrag}
          />
        </div>

        <SearchPanel
          cards={cards}
          onHover={setPreview}
          onSelect={selectCard}
          selected={selectedFor("pool")}
          onResultsChange={() => setSel((s) => (s?.grid === "pool" ? null : s))}
          onDragStart={(dragged) => beginPoolDrag(dragged)}
          onTileDragEnd={endDrag}
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

function ExportMenu({ onExport }: { onExport: (fmt: ExportFormat) => void }): JSX.Element {
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

  const pick = (fmt: ExportFormat) => {
    setOpen(false);
    onExport(fmt);
  };

  const items: Array<{ fmt: ExportFormat; ext: string; hint: string }> = [
    { fmt: "ydk", ext: ".ydk", hint: "EDOPro / YGOPro" },
    { fmt: "txt", ext: ".txt", hint: "Readable list" },
    { fmt: "json", ext: ".json", hint: "Structured data" },
    { fmt: "png", ext: ".png", hint: "Deck image" },
  ];

  return (
    <div className="exportmenu" ref={ref}>
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)}>
        Export ▾
      </button>
      {open && (
        <div className="exportmenu__menu">
          {items.map((it) => (
            <button key={it.fmt} type="button" className="exportmenu__item" onClick={() => pick(it.fmt)}>
              <span className="exportmenu__ext">{it.ext}</span>
              <span className="exportmenu__hint">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function statusBadge(status: BanStatus): { label: string; cls: string } | null {
  switch (status) {
    case "Forbidden": return { label: "Forbidden", cls: "forbidden" };
    case "Limited": return { label: "Limited", cls: "limited" };
    case "Semi-Limited": return { label: "Semi", cls: "semi" };
    case "Unreleased": return { label: "Unreleased", cls: "unreleased" };
    default: return null;
  }
}

function DeckViewerPanel({ card, mode, status, cost, isPinned, selectedCount }: { card: CardData | null; mode: FormatMode; status: BanStatus | null; cost: number; isPinned: boolean; selectedCount: number }): JSX.Element {
  const tile = card ? { card, imageId: card.images[0] ?? card.id } : null;
  const sb = status ? statusBadge(status) : null;
  const badge =
    mode === "tcg" ? (
      <div className={`banbadge banbadge--${sb ? sb.cls : "unlimited"} banbadge--inline`}>
        {sb ? sb.label : "Unlimited"}
      </div>
    ) : mode === "genesys" ? (
      <div className={`banbadge banbadge--${cost > 0 ? "genesys" : "unlimited"} banbadge--inline`}>
        {cost > 0 ? `${cost} pts` : "Free"}
      </div>
    ) : undefined;
  const pinLabel = isPinned ? (selectedCount > 1 ? `${selectedCount} selected` : "Pinned") : undefined;
  return <CardViewer tile={tile} badge={badge} pinLabel={pinLabel} />;
}

function MiniBadge({ status }: { status: BanStatus }): JSX.Element | null {
  const b = statusBadge(status);
  if (!b) return null;
  return <span className={`minibadge minibadge--${b.cls}`} title={status} />;
}

function MiniPoints({ points }: { points: number }): JSX.Element | null {
  if (points <= 0) return null;
  return <span className="minipts" title={`${points} points`}>{points}</span>;
}

function MiniOverlay({ mode, status, cost }: { mode: FormatMode; status: BanStatus; cost: number }): JSX.Element | null {
  if (mode === "tcg") return <MiniBadge status={status} />;
  if (mode === "genesys") return <MiniPoints points={cost} />;
  return null;
}

function DeckZone({
  label, zone, deck, byId, rows, limit, onHover, onSelect, selected, onDrop, onPickUp, onTileDragEnd, mode, statusOf, costOf,
}: {
  label: string; zone: Zone; deck: Deck; byId: Map<number, CardData>; rows: number; limit: string;
  onHover: (c: CardData) => void;
  onSelect: (grid: GridKey, index: number, card: CardData, e: React.MouseEvent) => void;
  selected: ReadonlySet<number>;
  onDrop: (e: React.DragEvent) => void;
  onPickUp: (zone: Zone, index: number, id: number, e: React.DragEvent) => void;
  onTileDragEnd: () => void;
  mode: FormatMode; statusOf: (c: CardData) => BanStatus; costOf: (c: CardData) => number;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const ids = deck[zone];

  const need = rows > 1 ? Math.ceil(ids.length / rows) : ids.length;
  const cols = clamp(need, BASE_COLS, MAX_COLS);

  const cw = width > 0 ? width / BASE_COLS - GAP : 70;
  const ch = cw * CARD_RATIO;
  const fullStep = cw + GAP;
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
        data-grid={zone}
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
              className={`mini mini--zone${selected.has(index) ? " mini--pinned" : ""}`}
              style={{ width: `${Math.round(cw)}px`, height: `${Math.round(ch)}px` }}
              data-card-id={id}
              data-index={index}
              title={`${card?.name ?? String(id)} — click to pin, Shift+Arrow to select more (Delete removes), drag out to remove`}
              draggable
              onDragStart={(e) => onPickUp(zone, index, id, e)}
              onDragEnd={onTileDragEnd}
              onMouseEnter={() => card && onHover(card)}
              onClick={(e) => card && onSelect(zone, index, card, e)}
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
  cards, onHover, onSelect, selected, onResultsChange, onDragStart, onTileDragEnd, onAdd, copiesOf: copies, mode, statusOf, costOf,
}: {
  cards: CardData[] | null;
  onHover: (c: CardData) => void;
  onSelect: (grid: GridKey, index: number, card: CardData, e: React.MouseEvent) => void;
  selected: ReadonlySet<number>;
  onResultsChange: () => void;
  onDragStart: (cards: CardData[], e: React.DragEvent) => void;
  onTileDragEnd: () => void;
  onAdd: (c: CardData) => void;
  copiesOf: (id: number) => number;
  mode: FormatMode;
  statusOf: (c: CardData) => BanStatus;
  costOf: (c: CardData) => number;
}): JSX.Element {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [classes, setClasses] = useState<CardSupertype[]>([]);
  const [frames, setFrames] = useState<string[]>([]);
  const [attributes, setAttributes] = useState<string[]>([]);
  const [levelMin, setLevelMin] = useState("");
  const [levelMax, setLevelMax] = useState("");
  const [atkMin, setAtkMin] = useState("");
  const [atkMax, setAtkMax] = useState("");
  const [defMin, setDefMin] = useState("");
  const [defMax, setDefMax] = useState("");
  const [race, setRace] = useState("");
  const [archetype, setArchetype] = useState("");
  const [sort, setSort] = useState<CardSort>("name");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(t);
  }, [text]);

  const prepared: PreparedCard[] | null = useMemo(() => (cards ? prepareCards(cards) : null), [cards]);
  const facets = useMemo(() => (cards ? deriveFacets(cards) : null), [cards]);

  const query: CardQuery = useMemo(() => {
    const q: CardQuery = { sort };
    if (debounced) q.text = debounced;
    if (classes.length) q.supertypes = classes;
    if (frames.length) q.frames = frames;
    if (attributes.length) q.attributes = attributes;
    if (race) q.race = race;
    if (archetype) q.archetype = archetype;
    if (levelMin) q.levelMin = Number(levelMin);
    if (levelMax) q.levelMax = Number(levelMax);
    if (atkMin !== "") q.atkMin = Number(atkMin);
    if (atkMax !== "") q.atkMax = Number(atkMax);
    if (defMin !== "") q.defMin = Number(defMin);
    if (defMax !== "") q.defMax = Number(defMax);
    return q;
  }, [debounced, classes, frames, attributes, race, archetype, levelMin, levelMax, atkMin, atkMax, defMin, defMax, sort]);

  const results = useMemo(() => (prepared ? runQuery(prepared, query) : []), [prepared, query]);

  useEffect(() => { onResultsChange(); }, [results]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterCount =
    classes.length + frames.length + attributes.length +
    (levelMin ? 1 : 0) + (levelMax ? 1 : 0) +
    (atkMin !== "" ? 1 : 0) + (atkMax !== "" ? 1 : 0) +
    (defMin !== "" ? 1 : 0) + (defMax !== "" ? 1 : 0) +
    (race ? 1 : 0) + (archetype ? 1 : 0);

  const clearAll = () => {
    setText("");
    setClasses([]);
    setFrames([]);
    setAttributes([]);
    setLevelMin("");
    setLevelMax("");
    setAtkMin("");
    setAtkMax("");
    setDefMin("");
    setDefMax("");
    setRace("");
    setArchetype("");
    setSort("name");
  };

  const startPoolDrag = (index: number, card: CardData, e: React.DragEvent) => {
    e.dataTransfer.setData("text/card-id", String(card.id));
    e.dataTransfer.effectAllowed = "copy";
    const dragged = selected.has(index)
      ? [...selected].sort((a, b) => a - b).map((i) => results[i]).filter((c): c is CardData => !!c)
      : [card];
    onDragStart(dragged, e);
  };

  return (
    <div className="searchpanel">
      <div className="searchpanel__bar">
        <input
          className="cards__input searchpanel__search"
          placeholder="Search cards…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className={`filtoggle${showFilters ? " filtoggle--on" : ""}`}
          title="Filters"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 5h18v2.59L14.41 14v6.41L9.59 18v-3.41L3 8V5z" />
          </svg>
          {filterCount > 0 && <span className="filtoggle__badge">{filterCount}</span>}
        </button>
      </div>

      {showFilters && (
        <div className="filterpanel">
          <div className="fp-group">
            <div className="fp-label">Card Type</div>
            <div className="chipgrid chipgrid--3">
              {TYPE_CHIPS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`chip${classes.includes(t.value) ? " chip--on" : ""}`}
                  onClick={() => setClasses((c) => toggleValue(c, t.value))}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="fp-group">
            <div className="fp-label">Frame</div>
            <div className="chipgrid">
              {FRAME_CHIPS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={`chip${frames.includes(f.value) ? " chip--on" : ""}`}
                  onClick={() => setFrames((s) => toggleValue(s, f.value))}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="fp-group">
            <div className="fp-label">Attribute</div>
            <div className="chipgrid">
              {ATTRIBUTE_CHIPS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`chip${attributes.includes(a) ? " chip--on" : ""}`}
                  onClick={() => setAttributes((s) => toggleValue(s, a))}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div className="fp-group">
            <div className="fp-label">Level / Rank</div>
            <div className="fp-row fp-row--2">
              <select className="cards__input" value={levelMin} onChange={(e) => setLevelMin(e.target.value)}>
                <option value="">Min</option>
                {LEVELS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <select className="cards__input" value={levelMax} onChange={(e) => setLevelMax(e.target.value)}>
                <option value="">Max</option>
                {LEVELS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          <div className="fp-group">
            <div className="fp-label">ATK</div>
            <div className="fp-row fp-row--2">
              <input className="cards__input" type="number" min={0} placeholder="Min" value={atkMin} onChange={(e) => setAtkMin(e.target.value)} />
              <input className="cards__input" type="number" min={0} placeholder="Max" value={atkMax} onChange={(e) => setAtkMax(e.target.value)} />
            </div>
          </div>

          <div className="fp-group">
            <div className="fp-label">DEF</div>
            <div className="fp-row fp-row--2">
              <input className="cards__input" type="number" min={0} placeholder="Min" value={defMin} onChange={(e) => setDefMin(e.target.value)} />
              <input className="cards__input" type="number" min={0} placeholder="Max" value={defMax} onChange={(e) => setDefMax(e.target.value)} />
            </div>
          </div>

          <div className="fp-group">
            <div className="fp-label">Monster Type</div>
            <select className="cards__input" value={race} onChange={(e) => setRace(e.target.value)}>
              <option value="">Any</option>
              {facets?.races.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          <div className="fp-group">
            <div className="fp-label">Archetype</div>
            <select className="cards__input" value={archetype} onChange={(e) => setArchetype(e.target.value)}>
              <option value="">Any</option>
              {facets?.archetypes.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          <button type="button" className="clearbtn" onClick={clearAll}>Clear all</button>
        </div>
      )}

      <div className="poolmeta">
        <span>{results.length.toLocaleString()} cards</span>
        <select
          className="cards__input poolmeta__sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as CardSort)}
        >
          {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div className="searchpanel__grid" data-grid="pool">
        {results.slice(0, RESULT_CAP).map((c, index) => (
          <div
            key={c.id}
            className={`mini${selected.has(index) ? " mini--pinned" : ""}`}
            data-card-id={c.id}
            title={`${c.name}${copies(c.id) ? ` (in deck ×${copies(c.id)})` : ""} — click to pin, Shift+Arrow to select more (Enter or drag adds), double-click to add`}
            draggable
            onDragStart={(e) => startPoolDrag(index, c, e)}
            onDragEnd={onTileDragEnd}
            onMouseEnter={() => onHover(c)}
            onClick={(e) => onSelect("pool", index, c, e)}
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

interface FmtRow {
  date: string;
  detail: string;
}

function FormatPicker({
  tcg, genesys, value, onChange,
}: {
  tcg: BanlistRevisionMeta[];
  genesys: GenesysRevisionMeta[];
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
  const recent = rows.slice(0, 2);

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

function loadImageEl(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function drawCardName(
  ctx: CanvasRenderingContext2D,
  card: CardData | undefined,
  x: number,
  ty: number,
  tileW: number,
): void {
  ctx.fillStyle = "#8a8a8a";
  ctx.font = "20px sans-serif";
  const words = (card?.name ?? "").split(/\s+/);
  const maxLineW = tileW - 20;
  let line = "";
  let yy = ty + 14;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxLineW && line) {
      ctx.fillText(line, x + 10, yy);
      yy += 24;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x + 10, yy);
}

async function renderDeckPng(deck: Deck, byId: Map<number, CardData>): Promise<string> {
  const TILE_W = 280;
  const TILE_H = Math.round(TILE_W * CARD_RATIO);
  const COLS = 10;
  const GAP = 12;
  const PAD = 48;
  const TITLE_H = 84;
  const SECTION_H = 52;
  const SECTION_GAP = 32;

  const sections = [
    { title: "Main Deck", ids: deck.main },
    { title: "Extra Deck", ids: deck.extra },
    { title: "Side Deck", ids: deck.side },
  ].filter((s) => s.ids.length > 0);

  const canvasW = PAD * 2 + COLS * TILE_W + (COLS - 1) * GAP;
  let canvasH = PAD + TITLE_H;
  for (const s of sections) {
    const rows = Math.ceil(s.ids.length / COLS);
    canvasH += SECTION_H + rows * TILE_H + (rows - 1) * GAP + SECTION_GAP;
  }
  canvasH += PAD;

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = Math.max(canvasH, PAD * 2 + TITLE_H + 40);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.textBaseline = "top";

  ctx.fillStyle = "#f0f0f0";
  ctx.font = "bold 52px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(deck.name || "Untitled Deck", PAD, PAD);
  let y = PAD + TITLE_H;

  if (sections.length === 0) {
    ctx.fillStyle = "#888888";
    ctx.font = "30px sans-serif";
    ctx.fillText("(deck is empty)", PAD, y + 16);
  }

  for (const s of sections) {
    ctx.fillStyle = "#9fb6d6";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText(`${s.title.toUpperCase()}   ${s.ids.length}`, PAD, y + 10);
    y += SECTION_H;

    const imgs = await Promise.all(
      s.ids.map((id) => {
        const card = byId.get(id);
        const imageId = card?.images[0] ?? id;
        return loadImageEl(window.duel.cards.imageUrl(imageId));
      }),
    );

    for (let i = 0; i < s.ids.length; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = PAD + col * (TILE_W + GAP);
      const ty = y + row * (TILE_H + GAP);
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(x, ty, TILE_W, TILE_H);
      const img = imgs[i];
      const card = byId.get(s.ids[i]!);
      if (img) {
        try {
          ctx.drawImage(img, x, ty, TILE_W, TILE_H);
        } catch {
          drawCardName(ctx, card, x, ty, TILE_W);
        }
      } else {
        drawCardName(ctx, card, x, ty, TILE_W);
      }
    }
    const rows = Math.ceil(s.ids.length / COLS);
    y += rows * TILE_H + (rows - 1) * GAP + SECTION_GAP;
  }

  return canvas.toDataURL("image/png");
}

function Art({ id, name, cls }: { id: number; name: string; cls: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  if (failed || !window.duel?.cards) {
    return <img className={cls} src={cardBack} alt={name || "Card back"} loading="lazy" />;
  }
  return (
    <img className={cls} src={window.duel.cards.imageUrl(id)} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  );
}
