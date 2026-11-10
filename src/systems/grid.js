// Navigation over tile grids. The engine is allowed on roads and the station
// apron; the crew may walk anywhere that is not a building footprint.
//
// A* is good enough here: the city is 2,400 tiles, and a path is asked for only
// when somebody is ordered somewhere.

import { TILE } from '../core/config.js';
import { distToRect } from '../core/math.js';

export function buildNav(city) {
  const { w, h, blocked, road, apron } = city;
  const walk = new Uint8Array(w * h);
  const drive = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    walk[i] = blocked[i] ? 0 : 1;
    drive[i] = road[i] || apron[i] ? 1 : 0;
  }
  return { w, h, walk, drive };
}

export const index = (nav, x, y) => y * nav.w + x;

export function passable(nav, mode, x, y) {
  if (x < 0 || y < 0 || x >= nav.w || y >= nav.h) return false;
  return (mode === 'drive' ? nav.drive : nav.walk)[y * nav.w + x] === 1;
}

export const walkableAt = (nav, x, y) => passable(nav, 'walk', x, y);
export const driveableAt = (nav, x, y) => passable(nav, 'drive', x, y);

export const tileOf = (px, py) => ({ x: Math.floor(px / TILE), y: Math.floor(py / TILE) });

export function tileCenter(tx, ty) {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/**
 * True if the straight line between two world points never leaves `mode`
 * ground. This is a grid traversal (Amanatides–Woo), not point sampling: a
 * diagonal that clips the corner of a blocked tile is rejected, which is what
 * keeps a smoothed engine path off the pavement.
 */
export function lineClear(nav, mode, ax, ay, bx, by) {
  let x = Math.floor(ax / TILE);
  let y = Math.floor(ay / TILE);
  if (!passable(nav, mode, x, y)) return false;

  const dx = bx - ax;
  const dy = by - ay;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const tDeltaX = dx === 0 ? Infinity : Math.abs(TILE / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(TILE / dy);
  let tX = dx === 0
    ? Infinity
    : (stepX > 0 ? (x + 1) * TILE - ax : ax - x * TILE) / Math.abs(dx);
  let tY = dy === 0
    ? Infinity
    : (stepY > 0 ? (y + 1) * TILE - ay : ay - y * TILE) / Math.abs(dy);

  for (let guard = 0; guard < 512; guard++) {
    let t;
    if (tX < tY) {
      t = tX;
      tX += tDeltaX;
      x += stepX;
    } else {
      t = tY;
      tY += tDeltaY;
      y += stepY;
    }
    if (t > 1) return true;
    if (!passable(nav, mode, x, y)) return false;
  }
  return false;
}

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(node) {
    const a = this.items;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < a.length && a[l].f < a[small].f) small = l;
        if (r < a.length && a[r].f < a[small].f) small = r;
        if (small === i) break;
        [a[small], a[i]] = [a[i], a[small]];
        i = small;
      }
    }
    return top;
  }
}

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

const octile = (dx, dy) => {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  return ax + ay - Math.SQRT2 * Math.min(ax, ay);
};

/** Nearest passable tile to (tx, ty), spiralling outwards by ring. */
export function nearestPassable(nav, mode, tx, ty, maxR = 8) {
  if (passable(nav, mode, tx, ty)) return { x: tx, y: ty };
  for (let r = 1; r <= maxR; r++) {
    let best = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (!passable(nav, mode, x, y)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** A* on tile coordinates. Returns tiles after the start, or null. */
export function findPath(nav, mode, from, to) {
  const grid = mode === 'drive' ? nav.drive : nav.walk;
  const start = passable(nav, mode, from.x, from.y)
    ? { x: from.x, y: from.y }
    : nearestPassable(nav, mode, from.x, from.y, 4);
  let goal = { x: to.x, y: to.y };
  if (!passable(nav, mode, goal.x, goal.y)) {
    const near = nearestPassable(nav, mode, goal.x, goal.y, 8);
    if (!near) return null;
    goal = near;
  }
  if (!start) return null;
  if (start.x === goal.x && start.y === goal.y) return [];

  const size = nav.w * nav.h;
  const gScore = new Float32Array(size).fill(Infinity);
  const came = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const open = new MinHeap();
  const startIdx = start.y * nav.w + start.x;
  gScore[startIdx] = 0;
  open.push({ x: start.x, y: start.y, f: octile(goal.x - start.x, goal.y - start.y) });

  while (open.size > 0) {
    const cur = open.pop();
    const ci = cur.y * nav.w + cur.x;
    if (closed[ci]) continue;
    closed[ci] = 1;

    if (cur.x === goal.x && cur.y === goal.y) {
      const path = [];
      let at = ci;
      while (at !== startIdx && at !== -1) {
        path.push({ x: at % nav.w, y: Math.floor(at / nav.w) });
        at = came[at];
      }
      path.reverse();
      return path;
    }

    for (const [dx, dy, cost] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!passable(nav, mode, nx, ny)) continue;
      // Never cut a diagonal corner between two blocked tiles.
      if (dx !== 0 && dy !== 0) {
        if (!grid[cur.y * nav.w + nx] || !grid[ny * nav.w + cur.x]) continue;
      }
      const ni = ny * nav.w + nx;
      if (closed[ni]) continue;
      const ng = gScore[ci] + cost;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = ci;
        open.push({ x: nx, y: ny, f: ng + octile(goal.x - nx, goal.y - ny) });
      }
    }
  }
  return null;
}

/** Drop waypoints that a straight line already clears, so units do not zigzag. */
export function smoothPath(nav, mode, startPx, tiles) {
  if (!tiles.length) return [];
  const points = tiles.map((t) => tileCenter(t.x, t.y));
  const out = [];
  let anchor = startPx;
  let i = 0;
  while (i < points.length) {
    let j = points.length - 1;
    while (j > i && !lineClear(nav, mode, anchor.x, anchor.y, points[j].x, points[j].y)) j--;
    out.push(points[j]);
    anchor = points[j];
    i = j + 1;
  }
  return out;
}

/** Best tile to stand on to work on a building: just outside its footprint. */
export function standTileForRect(nav, rect, fromX, fromY, radius = 4) {
  const x0 = Math.floor(rect.x / TILE) - 1;
  const y0 = Math.floor(rect.y / TILE) - 1;
  const x1 = Math.ceil((rect.x + rect.w) / TILE);
  const y1 = Math.ceil((rect.y + rect.h) / TILE);
  let best = null;
  let bestCost = Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!walkableAt(nav, x, y)) continue;
      const px = (x + 0.5) * TILE;
      const py = (y + 0.5) * TILE;
      const d = distToRect(px, py, rect);
      if (d > radius * TILE) continue;
      const cost = d + Math.hypot(px - fromX, py - fromY) * 0.35;
      if (cost < bestCost) {
        bestCost = cost;
        best = { x, y };
      }
    }
  }
  return best;
}
