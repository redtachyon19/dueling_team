import { useMemo } from "react";
import type { CardData, SetData } from "@duel/shared";
import { CardGridPage } from "./CardGridPage.tsx";
import type { GridCard } from "./CardGridPage.tsx";

const prefixOf = (code: string): string => code.split("-")[0] ?? code;

const collectorNum = (code: string): number => {
  const m = code.match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : 0;
};

function formatDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "—";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
}

export function SetDetail({
  code,
  set,
  cards,
  onOpenCard,
  onBack,
}: {
  code: string;
  set: SetData | undefined;
  cards: readonly CardData[];
  onOpenCard: (c: CardData) => void;
  onBack: () => void;
}): JSX.Element {
  const inSet = useMemo<GridCard[]>(() => {
    const out: { card: CardData; code: string }[] = [];
    for (const c of cards) {
      const print = c.sets.find((s) => prefixOf(s.code) === code);
      if (print) out.push({ card: c, code: print.code });
    }
    out.sort((a, b) => collectorNum(a.code) - collectorNum(b.code));
    return out.map(({ card, code: printCode }) => ({ card, key: printCode, code: printCode }));
  }, [cards, code]);

  return (
    <CardGridPage
      crumb="Set"
      title={set?.name || code}
      meta={
        <>
          <span className="setview__code">{code}</span>
          <span>·</span>
          <span>Released {formatDate(set?.tcgDate)}</span>
          <span>·</span>
          <span>
            {inSet.length} card{inSet.length === 1 ? "" : "s"}
          </span>
        </>
      }
      cards={inSet}
      emptyText="No cards on record for this set."
      onOpenCard={onOpenCard}
      onBack={onBack}
    />
  );
}
