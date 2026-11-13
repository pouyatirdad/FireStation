// The railway and the metro: lines of track that join the railway stations and
// the metro entrances along the avenues and streets, and the trains that run on
// them. The railway is an elevated line over the street; the metro runs in a
// tunnel under it. Trains are not part of the simulation: where one is at any
// moment is a pure function of the game clock, so the renderer, the minimap and
// the tests all agree and nothing needs saving.

import { buildLattice, latticeRoute } from '../systems/grid.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Visit the points nearest-first, starting from the first of `start`. */
function nearestChain(points, startAt) {
  const left = points.slice();
  const first = left.splice(startAt, 1)[0];
  const out = [first];
  while (left.length) {
    const last = out[out.length - 1];
    let best = 0;
    for (let i = 1; i < left.length; i++) if (dist(left[i], last) < dist(left[best], last)) best = i;
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

/** The junctions to pass through to visit every stop in order, as one polyline. */
function routeThrough(nav, stops) {
  const pts = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const route = latticeRoute(nav, centre(stops[i]), centre(stops[i + 1]));
    if (!route) continue;
    for (const p of route) {
      const last = pts[pts.length - 1];
      if (last && last.x !== p.x && last.y !== p.y) pts.push({ x: p.x, y: last.y }); // join two legs at a corner, not diagonally
      if (!last || last.x !== p.x || last.y !== p.y) pts.push({ x: p.x, y: p.y });
    }
  }
  // Drop corners that are not corners, and any place the line doubles back on itself.
  const out = [];
  for (const p of pts) {
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear = (b.x - a.x) * (p.y - b.y) === (b.y - a.y) * (p.x - b.x);
      if (!collinear) break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}

function makeLine(nav, def, stations) {
  if (stations.length < 2) return null;
  const pts = routeThrough(nav, stations);
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const length = cum[cum.length - 1];
  // A stop is the vertex of the line nearest each station.
  const stops = stations.map((b) => {
    const c = centre(b);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (dist(pts[i], c) < dist(pts[best], c)) best = i;
    return { x: pts[best].x, y: pts[best].y, d: cum[best], name: b.name, building: b.id };
  });
  return {
    ...def,
    pts,
    cum,
    length,
    stops,
    trains: Math.max(2, Math.round(length / def.spacing)),
  };
}

export function buildTransit(city) {
  const nav = { lattice: buildLattice(city) };
  const lines = [];
  if (!nav.lattice) return { lines };

  // The railway: one line through every railway station, west to east.
  const rail = city.buildings.filter((b) => b.type === 'railstation').sort((a, b) => a.x - b.x);
  const railLine = makeLine(nav, { id: 'rail1', kind: 'rail', name: 'Harbor Line', color: '#2f6fa8', speed: 7, cars: 5, carGap: 1.7, spacing: 220 }, rail.length >= 2 ? nearestChain(rail, 0) : []);
  if (railLine) lines.push(railLine);

  // The metro: the entrances are shared out between a red line and a blue line.
  const entrances = city.buildings.filter((b) => b.type === 'metro').sort((a, b) => a.x - b.x);
  const red = entrances.filter((_, i) => i % 2 === 0);
  const blue = entrances.filter((_, i) => i % 2 === 1);
  for (const [def, list] of [
    [{ id: 'metro1', kind: 'metro', name: 'Red Line', color: '#e5484d', speed: 9, cars: 4, carGap: 1.5, spacing: 170 }, red],
    [{ id: 'metro2', kind: 'metro', name: 'Blue Line', color: '#3b82f6', speed: 9, cars: 4, carGap: 1.5, spacing: 170 }, blue],
  ]) {
    const line = makeLine(nav, def, list.length >= 2 ? nearestChain(list, 0) : []);
    if (line) lines.push(line);
  }
  return { lines };
}

/** The point `s` tiles along a line, with the direction of the line there. */
export function pointAt(line, s) {
  const { pts, cum } = line;
  const d = Math.max(0, Math.min(line.length, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const span = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / span;
  return { x: a.x + (b.x - a.x) * t + 0.5, y: a.y + (b.y - a.y) * t + 0.5, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

/**
 * Every train on a line at game time `time`: each runs the line end to end and
 * back, evenly spaced. A train is a list of cars from the head backwards, in
 * tile coordinates, each with the direction it points.
 */
export function trainsAt(line, time) {
  const out = [];
  const lap = 2 * line.length;
  for (let i = 0; i < line.trains; i++) {
    const phase = (((time * line.speed + (i * lap) / line.trains) % lap) + lap) % lap;
    const forward = phase <= line.length;
    const head = forward ? phase : lap - phase;
    const cars = [];
    for (let k = 0; k < line.cars; k++) {
      const p = pointAt(line, head - (forward ? 1 : -1) * k * line.carGap);
      cars.push({ x: p.x, y: p.y, angle: p.angle + (forward ? 0 : Math.PI) });
    }
    out.push({ forward, cars });
  }
  return out;
}
