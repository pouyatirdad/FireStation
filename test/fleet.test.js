import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, commandBuyEngine, commandDispatch } from '../src/systems/game.js';
import { dispatchEngine } from '../src/systems/units.js';
import { CONFIG } from '../src/core/config.js';
import { ignite } from '../src/systems/fire.js';

test('buying an engine costs credits, adds three crew and a bay', () => {
  const state = createGame(7);
  startShift(state);
  const credits = state.credits;
  const before = state.engines.length;

  const engine = commandBuyEngine(state);

  assert.ok(engine, 'engine was not bought');
  assert.equal(state.engines.length, before + 1);
  assert.equal(state.crew.length, 3 * state.engines.length);
  assert.equal(state.credits, credits - CONFIG.vehicles.engine.cost);
  assert.equal(engine.crewIds.length, 3);
  assert.equal(state.selected.id, engine.id);
  assert.equal(state.activeEngineId, engine.id);
});

test('the station has only six bays and a vehicle must be affordable', () => {
  const state = createGame(7);
  startShift(state);

  state.credits = 0;
  assert.equal(commandBuyEngine(state), null, 'bought an engine with no credits');

  state.credits = 100000;
  for (let i = 0; i < 5; i++) assert.ok(commandBuyEngine(state), `bought ${i + 2} engines`);
  assert.equal(state.engines.length, 6);
  assert.equal(commandBuyEngine(state), null, 'bought a seventh engine');
});

test('with two engines, dispatch sends the idle one', () => {
  const state = createGame(7);
  startShift(state);
  state.credits = 100000;
  const second = commandBuyEngine(state);
  assert.ok(second);

  const buildings = state.buildings.filter((b) => b.id !== 'station');
  const first = buildings[4];
  const other = buildings[buildings.length - 4];
  ignite(state, first, 'test');
  ignite(state, other, 'test');

  const a = dispatchEngine(state, null, first.id);
  const b = dispatchEngine(state, null, other.id);
  assert.ok(a && b, 'a dispatch failed');
  assert.notEqual(a.id, b.id, 'both fires were sent to the same engine');
});

test('a two-engine shift can answer two calls at once', () => {
  const state = createGame(7);
  startShift(state);
  state.credits = 100000;
  commandBuyEngine(state);

  const buildings = state.buildings.filter((b) => b.id !== 'station');
  const first = buildings[3];
  const other = buildings[buildings.length - 3];
  ignite(state, first, 'test');
  ignite(state, other, 'test');

  assert.equal(commandDispatch(state, first.id), true);
  state.selected = null;
  assert.equal(commandDispatch(state, other.id), true);

  const committed = state.engines.filter((e) => e.targetId).length;
  assert.equal(committed, 2);
});
