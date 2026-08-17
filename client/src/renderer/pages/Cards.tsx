import { useEffect, useMemo, useRef, useState } from "react";
import type { CardData, CardQuery, CardSort, CardSupertype, SetData } from "@duel/shared";
import { runQuery, prepareCards, deriveFacets, expandArtworks } from "../cards/search.ts";
import type { ArtworkTile } from "../cards/search.ts";
import { CardDetail } from "./CardDetail.tsx";
import { SetDetail } from "./SetDetail.tsx";
import { ArchetypeDetail } from "./ArchetypeDetail.tsx";
import { AllSets } from "./AllSets.tsx";
import { CardViewer } from "./CardViewer.tsx";
// Card-back shown on a grid tile when its art isn't downloaded.
import cardBack from "../../../../ui/assets/sleeves/original_card_sleeve.png";

const PAGE = 120; // how many tiles to mount initially / reveal per scroll step
const SUPERTYPES: CardSupertype[] = ["Monster", "Spell", "Trap"];

// Grid ordering. Defaults to Newest so the tab opens on the latest release
// rather than raw db.json order. "Best match" is the text-relevance ranking,
// which only does anything while there's a search term. (Deck's pool has its
// own shorter list — no relevance there, since that grid is always filtered.)
const SORTS: Array<{ value: CardSort; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "relevance", label: "Best match" },
  { value: "name", label: "Name" },
  { value: "type", label: "Type" },
  { value: "atk-desc", label: "ATK ↓" },
  { value: "atk-asc", label: "ATK ↑" },
  { value: "def-desc", label: "DEF ↓" },
  { value: "def-asc", label: "DEF ↑" },
  { value: "level-desc", label: "Level ↓" },
  { value: "level-asc", label: "Level ↑" },
];

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty" } // bridge ok, but db.json missing / not imported
  | { status: "ready"; cards: CardData[] };

export function Cards(): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  // Filter inputs.
  const [text, setText] = useState("");
  const [debouncedText, setDebouncedText] = useState("");
  const [supertype, setSupertype] = useState("");
  const [attribute, setAttribute] = useState("");
  const [race, setRace] = useState("");
  const [frameType, setFrameType] = useState("");
  const [archetype, setArchetype] = useState("");
  const [levelMin, setLevelMin] = useState("");
  const [levelMax, setLevelMax] = useState("");
  const [sort, setSort] = useState<CardSort>("newest");

  // Progressive rendering: how many of the matched cards are currently mounted.
  const [visible, setVisible] = useState(PAGE);
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // The artwork shown in the left-side viewer. Updated on hover; stays put
  // (sticky) when the cursor leaves so you can read it.
  const [preview, setPreview] = useState<ArtworkTile | null>(null);

  // In-page navigation stack: empty = the search grid; otherwise the top entry
  // is the open card-, set-, or archetype-detail page. A stack (not a single
  // value) so you can go card → set → card → archetype → … and step back.
  type View =
    | { kind: "card"; card: CardData }
    | { kind: "set"; code: string }
    | { kind: "archetype"; name: string }
    | { kind: "allsets" };
  const [stack, setStack] = useState<View[]>([]);
  const openCard = (card: CardData) => setStack((s) => [...s, { kind: "card", card }]);
  const openSet = (code: string) => setStack((s) => [...s, { kind: "set", code }]);
  const openArchetype = (name: string) => setStack((s) => [...s, { kind: "archetype", name }]);
  const openAllSets = () => setStack((s) => [...s, { kind: "allsets" }]);
  const back = () => setStack((s) => s.slice(0, -1));
  const view = stack[stack.length - 1];

  // Set database, loaded once, to resolve a card's set codes to release dates.
  const [sets, setSets] = useState<SetData[] | null>(null);

  // Load the database once.
  useEffect(() => {
    let alive = true;
    if (!window.duel?.cards) {
      setLoad({ status: "error" });
      return;
    }
    window.duel.cards
      .load()
      .then((cards) => {
        if (!alive) return;
        setLoad(cards && cards.length ? { status: "ready", cards } : { status: "empty" });
      })
      .catch(() => alive && setLoad({ status: "error" }));
    return () => {
      alive = false;
    };
  }, []);

  // Load the set database once, for the detail view's set-release dates.
  useEffect(() => {
    window.duel?.sets?.load().then((s) => setSets(s ?? null)).catch(() => setSets(null));
  }, []);

  // Index sets by code prefix (e.g. "DUAD") so a card print's full code
  // ("DUAD-EN057") resolves to its set's name and release date.
  const setsByPrefix = useMemo(() => {
    const m = new Map<string, SetData>();
    for (const s of sets ?? []) m.set(s.code, s);
    return m;
  }, [sets]);

  // Debounce the free-text input so we don't refilter on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedText(text), 150);
    return () => clearTimeout(t);
  }, [text]);

  const cards = load.status === "ready" ? load.cards : undefined;

  // Pre-lowercase + precompute supertype ONCE when the DB loads, so each
  // subsequent query is a cheap scan instead of re-lowercasing ~14k strings.
  const prepared = useMemo(() => (cards ? prepareCards(cards) : null), [cards]);
  const facets = useMemo(() => (cards ? deriveFacets(cards) : null), [cards]);

  // Build the query with only the constraints that are actually set. Under
  // exactOptionalPropertyTypes, omitting a key is required — assigning
  // `undefined` to an optional field is a type error.
  const query: CardQuery = useMemo(() => {
    const q: CardQuery = {};
    if (debouncedText) q.text = debouncedText;
    if (supertype) q.supertype = supertype as CardSupertype;
    if (attribute) q.attribute = attribute;
    if (race) q.race = race;
    if (frameType) q.frameType = frameType;
    if (archetype) q.archetype = archetype;
    if (levelMin !== "") q.levelMin = Number(levelMin);
    if (levelMax !== "") q.levelMax = Number(levelMax);
    q.sort = sort;
    return q;
  }, [debouncedText, supertype, attribute, race, frameType, archetype, levelMin, levelMax, sort]);

  const results = useMemo(
    () => (prepared ? runQuery(prepared, query) : []),
    [prepared, query],
  );

  // Expand to one tile per artwork (alternate arts each get their own tile).
  const tiles = useMemo(() => expandArtworks(results), [results]);

  // Reset the reveal window and scroll to top whenever the result set changes.
  useEffect(() => {
    setVisible(PAGE);
    gridRef.current?.scrollTo({ top: 0 });
  }, [tiles]);

  // Reveal more as the sentinel scrolls into view (infinite scroll).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = gridRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible((v) => Math.min(v + PAGE, tiles.length));
        }
      },
      { root, rootMargin: "600px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [tiles.length]);

  const resetFilters = () => {
    setText("");
    setSupertype("");
    setAttribute("");
    setRace("");
    setFrameType("");
    setArchetype("");
    setLevelMin("");
    setLevelMax("");
  };

  if (load.status === "loading") {
    return <div className="cards cards--message">Loading card database…</div>;
  }
  if (load.status === "error") {
    return <div className="cards cards--message">Card bridge unavailable.</div>;
  }
  if (load.status === "empty") {
    return (
      <div className="cards cards--message">
        <p>No card database found.</p>
        <p className="cards__hint">
          Run <code>pnpm import:cards</code> to populate{" "}
          <code>engine/cards/db.json</code>, then reopen this tab.
        </p>
      </div>
    );
  }

  // Clicking a tile opens the full-page detail view; back returns to the grid.
  if (view?.kind === "card") {
    return (
      <CardDetail
        card={view.card}
        setsByPrefix={setsByPrefix}
        onOpenSet={openSet}
        onOpenArchetype={openArchetype}
        onBack={back}
      />
    );
  }
  if (view?.kind === "set") {
    return (
      <SetDetail
        code={view.code}
        set={setsByPrefix.get(view.code)}
        cards={cards ?? []}
        onOpenCard={openCard}
        onBack={back}
      />
    );
  }
  if (view?.kind === "archetype") {
    return (
      <ArchetypeDetail name={view.name} cards={cards ?? []} onOpenCard={openCard} onBack={back} />
    );
  }
  if (view?.kind === "allsets") {
    return <AllSets sets={sets ?? []} cards={cards ?? []} onOpenSet={openSet} onBack={back} />;
  }

  const shown = tiles.slice(0, visible);

  return (
    <div className="cards">
      <div className="cards__toolbar">
        <label className="cards__field cards__field--grow">
          <span className="cards__label">Search name &amp; text</span>
          <input
            className="cards__input"
            type="text"
            value={text}
            placeholder="e.g. Blue-Eyes, DUAD-EN068, 89631139…"
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        <label className="cards__field">
          <span className="cards__label">Sort</span>
          <select className="cards__input" value={sort} onChange={(e) => setSort(e.target.value as CardSort)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="cards__field">
          <span className="cards__label">Category</span>
          <select className="cards__input" value={supertype} onChange={(e) => setSupertype(e.target.value)}>
            <option value="">Any</option>
            {SUPERTYPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="cards__field">
          <span className="cards__label">Attribute</span>
          <select className="cards__input" value={attribute} onChange={(e) => setAttribute(e.target.value)}>
            <option value="">Any</option>
            {facets?.attributes.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="cards__field">
          <span className="cards__label">Type</span>
          <select className="cards__input" value={race} onChange={(e) => setRace(e.target.value)}>
            <option value="">Any</option>
            {facets?.races.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label className="cards__field">
          <span className="cards__label">Frame</span>
          <select className="cards__input" value={frameType} onChange={(e) => setFrameType(e.target.value)}>
            <option value="">Any</option>
            {facets?.frameTypes.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>

        <label className="cards__field cards__field--grow">
          <span className="cards__label">Archetype</span>
          <input
            className="cards__input"
            type="text"
            list="cards-archetypes"
            value={archetype}
            placeholder="Any"
            onChange={(e) => setArchetype(e.target.value)}
          />
          <datalist id="cards-archetypes">
            {facets?.archetypes.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>

        <label className="cards__field cards__field--narrow">
          <span className="cards__label">Lvl min</span>
          <input
            className="cards__input"
            type="number"
            min={0}
            max={13}
            value={levelMin}
            onChange={(e) => setLevelMin(e.target.value)}
          />
        </label>

        <label className="cards__field cards__field--narrow">
          <span className="cards__label">Lvl max</span>
          <input
            className="cards__input"
            type="number"
            min={0}
            max={13}
            value={levelMax}
            onChange={(e) => setLevelMax(e.target.value)}
          />
        </label>

        <button className="cards__reset" type="button" onClick={openAllSets}>
          All sets
        </button>
        <button className="cards__reset" type="button" onClick={resetFilters}>
          Reset
        </button>
      </div>

      <div className="cards__body">
        <CardViewer tile={preview} />

        <div className="cards__results">
          <div className="cards__meta">
            {results.length.toLocaleString()} card{results.length === 1 ? "" : "s"}
            {tiles.length !== results.length ? ` · ${tiles.length.toLocaleString()} artworks` : ""}
            {shown.length < tiles.length
              ? ` — showing ${shown.length.toLocaleString()} of ${tiles.length.toLocaleString()} (scroll for more)`
              : ""}
          </div>

          {tiles.length === 0 ? (
            <div className="cards__none">No cards match these filters.</div>
          ) : (
            <div className="cards__grid" ref={gridRef}>
              {shown.map((t) => (
                <CardTile key={t.imageId} tile={t} onHover={setPreview} onSelect={openCard} />
              ))}
              <div ref={sentinelRef} className="cards__sentinel" aria-hidden />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CardTile({
  tile,
  onHover,
  onSelect,
}: {
  tile: ArtworkTile;
  onHover: (t: ArtworkTile) => void;
  onSelect: (c: CardData) => void;
}): JSX.Element {
  // Grid tiles show ONLY the art — name/stats/effect live in the left viewer.
  // Hover previews in the side panel; click opens the full detail page.
  return (
    <article
      className="card-tile"
      title={tile.card.name}
      onMouseEnter={() => onHover(tile)}
      onFocus={() => onHover(tile)}
      onClick={() => onSelect(tile.card)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(tile.card);
        }
      }}
      tabIndex={0}
    >
      <CardArt id={tile.imageId} name={tile.card.name} />
    </article>
  );
}

function CardArt({ id, name }: { id: number; name: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed || !window.duel?.cards) {
    // Art not downloaded (or bridge unavailable) → fall back to the card sleeve.
    return <img className="card-tile__art" src={cardBack} alt={name || "Card back"} loading="lazy" />;
  }
  return (
    <img
      className="card-tile__art"
      src={window.duel.cards.imageUrl(id)}
      alt={name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
