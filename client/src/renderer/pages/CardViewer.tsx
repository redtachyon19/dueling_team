// client/src/renderer/pages/CardViewer.tsx
//
// The fixed-width preview panel shown beside a card grid (the search results
// and the set view). Updated on hover; shows the card's art, name, stats, and
// effect text. Falls back to the card sleeve when art isn't downloaded.

import { useEffect, useState, type ReactNode } from "react";
import { supertypeOf } from "../cards/search.ts";
import type { ArtworkTile } from "../cards/search.ts";
import cardBack from "../../../../assets/cards/sleeves/original_card_sleeve.png";

/**
 * The fixed-width card preview shown beside a card grid. The single sidebar
 * viewer used everywhere — Cards database, deck builder, and duel board — so
 * every instance is identical. `badge` and `pinLabel` are optional extras
 * (the deck builder's format badge + pin indicator) that simply don't render
 * when omitted.
 */
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
        <img className="cards__viewer-art" src={cardBack} alt="Card back" />
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
      <div className="cards__viewer-art-wrap">
        <BigArt id={imageId} name={card.name} />
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

function BigArt({ id, name }: { id: number; name: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  // Re-show on id change (a previously-failed id shouldn't poison the next card).
  useEffect(() => setFailed(false), [id]);
  if (failed || !window.duel?.cards) {
    // Art not downloaded (or bridge unavailable) → fall back to the card sleeve.
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
