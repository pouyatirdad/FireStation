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

const SMALL = () => ['structure', 'structure', 'structure', 'rescue', 'block'];
const BIG = ['industrial', 'bigBlock', 'forest'];

function candidates(state, types = null) {
  return state.buildings.filter((b) => (
    b.state === 'ok'
    && b.id !== 'station'
    && (!types || types.includes(b.type))
  ));
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
  const tiles = state.city.forestTiles;
  if (!tiles || tiles.length === 0) return null;
  const tile = state.rng.pick(tiles);
  const wildfire = startWildfire(
    state,
    (tile.x + 0.5) * TILE,
    (tile.y + 0.5) * TILE,
    price(state, 'forest'),
  );
  return wildfire;
}

function spawnSmall(state) {
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
