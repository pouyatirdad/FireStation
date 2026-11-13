import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, commandDispatch } from '../src/systems/game.js';
import { ignite, updateFire } from '../src/systems/fire.js';
import { evacuate, updateFleeing } from '../src/systems/civilians.js';
import { CONFIG } from '../src/core/config.js';

test('a fire evacuates a building and leaves some people trapped', () => {
  const state = createGame(7);
  const building = state.buildings.find((b) => b.type === 'apartment');
  building.occupants = 10;
  evacuate(state, building);

  assert.equal(building.evacuated, true);
  assert.equal(building.occupants, 0);
  assert.ok(building.trapped >= 0 && building.trapped <= 3);
  assert.equal(state.stats.escaped, 10 - building.trapped);
});

test('people running from a fire reach the street and disappear', () => {
  const state = createGame(8);
  const building = state.buildings.find((b) => b.type === 'hotel');
  building.occupants = 30;
  evacuate(state, building);
  assert.ok(state.fleeing.length > 0, 'nobody ran out');

  for (let i = 0; i < 30 * 90; i++) updateFleeing(state, 1 / 30);
  assert.equal(state.fleeing.length, 0);
});

test('a crew brings trapped people out of a burning building', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  const st = state.city.station;
  const building = state.buildings
    .filter((b) => b.type === 'house' && b.y > 10)
    .sort((a, b) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(b.x - st.x, b.y - st.y))[0];
  building.occupants = 6;
  building.integrity = 400;
  building.maxIntegrity = 400;
  ignite(state, building, 'test');
  building.trapped = 2;

  assert.equal(commandDispatch(state, building.id), true);
  let seconds = 0;
  while (state.stats.rescued < 2 && seconds < 120) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }

  assert.equal(state.stats.rescued, 2, `rescued ${state.stats.rescued} after ${seconds.toFixed(0)}s`);
  assert.equal(building.trapped, 0);
  assert.ok(state.rating >= CONFIG.rating.start);
});

test('people still inside when a building collapses are lost', () => {
  const state = createGame(9);
  const building = state.buildings.find((b) => b.type === 'warehouse');
  building.occupants = 8;
  ignite(state, building, 'test');
  building.trapped = 2;
  building.integrity = 4;
  const ratingBefore = state.rating;

  for (let i = 0; i < 30 * 120 && building.state === 'burning'; i++) updateFire(state, 1 / 30);

  assert.equal(building.state, 'rubble');
  assert.equal(state.stats.casualties, 2);
  assert.equal(state.rating, ratingBefore - CONFIG.rating.perLost - 12);
  assert.equal(building.trapped, 0);
});
