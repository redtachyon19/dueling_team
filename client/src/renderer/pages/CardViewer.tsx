import { useEffect, useState, type ReactNode } from "react";
import { supertypeOf } from "../cards/search.ts";
import type { ArtworkTile } from "../cards/search.ts";
import cardBack from "../../../../ui/assets/sleeves/original_card_sleeve.png";

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
