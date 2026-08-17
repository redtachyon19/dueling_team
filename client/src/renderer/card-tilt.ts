import type { PointerEvent as ReactPointerEvent } from "react";

/** Tilt at the very edge of a card, in degrees. */
export const CARD_TILT_DEG = 12;

/**
 * Cursor-tracked 3D tilt for a card.
 *
 * Writes CSS custom properties onto the hovered element. Custom properties
 * inherit, so any descendant can consume them in a transform — which is why this
 * works for both a hand slot wrapping a card and the viewer's art wrapper.
 *
 * Deliberately imperative: this runs on every pointer move, and routing it
 * through React state would re-render the surrounding page each time.
 */
export function cardTilt(maxDeg: number = CARD_TILT_DEG): {
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => void;
} {
  return {
    onPointerMove: (e) => {
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--tilt-ry", `${(px * 2 * maxDeg).toFixed(2)}deg`);
      el.style.setProperty("--tilt-rx", `${(-py * 2 * maxDeg).toFixed(2)}deg`);
      el.style.setProperty("--glare-x", `${((px + 0.5) * 100).toFixed(1)}%`);
      el.style.setProperty("--glare-y", `${((py + 0.5) * 100).toFixed(1)}%`);
    },
    onPointerLeave: (e) => {
      const el = e.currentTarget;
      el.style.removeProperty("--tilt-rx");
      el.style.removeProperty("--tilt-ry");
    },
  };
}
