import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, commandBuyVehicle } from '../src/systems/game.js';
import { orderEngine } from '../src/systems/units.js';
import { passable } from '../src/systems/grid.js';
import { TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 60000;
  return state;
}

// A vehicle is about 1.2 tiles wide. Walk along its whole route and check that
// both sides of the body, not just its middle, are always on a road.
function offRoad(state, engine, half = TILE * 0.45) {
  let bad = 0;
  let samples = 0;
  let ax = engine.x;
  let ay = engine.y;
  for (const wp of engine.path) {
    const len = Math.hypot(wp.x - ax, wp.y - ay);
    const steps = Math.max(1, Math.ceil(len / 4));
    const nx = len ? -(wp.y - ay) / len : 0;
    const ny = len ? (wp.x - ax) / len : 0;
    for (let i = 1; i <= steps; i++) {
      const x = ax + ((wp.x - ax) * i) / steps;
      const y = ay + ((wp.y - ay) * i) / steps;
      for (const side of [-1, 0, 1]) {
        samples++;
        if (!passable(state.nav, 'drive', Math.floor((x + nx * half * side) / TILE), Math.floor((y + ny * half * side) / TILE))) bad++;
      }
    }
    ax = wp.x;
    ay = wp.y;
  }
  return { bad, samples };
}

test('a vehicle route keeps the whole body on the road, even round corners', () => {
  const state = shift();
  const engine = state.engines[0];
  const targets = state.buildings.filter((b) => b.type !== 'station' && b.type !== 'hospital');
  let routes = 0;
  let bad = 0;
  for (let i = 0; i < targets.length && routes < 40; i += Math.floor(targets.length / 40) || 1) {
    const b = targets[i];
    engine.path = [];
    engine.x = state.city.bays[0].x;
    engine.y = state.city.bays[0].y;
    if (!orderEngine(state, engine, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE, b.id)) continue;
    routes++;
    bad += offRoad(state, engine).bad;
  }
  assert.ok(routes >= 20, 'too few routes were planned: ' + routes);
  assert.equal(bad, 0, 'the body left the road at ' + bad + ' points');
});

test('vehicles sent to the same building park apart', () => {
  const state = shift();
  for (let i = 0; i < 3; i++) commandBuyVehicle(state, 'engine');
  const target = state.buildings.find((b) => b.type === 'hotel');
  for (const engine of state.engines) {
    assert.ok(orderEngine(state, engine, (target.x + target.w / 2) * TILE, (target.y + target.h / 2) * TILE, target.id));
  }
  const goals = state.engines.map((e) => e.goal);
  for (let i = 0; i < goals.length; i++) {
    for (let j = i + 1; j < goals.length; j++) {
      assert.ok(Math.hypot(goals[i].x - goals[j].x, goals[i].y - goals[j].y) >= 2.5, 'two vehicles share a parking spot');
    }
  }
});
