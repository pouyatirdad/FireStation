import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, serialize, loadState,
  commandDispatchWildfire,
} from '../src/systems/game.js';
import { ignite, updateFire } from '../src/systems/fire.js';
import { startWildfire, updateWildfires } from '../src/systems/wildfire.js';
import { CONFIG } from '../src/core/config.js';

test('small calls arrive early; major incidents are held back', () => {
  const state = createGame(7);
  startShift(state);
  state.time = 100;
  state.nextCallAt = 0.1;
  state.nextBigAt = 0.1;

  for (let i = 0; i < 30 * 20; i++) update(state, 1 / 30);

  const big = state.buildings.some((b) => b.big);
  assert.equal(big, false, 'a major incident fired before bigAfter');
  assert.equal(state.wildfires.length, 0);
});

test('a major incident fires once the shift is old enough', () => {
  const state = createGame(7);
  startShift(state);
  state.time = CONFIG.incidents.bigAfter + 1;
  state.nextCallAt = 999;
  state.nextBigAt = 0.05;

  for (let i = 0; i < 30 * 5; i++) update(state, 1 / 30);

  const major = state.buildings.some((b) => b.big) || state.wildfires.length > 0;
  assert.equal(major, true, 'no major incident was generated');
});

test('a wildfire grows and can be knocked down for its reward', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  const wildfire = startWildfire(state, 120 * 32, 30 * 32, 2200);
  const radius = wildfire.radius;

  for (let i = 0; i < 30; i++) updateWildfires(state, 1 / 30);
  assert.ok(wildfire.radius > radius, 'wildfire did not grow');

  const credits = state.credits;
  for (let i = 0; i < 400 && state.wildfires.length > 0; i++) {
    state.streams = [{ wildfireId: wildfire.id, power: 0.3 }];
    updateWildfires(state, 1 / 30);
  }
  assert.equal(state.wildfires.length, 0, 'wildfire never went out');
  assert.ok(state.credits > credits, 'no reward for the wildfire');
});

test('a fire with an incident reward pays when it is knocked down', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  const building = state.buildings.find((b) => b.id !== 'station');
  building.reward = 750;
  ignite(state, building, 'test');
  const credits = state.credits;

  for (let i = 0; i < 30 * 120 && building.state === 'burning'; i++) {
    state.streams = [{ targetId: building.id, power: 0.3 }];
    updateFire(state, 1 / 30);
  }

  assert.equal(building.state, 'out');
  assert.equal(building.reward, 0);
  // The reward carries a speed bonus (it was put out quickly) and the knockdown
  // fee is scaled by what the building is worth.
  const fee = Math.round(CONFIG.economy.saved * CONFIG.economy.value[building.type]);
  const gained = state.credits - credits;
  assert.ok(gained >= 750 + fee, `only gained ${gained}`);
  assert.ok(gained <= Math.round(750 * (1 + CONFIG.economy.speedBonus.max)) + fee, `gained too much: ${gained}`);
});

test('a crew can be sent to a forest fire and put it out', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  const tile = state.city.forestTiles[Math.floor(state.city.forestTiles.length / 2)];
  const wildfire = startWildfire(state, (tile.x + 0.5) * 32, (tile.y + 0.5) * 32, 2200);

  assert.equal(commandDispatchWildfire(state, wildfire.id), true);
  let seconds = 0;
  while (state.wildfires.length > 0 && seconds < 240) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }

  assert.equal(state.wildfires.length, 0, `wildfire still burning after ${seconds.toFixed(0)}s`);
  assert.ok(state.stats.rescued >= 0);
});

test('rating zero does not end the shift', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.rating = 1;
  const building = state.buildings.find((b) => b.id !== 'station');
  building.integrity = 0.01;
  building.fire = 1;
  ignite(state, building, 'test');

  for (let i = 0; i < 30 && building.state === 'burning'; i++) updateFire(state, 1 / 30);

  assert.equal(building.state, 'rubble');
  assert.equal(state.rating, 0);
  assert.equal(state.over, false);
  update(state, 1 / 30);
  assert.equal(state.over, false);
});

test('a saved shift restores time, credits, buildings and fleet', () => {
  const state = createGame(7);
  startShift(state);
  commandBuyVehicle(state, 'ladder');
  state.credits = 4321;
  state.time = 123;
  state.clock = 456;
  const building = state.buildings.find((b) => b.id !== 'station');
  ignite(state, building, 'test');
  building.fire = 0.6;

  const saved = JSON.parse(JSON.stringify(serialize(state)));
  const loaded = loadState(saved);

  assert.equal(loaded.time, 123);
  assert.equal(loaded.credits, 4321);
  assert.equal(loaded.engines.length, 2);
  assert.equal(loaded.engines.some((e) => e.type === 'ladder'), true);
  const restored = loaded.buildings.find((b) => b.id === building.id);
  assert.equal(restored.state, 'burning');
  assert.ok(restored.fire >= 0.6);
  assert.equal(loaded.running, true);
});
