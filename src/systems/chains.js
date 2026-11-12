// Chained incidents: the thing that makes one call turn into three.
//
//   traffic accident  a wreck blocks the road and people are hurt. Left alone,
//                     its fuel catches after a minute or so and sets the nearest
//                     building alight; clear the wreck in time and it never does
//   pile-up (major)   three wrecks in a row, five or six injured, the same fuse
//   explosion         a warehouse fire that runs hot enough goes up, lighting its
//                     neighbours, hurting bystanders and throwing debris across
//                     the street in front
//
// Wildfire embers lighting buildings (wildfire.js) is the third chain of the
// same kind. Everything here uses the existing fire, patient and blockade
// systems; it only decides when they meet.

import { CONFIG, TILE } from '../core/config.js';
import { rectsTouch } from '../core/math.js';
import { V_ROADS, H_ROADS } from '../data/city.js';
import { addBlockade } from './blockades.js';
import { addEvent } from './events.js';
import { buildingRect, ignite } from './fire.js';
import { spawnPatientAt, spawnPatient } from './medical.js';
import { placeNear } from './places.js';
import { spawnSmoke } from './effects.js';

const crossesRoad = (list, from, to) => list.some((r) => to >= r - 2 && from <= r + 3);

/**
 * A stretch of straight road: not at a junction, not beside the station, not on
 * top of another blockade, and (if given) passing the `allowed(x, y)` test.
 * `rect` is in tiles.
 */
export function pickRoadSpot(state, allowed = () => true, from = null) {
  const city = state.city;
  const rng = state.rng;
  const station = city.station;
  const sx = station.x + station.w / 2;
  const sy = station.y + station.h / 2;

  for (let attempt = 0; attempt < 80; attempt++) {
    const vertical = from ? from.axis === 'v' : rng.chance(0.5);
    let rect;
    if (vertical) {
      const tx = from ? from.tx : rng.pick(V_ROADS);
      const ty = from ? from.ty + from.dy : rng.int(6, city.h - 14);
      rect = { tx, ty, tw: 2, th: 3, axis: 'v' };
      if (crossesRoad(H_ROADS, ty, ty + 2)) continue;
    } else {
      const ty = from ? from.ty : rng.pick(H_ROADS);
      const tx = from ? from.tx + from.dx : rng.int(6, city.w - 14);
      rect = { tx, ty, tw: 3, th: 2, axis: 'h' };
      if (crossesRoad(V_ROADS, tx, tx + 2)) continue;
    }
    if (rect.tx < 2 || rect.ty < 2 || rect.tx + rect.tw > city.w - 2 || rect.ty + rect.th > city.h - 2) continue;
    const cx = rect.tx + rect.tw / 2;
    const cy = rect.ty + rect.th / 2;
    if (Math.hypot(cx - sx, cy - sy) < CONFIG.blockade.minStationDist) continue;
    if (state.blockades.some((b) => Math.hypot(b.x / TILE - cx, b.y / TILE - cy) < 6)) continue;
    if (!allowed(cx, cy)) continue;
    return rect;
  }
  return null;
}

function hurtAt(state, rect, count, place) {
  const cx = (rect.tx + rect.tw / 2) * TILE;
  const cy = (rect.ty + rect.th / 2) * TILE;
  let made = 0;
  for (let i = 0; i < count; i++) {
    const p = spawnPatientAt(state, {
      x: cx + state.rng.range(-0.9, 0.9) * TILE,
      y: cy + state.rng.range(-0.9, 0.9) * TILE,
      severity: state.rng.range(0.35, 1),
      label: `the crash near ${place}`,
      silent: true,
    });
    if (p) made++;
  }
  return made;
}

export function trafficAccident(state, allowed) {
  const rect = pickRoadSpot(state, allowed);
  if (!rect) return null;
  const place = placeNear(state, (rect.tx + 1) * TILE, (rect.ty + 1) * TILE);
  const [lo, hi] = CONFIG.blockade.fuelDelay;
  const blockade = addBlockade(state, rect, {
    name: `Crash near ${place}`,
    place,
    reward: CONFIG.incidents.reward.crash,
    fuelAt: state.time + state.rng.range(lo, hi),
  });
  const hurt = hurtAt(state, rect, state.rng.int(1, 3), place);
  addEvent(
    state,
    `Traffic accident near ${place} — road blocked, ${hurt} injured`,
    'fire',
  );
  return blockade;
}

export function pileUp(state, allowed) {
  const first = pickRoadSpot(state, allowed);
  if (!first) return null;
  const place = placeNear(state, (first.tx + 1) * TILE, (first.ty + 1) * TILE);
  const spacing = CONFIG.blockade.pileSpacing;
  const rects = [first];
  // Two more wrecks further along the same road, if it stays straight.
  for (let n = 1; n <= 2; n++) {
    const next = pickRoadSpot(
      state,
      () => true,
      first.axis === 'v'
        ? { axis: 'v', tx: first.tx, ty: first.ty, dy: spacing * n, dx: 0 }
        : { axis: 'h', tx: first.tx, ty: first.ty, dx: spacing * n, dy: 0 },
    );
    if (next) rects.push(next);
  }
  const [lo, hi] = CONFIG.blockade.fuelDelay;
  let hurt = 0;
  for (const rect of rects) {
    addBlockade(state, rect, {
      name: `Pile-up near ${place}`,
      place,
      big: true,
      reward: Math.round(CONFIG.incidents.reward.pileup / rects.length),
      fuelAt: state.time + state.rng.range(lo, hi) + 10,
    });
    hurt += hurtAt(state, rect, state.rng.int(2, 3), place);
  }
  addEvent(
    state,
    `MAJOR INCIDENT — pile-up near ${place}: ${rects.length} wrecks, ${hurt} injured`,
    'big',
  );
  return rects.length;
}

/** The fuse on every wreck: when it burns down, the nearest building catches. */
export function updateChains(state) {
  for (const b of state.blockades) {
    if (b.fuelAt == null || b.fuelDone || state.time < b.fuelAt) continue;
    b.fuelDone = true;
    const reach = CONFIG.blockade.fuelReach * TILE;
    let best = null;
    let bestD = reach;
    for (const building of state.buildings) {
      if (building.state !== 'ok' || building.id === 'station') continue;
      const r = buildingRect(building);
      const dx = Math.max(r.x - b.x, 0, b.x - (r.x + r.w));
      const dy = Math.max(r.y - b.y, 0, b.y - (r.y + r.h));
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = building;
      }
    }
    for (let i = 0; i < 8; i++) spawnSmoke(state, b.x + state.rng.range(-30, 30), b.y + state.rng.range(-20, 20), 1.3);
    if (best) {
      best.reward = Math.max(best.reward ?? 0, CONFIG.incidents.reward.chain);
      best.incidentType = 'chain';
      best.big = b.big;
      addEvent(state, `Fuel leak — the wreck near ${b.place || 'the road'} has set ${best.name} alight`, 'fire');
      ignite(state, best, 'chain');
    } else {
      addEvent(state, `The wreck near ${b.place || 'the road'} burns out`, 'warn');
    }
  }
}

/** A hot warehouse fire goes up. Wired to `state.onExplosion` by game.js. */
export function explode(state, building) {
  const rect = buildingRect(building);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  addEvent(state, `EXPLOSION at ${building.name}!`, 'big');

  for (let i = 0; i < 16; i++) {
    spawnSmoke(state, cx + state.rng.range(-rect.w / 2, rect.w / 2), cy + state.rng.range(-rect.h / 2, rect.h / 2), 2);
  }

  // Neighbours within a few tiles catch from the blast.
  const near = state.buildings
    .filter((b) => b !== building && b.state === 'ok' && b.id !== 'station'
      && rectsTouch(rect, buildingRect(b), 3 * TILE));
  for (const b of state.rng.shuffle(near).slice(0, 2)) ignite(state, b, 'spread');

  spawnPatient(state, building, 0.85);
  spawnPatient(state, building, 0.7);

  // Debris across the nearest street.
  const city = state.city;
  let best = null;
  let bestD = Infinity;
  const x0 = Math.floor(rect.x / TILE) - 8;
  const y0 = Math.floor(rect.y / TILE) - 8;
  const x1 = Math.ceil((rect.x + rect.w) / TILE) + 8;
  const y1 = Math.ceil((rect.y + rect.h) / TILE) + 8;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 1 || y < 1 || x >= city.w - 2 || y >= city.h - 2) continue;
      if (!city.road[y * city.w + x]) continue;
      const d = Math.hypot((x + 0.5) * TILE - cx, (y + 0.5) * TILE - cy);
      if (d < bestD && Math.hypot(x - (city.station.x + city.station.w / 2), y - (city.station.y + city.station.h / 2)) > CONFIG.blockade.minStationDist) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  if (best) {
    addBlockade(state, { tx: best.x, ty: best.y, tw: 2, th: 2 }, {
      name: `Debris near ${building.name}`,
      place: building.name,
      reward: 150,
      debris: true,
    });
    addEvent(state, `Debris from ${building.name} blocks the street`, 'warn');
  }
}
