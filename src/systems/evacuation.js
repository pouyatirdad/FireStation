// Evacuation. The player orders an evacuation zone round an incident (a hazard
// zone, a forest fire, a building about to explode). Buildings inside it are
// emptied one after another, the residents walk to an emergency shelter, the
// streets inside are closed to traffic, and a building that is emptied first
// cannot kill anyone when it burns or blows. The zone lifts by itself when the
// danger is over and the residents go home.

import { clone, registerPersistence } from './persistence.js';
import { CONFIG, TILE } from '../core/config.js';
import { findPath, smoothPath, standTileForRect, tileCenter } from './grid.js';
import { addEvent } from './events.js';
import { supportAt } from './modifiers.js';
import { nextId } from './persistence.js';

const SHELTER_TYPES = ['school', 'mall', 'hospital', 'hotel'];
const MAX_ZONES = 4;
const MIN_ZONE_TIME = 60; // seconds
const COLORS = ['#3d6fb0', '#b0553d', '#4f7a45', '#8a5a9e', '#b08a3a', '#5e6b78'];


export function createEvacuation() {
  return { zones: [], stats: { evacuated: 0, sheltered: 0, unsheltered: 0, zones: 0 } };
}

export function restoreEvacuation(data) {
  const e = createEvacuation();
  if (!data || !Array.isArray(data.zones)) return e;
  e.zones = data.zones.map((z) => ({ ...z, queue: [...(z.queue ?? [])] }));
  e.stats = { ...e.stats, ...(data.stats ?? {}) };
  return e;
}

const centreOf = (b) => ({ x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE });
const inside = (z, b) => {
  const c = centreOf(b);
  return Math.hypot(c.x - z.x, c.y - z.y) <= z.radius;
};

/** What danger keeps a zone alive: anything burning, leaking or collapsed inside it, or a forest fire at its edge. */
function dangerIn(state, z) {
  for (const b of state.buildings) {
    if (!inside(z, b)) continue;
    if (b.state === 'burning' || (b.leak ?? 0) > 0 || b.collapse) return true;
  }
  return (state.wildfires ?? []).some((w) => Math.hypot(w.x - z.x, w.y - z.y) <= z.radius + w.radius);
}

function pickShelter(state, z) {
  let best = null;
  let bestD = Infinity;
  const used = new Map();
  for (const other of state.evac.zones) if (other.shelter) used.set(other.shelter.buildingId, (used.get(other.shelter.buildingId) ?? 0) + other.shelter.sheltered);
  for (const b of state.buildings) {
    if (!SHELTER_TYPES.includes(b.type) || b.state !== 'ok' || inside(z, b)) continue;
    const c = centreOf(b);
    const d = Math.hypot(c.x - z.x, c.y - z.y);
    if (d < z.radius + 3 * TILE || d >= bestD) continue;
    if ((used.get(b.id) ?? 0) >= CONFIG.evacuation.shelterCapacity) continue;
    bestD = d;
    best = b;
  }
  return best;
}

/** Order an evacuation. `target` is `{ x, y, radius?, buildingId?, label? }` in world pixels. */
export function startEvacuation(state, target) {
  const e = state.evac;
  const radius = (target.radius ?? CONFIG.evacuation.radius * TILE);
  if (e.zones.length >= MAX_ZONES) {
    addEvent(state, `Only ${MAX_ZONES} evacuation zones can be run at once`, 'warn');
    return null;
  }
  const dup = e.zones.find((z) => Math.hypot(z.x - target.x, z.y - target.y) < z.radius * 0.5);
  if (dup) {
    addEvent(state, 'That area is already being evacuated', 'info');
    return dup;
  }
  const zone = {
    id: nextId(state, 'evac'), x: target.x, y: target.y, radius, label: target.label ?? 'the area',
    startedAt: state.time, acc: 0, queue: [], total: 0, evacuated: 0, closed: true, shelter: null, boosted: false,
  };
  const list = state.buildings
    .filter((b) => b.type !== 'station' && b.type !== 'hospital' && b.state !== 'rubble' && (b.occupants ?? 0) > 0 && !b.evacuated && inside(zone, b))
    .sort((a, b) => Math.hypot(centreOf(a).x - zone.x, centreOf(a).y - zone.y) - Math.hypot(centreOf(b).x - zone.x, centreOf(b).y - zone.y));
  zone.queue = list.map((b) => b.id);
  zone.total = zone.queue.length;
  const shelter = pickShelter(state, zone);
  zone.shelter = shelter ? { buildingId: shelter.id, name: shelter.name, sheltered: 0 } : null;
  e.zones.push(zone);
  e.stats.zones += 1;
  closeStreets(state, zone);
  addEvent(state, `Evacuation of ${zone.label}: ${zone.total} building${zone.total === 1 ? '' : 's'} to clear` +
    (shelter ? `, shelter at ${shelter.name}` : ', no shelter in reach'), 'info');
  return zone;
}

/** Cars leave a closed zone; the streets inside are not open to traffic. */
function closeStreets(state, zone) {
  const traffic = state.traffic;
  if (!traffic) return;
  const gone = new Set();
  for (const car of traffic.cars) {
    if (Math.hypot(car.x - zone.x, car.y - zone.y) <= zone.radius) gone.add(car);
  }
  if (gone.size === 0) return;
  traffic.cars = traffic.cars.filter((c) => !gone.has(c));
  for (const lane of traffic.lanes) lane.cars = lane.cars.filter((c) => !gone.has(c));
}

function walkTo(state, b, count, shelterB) {
  const rect = { x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE };
  const start = standTileForRect(state.nav, rect, rect.x + rect.w / 2, rect.y + rect.h / 2, 5);
  if (!start) return;
  let goal = null;
  if (shelterB) {
    goal = standTileForRect(state.nav, { x: shelterB.x * TILE, y: shelterB.y * TILE, w: shelterB.w * TILE, h: shelterB.h * TILE }, rect.x, rect.y, 6);
  }
  if (!goal) return;
  const tiles = findPath(state.nav, 'walk', start, goal);
  if (!tiles) return;
  const origin = tileCenter(start.x, start.y);
  const visible = Math.min(count, 4, 24 - state.fleeing.length);
  for (let i = 0; i < visible; i++) {
    const x = origin.x + state.rng.range(-9, 9);
    const y = origin.y + state.rng.range(-9, 9);
    state.fleeing.push({
      x, y, angle: 0, path: smoothPath(state.nav, 'walk', { x, y }, tiles),
      speed: state.rng.range(2.1, 3.1) * TILE, color: state.rng.pick(COLORS), phase: state.rng.range(0, Math.PI * 2),
    });
  }
}

export function updateEvacuation(state, dt) {
  const e = state.evac;
  if (!e || e.zones.length === 0) return;
  for (let i = e.zones.length - 1; i >= 0; i--) {
    const z = e.zones[i];
    const civil = supportAt(state, 'civil', z.x, z.y) ? 2 : 1;
    z.acc += dt * civil;
    while (z.queue.length > 0 && z.acc >= CONFIG.evacuation.pace) {
      z.acc -= CONFIG.evacuation.pace;
      const id = z.queue.shift();
      const b = state.buildings.find((x) => x.id === id);
      if (!b || b.evacuated || b.state === 'rubble') continue;
      const n = b.occupants ?? 0;
      b.evacOccupants = n;
      b.occupants = 0;
      b.evacuated = true;
      b.evacZone = z.id;
      z.evacuated += n;
      e.stats.evacuated += n;
      state.stats.evacuated = (state.stats.evacuated ?? 0) + n;
      const cap = CONFIG.evacuation.shelterCapacity * (civil > 1 ? 2 : 1);
      const shelter = z.shelter ? state.buildings.find((x) => x.id === z.shelter.buildingId) : null;
      const room = Math.max(0, cap - (z.shelter?.sheltered ?? 0));
      const housed = shelter ? Math.min(room, n) : 0;
      if (z.shelter) z.shelter.sheltered += housed;
      e.stats.sheltered += housed;
      e.stats.unsheltered += n - housed;
      if (shelter && housed > 0) walkTo(state, b, housed, shelter);
    }
    if (z.queue.length > 0) continue;
    // Everyone is out. When the danger passes the zone lifts and people go home.
    // A zone stays up for at least a minute, and until the danger has passed.
    if (state.time - z.startedAt >= MIN_ZONE_TIME && !dangerIn(state, z)) {
      for (const b of state.buildings) {
        if (b.evacZone !== z.id) continue;
        b.evacZone = null;
        if (b.state === 'ok') {
          b.evacuated = false;
          b.occupants = b.evacOccupants ?? b.occupants;
        }
      }
      e.zones.splice(i, 1);
      addEvent(state, `Evacuation of ${z.label} lifted — ${z.evacuated} people go home`, 'good');
    }
  }
}

/** Incidents that would benefit from an evacuation and have none: hazard zones and forest fires. */
export function evacuationAdvice(state) {
  const out = [];
  const covered = (x, y) => state.evac.zones.some((z) => Math.hypot(z.x - x, z.y - y) <= z.radius);
  for (const h of state.hazards ?? []) {
    if (h.level >= 0.3 && !covered(h.x, h.y)) out.push({ kind: 'building', id: h.buildingId, x: h.x, y: h.y, radius: h.radius + 4 * TILE, label: h.name });
  }
  for (const w of state.wildfires ?? []) {
    if (!covered(w.x, w.y)) out.push({ kind: 'wildfire', id: w.id, x: w.x, y: w.y, radius: w.radius + 8 * TILE, label: 'the forest fire' });
  }
  return out;
}

/** The order the UI and the dispatch give: evacuate round an incident. */
export function evacuateIncident(state, kind, id) {
  let target = null;
  if (kind === 'wildfire') {
    const w = state.wildfires.find((x) => x.id === id);
    if (w) target = { x: w.x, y: w.y, radius: w.radius + 8 * TILE, label: 'the forest fire' };
  } else if (kind === 'building') {
    const b = state.buildings.find((x) => x.id === id);
    if (b) {
      const hazard = (state.hazards ?? []).find((h) => h.buildingId === b.id);
      target = { ...centreOf(b), radius: hazard ? hazard.radius + 4 * TILE : CONFIG.evacuation.radius * TILE, label: b.name };
    }
  }
  if (!target) return null;
  return startEvacuation(state, target);
}

registerPersistence({
  key: 'evac',
  order: 84,
  save: (state) => clone(state.evac),
  load: (state, data) => { state.evac = restoreEvacuation(data.evac); },
});
