// client/src/renderer/pages/CardGridPage.tsx
//
// Shared shell for the in-page "grid of cards" views (a set's cards, an
// archetype's cards): a back bar, a header, the hover CardViewer on the left,
// and a clickable card grid on the right. Each consumer just supplies the
// title/meta and the list of cards.

import { useEffect, useState } from "react";
import type { CardData } from "@duel/shared";
import type { ArtworkTile } from "../cards/search.ts";
import { CardViewer } from "./CardViewer.tsx";
import cardBack from "../../../../assets/cards/sleeves/original_card_sleeve.png";

/** One tile in the grid: a card plus an optional code/caption shown above its name. */
export interface GridCard {
  card: CardData;
  key: string;
  code?: string;
}

export function CardGridPage({
  crumb,
  title,
  meta,
  cards,
  emptyText,
  onOpenCard,
  onBack,
}: {
  crumb: string;
  title: string;
  meta: JSX.Element;
  cards: GridCard[];
  emptyText: string;
  onOpenCard: (c: CardData) => void;
  onBack: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // The card shown in the side viewer; updated on hover, sticky when the cursor
  // leaves (same behavior as the search grid).
  const [preview, setPreview] = useState<ArtworkTile | null>(null);

  return (
    <div className="setview">
      <div className="detail__bar">
        <button className="detail__back" type="button" onClick={onBack} aria-label="Back">
          ← Back
        </button>
        <span className="detail__crumb">{crumb}</span>
      </div>

      <header className="setview__head">
        <h1 className="setview__name">{title}</h1>
        <div className="setview__meta">{meta}</div>
      </header>

      <div className="setview__body">
        <CardViewer tile={preview} />

        {cards.length === 0 ? (
          <div className="setview__none">{emptyText}</div>
        ) : (
          <div className="setview__grid">
            {cards.map(({ card, key, code }) => (
              <article
                key={key}
                className="setview__tile"
                title={`${card.name}${code ? ` · ${code}` : ""}`}
                onMouseEnter={() => setPreview({ card, imageId: card.images[0] ?? card.id })}
                onFocus={() => setPreview({ card, imageId: card.images[0] ?? card.id })}
                onClick={() => onOpenCard(card)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenCard(card);
                  }
                }}
                tabIndex={0}
              >
                <TileArt id={card.images[0] ?? card.id} name={card.name} />
                {code && <div className="setview__tile-code">{code}</div>}
                <div className="setview__tile-name">{card.name}</div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TileArt({ id, name }: { id: number; name: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed || !window.duel?.cards) {
    return <img className="setview__art" src={cardBack} alt={name || "Card back"} loading="lazy" />;
  }
  return (
    <img
      className="setview__art"
      src={window.duel.cards.imageUrl(id)}
      alt={name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
