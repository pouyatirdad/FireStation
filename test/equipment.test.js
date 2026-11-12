import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, selectUnit, commandEquip, commandMove, commandRecall,
  serialize, loadState,
} from '../src/systems/game.js';
import { createCity } from '../src/data/city.js';
import { findPath, passable, tileOf } from '../src/systems/grid.js';
import { toolsFree } from '../src/systems/units.js';
import { missionDone } from '../src/systems/economy.js';
import { CONFIG, TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 80000;
  return state;
}

const run = (state, seconds, until = () => false) => {
  for (let t = 0; t < seconds && !until(); t += 1 / 30) update(state, 1 / 30);
};

// ------------------------------------------------------------- the woods ---

test('there are no streets inside the forests, only round them', () => {
  const city = createCity(7);
  const at = (x, y) => y * city.w + x;
  // Deep in the Southeast Forest, where an avenue and a street used to cross.
  assert.equal(city.road[at(432, 276)], 0, 'a junction inside the forest');
  assert.equal(city.road[at(432, 290)], 0, 'an avenue inside the forest');
  assert.equal(city.woods[at(432, 290)] > 0, true);
  assert.equal(city.forest[at(432, 290)], 1);
  // The avenue along its western edge, by the river, is still a street.
  assert.equal(city.road[at(372, 290)], 1);
  // Nothing parks or stands by a road in the woods.
  for (const car of city.cars) {
    assert.equal(city.woods[at(Math.floor(car.x / TILE), Math.floor(car.y / TILE))], 0, 'a parked car in the woods');
  }
});

test('traffic keeps to the streets that are left', () => {
  const state = shift();
  run(state, 10);
  const city = state.city;
  for (const car of state.traffic.cars) {
    const x = Math.floor(car.x / TILE);
    const y = Math.floor(car.y / TILE);
    assert.equal(city.road[y * city.w + x], 1, `a car off the road at ${x},${y}`);
  }
});

// ------------------------------------------------------------- equipment ---

test('tools come out of the lockers one at a time and go back when the crew boards', () => {
  const state = shift();
  const engine = state.engines[0];
  assert.equal(toolsFree(state, engine, 'chainsaw'), CONFIG.vehicles.engine.tools.chainsaw);
  selectUnit(state, engine.id);
  assert.equal(commandEquip(state, 'chainsaw'), true);
  const sawyer = state.crew.find((c) => c.engineId === engine.id && c.fetch === 'chainsaw');
  assert.ok(sawyer, 'nobody went for the chainsaw');
  assert.equal(sawyer.riding, false);
  assert.equal(toolsFree(state, engine, 'chainsaw'), 0);

  // The engine's only chainsaw is out: a second one cannot be had.
  selectUnit(state, engine.id);
  assert.equal(commandEquip(state, 'chainsaw'), false);
  // And a tanker carries none at all.
  const tanker = state.engines.find((e) => e.type === 'tanker') ?? null;
  assert.equal(tanker, null);

  run(state, 3);
  assert.equal(sawyer.tool, 'chainsaw');
  assert.equal(sawyer.fetch, null);

  selectUnit(state, engine.id);
  commandRecall(state);
  assert.equal(sawyer.riding, true);
  assert.equal(toolsFree(state, engine, 'chainsaw'), 1);
});

test('a firefighter with a chainsaw cuts a track deep into the woods that an engine can drive', () => {
  const state = shift();
  const engine = state.engines[0];
  // Park at the end of the avenue that stops at the North Woods.
  engine.x = 133 * TILE;
  engine.y = 37.5 * TILE;
  assert.equal(passable(state.nav, 'drive', 132, 37), true, 'not parked on the road');
  assert.equal(passable(state.nav, 'drive', 132, 20), false, 'the woods are already open');

  selectUnit(state, engine.id);
  assert.equal(commandEquip(state, 'chainsaw'), true);
  const sawyer = state.crew.find((c) => c.engineId === engine.id && c.fetch === 'chainsaw');
  run(state, 3);
  assert.equal(sawyer.tool, 'chainsaw');

  selectUnit(state, sawyer.id);
  assert.equal(commandMove(state, 132.5 * TILE, 10.5 * TILE), true, 'the cut order was refused');
  assert.ok(sawyer.cut, 'no cutting job');
  run(state, 150, () => !sawyer.cut);
  assert.equal(sawyer.cut, null, 'still cutting');
  for (let y = 11; y <= 35; y++) assert.equal(passable(state.nav, 'drive', 132, y), true, `track not cut at 132,${y}`);
  assert.ok(state.cutCount >= 40, `${state.cutCount} tiles cut`);

  const path = findPath(state.nav, 'drive', tileOf(engine.x, engine.y), { x: 132, y: 12 });
  assert.ok(path && path.length > 20, 'an engine cannot drive the track');

  // The track survives a save.
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.equal(passable(loaded.nav, 'drive', 132, 15), true);
  assert.equal(loaded.cut[15 * loaded.city.w + 132], 1);
});

test('a chainsaw only cuts where there are trees', () => {
  const state = shift();
  const engine = state.engines[0];
  selectUnit(state, engine.id);
  commandEquip(state, 'chainsaw');
  const sawyer = state.crew.find((c) => c.engineId === engine.id && c.fetch === 'chainsaw');
  run(state, 3);
  selectUnit(state, sawyer.id);
  // Out on the station apron a right-click is just a move.
  commandMove(state, engine.x + 3 * TILE, engine.y);
  assert.equal(sawyer.cut, null);
});

// ------------------------------------------------------------ volunteers ---

test('a volunteers’ grant comes only after a run of missions and only in a city that is doing well', () => {
  const state = shift();
  state.rng.chance = () => true;
  state.ledger.grantAfter = 3;
  const before = state.credits;
  assert.equal(missionDone(state), null);
  assert.equal(missionDone(state), null);
  const amount = missionDone(state);
  assert.ok(amount >= CONFIG.economy.grant.min && amount <= CONFIG.economy.grant.max, `grant of ${amount}`);
  assert.equal(state.credits, before + amount);
  assert.equal(state.ledger.missions, 0);
  assert.ok(state.ledger.grantAfter >= 10 && state.ledger.grantAfter <= 20);
  assert.ok(state.events.some((e) => /foundation grant/.test(e.text)));

  // A city with a poor rating gets nothing, and the next chance moves on.
  state.ledger.missions = 0;
  state.ledger.grantAfter = 1;
  state.rating = 50;
  assert.equal(missionDone(state), null);
  assert.ok(state.ledger.grantAfter > 1);
});

test('the grant is rare: never within the first ten missions, and not every time after', () => {
  let total = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const state = createGame(seed);
    startShift(state);
    let grants = 0;
    for (let i = 0; i < 9; i++) if (missionDone(state)) grants++;
    assert.equal(grants, 0, 'a grant before ten missions');
    for (let i = 0; i < 21; i++) if (missionDone(state)) grants++;
    assert.ok(grants <= 2, `${grants} grants in 30 missions`);
    total += grants;
  }
  assert.ok(total < 12, 'every shift got a grant');
});
