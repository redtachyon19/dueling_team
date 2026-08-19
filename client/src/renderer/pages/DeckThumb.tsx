import { useEffect, useRef } from "react";
import { createCardCase2D, COLORWAYS, type Colorway, type CardCase2D } from "../cards/CardCase2D.ts";

const COLORWAY_LIST: Colorway[] = Object.values(COLORWAYS);

/** Stable per-deck colorway: hash the id so a deck always gets the same box. */
function colorwayFor(seed: string): Colorway {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return COLORWAY_LIST[Math.abs(h) % COLORWAY_LIST.length] ?? COLORWAY_LIST[0]!;
}

/** The effective box hex for a deck with no explicit color set. */
export function defaultBoxColor(seed: string): string {
  return colorwayFor(seed).shell;
}

/**
 * Rasterize a card image to a data: URI. The `card://` scheme is allowed for
 * `<img>` by CSP (img-src card:) but SVG `<image>` may refuse it, so we load it
 * as a plain CORS image and re-emit it as data: (also CSP-allowed) for the SVG.
 */
function toDataUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 421;
      canvas.height = img.naturalHeight || 614;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.drawImage(img, 0, 0);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Deck-box thumbnail for the deck list. Renders a CardCase2D SVG whose tint is
 * `color` (falling back to a stable hash of `seed`), reveals `coverUrl` art when
 * opened, and lifts its flap while `open` is true.
 */
export function DeckThumb({
  seed,
  open,
  color,
  coverUrl,
}: {
  seed: string;
  open: boolean;
  color?: string | undefined;
  coverUrl?: string | null | undefined;
}): JSX.Element {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const caseRef = useRef<CardCase2D | null>(null);

  useEffect(() => {
    const c = createCardCase2D(slotRef.current, { colorway: colorwayFor(seed) });
    c.svg.style.width = "100%";
    c.svg.style.height = "100%";
    caseRef.current = c;
    return () => c.destroy();
  }, [seed]);

  useEffect(() => {
    if (color) caseRef.current?.setShell(color);
    else caseRef.current?.setColorway(colorwayFor(seed));
  }, [color, seed]);

  useEffect(() => {
    if (!coverUrl) {
      caseRef.current?.setCoverImage(null);
      return;
    }
    let alive = true;
    toDataUrl(coverUrl)
      .then((data) => alive && caseRef.current?.setCoverImage(data))
      .catch(() => alive && caseRef.current?.setCoverImage(coverUrl)); // fall back to direct URL
    return () => {
      alive = false;
    };
  }, [coverUrl]);

  useEffect(() => {
    caseRef.current?.setFlapOpen(open);
  }, [open]);

  return <div className="deckthumb" ref={slotRef} aria-hidden="true" />;
}
