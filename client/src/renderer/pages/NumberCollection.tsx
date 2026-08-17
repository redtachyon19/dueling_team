import { useEffect, useMemo, useState } from "react";
import type { CardData, SetData } from "@duel/shared";
import { CardGridPage } from "./CardGridPage.tsx";
import type { GridCard, GridSection } from "./CardGridPage.tsx";
import { CardDetail } from "./CardDetail.tsx";
import { SetDetail } from "./SetDetail.tsx";
import { ArchetypeDetail } from "./ArchetypeDetail.tsx";

const PREFIX_RANK: Record<string, number> = { "": 0, c: 1, f: 2, s: 3, ic: 4 };

function numberKey(name: string): { n: number; p: number } {
  const m = name.match(/^Number\s+(C|S|F|iC)?\s*(\d+)/i);
  if (!m) return { n: Number.POSITIVE_INFINITY, p: 99 };
  return { n: Number(m[2]), p: PREFIX_RANK[(m[1] ?? "").toLowerCase()] ?? 90 };
}

export function NumberCollection({ onExit }: { onExit: () => void }): JSX.Element {
  const [cards, setCards] = useState<CardData[] | null>(null);
  const [sets, setSets] = useState<SetData[] | null>(null);

  useEffect(() => {
    let alive = true;
    window.duel?.cards?.load().then((c) => alive && setCards(c ?? [])).catch(() => alive && setCards([]));
    window.duel?.sets?.load().then((s) => alive && setSets(s ?? [])).catch(() => alive && setSets([]));
    return () => {
      alive = false;
    };
  }, []);

  const setsByPrefix = useMemo(() => {
    const m = new Map<string, SetData>();
    for (const s of sets ?? []) m.set(s.code, s);
    return m;
  }, [sets]);

  const sections = useMemo<GridSection[]>(() => {
    if (!cards) return [];

    type Entry = { card: CardData; key: string; sort: { n: number; p: number } };
    const all: Entry[] = cards
      .filter((c) => c.frameType === "xyz" && /^Number\s/i.test(c.name))
      .map((card) => ({ card, key: String(card.id), sort: numberKey(card.name) }));

    const baseGroups = new Map<number, Entry[]>();
    for (const x of all) {
      if (x.sort.p === 0 && Number.isFinite(x.sort.n)) {
        const g = baseGroups.get(x.sort.n) ?? [];
        g.push(x);
        baseGroups.set(x.sort.n, g);
      }
    }
    const isNumeronGate = (name: string) => /Numeron Gate/i.test(name);

    const NUMBER = 0, CHAOS = 1, ICHAOS = 2, BARIAN = 3, FUTURE = 4, SHINING = 5, OTHER = 6;
    const TITLES = [
      "Number Cards",
      "Chaos Number",
      "Imaginary Chaos Number",
      "Barian Numbers",
      "Future Number",
      "Shining Number",
      "Other Numbers",
    ];

    const classify = (x: Entry): number => {
      const { p, n } = x.sort;
      if (p === 1) return CHAOS;
      if (p === 4) return ICHAOS;
      if (p === 2) return FUTURE;
      if (p === 3) return SHINING;
      if (p !== 0) return OTHER;
      const group = baseGroups.get(n)!;
      if (group.length > 1) {
        if (group.some((g) => isNumeronGate(g.card.name))) {
          return isNumeronGate(x.card.name) ? NUMBER : BARIAN;
        }
        const canonical = group.reduce((a, b) => (b.card.name.length < a.card.name.length ? b : a));
        return x.card.id === canonical.card.id ? NUMBER : OTHER;
      }
      return NUMBER;
    };

    const buckets: Entry[][] = TITLES.map(() => []);
    for (const x of all) buckets[classify(x)]!.push(x);

    return TITLES.map((title, i) => ({
      title,
      cards: buckets[i]!
        .sort(
          (a, b) =>
            a.sort.n - b.sort.n || a.sort.p - b.sort.p || a.card.name.localeCompare(b.card.name),
        )
        .map(({ card, key }) => ({ card, key })),
    }));
  }, [cards]);

  const total = useMemo(() => sections.reduce((n, s) => n + s.cards.length, 0), [sections]);

  type View =
    | { kind: "card"; card: CardData }
    | { kind: "set"; code: string }
    | { kind: "archetype"; name: string };
  const [stack, setStack] = useState<View[]>([]);
  const openCard = (card: CardData) => setStack((s) => [...s, { kind: "card", card }]);
  const openSet = (code: string) => setStack((s) => [...s, { kind: "set", code }]);
  const openArchetype = (name: string) => setStack((s) => [...s, { kind: "archetype", name }]);
  const back = () => setStack((s) => s.slice(0, -1));
  const view = stack[stack.length - 1];

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
    return <ArchetypeDetail name={view.name} cards={cards ?? []} onOpenCard={openCard} onBack={back} />;
  }

  return (
    <CardGridPage
      crumb="Number Hunters"
      title="Number Collection"
      meta={<span>{cards === null ? "Loading…" : `${total} Numbers`}</span>}
      sections={sections}
      emptyText={cards === null ? "Loading card database…" : "No Number cards found."}
      onOpenCard={openCard}
      onBack={onExit}
    />
  );
}
