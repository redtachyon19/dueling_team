import { useEffect, useState } from "react";
import type { DeckSummary } from "@duel/shared";
import { DuelBoard } from "./DuelBoard.tsx";

type Stage =
  | { view: "menu" }
  | { view: "setup"; mode: string }
  | { view: "play"; mode: string; deckId: string };

// The Duel tab. Landing screen is the five format/mode tiles; choosing one
// leads to a deck pick and then a (goldfish) duel powered by ocgcore.
export function Duel(): JSX.Element {
  const [stage, setStage] = useState<Stage>({ view: "menu" });

  if (stage.view === "play") {
    return <DuelBoard deckId={stage.deckId} onExit={() => setStage({ view: "menu" })} />;
  }
  if (stage.view === "setup") {
    return (
      <DuelSetup
        mode={stage.mode}
        onBack={() => setStage({ view: "menu" })}
        onStart={(deckId) => setStage({ view: "play", mode: stage.mode, deckId })}
      />
    );
  }

  const open = (mode: string) => setStage({ view: "setup", mode });
  return (
    <div className="duel-grid">
      <button className="duel-card duel-card--g1" onClick={() => open("Advanced")}>
        <span className="duel-card__label">Advanced</span>
      </button>
      <button className="duel-card duel-card--g2" onClick={() => open("Genesys")}>
        <span className="duel-card__label">Genesys</span>
      </button>
      <button className="duel-card duel-card--g3" onClick={() => open("Number Hunters")}>
        <span className="duel-card__label">Number Hunters</span>
      </button>
      <button className="duel-card duel-card--g4" onClick={() => open("Action Duels")}>
        <span className="duel-card__label">Action Duels</span>
      </button>
      <button className="duel-card duel-card--g5" onClick={() => open("Draft & Sealed Play")}>
        <span className="duel-card__label">Draft &amp; Sealed Play</span>
      </button>
    </div>
  );
}

function DuelSetup({ mode, onBack, onStart }: { mode: string; onBack: () => void; onStart: (deckId: string) => void }): JSX.Element {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    window.duel?.decks?.list().then((d) => {
      setDecks(d ?? []);
      if (d && d.length) setSelected(d[0]!.id);
    }).catch(() => setDecks([]));
  }, []);

  return (
    <div className="duelsetup">
      <div className="duelsetup__head">
        <button className="btn" onClick={onBack}>← Modes</button>
        <h1>{mode}</h1>
      </div>
      <p className="duelsetup__hint">Solo goldfish — you play; the opponent passes. Pick a deck to start.</p>
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
                onDoubleClick={() => onStart(d.id)}
              >
                <span className="duelsetup__deck-name">{d.name}</span>
                <span className="duelsetup__deck-counts">Main {d.mainCount} · Extra {d.extraCount}</span>
              </button>
            ))}
          </div>
          <button className="btn btn--primary" disabled={!selected} onClick={() => selected && onStart(selected)}>
            Start Duel
          </button>
        </>
      )}
    </div>
  );
}
