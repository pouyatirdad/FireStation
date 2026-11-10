import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, commandHydrant, commandReturnHome } from '../src/systems/game.js';
import { hydrantInReach, orderEngine } from '../src/systems/units.js';

const TILE = 32;

function parkOnHydrant(state, engine) {
  const station = state.city.station;
  const hydrant = state.city.hydrants.find(
    (h) => Math.abs(h.x - station.x) + Math.abs(h.y - station.y) > 16,
  );
  engine.x = (hydrant.x + 0.5) * TILE;
  engine.y = (hydrant.y + 0.5) * TILE;
  return hydrant;
}

test('a supply line needs a hydrant in reach and can be detached again', () => {
  const state = createGame(7);
  startShift(state);
  const engine = state.engines[0];
  const hydrant = parkOnHydrant(state, engine);

  assert.ok(hydrantInReach(state, engine), 'test hydrant is out of reach');
  assert.equal(commandHydrant(state), true);
  assert.ok(engine.supply, 'no supply line');
  assert.equal(engine.supply.x, (hydrant.x + 0.5) * TILE);

  assert.equal(commandHydrant(state), false, 'toggle did not detach');
  assert.equal(engine.supply, null);
});

test('a hydrant does not refill the tank until the line is connected', () => {
  const state = createGame(7);
  startShift(state);
  const engine = state.engines[0];
  parkOnHydrant(state, engine);
  engine.water = 0;

  for (let i = 0; i < 30; i++) update(state, 1 / 30);
  assert.equal(engine.water, 0, 'refilled from a hydrant with no supply line');

  commandHydrant(state);
  for (let i = 0; i < 30; i++) update(state, 1 / 30);
  assert.ok(engine.water > 0, 'did not refill once connected');
});

test('driving away detaches the supply line', () => {
  const state = createGame(7);
  startShift(state);
  const engine = state.engines[0];
  parkOnHydrant(state, engine);
  commandHydrant(state);
  assert.ok(engine.supply);

  orderEngine(state, engine, 20 * TILE, 12 * TILE);
  assert.equal(engine.supply, null);
});

test('going home also detaches the line', () => {
  const state = createGame(7);
  startShift(state);
  const engine = state.engines[0];
  parkOnHydrant(state, engine);
  commandHydrant(state);
  assert.ok(engine.supply);

  commandReturnHome(state);
  assert.equal(engine.supply, null);
});
