import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatch, commandDispatchAll,
  commandBindKey, selectUnitByKey, commandDispatchWildfire, commandReturnAll, serialize, loadState,
} from '../src/systems/game.js';
import { dispatchEngine } from '../src/systems/units.js';
import { ignite } from '../src/systems/fire.js';
import { spawnPatient } from '../src/systems/medical.js';
import { startWildfire } from '../src/systems/wildfire.js';
import { UNIT_KEYS, isUnitKey } from '../src/core/hotkeys.js';
import { CONFIG, TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 90000;
  return state;
}

/** Ordinary buildings spread well apart, far enough from the station to be separate scenes. */
function scenes(state, n) {
  const station = state.city.station;
  const pool = state.buildings.filter((b) => !['station', 'hospital', 'warehouse'].includes(b.type) && b.state === 'ok'
    && Math.hypot(b.x - station.x, b.y - station.y) > 12 && Math.hypot(b.x - station.x, b.y - station.y) < 80);
  const out = [];
  for (const b of pool) {
    if (out.every((o) => Math.hypot(o.x - b.x, o.y - b.y) > 20)) out.push(b);
    if (out.length === n) break;
  }
  assert.equal(out.length, n, 'not enough separate buildings');
  return out;
}

const buy = (state, type, n) => {
  for (let i = 0; i < n; i++) assert.ok(commandBuyVehicle(state, type), type + ' ' + i);
};

// ---------------------------------------------------------- dispatch all ---

test('dispatch all gives every fire a vehicle of its own', () => {
  const state = shift();
  buy(state, 'engine', 3); // four engines
  const fires = scenes(state, 4);
  for (const b of fires) ignite(state, b, 'test');

  const result = commandDispatchAll(state);
  assert.ok(result);
  assert.equal(result.sent, 4);
  const targets = state.engines.map((e) => e.targetId);
  assert.equal(new Set(targets).size, 4, 'two engines went to the same fire: ' + targets);
  for (const b of fires) assert.ok(targets.includes(b.id), b.name + ' got nobody');
});

test('with more vehicles than fires each fire gets exactly one and the rest stay in quarters', () => {
  const state = shift();
  buy(state, 'engine', 4); // five engines
  const fires = scenes(state, 2);
  for (const b of fires) ignite(state, b, 'test');
  commandDispatchAll(state);
  for (const b of fires) {
    assert.equal(state.engines.filter((e) => e.targetId === b.id).length, 1, b.name);
  }
  assert.equal(state.engines.filter((e) => e.targetId).length, 2);
});

test('one burning house gets one vehicle, not the whole fleet', () => {
  const state = shift();
  buy(state, 'engine', 3);
  buy(state, 'ladder', 1);
  const [house] = scenes(state, 1);
  ignite(state, house, 'test');
  const result = commandDispatchAll(state);
  assert.equal(result.sent, 1);
  assert.equal(state.engines.filter((e) => e.targetId === house.id).length, 1);
  assert.equal(state.engines.filter((e) => e.path.length > 0).length, 1);
});

test('a vehicle with an empty tank is not dispatched to a fire', () => {
  const state = shift();
  buy(state, 'engine', 1);
  const [house] = scenes(state, 1);
  ignite(state, house, 'test');
  state.engines[0].water = 0;
  commandDispatchAll(state);
  assert.equal(state.engines[0].targetId, null);
  assert.equal(state.engines[1].targetId, house.id);
});

test('with fewer vehicles than fires the rest are reported, and a second press changes nothing', () => {
  const state = shift();
  buy(state, 'engine', 1); // two engines
  const fires = scenes(state, 4);
  for (const b of fires) ignite(state, b, 'test');
  const result = commandDispatchAll(state);
  assert.equal(result.sent, 2);
  assert.ok(result.uncovered >= 2, 'the fires nobody could reach were not reported');
  assert.equal(new Set(state.engines.map((e) => e.targetId)).size, 2);
  const before = state.engines.map((e) => e.targetId).join();
  assert.equal(commandDispatchAll(state), false);
  assert.equal(state.engines.map((e) => e.targetId).join(), before);
});

test('pressing dispatch repeatedly spreads engines over different fires', () => {
  const state = shift();
  buy(state, 'engine', 2);
  const fires = scenes(state, 3);
  for (const b of fires) ignite(state, b, 'test');
  for (let i = 0; i < 3; i++) assert.ok(commandDispatch(state), 'dispatch ' + i);
  const targets = state.engines.map((e) => e.targetId);
  assert.equal(new Set(targets).size, 3, 'all engines went to one fire: ' + targets);
});

test('dispatch all sends ambulances to different patients and engines to the fire', () => {
  const state = shift();
  buy(state, 'engine', 1);
  buy(state, 'ambulance', 2);
  const [a, b, c] = scenes(state, 3);
  ignite(state, a, 'test');
  spawnPatient(state, b);
  spawnPatient(state, c);
  const result = commandDispatchAll(state);
  assert.equal(result.sent, 3); // one engine to the fire, an ambulance to each patient
  const ambulances = state.engines.filter((e) => e.spec.medical);
  assert.ok(ambulances.every((e) => e.patientId));
  assert.notEqual(ambulances[0].patientId, ambulances[1].patientId, 'both ambulances went to the same patient');
  const engines = state.engines.filter((e) => !e.spec.medical && e.targetId);
  assert.equal(engines.length, 1);
  assert.equal(engines[0].targetId, a.id);
});

test('dispatch all says so when there is nothing to do', () => {
  const state = shift();
  assert.equal(commandDispatchAll(state), false);
  assert.ok(state.events[0].text.includes('quiet'));
});

// ------------------------------------------------- empty tanks, back all ---

test('an engine whose tank runs dry drives back to the station by itself', () => {
  const state = shift();
  const engine = state.engines[0];
  const [house] = scenes(state, 1);
  ignite(state, house, 'test');
  assert.equal(dispatchEngine(state, engine, house.id), engine);
  for (let i = 0; i < 60 * 120 && engine.path.length > 0; i++) update(state, 1 / 60);
  engine.water = 0;
  update(state, 1 / 60);
  assert.ok(engine.path.length > 0 || engine.packTimer > 0, 'it stayed at the fire with no water');
  assert.ok(state.events.some((e) => e.text.includes('out of water — returning')));
  for (let i = 0; i < 60 * 240; i++) update(state, 1 / 60);
  const bay = state.city.bays[engine.bayIndex];
  assert.ok(Math.hypot(engine.x - bay.x, engine.y - bay.y) < 3 * TILE, 'it did not reach its bay');
  assert.ok(engine.water > 0, 'it did not refill');
});

test('back all sends every vehicle home and drops its job', () => {
  const state = shift();
  buy(state, 'engine', 2);
  buy(state, 'ambulance', 1);
  const [a, b, c] = scenes(state, 3);
  ignite(state, a, 'test');
  ignite(state, b, 'test');
  spawnPatient(state, c);
  commandDispatchAll(state);
  assert.ok(state.engines.filter((e) => e.path.length > 0).length >= 3);
  assert.ok(commandReturnAll(state));
  assert.ok(state.engines.every((e) => !e.targetId && !e.patientId));
  assert.ok(state.patients.every((p) => !p.claimedBy));
  for (let i = 0; i < 60 * 240; i++) update(state, 1 / 60);
  for (const e of state.engines) {
    const bay = state.city.bays[e.bayIndex];
    assert.ok(Math.hypot(e.x - bay.x, e.y - bay.y) < 3 * TILE, e.name + ' is not home');
  }
  assert.equal(commandReturnAll(state), false, 'nothing is left to send');
});

// ------------------------------------------------------- the rapid car ---

test('the rapid response car is small and quick, with two crew, a locker of tools and no pump', () => {
  const state = shift();
  const car = commandBuyVehicle(state, 'rapid');
  assert.ok(car);
  assert.equal(state.crew.filter((c) => c.engineId === car.id).length, 2);
  assert.equal(car.capacity, 0);
  assert.equal(car.spec.turretRange, 0);
  for (const tool of ['chainsaw', 'cutter', 'diving']) assert.ok(car.spec.tools[tool] > 0, tool);
  assert.ok(car.spec.hoseRange > 0);
  assert.ok(car.spec.cost < CONFIG.vehicles.engine.cost * 1.5 && car.spec.speed > CONFIG.vehicles.engine.speed);
});

test('the rapid car parks at a hydrant, connects, and its crew put the fire out with the hose', () => {
  const state = shift();
  const car = commandBuyVehicle(state, 'rapid');
  const fire = scenes(state, 1)[0];
  ignite(state, fire, 'test');
  assert.equal(dispatchEngine(state, car, fire.id), car);

  for (let i = 0; i < 60 * 120 && !car.supply; i++) update(state, 1 / 60);
  assert.ok(car.supply, 'the car did not connect to a hydrant');
  assert.ok(Math.hypot(car.supply.x - car.x, car.supply.y - car.y) <= CONFIG.refillRange * TILE, 'parked away from its hydrant');

  let sprayed = false;
  for (let i = 0; i < 60 * 150; i++) {
    update(state, 1 / 60);
    if (state.crew.some((c) => c.engineId === car.id && c.spraying)) sprayed = true;
    if (fire.state !== 'burning') break;
  }
  assert.ok(sprayed, 'nobody put the hose on the fire');
  assert.notEqual(fire.state, 'burning', 'the fire is still burning');
  assert.equal(car.water, 0, 'it has no tank to spend');
});

test('the rapid car does not get far from a hydrant without one in hose reach', () => {
  const state = shift();
  const car = commandBuyVehicle(state, 'rapid');
  const fire = scenes(state, 1)[0];
  // Take every hydrant away: there is nowhere to connect.
  state.city.hydrants = [];
  ignite(state, fire, 'test');
  assert.equal(dispatchEngine(state, car, fire.id), null);
  assert.equal(car.path.length, 0);
});

test('the rapid car refuses a forest fire, which has no hydrants', () => {
  const state = shift();
  const car = commandBuyVehicle(state, 'rapid');
  startWildfire(state);
  const wf = state.wildfires[0];
  assert.ok(wf);
  commandDispatchWildfire(state, wf.id);
  assert.equal(car.wildfireId, null);
  assert.equal(car.path.length, 0);
  commandDispatchAll(state);
  assert.equal(car.wildfireId, null);
});

// --------------------------------------------------------- shortcuts ---

test('every vehicle gets its own shortcut key, and keys can be changed', () => {
  const state = shift();
  buy(state, 'engine', 3);
  const keys = state.engines.map((e) => e.hotkey);
  assert.deepEqual(keys, ['1', '2', '3', '4']);

  assert.equal(selectUnitByKey(state, '3'), true);
  assert.equal(state.selected.id, state.engines[2].id);

  // Rebinding takes the key and swaps with whoever had it.
  assert.equal(commandBindKey(state, state.engines[0].id, '3'), true);
  assert.equal(state.engines[0].hotkey, '3');
  assert.equal(state.engines[2].hotkey, '1');
  selectUnitByKey(state, '3');
  assert.equal(state.selected.id, state.engines[0].id);

  // The game's own keys are not available; clearing works.
  for (const key of ['d', 'a', 'e', 'b', 'h']) assert.equal(commandBindKey(state, state.engines[1].id, key), false, key);
  assert.equal(state.engines[1].hotkey, '2');
  assert.equal(commandBindKey(state, state.engines[1].id, ''), true);
  assert.equal(selectUnitByKey(state, '2'), false);
  assert.ok(UNIT_KEYS.every(isUnitKey));
});

test('a letter key works as a unit shortcut, and shortcuts survive a save', () => {
  const state = shift();
  buy(state, 'ambulance', 1);
  commandBindKey(state, state.engines[1].id, 'q');
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.deepEqual(loaded.engines.map((e) => e.hotkey), ['1', 'q']);
  selectUnitByKey(loaded, 'q');
  assert.equal(loaded.selected.id, loaded.engines[1].id);
});

test('with more than ten vehicles the extra ones still get keys', () => {
  const state = shift();
  buy(state, 'engine', 12);
  assert.ok(state.engines.every((e) => e.hotkey));
  assert.equal(new Set(state.engines.map((e) => e.hotkey)).size, 13);
});

// ----------------------------------------------------------- capacity ---

test('each station has sixteen bays and the original bay numbers are unchanged', () => {
  const state = shift();
  const { stations, bays } = state.city;
  assert.equal(stations[0].bays.length, 16);
  assert.equal(stations[1].bays.length, 16);
  assert.equal(stations[2].bays.length, 16);
  // Old saves refer to bays 0-7 (station 1), 8-15 (station 2), 16-23 (dock).
  assert.deepEqual(bays.slice(0, 8).map((b) => b.station), Array(8).fill(0));
  assert.deepEqual(bays.slice(8, 16).map((b) => b.station), Array(8).fill(1));
  assert.deepEqual(bays.slice(16, 24).map((b) => b.station), Array(8).fill(2));
  assert.ok(bays.slice(0, 24).every((b) => !b.extra));
  assert.ok(bays.slice(24).every((b) => b.extra));
});
