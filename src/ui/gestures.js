// Touch gesture maths, kept free of the DOM so it can be tested. main.js feeds
// it pointer positions (in canvas pixels) and applies the camera it returns.

import { clamp } from '../core/math.js';

const gap = (a, b) => Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));

/** Remember where a two-finger gesture began: the fingers' midpoint and spread, and the camera then. */
export function startPinch(a, b, cam) {
  return {
    dist: gap(a, b),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
    zoom: cam.zoom,
    x: cam.x,
    y: cam.y,
  };
}

/**
 * The camera for fingers now at a and b. Zoom follows how far apart they are,
 * and the point of the map that was under their midpoint stays under it as it
 * moves, so two fingers zoom and pan at once. `view` is the canvas size in CSS
 * pixels; `limits` is { min, max } zoom.
 */
export function pinchCamera(start, a, b, view, limits) {
  const zoom = clamp(start.zoom * (gap(a, b) / start.dist), limits.min, limits.max);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const wx = (start.mx - view.width / 2) / start.zoom + start.x;
  const wy = (start.my - view.height / 2) / start.zoom + start.y;
  return {
    zoom,
    x: wx - (mx - view.width / 2) / zoom,
    y: wy - (my - view.height / 2) / zoom,
  };
}

/** Is this a small screen, where the panels fold away and the bottom bar takes over? */
export const COMPACT_QUERY = '(max-width: 900px), (max-height: 520px)';

export function isCompact() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(COMPACT_QUERY).matches);
}

/** A zoom that suits the screen at the start of a shift: a phone sees the same few streets, not a keyhole. */
export function startZoomFor(width, height, base) {
  const shortSide = Math.min(width, height);
  if (shortSide >= 600) return base;
  return clamp(base * (0.62 + (shortSide / 600) * 0.38), 0.5, base);
}
