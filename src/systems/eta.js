// Estimated arrival times. There is no second router here: a vehicle already on
// its way is measured along the path it is actually following, and one that is
// still in quarters is routed with the same A* (`findPath`) the orders use.
// Speed is the vehicle's own, times the traffic factor (rush hour, police
// control) and its crew's driving skill, so the figure moves when conditions do.

import { TILE } from '../core/config.js';
import { dist } from '../core/math.js';
import { findPath, nearestPassable, smoothPath, tileOf } from './grid.js';
import { speedMod } from './modifiers.js';

const CACHE_FOR = 3; // seconds of game time a computed route is reused
const BODY_HALF = TILE * 0.46;

export function pathLength(from, points) {
  let len = 0;
  let x = from.x;
  let y = from.y;
  for (const p of points) {
    len += Math.hypot(p.x - x, p.y - y);
    x = p.x;
    y = p.y;
  }
  return len;
}

/** Pixels per second the vehicle covers right now on its way. */
export function travelSpeed(state, engine) {
  const base = engine.spec.speed * TILE;
  if (engine.spec.flying || engine.spec.boat) return base * speedMod(state, engine);
  return base * (state.trafficFactor ?? 1) * speedMod(state, engine);
}

function routeKey(state, engine, x, y) {
  return `${Math.round(x)},${Math.round(y)}|${state.blockades?.length ?? 0}|${state.cutCount ?? 0}`;
}

/**
 * Route and arrival estimate from a vehicle to a world point.
 * Returns `{ seconds, length, points, reachable }`.
 */
export function estimate(state, engine, x, y) {
  const speed = travelSpeed(state, engine);
  if (engine.spec.plane || engine.spec.flying) {
    const length = dist(engine.x, engine.y, x, y);
    return { seconds: length / speed + (engine.packTimer || 0), length, points: [{ x, y }], reachable: true };
  }

  // Already moving there: the path it is following is the route.
  if (engine.path.length > 0 && engine.goal) {
    const gx = (engine.goal.x + 0.5) * TILE;
    const gy = (engine.goal.y + 0.5) * TILE;
    if (dist(gx, gy, x, y) <= 16 * TILE) {
      const length = pathLength(engine, engine.path);
      return { seconds: length / speed + (engine.packTimer || 0), length, points: engine.path, reachable: true };
    }
  }

  const cache = (engine.etaCache = engine.etaCache ?? {});
  const key = routeKey(state, engine, x, y);
  if (cache.key === key && state.time - cache.at < CACHE_FOR) {
    const length = cache.points ? pathLength(engine, cache.points) : Infinity;
    return { seconds: length / speed, length, points: cache.points ?? [], reachable: Boolean(cache.points) };
  }

  const mode = engine.spec.boat ? 'sail' : 'drive';
  const goal = nearestPassable(state.nav, mode, Math.floor(x / TILE), Math.floor(y / TILE), 14);
  let points = null;
  if (goal) {
    const tiles = findPath(state.nav, mode, tileOf(engine.x, engine.y), goal);
    if (tiles) points = smoothPath(state.nav, mode, { x: engine.x, y: engine.y }, tiles, mode === 'drive' ? BODY_HALF : 0);
  }
  cache.key = key;
  cache.at = state.time;
  cache.points = points;
  if (!points) return { seconds: Infinity, length: Infinity, points: [], reachable: false };
  const length = pathLength(engine, points);
  return { seconds: length / speed, length, points, reachable: true };
}

/** The point an incident (a building, forest fire, patient, victim, wreck) is at. */
export function incidentPoint(state, kind, id) {
  if (kind === 'building') {
    const b = state.buildings.find((x) => x.id === id);
    return b ? { x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE } : null;
  }
  const list = { wildfire: state.wildfires, patient: state.patients, victim: state.victims, blockade: state.blockades }[kind];
  const e = list?.find((v) => v.id === id);
  return e ? { x: e.x, y: e.y } : null;
}

/** What a vehicle is heading for right now, as `{ kind, id }`, or null. */
export function currentTarget(engine) {
  if (engine.targetId) return { kind: 'building', id: engine.targetId };
  if (engine.wildfireId) return { kind: 'wildfire', id: engine.wildfireId };
  if (engine.patientId) return { kind: 'patient', id: engine.patientId };
  if (engine.victimId) return { kind: 'victim', id: engine.victimId };
  if (engine.blockadeId) return { kind: 'blockade', id: engine.blockadeId };
  if (engine.standbyFor && engine.path.length > 0) return engine.standbyFor;
  return null;
}

/** Seconds until this vehicle reaches what it was sent to; null if it is not on its way. */
export function engineEta(state, engine) {
  if (engine.path.length === 0 || engine.arrived) return null;
  const t = currentTarget(engine);
  const p = t ? incidentPoint(state, t.kind, t.id) : engine.path[engine.path.length - 1];
  if (!p) return null;
  return estimate(state, engine, p.x, p.y).seconds;
}

/** Every vehicle heading for an incident with its arrival time, soonest first. */
export function incidentEtas(state, kind, id) {
  const out = [];
  for (const engine of state.engines) {
    const t = currentTarget(engine);
    if (!t || t.kind !== kind || t.id !== id || engine.arrived || engine.path.length === 0) continue;
    const eta = engineEta(state, engine);
    if (eta != null && Number.isFinite(eta)) out.push({ engine, seconds: eta });
  }
  return out.sort((a, b) => a.seconds - b.seconds);
}

export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}
