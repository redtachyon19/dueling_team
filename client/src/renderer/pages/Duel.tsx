export function Duel(): JSX.Element {
  return (
    <div className="duel-grid">
      <button className="duel-card duel-card--g1">
        <span className="duel-card__label">Advanced</span>
      </button>
      <button className="duel-card duel-card--g2">
        <span className="duel-card__label">Genesys</span>
      </button>
      <button className="duel-card duel-card--g3">
        <span className="duel-card__label">Number Hunters</span>
      </button>
      <button className="duel-card duel-card--g4">
        <span className="duel-card__label">Action Duels</span>
      </button>
      <button className="duel-card duel-card--g5">
        <span className="duel-card__label">Draft &amp; Sealed Play</span>
      </button>
    </div>
  );
}
