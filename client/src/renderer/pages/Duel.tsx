import { useEffect, useMemo, useRef, useState } from "react";
import type { CardData, Deck, DeckSummary, DuelDifficulty, DuelFormat } from "@duel/shared";
import { DuelBoard } from "./DuelBoard.tsx";
import { OnlineLobby } from "./OnlineLobby.tsx";
import {
  validateDeckForFormat,
  buildBanlistLookup,
  buildGenesysLookup,
  type BanlistLookup,
  type GenesysLookup,
} from "../cards/deck.ts";

type StartOpts = { seed?: string | undefined; opponent?: "goldfish" | "ai" | undefined; difficulty?: DuelDifficulty | undefined; aiDeckId?: string | undefined };

type Stage =
  | { view: "menu" }
  | { view: "setup"; mode: string }
  | { view: "play"; mode: string; deckId: string; opts: StartOpts }
  | { view: "online" }
  | { view: "netplay"; deckId: string; format: DuelFormat };

const MODES: { key: string; cls: string; ready: boolean }[] = [
  { key: "Advanced", cls: "duel-card--g1", ready: true },
  { key: "Genesys", cls: "duel-card--g2", ready: true },
  { key: "Number Hunters", cls: "duel-card--g3", ready: true },
  { key: "Action Duels", cls: "duel-card--g4", ready: true },
  { key: "Draft & Sealed Play", cls: "duel-card--g5", ready: true },
];

export function Duel(): JSX.Element {
  const [stage, setStage] = useState<Stage>({ view: "menu" });

  if (stage.view === "play") {
    return (
      <DuelBoard
        deckId={stage.deckId}
        format={stage.mode === "Genesys" ? "genesys" : "advanced"}
        seed={stage.opts.seed}
        opponent={stage.opts.opponent}
        difficulty={stage.opts.difficulty}
        aiDeckId={stage.opts.aiDeckId}
        onExit={() => setStage({ view: "menu" })}
      />
    );
  }
  if (stage.view === "netplay") {
    return (
      <DuelBoard
        deckId={stage.deckId}
        format={stage.format}
        networked
        onExit={() => { window.duel.net?.leave().catch(() => {}); setStage({ view: "menu" }); }}
      />
    );
  }
  if (stage.view === "online") {
    return (
      <OnlineLobby
        onBack={() => setStage({ view: "menu" })}
        onPlay={(deckId, format) => setStage({ view: "netplay", deckId, format })}
      />
    );
  }
  if (stage.view === "setup") {
    return (
      <DuelSetup
        mode={stage.mode}
        onBack={() => setStage({ view: "menu" })}
        onStart={(deckId, opts) => setStage({ view: "play", mode: stage.mode, deckId, opts })}
      />
    );
  }

  const open = (mode: string) => setStage({ view: "setup", mode });
  return (
    <div className="duel-menu">
      <div className="duel-grid">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`duel-card ${m.cls}${m.ready ? "" : " is-soon"}`}
            onClick={m.ready ? () => open(m.key) : undefined}
            disabled={!m.ready}
            title={m.ready ? m.key : `${m.key} — coming soon`}
          >
            <span className="duel-card__label">{m.key}</span>
            {!m.ready && <span className="duel-card__soon">Coming soon</span>}
          </button>
        ))}
      </div>
      <div className="duel-online-bar">
        <button className="btn btn--primary" onClick={() => setStage({ view: "online" })}>🌐 Online Play (friends)</button>
      </div>
    </div>
  );
}

function DuelSetup({ mode, onBack, onStart }: { mode: string; onBack: () => void; onStart: (deckId: string, opts: StartOpts) => void }): JSX.Element {
  const format: DuelFormat = mode === "Genesys" ? "genesys" : "advanced";
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [seed, setSeed] = useState("");
  const [oppMode, setOppMode] = useState<"goldfish" | "duelbot">("goldfish");
  const AI_DEFAULT_DECK = "__default__";
  const [aiDeckSel, setAiDeckSel] = useState<string>(AI_DEFAULT_DECK);
  const [aiDeck, setAiDeck] = useState<Deck | null>(null);
  const [aiDeckFailed, setAiDeckFailed] = useState(false);

  const cardsRef = useRef<Map<number, CardData>>(new Map());
  const [banlist, setBanlist] = useState<BanlistLookup | null>(null);
  const [genesys, setGenesys] = useState<GenesysLookup | null>(null);
  const [ctxReady, setCtxReady] = useState(false);
  const [selectedDeck, setSelectedDeck] = useState<Deck | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    window.duel?.decks?.list().then((d) => {
      setDecks(d ?? []);
      if (d && d.length) setSelected(d[0]!.id);
    }).catch(() => setDecks([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setCtxReady(false);
    const tasks: Promise<unknown>[] = [];
    tasks.push((window.duel?.cards?.load() ?? Promise.resolve(null)).then((cards) => {
      if (!alive) return;
      const m = new Map<number, CardData>();
      for (const c of cards ?? []) m.set(c.id, c);
      cardsRef.current = m;
      bump((n) => n + 1);
    }).catch(() => {}));
    if (format === "genesys") {
      tasks.push((window.duel?.genesys?.list() ?? Promise.resolve([])).then(async (metas) => {
        const date = metas?.[0]?.date;
        const rev = date ? await window.duel.genesys.load(date) : null;
        if (alive && rev) setGenesys(buildGenesysLookup(rev));
      }).catch(() => {}));
    } else {
      tasks.push((window.duel?.banlists?.list() ?? Promise.resolve([])).then(async (metas) => {
        const date = metas?.[0]?.date;
        const rev = date ? await window.duel.banlists.load(date) : null;
        if (alive && rev) setBanlist(buildBanlistLookup(rev));
      }).catch(() => {}));
    }
    Promise.all(tasks).then(() => { if (alive) setCtxReady(true); });
    return () => { alive = false; };
  }, [format]);

  useEffect(() => {
    if (!selected) { setSelectedDeck(null); return; }
    let alive = true;
    window.duel?.decks?.load(selected)
      .then((d) => { if (alive) setSelectedDeck(d); })
      .catch(() => { if (alive) setSelectedDeck(null); });
    return () => { alive = false; };
  }, [selected]);

  useEffect(() => {
    if (aiDeckSel === AI_DEFAULT_DECK) { setAiDeck(null); setAiDeckFailed(false); return; }
    let alive = true;
    setAiDeckFailed(false);
    window.duel?.decks?.load(aiDeckSel)
      .then((d) => { if (alive) { setAiDeck(d); setAiDeckFailed(!d); } })
      .catch(() => { if (alive) { setAiDeck(null); setAiDeckFailed(true); } });
    return () => { alive = false; };
  }, [aiDeckSel]);

  const issues = useMemo(() => {
    if (!selectedDeck || !ctxReady) return [];
    return validateDeckForFormat(selectedDeck, format, { cards: cardsRef.current, banlist, genesys });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeck, ctxReady, banlist, genesys, format]);

  const aiUsingCustom = oppMode !== "goldfish" && aiDeckSel !== AI_DEFAULT_DECK;
  const aiIssues = useMemo(() => {
    if (!aiUsingCustom || !aiDeck || !ctxReady) return [];
    return validateDeckForFormat(aiDeck, format, { cards: cardsRef.current, banlist, genesys });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiUsingCustom, aiDeck, ctxReady, banlist, genesys, format]);

  const revDate = format === "genesys" ? genesys?.date : banlist?.date;
  const checking = !!selected && (!ctxReady || !selectedDeck);
  const aiReady = !aiUsingCustom || (!!aiDeck && aiIssues.length === 0);
  const canStart = !!selected && ctxReady && !!selectedDeck && issues.length === 0 && aiReady;
  const start = () => {
    if (!selected || !canStart) return;
    const seedClean = seed.trim();
    const isAi = oppMode === "duelbot";
    onStart(selected, {
      seed: /^\d+$/.test(seedClean) ? seedClean : undefined,
      opponent: isAi ? "ai" : "goldfish",
      difficulty: isAi ? "hard" : undefined,
      aiDeckId: aiUsingCustom ? aiDeckSel : undefined,
    });
  };

  return (
    <div className="duelsetup">
      <div className="duelsetup__head">
        <button className="btn" onClick={onBack}>← Modes</button>
        <h1>{mode}</h1>
      </div>
      <p className="duelsetup__hint">
        Solo goldfish — you play; the opponent passes. Pick a {format === "genesys" ? "Genesys-legal " : ""}deck to start.
      </p>
      {decks === null ? (
        <div className="decklist__msg">Loading decks…</div>
      ) : decks.length === 0 ? (
        <div className="decklist__msg">No decks yet. Build one in the Deck tab first.</div>
      ) : (
        <>
          <div className="duelsetup__decks">
            {decks.map((d) => (
              <button
                key={d.id}
                className={`duelsetup__deck${selected === d.id ? " is-active" : ""}`}
                onClick={() => setSelected(d.id)}
                onDoubleClick={start}
              >
                <span className="duelsetup__deck-name">{d.name}</span>
                <span className="duelsetup__deck-counts">Main {d.mainCount} · Extra {d.extraCount}</span>
              </button>
            ))}
          </div>
          {selected && (
            checking ? (
              <div className="duelsetup__legality">Checking legality…</div>
            ) : issues.length === 0 ? (
              <div className="duelsetup__legality is-ok">✓ Legal for {mode}{revDate ? ` (${revDate})` : ""}</div>
            ) : (
              <div className="duelsetup__legality is-bad">
                <span className="duelsetup__legality-title">Not legal for {mode}{revDate ? ` (${revDate})` : ""}:</span>
                <ul className="duelsetup__issues">
                  {issues.slice(0, 8).map((iss, i) => <li key={i}>{iss.message}</li>)}
                  {issues.length > 8 && <li>+{issues.length - 8} more…</li>}
                </ul>
              </div>
            )
          )}
          <div className="duelsetup__opts">
            <label className="duelsetup__opt">
              <span>Shuffle seed</span>
              <input
                className="cards__input"
                placeholder="random"
                value={seed}
                onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))}
                title="Enter a number for a reproducible shuffle; leave blank for random"
              />
            </label>
            <label className="duelsetup__opt">
              <span>Opponent</span>
              <select className="cards__input" value={oppMode} onChange={(e) => setOppMode(e.target.value as typeof oppMode)}>
                <option value="goldfish">Goldfish (passive)</option>
                <option value="duelbot">DuelBot</option>
              </select>
            </label>
            {oppMode !== "goldfish" && (
              <label className="duelsetup__opt">
                <span>AI deck</span>
                <select className="cards__input" value={aiDeckSel} onChange={(e) => setAiDeckSel(e.target.value)} title="Pick a deck for the AI to play, or use the built-in default">
                  <option value={AI_DEFAULT_DECK}>Default opponent deck</option>
                  {decks.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {aiUsingCustom && aiDeckFailed && (
            <div className="duelsetup__legality is-bad">
              <span className="duelsetup__legality-title">AI deck could not be loaded.</span>
            </div>
          )}
          {aiUsingCustom && aiDeck && aiIssues.length > 0 && (
            <div className="duelsetup__legality is-bad">
              <span className="duelsetup__legality-title">AI deck not legal for {mode}{revDate ? ` (${revDate})` : ""}:</span>
              <ul className="duelsetup__issues">
                {aiIssues.slice(0, 8).map((iss, i) => <li key={i}>{iss.message}</li>)}
                {aiIssues.length > 8 && <li>+{aiIssues.length - 8} more…</li>}
              </ul>
            </div>
          )}
          <button className="btn btn--primary" disabled={!canStart} onClick={start}>
            Start Duel
          </button>
        </>
      )}
    </div>
  );
}
