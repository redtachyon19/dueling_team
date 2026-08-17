export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export function rangeInclusive(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

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
