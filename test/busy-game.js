// A helper for the save tests (it holds no tests of its own): a deterministic game with as many kinds of
// thing going on as possible, so a reflection over it finds the fields every entity can really have.

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatchAll,
} from '../src/systems/game.js';
import { createCareer, createScenarioGame } from '../src/systems/modes.js';
import { findChallenge } from '../src/data/scenarios.js';
import { drowningCall } from '../src/systems/water.js';
import { startWildfire } from '../src/systems/wildfire.js';
import { addBlockade } from '../src/systems/blockades.js';
import { collapseBuilding } from '../src/systems/collapse.js';
import { startLeak } from '../src/systems/hazmat.js';
import { startEvacuation } from '../src/systems/evacuation.js';
import { callAgency } from '../src/systems/agencies.js';
import { spawnPatient } from '../src/systems/medical.js';
import { ignite } from '../src/systems/fire.js';
import { Rng } from '../src/core/math.js';
import { TILE } from '../src/core/config.js';

/** A tile pair on a street, for a wreck. */
function streetSpot(state) {
  const { road, w, h } = state.city;
  const st = state.city.station;
  for (let r = 14; r < 80; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = st.x + dx;
        const y = st.y + dy;
        if (x < 2 || y < 2 || x >= w - 4 || y >= h - 4) continue;
        const i = y * w + x;
        if (road[i] && road[i + 1] && road[i + 2]) return { tx: x, ty: y, tw: 2, th: 1 };
      }
    }
  }
  return null;
}

/**
 * Build a game of the given mode ('quick' | 'career' | 'challenge') and play it into the middle of a busy
 * operation: fires, patients, people in the water, a forest fire, a wreck, a collapse, a leak, an evacuation,
 * an EMS call-out, vehicles on the road, patients on stretchers.
 */
export function busyGame(mode = 'quick', { seconds = 240, seed = 404 } = {}) {
  let state;
  if (mode === 'career') state = createCareer({ name: 'Busy' });
  else if (mode === 'challenge') state = createScenarioGame(findChallenge('mass-casualty'));
  else state = createGame(7);
  startShift(state);
  state.rng = new Rng(seed);
  state.credits = Math.max(state.credits, 80000);
  state.ownedStations[2] = true;
  for (const type of ['ambulance', 'ladder', 'rescue', 'tanker', 'rescueboat', 'medcar']) commandBuyVehicle(state, type);

  const houses = state.buildings.filter((b) => b.type === 'house' && b.state === 'ok');
  const st = state.city.station;
  houses.sort((a, b) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(b.x - st.x, b.y - st.y));
  for (let t = 0; t < seconds * 60; t++) {
    update(state, 1 / 60);
    const s = t / 60;
    if (t % 60 === 0) {
      if (s === 20 || s === 80) drowningCall(state, () => true);
      if (s === 30) { try { startWildfire(state, 80 * TILE, 60 * TILE); } catch { /* optional */ } }
      if (s === 40) { const spot = streetSpot(state); if (spot) addBlockade(state, spot, { name: 'Wreck', big: true, reward: 300, fuelAt: state.time + 70 }); }
      if (s === 50) ignite(state, houses[5], 'test');
      if (s === 60) spawnPatient(state, houses[8], 0.95);
      if (s === 70) collapseBuilding(state, houses[12], 2);
      if (s === 75) startLeak(state, houses[20], 1);
      if (s === 100) startEvacuation(state, { x: houses[30].x * TILE, y: houses[30].y * TILE, label: 'test zone' });
      if (s === 110) callAgency(state, 'ems', { kind: 'patient', id: state.patients[0]?.id ?? 'none' });
    }
    if (t % 120 === 0) commandDispatchAll(state);
  }
  // Whatever has finished by now, make sure there is somebody in the water and somebody hurt at the end.
  drowningCall(state, () => true);
  spawnPatient(state, houses[3], 0.5);
  return state;
}

/** Deep-compare two JSON-safe values; returns the paths that differ. */
export function diffJson(a, b, path = '', out = []) {
  if (typeof a !== typeof b || (a === null) !== (b === null) || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 50)} vs ${JSON.stringify(b)?.slice(0, 50)}`);
    return out;
  }
  if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffJson(a[k], b[k], `${path}.${k}`, out);
  } else if (a !== b) out.push(`${path}: ${a} vs ${b}`);
  return out;
}

export const roundTrip = (data) => JSON.parse(JSON.stringify(data));
