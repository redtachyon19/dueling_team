/**
 * CardCase2D.ts — flat 3/4-view card case (deck box) drawn as SVG.
 *
 * No dependencies, no framework. Builds the same drawing as the design:
 * body + hinged front flap, a square thumb indentation in the front wall,
 * a card stack, and a single tint color that drives every face shade.
 *
 *   import { createCardCase2D, COLORWAYS } from './CardCase2D';
 *
 *   const case2d = createCardCase2D(document.getElementById('slot')!);
 *   case2d.setColorway(COLORWAYS.crimson);
 *   case2d.setFlapOpen(true);            // animates; hinged at the back edge
 *
 * The flap "opens" by mirroring across the back top edge with foreshortening,
 * which tweens through the flat (edge-on) state — a 2D hinge.
 */

export interface Colorway {
  name: string;
  shell: string;
}

const DEFAULT_SHELL = '#1e2536';

export const COLORWAYS: Record<string, Colorway> = {
  midnight: { name: 'Midnight', shell: '#1e2536' },
  crimson:  { name: 'Crimson',  shell: '#41171c' },
  emerald:  { name: 'Emerald',  shell: '#153026' },
  violet:   { name: 'Violet',   shell: '#291b3b' },
  graphite: { name: 'Graphite', shell: '#262930' },
  bone:     { name: 'Bone',     shell: '#d3ccbc' }
};

export interface CardCase2DOptions {
  colorway?: Colorway;
  /** Override the tint directly; wins over `colorway`. */
  shell?: string;
  /** Draw the card stack. Default true. */
  cards?: boolean;
  /** Start with the flap open. Default false. */
  open?: boolean;
  /** Flap transition, CSS. Default 'transform .55s cubic-bezier(.34,.06,.2,1)'. */
  transition?: string;
  /** Ground shadow ellipse. Default true. */
  shadow?: boolean;
  /** Card image URL painted onto the revealed faces. Default none. */
  cover?: string | null;
}

export interface CardCase2D {
  /** The <svg> element; append or style it as you like. */
  svg: SVGSVGElement;
  setColorway(c: Colorway): void;
  setShell(hex: string): void;
  setFlapOpen(open: boolean): void;
  setCardsVisible(visible: boolean): void;
  /** Paint a card image (any URL) onto the revealed faces; null clears it. */
  setCoverImage(url: string | null): void;
  readonly isOpen: boolean;
  destroy(): void;
}

/** Projection: near vertical edge at x=196, width axis (158,-28), depth axis (-96,-42). */
const GEO = {
  viewBox: '0 0 430 440',
  side:        '100,84 196,126 196,376 100,334',
  front:       '196,126 354,98 354,348 196,376',
  nearEdge:    { x1: 196, y1: 126, x2: 196, y2: 376 },
  top:         '100,84 196,126 354,98 258,56',
  flapTongue:  '196,126 354,98 354,222 196,250',
  tongueEdge:  { x1: 196, y1: 250, x2: 354, y2: 222 },
  notch:       '230.8,119.8 319.2,104.2 319.2,200.2 230.8,215.8',
  notchCards:  '233.8,122.5 316.2,108 316.2,198.2 233.8,212.8',
  notchLines: [
    { x1: 233.8, y1: 152.5, x2: 316.2, y2: 138 },
    { x1: 233.8, y1: 182.5, x2: 316.2, y2: 168 }
  ],
  rimCardsTop:  '201.5,116.8 321.6,95.5 252.5,65.2 132.4,86.5',
  rimCardsEdge: '201.5,128.8 321.6,107.5 321.6,95.5 201.5,116.8',
  rimCardLines: [
    { x1: 156.6, y1: 97.1, x2: 276.7, y2: 75.8 },
    { x1: 180.8, y1: 107.7, x2: 300.9, y2: 86.4 }
  ],
  shadow: { cx: 228, cy: 386, rx: 128, ry: 15 },
  /** Back top edge, the flap hinge: (100,84)–(258,56). */
  hinge: { originX: 179, originY: 70, angleDeg: -10.06, foreshorten: 0.55 },
  outline: '#0d0e11',
  spec: '#c4cad3'
};

/**
 * The face we paint a cover image onto: the front thumb-notch window. Given as
 * origin O + the two corner points adjacent to it (A along the width, B down the
 * height); `clip` trims the mapped image, `align` anchors it (top of the card
 * shows through the window). The card keeps its aspect — `slice` never squishes.
 */
const COVER_SURFACES = [
  { key: 'notch', O: [233.8, 122.5], A: [316.2, 108], B: [233.8, 212.8], clip: GEO.notchCards, align: 'xMidYMin', zoom: 1.7 }
] as const;

const NS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

let instanceSeq = 0;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function createCardCase2D(
  container: Element | null,
  options: CardCase2DOptions = {}
): CardCase2D {
  const {
    colorway,
    shell: shellOverride,
    cards: withCards = true,
    open: startOpen = false,
    transition = 'transform .55s cubic-bezier(.34,.06,.2,1)',
    shadow = true
  } = options;

  let shell = shellOverride ?? colorway?.shell ?? DEFAULT_SHELL;
  let isOpen = startOpen;

  const svg = el('svg', {
    viewBox: GEO.viewBox,
    'stroke-linejoin': 'round'
  });
  svg.style.display = 'block';
  svg.style.overflow = 'visible';

  // tinted faces get collected so a color change is one pass
  const tinted: SVGElement[] = [];
  const tint = (node: SVGElement) => { tinted.push(node); node.setAttribute('fill', shell); return node; };

  if (shadow) {
    svg.append(el('ellipse', { ...GEO.shadow, fill: '#000000', opacity: 0.34 }));
  }

  // ---- body ----
  const body = el('g');
  body.append(
    tint(el('polygon', { points: GEO.side })),
    el('polygon', { points: GEO.side, fill: '#000000', opacity: 0.32 }),
    tint(el('polygon', { points: GEO.front })),

    // thumb indentation in the front wall
    el('polygon', { points: GEO.notch, fill: '#0a0b0e' })
  );

  const notchFill = el('polygon', { points: GEO.notchCards, fill: '#ded8ca' });
  const notchCards = el('g');
  notchCards.append(
    notchFill,
    ...GEO.notchLines.map((l) => el('line', { ...l, stroke: GEO.outline, 'stroke-width': 1, opacity: 0.22 }))
  );
  body.append(notchCards);

  body.append(
    el('polygon', { points: GEO.notch, fill: 'none', stroke: GEO.outline, 'stroke-width': 2.2 }),
    el('polygon', { points: GEO.side, fill: 'none', stroke: GEO.outline, 'stroke-width': 2.6 }),
    el('polygon', { points: GEO.front, fill: 'none', stroke: GEO.outline, 'stroke-width': 2.6 }),
    el('line', { ...GEO.nearEdge, stroke: GEO.spec, 'stroke-width': 1.3, opacity: 0.4 })
  );
  svg.append(body);

  // ---- rim + card tops (revealed when the flap lifts) ----
  const rim = el('g');
  rim.append(el('polygon', { points: GEO.top, fill: '#0a0b0e' }));

  const rimTopFill = el('polygon', { points: GEO.rimCardsTop, fill: '#e7e1d4' });
  const rimCards = el('g');
  rimCards.append(
    el('polygon', { points: GEO.rimCardsEdge, fill: '#cfc8b7' }),
    rimTopFill,
    el('polygon', { points: GEO.rimCardsTop, fill: 'none', stroke: GEO.outline, 'stroke-width': 1.6 }),
    el('polygon', { points: GEO.rimCardsEdge, fill: 'none', stroke: GEO.outline, 'stroke-width': 1.6 }),
    ...GEO.rimCardLines.map((l) => el('line', { ...l, stroke: GEO.outline, 'stroke-width': 1, opacity: 0.28 }))
  );
  rim.append(rimCards);
  rim.append(el('polygon', { points: GEO.top, fill: 'none', stroke: GEO.outline, 'stroke-width': 2.6 }));
  svg.append(rim);

  // ---- flap: top leaf + tongue down the front, hinged at the back edge ----
  const flap = el('g');
  flap.style.transition = transition;
  flap.style.transformOrigin = `${GEO.hinge.originX}px ${GEO.hinge.originY}px`;
  flap.append(
    tint(el('polygon', { points: GEO.top })),
    el('polygon', { points: GEO.top, fill: '#ffffff', opacity: 0.12 }),
    tint(el('polygon', { points: GEO.flapTongue })),
    el('polygon', { points: GEO.flapTongue, fill: '#ffffff', opacity: 0.04 }),
    el('polygon', { points: GEO.top, fill: 'none', stroke: GEO.outline, 'stroke-width': 2.6 }),
    el('polygon', { points: GEO.flapTongue, fill: 'none', stroke: GEO.outline, 'stroke-width': 2.6 }),
    el('line', { ...GEO.tongueEdge, stroke: GEO.spec, 'stroke-width': 1.4, opacity: 0.5 })
  );
  svg.append(flap);

  function applyFlap() {
    const { angleDeg, foreshorten } = GEO.hinge;
    const sy = isOpen ? -foreshorten : 1;
    flap.style.transform = `rotate(${angleDeg}deg) scale(1,${sy}) rotate(${-angleDeg}deg)`;
  }

  function applyCards(visible: boolean) {
    const v = visible ? '1' : '0';
    notchCards.setAttribute('opacity', v);
    rimCards.setAttribute('opacity', v);
  }

  // ---- cover image: perspective-map a card onto the revealed card faces ----
  const uid = `cc${++instanceSeq}`;
  const coverNodes: SVGElement[] = [];

  const fillFor: Record<string, SVGElement> = { notch: notchFill, top: rimTopFill };

  function applyCover(url: string | null) {
    coverNodes.forEach((n) => n.remove());
    coverNodes.length = 0;
    // the top card stack stays cream; only covered faces hide their fill
    notchFill.setAttribute('opacity', '1');
    rimTopFill.setAttribute('opacity', '1');
    if (!url) return;

    for (const s of COVER_SURFACES) {
      const ux = s.A[0] - s.O[0], uy = s.A[1] - s.O[1];
      const vx = s.B[0] - s.O[0], vy = s.B[1] - s.O[1];
      const lenU = Math.hypot(ux, uy) || 1;
      const lenV = Math.hypot(vx, vy) || 1;

      const clipId = `${uid}-${s.key}`;
      const clip = el('clipPath', { id: clipId });
      clip.append(el('polygon', { points: s.clip }));

      // enlarge the image viewport by `zoom` so the notch shows a cropped,
      // zoomed-in slice of the card (name + art) rather than the whole card
      const z = s.zoom ?? 1;
      const w = lenU * z, h = lenV * z;
      const img = el('image', {
        x: -(w - lenU) / 2, y: 0, width: w, height: h,
        preserveAspectRatio: `${s.align} slice`,
        transform: `matrix(${ux / lenU},${uy / lenU},${vx / lenV},${vy / lenV},${s.O[0]},${s.O[1]})`
      });
      img.setAttribute('href', url);
      img.setAttributeNS(XLINK, 'href', url);

      // wrapper carries the clip in untransformed space so the polygon lines up
      const wrap = el('g', { 'clip-path': `url(#${clipId})` });
      wrap.append(clip, img);

      const anchor = fillFor[s.key];
      if (anchor) {
        anchor.setAttribute('opacity', '0');
        anchor.after(wrap);
      }
      coverNodes.push(wrap);
    }
  }

  applyFlap();
  applyCards(withCards);
  applyCover(options.cover ?? null);
  container?.append(svg);

  return {
    svg,
    setColorway(c) { shell = c.shell; tinted.forEach((n) => n.setAttribute('fill', shell)); },
    setShell(hex) { shell = hex; tinted.forEach((n) => n.setAttribute('fill', shell)); },
    setFlapOpen(open) { isOpen = open; applyFlap(); },
    setCardsVisible(visible) { applyCards(visible); },
    setCoverImage(url) { applyCover(url); },
    get isOpen() { return isOpen; },
    destroy() { svg.remove(); }
  };
}
