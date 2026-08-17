import { useEffect, useState, type ReactNode } from "react";
import { supertypeOf } from "../cards/search.ts";
import type { ArtworkTile } from "../cards/search.ts";
import cardBack from "../../../../ui/assets/sleeves/original_card_sleeve.png";
import { cardTilt } from "../card-tilt.ts";

export function CardViewer({
  tile,
  badge,
  pinLabel,
}: {
  tile: ArtworkTile | null;
  badge?: ReactNode;
  pinLabel?: string | undefined;
}): JSX.Element {
  if (!tile) {
    return (
      <aside className="cards__viewer">
        <div className="cards__viewer-art-wrap" {...cardTilt()}>
          <img className="cards__viewer-art" src={cardBack} alt="Card back" />
        </div>
      </aside>
    );
  }
  const { card, imageId } = tile;
  const stats =
    supertypeOf(card) === "Monster"
      ? [card.attribute, card.race, card.level != null ? `Lv ${card.level}` : null]
          .filter(Boolean)
          .join(" · ")
      : [card.type, card.race].filter(Boolean).join(" · ");

  return (
    <aside className="cards__viewer">
      <div className="cards__viewer-art-wrap" {...cardTilt()}>
        <FlipCard front={<BigArt id={imageId} name={card.name} />} resetKey={imageId} />
        {pinLabel && (
          <span className="viewer__pin" title="Shift+Arrow to select more; click again to unpin">
            📌 {pinLabel}
          </span>
        )}
      </div>
      <div className="cards__viewer-info">
        <div className="cards__viewer-name">{card.name}</div>
        {badge}
        <div className="cards__viewer-sub">{stats}</div>
        {supertypeOf(card) === "Monster" && card.atk != null && (
          <div className="cards__viewer-atk">
            ATK {card.atk} / DEF {card.def ?? "—"}
          </div>
        )}
        <p className="cards__viewer-desc">{card.desc}</p>
      </div>
    </aside>
  );
}

/**
 * Click to turn the card over. The flip lives on an inner element so it composes
 * with the wrapper's cursor tilt instead of fighting it, and both faces are
 * backface-hidden so only the one pointing at you is drawn.
 */
function FlipCard({ front, resetKey }: { front: ReactNode; resetKey: number }): JSX.Element {
  const [flipped, setFlipped] = useState(false);
  // Show the new card's face when the viewer switches cards.
  useEffect(() => setFlipped(false), [resetKey]);
  const toggle = () => setFlipped((f) => !f);
  return (
    <div
      className={`viewer__flip${flipped ? " is-flipped" : ""}`}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={flipped}
      title={flipped ? "Click to turn back over" : "Click to turn the card over"}
    >
      <div className="viewer__face viewer__face--front">{front}</div>
      <div className="viewer__face viewer__face--back">
        <img className="cards__viewer-art" src={cardBack} alt="Card back" />
      </div>
    </div>
  );
}

function BigArt({ id, name }: { id: number; name: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  if (failed || !window.duel?.cards) {
    return <img className="cards__viewer-art" src={cardBack} alt={name || "Card back"} />;
  }
  return (
    <img
      className="cards__viewer-art"
      src={window.duel.cards.imageUrl(id)}
      alt={name}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
