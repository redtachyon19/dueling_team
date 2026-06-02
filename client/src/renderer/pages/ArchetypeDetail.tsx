// client/src/renderer/pages/ArchetypeDetail.tsx
//
// Full-page view for an archetype: every card belonging to it, via the shared
// CardGridPage shell. Reached by clicking the archetype in a card's detail.

import { useMemo } from "react";
import type { CardData } from "@duel/shared";
import { CardGridPage } from "./CardGridPage.tsx";
import type { GridCard } from "./CardGridPage.tsx";

export function ArchetypeDetail({
  name,
  cards,
  onOpenCard,
  onBack,
}: {
  name: string;
  cards: readonly CardData[];
  onOpenCard: (c: CardData) => void;
  onBack: () => void;
}): JSX.Element {
  const members = useMemo<GridCard[]>(
    () =>
      cards
        .filter((c) => c.archetype === name)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((card) => ({ card, key: String(card.id) })),
    [cards, name],
  );

  return (
    <CardGridPage
      crumb="Archetype"
      title={name}
      meta={
        <span>
          {members.length} card{members.length === 1 ? "" : "s"}
        </span>
      }
      cards={members}
      emptyText="No cards in this archetype."
      onOpenCard={onOpenCard}
      onBack={onBack}
    />
  );
}
