// Navigation over tile grids. Vehicles prefer roads and the station apron but
// can drive on any open ground between the buildings (lanes, yards, lawns,
// pavements); not through buildings, water or woods. The crew may walk anywhere
// that is not a building footprint.
//
// A* is good enough here: even the 520×384 city is open ground and straight
// avenues, and a path is asked for only when somebody is ordered somewhere.

import { TILE } from '../core/config.js';
import { distToRect } from '../core/math.js';

// Four ways to move: vehicles `drive` on roads and aprons (bridges included),
// crews `walk` on anything that is not a building or open water, boats `sail` on
// water (under bridges too), and divers `swim` anywhere but through a building.
export const OFFROAD_COST = 1.35; // driving off the road costs this much more per tile

export function buildNav(city) {
  const { w, h, blocked, road, apron } = city;
  const water = city.water ?? new Uint8Array(w * h);
  const woods = city.woods ?? new Uint8Array(w * h);
  const walk = new Uint8Array(w * h);
  const drive = new Uint8Array(w * h);
  const driveCost = new Float32Array(w * h);
  const sail = new Uint8Array(w * h);
  const swim = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    walk[i] = blocked[i] || (water[i] && !road[i]) ? 0 : 1;
    const paved = road[i] || apron[i];
    drive[i] = paved || !(blocked[i] || water[i] || woods[i]) ? 1 : 0;
    driveCost[i] = paved ? 1 : OFFROAD_COST;
    sail[i] = water[i] ? 1 : 0;
    swim[i] = blocked[i] ? 0 : 1;
  }
  return { w, h, walk, drive, driveCost, sail, swim, water, lattice: buildLattice(city) };
}

// The avenues and streets form a lattice. Long drives are planned on it first
// (a few thousand junctions), then each leg between two junctions is searched
// tile by tile. That keeps a trip across the whole map to a few milliseconds.
export function buildLattice(city) {
  const runs = city.roadRuns;
  if (!runs?.v?.length || !runs?.h?.length) return null;
  const vs = runs.v.map((r) => r.line);
  const hs = runs.h.map((r) => r.line);
  const covers = (spans, a, b) => spans.some(([s0, s1]) => s0 <= a && s1 >= b);
  // hEdge[hi * nv + vi]: street hi is open from avenue vi to avenue vi + 1.
  const nv = vs.length;
  const nh = hs.length;
  const hEdge = new Uint8Array(nh * nv);
  const vEdge = new Uint8Array(nv * nh);
  for (let hi = 0; hi < nh; hi++) {
    for (let vi = 0; vi + 1 < nv; vi++) hEdge[hi * nv + vi] = covers(runs.h[hi].spans, vs[vi], vs[vi + 1] + 1) ? 1 : 0;
  }
  for (let vi = 0; vi < nv; vi++) {
    for (let hi = 0; hi + 1 < nh; hi++) vEdge[vi * nh + hi] = covers(runs.v[vi].spans, hs[hi], hs[hi + 1] + 1) ? 1 : 0;
  }
  return { vs, hs, nv, nh, hEdge, vEdge };
}

const gridOf = (nav, mode) => (mode === 'drive' ? nav.drive : mode === 'sail' ? nav.sail : mode === 'swim' ? nav.swim : nav.walk);

export const index = (nav, x, y) => y * nav.w + x;

export function passable(nav, mode, x, y) {
  if (x < 0 || y < 0 || x >= nav.w || y >= nav.h) return false;
  return gridOf(nav, mode)[y * nav.w + x] === 1;
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

  for (let guard = 0; guard < 1024; guard++) {
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

/**
 * Like `lineClear`, but for something with a body: the line and two parallel
 * lines `half` pixels to each side must all stay on `mode` ground. A road is only
 * two tiles wide, so this is what stops a long vehicle cutting a corner across
 * the pavement (and the building behind it).
 */
export function corridorClear(nav, mode, ax, ay, bx, by, half) {
  if (!lineClear(nav, mode, ax, ay, bx, by)) return false;
  if (!(half > 0)) return true;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  return lineClear(nav, mode, ax + nx, ay + ny, bx + nx, by + ny)
    && lineClear(nav, mode, ax - nx, ay - ny, bx - nx, by - ny);
}

// A binary min-heap of tile indices keyed by a float, kept in flat arrays so a
// long search allocates nothing per node.
class MinHeap {
  constructor() {
    this.keys = new Float64Array(1024);
    this.vals = new Int32Array(1024);
    this.n = 0;
  }
  get size() {
    return this.n;
  }
  push(val, key) {
    if (this.n === this.keys.length) {
      const keys = new Float64Array(this.n * 2);
      const vals = new Int32Array(this.n * 2);
      keys.set(this.keys);
      vals.set(this.vals);
      this.keys = keys;
      this.vals = vals;
    }
    const { keys, vals } = this;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  /** Remove and return the value with the smallest key. */
  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const n = --this.n;
    if (n > 0) {
      const key = keys[n];
      const val = vals[n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
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

/** The four junctions round a tile, as lattice (vi, hi) pairs. */
function junctionsAround(lat, x, y) {
  const bracket = (arr, v) => {
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const vi = bracket(lat.vs, x);
  const hi = bracket(lat.hs, y);
  const out = [];
  for (const dv of [0, 1]) {
    for (const dh of [0, 1]) {
      const a = vi + dv;
      const b = hi + dh;
      if (a < lat.nv && b < lat.nh) out.push([a, b]);
    }
  }
  return out;
}

/**
 * Plan a long drive on the avenue/street lattice: the junctions to pass through,
 * or null if the lattice offers no route (a street cut by a wreck or by woods).
 */
export function latticeRoute(nav, from, to) {
  const lat = nav.lattice;
  if (!lat) return null;
  const node = (vi, hi) => hi * lat.nv + vi;
  const total = lat.nv * lat.nh;
  const px = (n) => lat.vs[n % lat.nv] + 0.5;
  const py = (n) => lat.hs[(n - (n % lat.nv)) / lat.nv] + 0.5;
  const scratch = nav.latScratch ?? (nav.latScratch = { g: new Float32Array(total + 1), came: new Int32Array(total + 1), done: new Uint8Array(total + 1) });
  const { g, came, done } = scratch;
  g.fill(Infinity);
  came.fill(-1);
  done.fill(0);
  const goalNodes = new Map();
  for (const [vi, hi] of junctionsAround(lat, to.x, to.y)) goalNodes.set(node(vi, hi), true);
  const heap = new MinHeap();
  const dist = (a, b, c, d) => Math.hypot(a - c, b - d);
  for (const [vi, hi] of junctionsAround(lat, from.x, from.y)) {
    const n = node(vi, hi);
    g[n] = dist(from.x, from.y, px(n), py(n));
    heap.push(n, g[n] + dist(px(n), py(n), to.x, to.y));
  }
  let end = -1;
  let endCost = Infinity;
  while (heap.size > 0) {
    const n = heap.pop();
    if (done[n]) continue;
    done[n] = 1;
    if (goalNodes.has(n)) {
      const total2 = g[n] + dist(px(n), py(n), to.x, to.y);
      if (total2 < endCost) {
        endCost = total2;
        end = n;
      }
    }
    // Nothing better than the best goal found can still be queued.
    if (end >= 0 && g[n] >= endCost) break;
    const vi = n % lat.nv;
    const hi = (n - vi) / lat.nv;
    const next = [];
    if (vi + 1 < lat.nv && lat.hEdge[hi * lat.nv + vi]) next.push(n + 1);
    if (vi > 0 && lat.hEdge[hi * lat.nv + vi - 1]) next.push(n - 1);
    if (hi + 1 < lat.nh && lat.vEdge[vi * lat.nh + hi]) next.push(n + lat.nv);
    if (hi > 0 && lat.vEdge[vi * lat.nh + hi - 1]) next.push(n - lat.nv);
    for (const m of next) {
      if (done[m]) continue;
      const ng = g[n] + dist(px(n), py(n), px(m), py(m));
      if (ng < g[m]) {
        g[m] = ng;
        came[m] = n;
        heap.push(m, ng + dist(px(m), py(m), to.x, to.y));
      }
    }
  }
  if (end < 0) return null;
  const route = [];
  for (let n = end; n !== -1; n = came[n]) route.push({ x: Math.round(px(n) - 0.5), y: Math.round(py(n) - 0.5) });
  return route.reverse();
}

/**
 * A* on tile coordinates. Returns tiles after the start, or null. A long drive
 * is first planned along the street lattice and filled in leg by leg.
 */
export function findPath(nav, mode, from, to, legOnly = false) {
  if (mode === 'drive' && !legOnly && nav.lattice
    && octile(to.x - from.x, to.y - from.y) > 140) {
    const route = latticeRoute(nav, from, to);
    if (route && route.length > 0) {
      const stops = [from, ...route, to];
      const out = [];
      let ok = true;
      for (let i = 0; i + 1 < stops.length && ok; i++) {
        const leg = findPath(nav, mode, stops[i], stops[i + 1], true);
        if (leg === null) ok = false;
        else out.push(...leg);
      }
      if (ok) return out;
    }
  }
  return findPathTiles(nav, mode, from, to);
}

function findPathTiles(nav, mode, from, to) {
  const grid = gridOf(nav, mode);
  const costs = mode === 'drive' ? nav.driveCost : null;
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

  // The map is ~200,000 tiles and crews re-path several times a second, so the
  // search buffers are kept on the nav and reset by a generation stamp instead
  // of being allocated and filled on every call.
  const size = nav.w * nav.h;
  const scratch = nav.scratch ?? (nav.scratch = {
    gen: 0,
    stamp: new Uint32Array(size),
    closedStamp: new Uint32Array(size),
    g: new Float32Array(size),
    came: new Int32Array(size),
  });
  const gen = ++scratch.gen;
  const { stamp, closedStamp, g: gBuf, came } = scratch;
  const gAt = (i) => (stamp[i] === gen ? gBuf[i] : Infinity);
  const open = new MinHeap();
  const startIdx = start.y * nav.w + start.x;
  stamp[startIdx] = gen;
  gBuf[startIdx] = 0;
  came[startIdx] = -1;
  // Short trips are searched exactly. On a long trip the heuristic is weighted,
  // which keeps the search to a corridor round the straight line instead of
  // flooding the open ground on both sides: the route can be a few per cent
  // longer than the best one, which nobody driving across a city would notice.
  const trip = octile(goal.x - start.x, goal.y - start.y);
  const weight = trip < 80 ? 1 : Math.min(2.2, 1 + (trip - 80) / 120);
  open.push(startIdx, trip * weight);

  while (open.size > 0) {
    const ci = open.pop();
    if (closedStamp[ci] === gen) continue;
    closedStamp[ci] = gen;
    const cur = { x: ci % nav.w, y: (ci - (ci % nav.w)) / nav.w };

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
      if (closedStamp[ni] === gen) continue;
      const ng = gBuf[ci] + (costs ? cost * costs[ni] : cost);
      if (ng < gAt(ni)) {
        stamp[ni] = gen;
        gBuf[ni] = ng;
        came[ni] = ci;
        open.push(ni, ng + weight * octile(goal.x - nx, goal.y - ny));
      }
    }
  }
  return null;
}

/**
 * Drop waypoints that a straight line already clears, so units do not zigzag.
 * With `half` (a body's half-width in pixels) a shortcut is only taken if the
 * whole body fits along it.
 */
export function smoothPath(nav, mode, startPx, tiles, half = 0) {
  if (!tiles.length) return [];
  const points = tiles.map((t) => tileCenter(t.x, t.y));
  const out = [];
  let anchor = startPx;
  let i = 0;
  while (i < points.length) {
    let j = points.length - 1;
    while (j > i && !corridorClear(nav, mode, anchor.x, anchor.y, points[j].x, points[j].y, half)) j--;
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
