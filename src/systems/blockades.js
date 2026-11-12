// Blocked roads and the traffic that fills the streets.
//
// A wreck or a pile of debris seals a stretch of road: those tiles stop being
// drivable for the fleet until a crew has cleared them, so engines have to find
// another way round. Everyday traffic (decoration with one real rule: cars queue
// behind a blockage, they do not drive through it) makes the jam visible.
//
// This module owns the blockade list, the nav changes and the traffic cars. The
// incident logic that creates blockades lives in chains.js; the crews that clear
// them live in units.js.

import { CONFIG, TILE } from '../core/config.js';
import { V_ROADS, H_ROADS } from '../data/city.js';
import { addEvent } from './events.js';
import { earn, money } from './economy.js';

let seq = 1;

// ---------------------------------------------------------- blockades ---

/** Block a rectangle of road tiles. Returns the blockade. */
export function addBlockade(state, rect, opts = {}) {
  const { tx, ty, tw, th } = rect;
  const nav = state.nav;
  const saved = [];
  for (let y = ty; y < ty + th; y++) {
    for (let x = tx; x < tx + tw; x++) {
      if (x < 0 || y < 0 || x >= nav.w || y >= nav.h) continue;
      const i = y * nav.w + x;
      if (nav.drive[i] === 1) {
        saved.push(i);
        nav.drive[i] = 0;
      }
    }
  }
  const blockade = {
    id: `wreck${seq++}`,
    kind: 'blockade',
    name: opts.name ?? 'Blocked road',
    place: opts.place ?? '',
    tx,
    ty,
    tw,
    th,
    x: (tx + tw / 2) * TILE,
    y: (ty + th / 2) * TILE,
    w: tw * TILE,
    h: th * TILE,
    saved,
    progress: 0,
    big: Boolean(opts.big),
    reward: opts.reward ?? 0,
    fuelAt: opts.fuelAt ?? null,
    fuelDone: false,
    debris: Boolean(opts.debris),
    createdAt: state.time,
  };
  state.blockades.push(blockade);
  moveTrafficOut(state, blockade);
  state.onBlockadeChange?.(state);
  return blockade;
}

/** Bring a blockade back from a save (the nav is rebuilt from the city, so re-seal it). */
export function restoreBlockades(state, list = []) {
  state.blockades = [];
  for (const saved of list) {
    const b = addBlockade(state, saved, { ...saved });
    b.id = saved.id ?? b.id;
    b.progress = saved.progress ?? 0;
    b.fuelAt = saved.fuelAt ?? null;
    b.fuelDone = Boolean(saved.fuelDone);
    const match = /(\d+)$/.exec(b.id);
    if (match) seq = Math.max(seq, Number(match[1]) + 1);
  }
  return state.blockades;
}

export const findBlockade = (state, id) => state.blockades.find((b) => b.id === id) ?? null;

/** Crew work on a blockade. `amount` is crew-seconds of progress (already scaled). */
export function workOnBlockade(state, blockade, amount) {
  if (!blockade || blockade.progress >= 1) return false;
  blockade.progress = Math.min(1, blockade.progress + amount / CONFIG.blockade.clearTime);
  if (blockade.progress >= 1) {
    openRoad(state, blockade);
    return true;
  }
  return false;
}

function openRoad(state, blockade) {
  const nav = state.nav;
  for (const i of blockade.saved) nav.drive[i] = 1;
  state.blockades = state.blockades.filter((b) => b !== blockade);

  const quick = !blockade.fuelDone && blockade.fuelAt != null;
  const reward = (blockade.reward ?? 0) + (quick ? CONFIG.blockade.quickBonus : 0);
  if (reward > 0) earn(state, reward, 'incident');
  state.stats.cleared = (state.stats.cleared ?? 0) + 1;
  addEvent(
    state,
    `Road reopened${blockade.place ? ` near ${blockade.place}` : ''}${reward > 0 ? ` — ${money(reward)}${quick ? ' incl. quick-clearance bonus' : ''}` : ''}`,
    'good',
  );
  state.onBlockadeChange?.(state);
}

// ------------------------------------------------------------- traffic ---

/**
 * Cars on every stretch of avenue and street: one lane each way, each lane a
 * list of cars that follow the one in front. A street that ends at the woods or
 * the quay is its own stretch. Positions are in world pixels along the road.
 */
export function createTraffic(state) {
  const rng = state.rng;
  const city = state.city;
  const lanes = [];
  const add = (axis, line, dir, from, to) => lanes.push({
    axis, line, dir, start: from * TILE, end: (to + 1) * TILE, length: (to + 1 - from) * TILE, cars: [],
  });
  const runs = city.roadRuns ?? {
    v: V_ROADS.map((line) => ({ line, spans: [[0, city.h - 1]] })),
    h: H_ROADS.map((line) => ({ line, spans: [[0, city.w - 1]] })),
  };
  for (const { line: vx, spans } of runs.v) {
    for (const [a, b] of spans) {
      if (b - a < 6) continue;
      add('v', (vx + 0.5) * TILE, 1, a, b);
      add('v', (vx + 1.5) * TILE, -1, a, b);
    }
  }
  for (const { line: hy, spans } of runs.h) {
    for (const [a, b] of spans) {
      if (b - a < 6) continue;
      add('h', (hy + 0.5) * TILE, -1, a, b);
      add('h', (hy + 1.5) * TILE, 1, a, b);
    }
  }

  const colors = ['#cfd3d8', '#3d4d63', '#8f2f27', '#e7e3d6', '#4c5c50', '#b98a3a', '#6b6f76', '#2f4f7a'];
  const total = CONFIG.traffic.cars;
  const [lo, hi] = CONFIG.traffic.speed;
  // Longer roads carry more cars.
  const totalLength = lanes.reduce((sum, l) => sum + l.length, 0);
  const laneAt = (d) => {
    for (const l of lanes) {
      if (d < l.length) return l;
      d -= l.length;
    }
    return lanes[lanes.length - 1];
  };
  for (let i = 0; i < total; i++) {
    const lane = laneAt(rng.float() * totalLength);
    const speed = rng.range(lo, hi) * TILE;
    const car = {
      lane,
      pos: rng.range(lane.start, lane.end),
      v: speed,
      cruise: speed,
      color: colors[Math.floor(rng.float() * colors.length)],
      x: 0,
      y: 0,
      angle: 0,
    };
    lane.cars.push(car);
  }
  for (const lane of lanes) placeCars(lane);
  state.traffic = { lanes, cars: lanes.flatMap((l) => l.cars) };
  state.trafficFactor = 1;
}

function placeCars(lane) {
  for (const car of lane.cars) {
    if (lane.axis === 'v') {
      car.x = lane.line;
      car.y = car.pos;
      car.angle = lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      car.x = car.pos;
      car.y = lane.line;
      car.angle = lane.dir > 0 ? 0 : Math.PI;
    }
  }
}

/** Cars caught inside a new wreck are shunted back up the road, stopped. */
function moveTrafficOut(state, b) {
  for (const lane of state.traffic?.lanes ?? []) {
    const across = lane.axis === 'v'
      ? Math.abs(b.x - lane.line) < b.w / 2 + 14
      : Math.abs(b.y - lane.line) < b.h / 2 + 14;
    if (!across) continue;
    const centre = lane.axis === 'v' ? b.y : b.x;
    const half = (lane.axis === 'v' ? b.h : b.w) / 2;
    for (const car of lane.cars) {
      if (Math.abs(car.pos - centre) < half + 30) {
        car.pos = centre - lane.dir * (half + 90 + state.rng.range(0, 20));
        car.v = 0;
      }
    }
    placeCars(lane);
  }
}

const SAFE_GAP = 56; // px kept to the car or blockade ahead

/** Rush hour is a fact of the clock: slower for emergency vehicles, busier for everyone. */
export function rushFactor(clockMinutes) {
  const hour = (((clockMinutes / 60) % 24) + 24) % 24;
  return CONFIG.traffic.rush.some(([a, b]) => hour >= a && hour < b) ? CONFIG.traffic.rushFactor : 1;
}

export function updateTraffic(state, dt) {
  const traffic = state.traffic;
  if (!traffic) return;
  const factor = rushFactor(state.clock);
  if (factor !== state.trafficFactor) {
    state.trafficFactor = factor;
    addEvent(
      state,
      factor < 1 ? 'Rush hour — the roads are congested, response times are longer' : 'Rush hour is over — the roads are clearing',
      'info',
    );
  }
  const blockades = state.blockades;

  for (const lane of traffic.lanes) {
    const cars = lane.cars;
    if (cars.length === 0) continue;
    // Leader first, in the direction of travel.
    cars.sort((a, b) => (b.pos - a.pos) * lane.dir);

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      let gap = Infinity;
      if (i > 0) gap = (cars[i - 1].pos - car.pos) * lane.dir;
      for (const b of blockades) {
        // Is the blockage across this lane, and ahead of the car?
        const across = lane.axis === 'v'
          ? Math.abs(b.x - lane.line) < b.w / 2 + 14
          : Math.abs(b.y - lane.line) < b.h / 2 + 14;
        if (!across) continue;
        const centre = lane.axis === 'v' ? b.y : b.x;
        const half = (lane.axis === 'v' ? b.h : b.w) / 2;
        const ahead = (centre - car.pos) * lane.dir - half;
        if (ahead > -half * 2 && ahead < gap) gap = Math.max(ahead, 0);
      }
      const target = gap < SAFE_GAP ? 0 : Math.min(car.cruise, (gap - SAFE_GAP) * 2.5);
      // Brake hard, accelerate gently.
      const rate = target < car.v ? 520 : 150;
      car.v += clampStep(target - car.v, rate * dt);
      car.pos += lane.dir * car.v * dt;
      // A car leaving the end of its stretch turns off; another turns in at the start.
      if (car.pos > lane.end) car.pos -= lane.length;
      else if (car.pos < lane.start) car.pos += lane.length;
    }
    placeCars(lane);
  }
}

const clampStep = (delta, max) => (delta > max ? max : delta < -max ? -max : delta);

/** Cars standing still: a rough measure of how jammed the city is. */
export function stoppedCars(state) {
  return (state.traffic?.cars ?? []).filter((c) => c.v < 8).length;
}

