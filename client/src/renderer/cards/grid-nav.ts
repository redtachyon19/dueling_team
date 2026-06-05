// client/src/renderer/cards/grid-nav.ts
//
// Pure helpers for keyboard navigation + range selection over a row-major grid
// of cards (deck zones and the search pool). No DOM, no React — the caller
// supplies the current column count and item count (read from the live grid).

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/** Every index from a to b inclusive, ascending (order-independent inputs). */
export function rangeInclusive(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/**
 * The next focus index when an arrow key is pressed in a row-major grid.
 * Left/Right step by 1 (and may cross a row edge, like a list); Up/Down step by
 * one full row (`cols`). Movement that would leave the grid is rejected — the
 * focus stays put rather than wrapping.
 */
export function stepIndex(focus: number, key: ArrowKey, cols: number, count: number): number {
  if (count <= 0) return focus;
  const c = Math.max(1, cols);
  let next = focus;
  if (key === "ArrowLeft") next = focus - 1;
  else if (key === "ArrowRight") next = focus + 1;
  else if (key === "ArrowUp") next = focus - c;
  else if (key === "ArrowDown") next = focus + c;
  if (next < 0 || next >= count) return focus;
  return next;
}
