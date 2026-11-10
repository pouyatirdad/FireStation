// Small maths helpers shared by the systems and the renderer.

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

export const angleTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Turn `from` toward `to` by at most `step` radians. */
export function approachAngle(from, to, step) {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= step) return to;
  return from + Math.sign(d) * step;
}

/** Distance from a point to an axis-aligned rectangle. Zero inside it. */
export function distToRect(px, py, rect) {
  const dx = Math.max(rect.x - px, 0, px - (rect.x + rect.w));
  const dy = Math.max(rect.y - py, 0, py - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

export function pointInRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/** Point on a rectangle's edge closest to (px, py) — where a stream lands. */
export function closestOnRect(px, py, rect) {
  return {
    x: clamp(px, rect.x, rect.x + rect.w),
    y: clamp(py, rect.y, rect.y + rect.h),
  };
}

export function rectsTouch(a, b, gap = 0) {
  return (
    a.x - gap < b.x + b.w &&
    b.x - gap < a.x + a.w &&
    a.y - gap < b.y + b.h &&
    b.y - gap < a.y + a.h
  );
}

export function formatClock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// A tiny seeded PRNG. The city is generated from it, so the same seed always
// produces the same streets and the tests can name a building.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1) {
    this._next = mulberry32(seed);
  }
  float() {
    return this._next();
  }
  range(a, b) {
    return a + (b - a) * this._next();
  }
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p) {
    return this._next() < p;
  }
  pick(list) {
    return list[Math.floor(this._next() * list.length)];
  }
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
