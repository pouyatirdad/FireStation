// People in the water: a car off a bridge, someone off the quay. They have a
// clock (short, cold water) and only divers can reach them: a dive truck parked on
// the bank, or a rescue boat. A rescued person is carried to the bank and becomes a
// critical patient, so the call chains into the ambulances and the hospital.
//
// This module owns the victim list and the rescue bookkeeping. Moving the divers
// is units.js.

import { CONFIG, TILE } from '../core/config.js';
import { SEA_Y } from '../data/city.js';
import { addEvent } from './events.js';
import { earn, money, spend } from './economy.js';
import { nearestPassable, tileOf } from './grid.js';
import { spawnPatientAt } from './medical.js';
import { districtName } from './places.js';

let seq = 1;

export const findVictim = (state, id) => state.victims.find((v) => v.id === id) ?? null;

export function spawnVictim(state, x, y, label) {
  if (state.victims.length >= CONFIG.water.maxVictims) return null;
  const [lo, hi] = CONFIG.water.survive;
  const life = state.rng.range(lo, hi);
  const victim = {
    id: `victim${seq++}`,
    kind: 'victim',
    name: 'Person in the water',
    x,
    y,
    label,
    life,
    maxLife: life,
    rescueTimer: 0,
    diverId: null,
  };
  state.victims.push(victim);
  return victim;
}

export function restoreVictims(state, list = []) {
  state.victims = list.map((v) => ({
    kind: 'victim', name: 'Person in the water', rescueTimer: 0, diverId: null, ...v,
  }));
  for (const v of state.victims) {
    const m = /(\d+)$/.exec(v.id ?? '');
    if (m) seq = Math.max(seq, Number(m[1]) + 1);
  }
  return state.victims;
}

/** The nearest victim a diver could still reach, optionally one nobody has claimed. */
export function nearestVictim(state, x, y, { unclaimed = false, maxDist = Infinity } = {}) {
  let best = null;
  let bestD = maxDist;
  for (const v of state.victims) {
    if (unclaimed && v.diverId) continue;
    const d = Math.hypot(v.x - x, v.y - y);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

/** A diver has them: out of the water, onto the bank, into the medical system. */
export function rescueVictim(state, victim) {
  state.victims = state.victims.filter((v) => v !== victim);
  state.stats.dived = (state.stats.dived ?? 0) + 1;
  state.rating = Math.min(CONFIG.rating.start, state.rating + 3);
  const fee = earn(state, CONFIG.water.reward, 'rescue');

  const bank = nearestPassable(state.nav, 'walk', ...Object.values(tileOf(victim.x, victim.y)), 14);
  const x = bank ? (bank.x + 0.5) * TILE : victim.x;
  const y = bank ? (bank.y + 0.5) * TILE : victim.y;
  spawnPatientAt(state, {
    x,
    y,
    severity: Math.max(0.75, state.rng.range(0.75, 1)),
    label: victim.label ?? 'the river',
    silent: true,
  });
  addEvent(state, `Diver brought someone out near ${victim.label ?? 'the water'} — ${money(fee)}; they need an ambulance`, 'good');
  return true;
}

export function updateVictims(state, dt) {
  for (let i = state.victims.length - 1; i >= 0; i--) {
    const v = state.victims[i];
    if (v.diverId && !state.crew.some((c) => c.id === v.diverId && !c.riding)) v.diverId = null;
    v.life -= dt;
    if (v.life <= 0) {
      state.victims.splice(i, 1);
      state.stats.casualties += 1;
      state.rating = Math.max(0, state.rating - 6);
      spend(state, CONFIG.economy.casualtyPenalty, 'casualty');
      addEvent(state, `Someone drowned near ${v.label ?? 'the water'}`, 'bad');
    }
  }
}

/** Tiles where a street crosses the river, found once from the bridge mask. */
function bridgeTiles(state) {
  if (!state.city.bridgeTiles) {
    const list = [];
    const { bridge, w, h } = state.city;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bridge[y * w + x]) list.push({ x, y });
    state.city.bridgeTiles = list;
  }
  return state.city.bridgeTiles;
}

/** A car goes off a bridge, or someone goes into the harbour. */
export function drowningCall(state, allowed = () => true) {
  const rng = state.rng;
  const city = state.city;
  let spot = null;
  if (rng.chance(0.65)) {
    const options = bridgeTiles(state).filter((t) => allowed(t.x, t.y));
    if (options.length) {
      const t = rng.pick(options);
      // The water either side of the deck.
      const side = rng.chance(0.5) ? -1 : 1;
      spot = { x: (t.x + 0.5) * TILE, y: (t.y + 0.5 + side * 2.2) * TILE, what: 'A car has gone off the bridge' };
    }
  }
  if (!spot) {
    for (let n = 0; n < 40 && !spot; n++) {
      const x = rng.int(8, city.w - 8);
      if (allowed(x, SEA_Y - 1)) spot = { x: (x + 0.5) * TILE, y: (SEA_Y + 1.6) * TILE, what: 'Someone has gone into the harbour' };
    }
  }
  if (!spot) return null;
  // Make sure it is water.
  if (!city.water[Math.floor(spot.y / TILE) * city.w + Math.floor(spot.x / TILE)]) return null;

  const place = districtName(state, spot.x, spot.y) ?? 'the city';
  const n = rng.int(1, 3);
  let made = 0;
  for (let i = 0; i < n; i++) {
    const v = spawnVictim(state, spot.x + rng.range(-1.2, 1.2) * TILE, spot.y + rng.range(-0.8, 0.8) * TILE, place);
    if (v) made++;
  }
  if (made === 0) return null;
  addEvent(state, `${spot.what} near ${place} — ${made} in the water, divers needed`, 'fire');
  return made;
}
