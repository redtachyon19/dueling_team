// client/src/renderer/pages/CardDetail.tsx
//
// Full-page detail view for a single card, reached by clicking a tile in the
// Cards search or set view. The card itself (art, name, stats, effect) is shown
// by the shared CardViewer on the left, so this page's right column carries
// only the extra detail that isn't in the viewer: release date, archetype,
// passcode, banlist history, Genesys points history, and every set it was
// printed in. Back (or Esc) returns to wherever you came from.

import { useEffect, useState } from "react";
import type { CardData, SetData, BanSpan, GenesysHistory } from "@duel/shared";
import type { ArtworkTile } from "../cards/search.ts";
import { CardViewer } from "./CardViewer.tsx";

/** Set-code prefix, e.g. "DUAD-EN057" → "DUAD". */
const prefixOf = (code: string): string => code.split("-")[0] ?? code;

/** Color matching a card's frame. Pendulum variants take their base monster
 *  color. Tuned to read on the dark UI. */
const FRAME_COLORS: Record<string, string> = {
  normal: "#d9b94e",
  effect: "#e0934a",
  ritual: "#5a8fd6",
  fusion: "#a45fc4",
  synchro: "#e8e8e8",
  xyz: "#aab0b6",
  link: "#2f8fd0",
  spell: "#16a085",
  trap: "#c44f86",
  token: "#9aa0a6",
};
const frameColor = (frameType: string): string =>
  FRAME_COLORS[frameType.replace(/_pendulum$/, "")] ?? "#d9b94e";

const BAN_COLORS: Record<string, string> = {
  Forbidden: "#ff5a5a",
  Limited: "#ff9f1a",
  "Semi-Limited": "#ffe14d",
};

/** "2025-07-03" → "Jul 3, 2025"; passes through anything unparseable. */
function formatDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "—";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
}

export function CardDetail({
  card,
  setsByPrefix,
  onOpenSet,
  onOpenArchetype,
  onBack,
}: {
  card: CardData;
  setsByPrefix: Map<string, SetData>;
  onOpenSet: (code: string) => void;
  onOpenArchetype: (name: string) => void;
  onBack: () => void;
}): JSX.Element {
  // Esc returns to the grid, matching the back arrow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Printings sorted newest-first by set release date; undated prints sink to
  // the bottom. Date comes from the set DB, resolved by the code's prefix.
  const dateOf = (code: string): string => setsByPrefix.get(prefixOf(code))?.tcgDate ?? "";
  const sortedSets = [...card.sets].sort((a, b) => dateOf(b.code).localeCompare(dateOf(a.code)));

  const tile: ArtworkTile = { card, imageId: card.images[0] ?? card.id };

  return (
    <div className="detail">
      <div className="detail__bar">
        <button className="detail__back" type="button" onClick={onBack} aria-label="Back">
          ← Back
        </button>
        <span className="detail__crumb">Card</span>
      </div>

      <div className="detail__body">
        <CardViewer tile={tile} />

        <div className="detail__info">
          <div className="detail__type" style={{ color: frameColor(card.frameType) }}>
            {card.type}
          </div>

          <dl className="detail__facts">
            <dt>Released</dt>
            <dd>{formatDate(card.tcgDate)}</dd>
            {card.archetype && (
              <>
                <dt>Archetype</dt>
                <dd>
                  <button
                    type="button"
                    className="detail__link"
                    onClick={() => onOpenArchetype(card.archetype!)}
                  >
                    {card.archetype}
                  </button>
                </dd>
              </>
            )}
            <dt>Passcode</dt>
            <dd>{card.id >= 100_000_000 ? "—" : String(card.id).padStart(8, "0")}</dd>
          </dl>

          <div className="detail__hist-row">
            <BanlistHistory id={card.id} />
            <GenesysHistory id={card.id} />
          </div>

          <section className="detail__sets">
            <h2 className="detail__sets-title">
              Printed in {card.sets.length} set{card.sets.length === 1 ? "" : "s"}
            </h2>
            {card.sets.length === 0 ? (
              <div className="detail__sets-none">No set printings on record.</div>
            ) : (
              <table className="detail__sets-table">
                <thead>
                  <tr>
                    <th>Set</th>
                    <th>Code</th>
                    <th>Rarity</th>
                    <th>Released</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSets.map((p) => {
                    const prefix = prefixOf(p.code);
                    const set = setsByPrefix.get(prefix);
                    return (
                      <tr
                        key={p.code}
                        className="detail__sets-row"
                        title={`View ${p.name || set?.name || prefix}`}
                        onClick={() => onOpenSet(prefix)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenSet(prefix);
                          }
                        }}
                        tabIndex={0}
                      >
                        <td>{p.name || set?.name || "—"}</td>
                        <td className="detail__sets-code">{p.code}</td>
                        <td>{p.rarity ?? "—"}</td>
                        <td>{formatDate(set?.tcgDate ?? null)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function BanlistHistory({ id }: { id: number }): JSX.Element {
  const [spans, setSpans] = useState<BanSpan[] | null>(null);
  useEffect(() => {
    let alive = true;
    window.duel?.banlists
      ?.history(id)
      .then((s) => alive && setSpans(s ?? []))
      .catch(() => alive && setSpans([]));
    return () => {
      alive = false;
    };
  }, [id]);

  const rangeOf = (s: BanSpan): string =>
    s.current
      ? `${formatDate(s.from)} – present`
      : s.from === s.to
        ? formatDate(s.from)
        : `${formatDate(s.from)} – ${formatDate(s.to)}`;

  return (
    <section className="detail__hist">
      <h2 className="detail__sets-title">Banlist history</h2>
      {spans === null ? (
        <div className="detail__hist-note">Loading…</div>
      ) : spans.length === 0 ? (
        <div className="detail__hist-note">Never restricted — always Unlimited on the TCG list.</div>
      ) : (
        <ul className="detail__hist-list">
          {spans
            .slice()
            .reverse()
            .map((s) => (
              <li key={`${s.status}-${s.from}`}>
                <span className="detail__hist-status" style={{ color: BAN_COLORS[s.status] }}>
                  {s.status}
                </span>
                <span className="detail__hist-range">{rangeOf(s)}</span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function GenesysHistory({ id }: { id: number }): JSX.Element {
  const [hist, setHist] = useState<GenesysHistory | null>(null);
  useEffect(() => {
    let alive = true;
    window.duel?.genesys
      ?.history(id)
      .then((h) => alive && setHist(h ?? { current: 0, changes: [] }))
      .catch(() => alive && setHist({ current: 0, changes: [] }));
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <section className="detail__hist">
      <h2 className="detail__sets-title">Genesys points</h2>
      {hist === null ? (
        <div className="detail__hist-note">Loading…</div>
      ) : hist.current === 0 && hist.changes.length === 0 ? (
        <div className="detail__hist-note">Not in Genesys — 0 points.</div>
      ) : (
        <>
          <div className="detail__hist-current">
            {hist.current} pts <span className="detail__hist-cur-label">current</span>
          </div>
          {hist.changes.length === 0 ? (
            <div className="detail__hist-note">Unchanged since it was listed.</div>
          ) : (
            <ul className="detail__hist-list">
              {hist.changes
                .slice()
                .reverse()
                .map((ch) => (
                  <li key={ch.date}>
                    <span
                      className="detail__hist-status"
                      style={{ color: ch.delta > 0 ? "#ff9f1a" : "#5fd38a" }}
                    >
                      {ch.delta > 0 ? "+" : ""}
                      {ch.delta}
                    </span>
                    <span className="detail__hist-range">
                      → {ch.points} pts · {formatDate(ch.date)}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
