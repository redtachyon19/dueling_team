// client/src/renderer/pages/AllSets.tsx
//
// Browse-all-sets page: every set with its release date and card count, newest
// first, filterable by name/code. Clicking a row opens that set's detail view.
// Reached from the "All sets" button in the Cards toolbar.

import { useEffect, useMemo, useState } from "react";
import type { CardData, SetData } from "@duel/shared";

/** "2025-07-03" → "Jul 3, 2025"; passes through anything unparseable. */
function formatDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
}

export function AllSets({
  sets,
  cards,
  onOpenSet,
  onBack,
}: {
  sets: readonly SetData[];
  cards: readonly CardData[];
  onOpenSet: (code: string) => void;
  onBack: () => void;
}): JSX.Element {
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Distinct print count (set numbers we actually have) per set-code prefix.
  const printCount = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of cards) {
      for (const s of c.sets) {
        const pfx = s.code.split("-")[0] ?? s.code;
        let set = m.get(pfx);
        if (!set) m.set(pfx, (set = new Set()));
        set.add(s.code);
      }
    }
    return m;
  }, [cards]);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return sets
      .filter((s) => !t || s.name.toLowerCase().includes(t) || s.code.toLowerCase().includes(t))
      .slice()
      .sort((a, b) => (b.tcgDate ?? "").localeCompare(a.tcgDate ?? ""));
  }, [sets, q]);

  return (
    <div className="allsets">
      <div className="detail__bar">
        <button className="detail__back" type="button" onClick={onBack} aria-label="Back">
          ← Back
        </button>
        <span className="detail__crumb">All sets</span>
      </div>

      <header className="allsets__head">
        <h1 className="allsets__title">All sets</h1>
        <input
          className="cards__input allsets__filter"
          type="text"
          value={q}
          placeholder="Filter by name or code…"
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="allsets__count">{rows.length.toLocaleString()} sets</span>
      </header>

      <div className="allsets__scroll">
        <table className="allsets__table">
          <thead>
            <tr>
              <th>Set</th>
              <th>Code</th>
              <th>Released</th>
              <th className="allsets__num">Cards</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.code}
                className="allsets__row"
                onClick={() => onOpenSet(s.code)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenSet(s.code);
                  }
                }}
                tabIndex={0}
              >
                <td>{s.name}</td>
                <td className="allsets__code">{s.code}</td>
                <td>{formatDate(s.tcgDate)}</td>
                <td className="allsets__num">{printCount.get(s.code)?.size ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
