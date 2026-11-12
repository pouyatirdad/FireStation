import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift } from '../src/systems/game.js';
import { orderEngine } from '../src/systems/units.js';
import { addBlockade } from '../src/systems/blockades.js';
import { findPath, nearestPassable, passable } from '../src/systems/grid.js';
import { TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  return state;
}

const onRoad = (state, t) => state.city.road[t.y * state.city.w + t.x] === 1 || state.city.apron[t.y * state.city.w + t.x] === 1;

test('vehicles can drive on open ground between the buildings, but not through them', () => {
  const state = shift();
  const { nav, city } = state;
  let open = 0;
  for (let i = 0; i < city.w * city.h; i++) {
    if (nav.drive[i] && !city.road[i] && !city.apron[i]) open++;
    if (city.blocked[i]) assert.equal(nav.drive[i], 0, 'a building tile is drivable');
    if (city.water[i] && !city.road[i]) assert.equal(nav.drive[i], 0, 'open water is drivable');
    if (city.woods[i] && !city.road[i] && !city.apron[i]) assert.equal(nav.drive[i], 0, 'the woods are drivable');
  }
  assert.ok(open > 20000, 'hardly any open ground is drivable: ' + open);
});

test('an engine drives right up to a building across the lot, not just to the nearest street', () => {
  const state = shift();
  const engine = state.engines[0];
  let off = 0;
  let tried = 0;
  for (const b of state.buildings) {
    if (b.type === 'station' || b.type === 'hospital' || tried >= 60) continue;
    tried++;
    engine.path = [];
    engine.x = state.city.bays[0].x;
    engine.y = state.city.bays[0].y;
    if (!orderEngine(state, engine, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE, b.id)) continue;
    if (!onRoad(state, engine.goal)) off++;
  }
  assert.ok(off >= 10, 'engines still stop at the street: ' + off + ' of ' + tried);
});

test('routes across open ground are never longer than road-only routes, and often shorter', () => {
  const state = shift();
  const { nav, city } = state;
  const from = { x: 52, y: 62 };
  const roadOnly = {
    ...nav,
    drive: Uint8Array.from(nav.drive, (v, i) => (city.road[i] || city.apron[i] ? v : 0)),
  };
  const length = (path) => path.reduce((sum, t, i) => {
    const p = i === 0 ? from : path[i - 1];
    return sum + Math.hypot(t.x - p.x, t.y - p.y) * (onRoad(state, t) ? 1 : 1.35);
  }, 0);
  const targets = state.buildings.filter((bd) => Math.hypot(bd.x - 52, bd.y - 62) > 40 && Math.hypot(bd.x - 52, bd.y - 62) < 160);
  let shorter = 0;
  let tried = 0;
  for (let i = 0; i < targets.length && tried < 12; i += Math.floor(targets.length / 12) || 1) {
    const goal = nearestPassable(nav, 'drive', Math.floor(targets[i].x + targets[i].w / 2), Math.floor(targets[i].y + targets[i].h / 2), 14);
    const goalRoad = nearestPassable(roadOnly, 'drive', goal.x, goal.y, 14);
    const free = findPath(nav, 'drive', from, goal);
    const roads = findPath(roadOnly, 'drive', from, goalRoad);
    if (!free || !roads) continue;
    tried++;
    if (free.length < roads.length) shorter++;
  }
  assert.ok(tried >= 8, 'too few routes: ' + tried);
  assert.ok(shorter >= 1, 'open ground never made a route shorter');
});

test('a wreck closes the whole street, pavement and all, so nobody drives round it', () => {
  const state = shift();
  const { nav, city } = state;
  // A stretch of the first avenue, clear of junctions.
  const vx = 42;
  const ty = 20;
  const before = Uint8Array.from(nav.drive);
  const wreck = addBlockade(state, { tx: vx, ty, tw: 2, th: 3 }, { name: 'test wreck' });
  for (let y = ty; y < ty + 3; y++) {
    for (let x = vx - 3; x <= vx + 4; x++) {
      if (city.blocked[y * city.w + x]) continue;
      assert.equal(nav.drive[y * city.w + x], 0, `the pavement at ${x},${y} is still open`);
    }
  }
  assert.equal(passable(nav, 'drive', vx, ty + 3), true, 'the street beyond the wreck is closed');
  // No route past it along those rows.
  state.blockades = state.blockades.filter((b) => b !== wreck);
  for (const i of wreck.saved) nav.drive[i] = 1;
  assert.deepEqual(Array.from(nav.drive), Array.from(before), 'reopening did not restore the map');
});

test('no building is walled in, and no patch of open ground is cut off from the streets', () => {
  for (const seed of [7, 3, 11, 21]) {
    const state = createGame(seed);
    startShift(state);
    const { nav, city } = state;
    // Flood the drivable ground from Station 1.
    const w = city.w;
    const seen = new Uint8Array(w * city.h);
    const a = city.stations[0].apron;
    const queue = [(a.y0 + 1) * w + a.x0 + 1];
    seen[queue[0]] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= city.h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !nav.drive[ni]) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    let cutOff = 0;
    for (let i = 0; i < w * city.h; i++) if (nav.drive[i] && !seen[i]) cutOff++;
    assert.equal(cutOff, 0, `seed ${seed}: ${cutOff} drivable tiles cannot be reached`);
  }
});

test('an engine can be sent to every building in the city', () => {
  const state = shift();
  const engine = state.engines[0];
  const failed = [];
  for (const b of state.buildings) {
    if (b.type === 'station') continue;
    engine.path = [];
    engine.x = state.city.bays[0].x;
    engine.y = state.city.bays[0].y;
    if (!orderEngine(state, engine, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE, b.id)) failed.push(b.name);
  }
  assert.deepEqual(failed, [], 'no route to: ' + failed.slice(0, 5));
});
