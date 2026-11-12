// Calls for service: the incident generator.
//
// Small jobs arrive on a timer from the first minute. Major incidents are held
// back until the shift has been running for `bigAfter` seconds, give much more
// money, and only one can be live at a time.

import { CONFIG, TILE } from '../core/config.js';
import { rectsTouch } from '../core/math.js';
import { addEvent } from './events.js';
import { buildingRect, ignite } from './fire.js';
import { startWildfire } from './wildfire.js';
import { spawnPatient } from './medical.js';

const SMALL = () => ['structure', 'structure', 'structure', 'rescue', 'block'];
const BIG = ['industrial', 'bigBlock', 'forest'];

/**
 * How far from Station 1 (in tiles) a call can come from. It starts as the
 * neighbourhood and grows through the shift until the whole city is covered.
 */
export function coverageRadius(state) {
  const { start, growPerSecond } = CONFIG.incidents.radius;
  return start + state.time * growPerSecond;
}

const inCoverage = (state, x, y, scale = 1) => {
  const station = state.city.station;
  const cx = station.x + station.w / 2;
  const cy = station.y + station.h / 2;
  return Math.hypot(x - cx, y - cy) <= coverageRadius(state) * scale;
};

function candidates(state, types = null) {
  const pool = state.buildings.filter((b) => (
    b.state === 'ok'
    && b.id !== 'station'
    && (!types || types.includes(b.type))
  ));
  const near = pool.filter((b) => inCoverage(state, b.x + b.w / 2, b.y + b.h / 2));
  return near.length ? near : pool;
}

function pick(state, types = null) {
  const pool = candidates(state, types);
  return pool.length ? state.rng.pick(pool) : null;
}

function price(state, kind, count = 1) {
  const total = CONFIG.incidents.reward[kind] ?? 300;
  return Math.round(total / count);
}

function structureFire(state) {
  const building = pick(state);
  if (!building) return null;
  building.reward = price(state, 'structure');
  building.incidentType = 'structure';
  ignite(state, building, 'call');
  return building;
}

function blockFire(state, count) {
  const first = pick(state);
  if (!first) return null;
  const rect = buildingRect(first);
  const neighbours = state.buildings.filter((b) => (
    b !== first
    && b.state === 'ok'
    && b.id !== 'station'
    && rectsTouch(rect, buildingRect(b), 4 * TILE)
  ));
  const picks = [first, ...state.rng.shuffle(neighbours).slice(0, count - 1)];
  const each = price(state, 'block', picks.length);
  for (const b of picks) {
    b.reward = each;
    b.incidentType = 'block';
  }
  for (const b of picks) ignite(state, b, 'call');
  addEvent(state, `Block fire — ${picks.length} buildings around ${first.name}`, 'fire');
  return picks[0];
}

function rescueJob(state) {
  const building = pick(state, ['office', 'hotel', 'apartment', 'shop']);
  if (!building) return null;
  building.trapped = state.rng.int(1, 2);
  building.incidentType = 'rescue';
  building.reward = price(state, 'rescue');
  addEvent(state, `Person reported trapped — ${building.name}`, 'warn');
  return building;
}

function industrialFire(state) {
  const building = pick(state, ['warehouse', 'office', 'hotel']);
  if (!building) return null;
  building.reward = price(state, 'industrial');
  building.incidentType = 'big';
  building.big = true;
  ignite(state, building, 'call');
  building.fire = 0.55;
  addEvent(state, `MAJOR INCIDENT — industrial fire at ${building.name}`, 'big');
  return building;
}

function bigBlockFire(state) {
  const first = pick(state);
  if (!first) return null;
  const rect = buildingRect(first);
  const neighbours = state.buildings.filter((b) => (
    b !== first
    && b.state === 'ok'
    && b.id !== 'station'
    && rectsTouch(rect, buildingRect(b), 5 * TILE)
  ));
  const picks = [first, ...state.rng.shuffle(neighbours).slice(0, 3)];
  const each = price(state, 'bigBlock', picks.length);
  for (const b of picks) {
    b.reward = each;
    b.incidentType = 'big';
    b.big = true;
  }
  for (const b of picks) ignite(state, b, 'call');
  addEvent(state, `MAJOR INCIDENT — ${picks.length} buildings alight around ${first.name}`, 'big');
  return picks[0];
}

function forestFire(state) {
  const all = state.city.forestTiles;
  if (!all || all.length === 0) return null;
  const near = all.filter((t) => inCoverage(state, t.x, t.y, 1.4));
  const tile = state.rng.pick(near.length ? near : all);
  const wildfire = startWildfire(
    state,
    (tile.x + 0.5) * TILE,
    (tile.y + 0.5) * TILE,
    price(state, 'forest'),
  );
  return wildfire;
}

function medicalCall(state) {
  if (state.patients.filter((p) => !p.treated).length >= 5) return null;
  const building = pick(state, ['house', 'apartment', 'office', 'hotel', 'shop', 'pharmacy']);
  if (!building) return null;
  return spawnPatient(state, building, state.rng.range(0.3, 1));
}

function spawnSmall(state) {
  if (state.rng.chance(CONFIG.incidents.medicalCall)) return medicalCall(state);
  const kind = state.rng.pick(SMALL());
  if (kind === 'rescue') return rescueJob(state);
  if (kind === 'block') return blockFire(state, 2);
  return structureFire(state);
}

function spawnBig(state) {
  const kind = state.rng.pick(BIG);
  if (kind === 'industrial') return industrialFire(state);
  if (kind === 'forest') return forestFire(state);
  return bigBlockFire(state);
}

export function bigIncidentActive(state) {
  if (state.wildfires.some((w) => w.intensity > 0)) return true;
  return state.buildings.some((b) => b.big && (b.state === 'burning' || b.state === 'out'));
}

export function updateIncidents(state, dt) {
  if (state.incidentsEnabled === false) return;
  const active = state.buildings.filter((b) => b.state === 'burning').length;

  state.nextCallAt -= dt;
  if (state.nextCallAt <= 0) {
    const [lo, hi] = CONFIG.incidents.callEvery;
    state.nextCallAt = state.rng.range(lo, hi) * (bigIncidentActive(state) ? 1.35 : 1);
    if (active < CONFIG.incidents.maxActive) spawnSmall(state);
  }

  if (state.time < CONFIG.incidents.bigAfter) return;

  state.nextBigAt -= dt;
  if (state.nextBigAt > 0) return;
  if (active >= 4 || bigIncidentActive(state)) {
    state.nextBigAt = 15;
    return;
  }
  const [lo, hi] = CONFIG.incidents.bigEvery;
  state.nextBigAt = state.rng.range(lo, hi);
  spawnBig(state);
}
