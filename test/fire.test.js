import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, commandDispatch, orderEngine } from '../src/systems/game.js';
import { ignite, updateFire } from '../src/systems/fire.js';
import { CONFIG } from '../src/core/config.js';

const step = (state, seconds, dt = 1 / 30) => {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) update(state, dt);
};

test('a fire grows, damages the building and is finally put out by water', () => {
  const state = createGame(11);
  state.running = true;
  const building = state.buildings.find((b) => b.type === 'warehouse');
  ignite(state, building, 'test');
  assert.equal(building.state, 'burning');

  for (let i = 0; i < 300; i++) updateFire(state, 1 / 30);
  assert.ok(building.fire > 0.2, `fire only reached ${building.fire.toFixed(2)}`);
  assert.ok(building.integrity < building.maxIntegrity, 'fire did no damage');

  // Three crew streams on it, for as long as it takes.
  let seconds = 0;
  while (building.state === 'burning' && seconds < 60) {
    state.streams = [
      { targetId: building.id, power: 0.035 },
      { targetId: building.id, power: 0.035 },
      { targetId: building.id, power: 0.035 },
    ];
    updateFire(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.equal(building.state, 'out');
  assert.equal(state.stats.saved, 1);
  assert.ok(state.rating >= 100);
});

test('an unattended building is lost, and the city rating drops with it', () => {
  const state = createGame(12);
  state.running = true;
  const building = state.buildings.find((b) => b.type === 'house');
  building.occupants = 0; // isolate the structural loss from casualties
  ignite(state, building, 'test');
  const ratingBefore = state.rating;

  for (let i = 0; i < 30 * 240 && building.state === 'burning'; i++) updateFire(state, 1 / 30);
  assert.equal(building.state, 'rubble');
  assert.equal(state.stats.lost, 1);
  assert.equal(state.rating, ratingBefore - CONFIG.rating.perLost);
  assert.ok(building.integrity <= 0);
});

test('fire spreads to a neighbouring building', () => {
  const state = createGame(13);
  state.running = true;
  // An office with a neighbour close enough to catch.
  const close = (a, b) => Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < (a.w + b.w) / 2 + 2 && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < (a.h + b.h) / 2 + 2;
  const source = state.buildings.find((b) => b.type === 'office' && state.buildings.some((o) => o !== b && o.type !== 'station' && close(b, o)));
  source.integrity = 100000; // hold the source open while the spread is tested
  source.fire = 0.95;
  ignite(state, source, 'test');
  source.integrity = 100000;

  let spread = false;
  for (let i = 0; i < 30 * 180 && !spread; i++) {
    updateFire(state, 1 / 30);
    spread = state.buildings.some((b) => b !== source && b.state === 'burning');
  }
  assert.ok(spread, 'fire never jumped to a neighbour');
});

test('the shift clock runs while the game is running', () => {
  const state = createGame(14);
  startShift(state);
  const before = state.clock;
  step(state, 10);
  assert.ok(state.clock > before);
  assert.equal(state.over, false);
});

test('dispatch sends the engine, deploys the crew and puts the fire out', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  const target = state.buildings.find((b) => b.type === 'house' && b.y > 20);
  ignite(state, target, 'test');

  assert.equal(commandDispatch(state, target.id), true);
  let seconds = 0;
  while (target.state === 'burning' && seconds < 240) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }

  assert.equal(target.state, 'out', `fire still burning after ${seconds.toFixed(0)}s`);
  assert.ok(state.stats.saved >= 1);
  assert.ok(state.crew.some((c) => !c.riding), 'crew never left the engine');
  assert.ok(state.engines[0].water < state.engines[0].capacity, 'no water was used');
});

test('the engine drives only on roads and stops beside the target', () => {
  const state = createGame(7);
  startShift(state);
  const target = state.buildings.find((b) => b.type === 'shop');
  orderEngine(state, state.engines[0], (target.x + target.w / 2) * 32, (target.y + target.h / 2) * 32, target.id);

  for (let i = 0; i < 30 * 30; i++) {
    update(state, 1 / 30);
    const tileX = Math.floor(state.engines[0].x / 32);
    const tileY = Math.floor(state.engines[0].y / 32);
    const drivable = state.city.road[tileY * state.city.w + tileX] || state.city.apron[tileY * state.city.w + tileX];
    assert.ok(drivable, `engine left the road at ${tileX},${tileY}`);
    if (state.engines[0].path.length === 0 && state.engines[0].arrived) break;
  }
  assert.equal(state.engines[0].arrived, true, 'engine never arrived');
});
