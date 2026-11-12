import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatchPatient,
  commandDispatchBlockade, serialize, loadState, selectUnit,
} from '../src/systems/game.js';
import { addBlockade, rushFactor, stoppedCars, workOnBlockade } from '../src/systems/blockades.js';
import { explode, pickRoadSpot, pileUp, trafficAccident, updateChains } from '../src/systems/chains.js';
import { orderEngine } from '../src/systems/units.js';
import { findPath, tileOf } from '../src/systems/grid.js';
import { ignite } from '../src/systems/fire.js';
import { spawnPatient } from '../src/systems/medical.js';
import { startWildfire, updateWildfires } from '../src/systems/wildfire.js';
import { downwindFactor, updateWind, windFrom, windLabel } from '../src/systems/wind.js';
import { CONFIG, TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 30000;
  return state;
}

const driveTilesBlocked = (state, b) => b.saved.every((i) => state.nav.drive[i] === 0);

// ------------------------------------------------------------------ wind ---

test('wind names the compass point it blows from', () => {
  assert.equal(windFrom(0), 'W'); // blowing east, so it comes from the west
  assert.equal(windFrom(Math.PI / 2), 'N'); // blowing south, from the north
  assert.equal(windFrom(Math.PI), 'E');
  assert.equal(windFrom(-Math.PI / 2), 'S');
  assert.match(windLabel({ dir: 0, speed: 0.5 }), /^W 21 km\/h$/);
});

test('fire is likelier to travel downwind than upwind, and not at all biased in calm air', () => {
  const state = shift();
  state.wind = { dir: 0, speed: 1, targetDir: 0, targetSpeed: 1, changeIn: 999 };
  const down = downwindFactor(state, 0, 0, 100, 0);
  const up = downwindFactor(state, 0, 0, -100, 0);
  const across = downwindFactor(state, 0, 0, 0, 100);
  assert.ok(down > 2, `downwind ${down}`);
  assert.ok(up < 0.5, `upwind ${up}`);
  assert.ok(Math.abs(across - 1) < 1e-9);
  state.wind.speed = 0;
  assert.equal(downwindFactor(state, 0, 0, 100, 0), 1);
});

test('the wind drifts and stays within sensible bounds', () => {
  const state = shift();
  const start = { dir: state.wind.dir, speed: state.wind.speed };
  state.wind.changeIn = 0.01;
  for (let i = 0; i < 30 * 120; i++) {
    updateWind(state, 1 / 30);
    assert.ok(state.wind.speed >= 0 && state.wind.speed <= 1.05, `speed ${state.wind.speed}`);
  }
  assert.ok(state.wind.dir !== start.dir || state.wind.speed !== start.speed, 'the wind never changed');
});

test('a forest fire creeps downwind', () => {
  const state = shift();
  state.wind = { dir: 0, speed: 1, targetDir: 0, targetSpeed: 1, changeIn: 9999 };
  const tile = state.city.forestTiles[Math.floor(state.city.forestTiles.length / 2)];
  const wf = startWildfire(state, tile.x * TILE, tile.y * TILE, 1000);
  const x = wf.x;
  const y = wf.y;
  for (let i = 0; i < 30 * 30; i++) updateWildfires(state, 1 / 30);
  assert.ok(wf.x > x + 5 * TILE, `only moved ${(wf.x - x) / TILE} tiles east`);
  assert.ok(Math.abs(wf.y - y) < 1);
});

// ------------------------------------------------------------- blockades ---

test('a blockade seals the road tiles and reopening restores them and pays', () => {
  const state = shift();
  const rect = pickRoadSpot(state);
  assert.ok(rect, 'no place for a crash');
  const b = addBlockade(state, rect, { name: 'Test wreck', reward: 100 });
  assert.ok(b.saved.length >= 4, 'the blockade did not cover the road');
  assert.ok(driveTilesBlocked(state, b));

  const credits = state.credits;
  assert.equal(workOnBlockade(state, b, CONFIG.blockade.clearTime / 2), false);
  assert.equal(b.progress, 0.5);
  assert.equal(workOnBlockade(state, b, CONFIG.blockade.clearTime), true);
  assert.equal(state.blockades.length, 0);
  assert.ok(b.saved.every((i) => state.nav.drive[i] === 1), 'road tiles were not restored');
  assert.equal(state.credits, credits + 100);
});

test('engines route round a blockade, and re-plan when one appears on their way', () => {
  const state = shift();
  const engine = state.engines[0];
  const start = tileOf(engine.x, engine.y);
  const goal = { x: 100, y: 61 }; // a street some way east of the station
  const before = findPath(state.nav, 'drive', start, goal);
  assert.ok(before && before.length > 0);

  // Block the street in the middle of the straight run.
  const mid = before[Math.floor(before.length / 2)];
  const b = addBlockade(state, { tx: mid.x - 1, ty: 60, tw: 3, th: 2 }, { name: 'Test' });
  const after = findPath(state.nav, 'drive', start, goal);
  assert.ok(after, 'no way round');
  assert.ok(after.every((t) => !(t.x >= b.tx && t.x < b.tx + b.tw && t.y >= b.ty && t.y < b.ty + b.th)), 'route goes through the wreck');
});

test('a moving engine is re-routed when a wreck lands on its path', () => {
  const state = shift();
  const engine = state.engines[0];
  assert.equal(orderEngine(state, engine, 100 * TILE, 61 * TILE), true);
  const mid = engine.path[Math.floor(engine.path.length / 2)];
  const tx = Math.floor(mid.x / TILE);
  const ty = Math.floor(mid.y / TILE);
  const rect = { tx: tx - 1, ty: ty - 1, tw: 3, th: 3 };
  addBlockade(state, rect, { name: 'Test' });
  assert.ok(engine.path.length > 0 || engine.status === 'blocked');
  for (const wp of engine.path) {
    const wx = Math.floor(wp.x / TILE);
    const wy = Math.floor(wp.y / TILE);
    assert.ok(!(wx >= rect.tx && wx < rect.tx + rect.tw && wy >= rect.ty && wy < rect.ty + rect.th));
  }
});

test('traffic queues behind a blockade instead of driving through it', () => {
  const state = shift();
  const lane = state.traffic.lanes.find((l) => l.axis === 'v' && l.cars.length >= 8);
  assert.ok(lane, 'no busy lane');
  const vx = Math.floor(lane.line / TILE);
  const roadX = state.city.road[200 * state.city.w + vx] ? vx : vx - 1;
  const b = addBlockade(state, { tx: roadX, ty: 190, tw: 2, th: 3 }, { name: 'Jam' });
  const before = stoppedCars(state);
  for (let i = 0; i < 30 * 40; i++) update(state, 1 / 30);
  assert.ok(stoppedCars(state) > before, 'no car stopped');
  for (const car of lane.cars) {
    const inside = Math.abs(car.x - b.x) < b.w / 2 && Math.abs(car.y - b.y) < b.h / 2;
    assert.equal(inside, false, 'a car drove into the wreck');
  }
});

test('rush hour slows the response, and is announced', () => {
  assert.equal(rushFactor(7.5 * 60), CONFIG.traffic.rushFactor);
  assert.equal(rushFactor(12 * 60), 1);
  assert.equal(rushFactor(17 * 60), CONFIG.traffic.rushFactor);
  const state = shift();
  state.clock = 12 * 60;
  update(state, 1 / 30);
  assert.equal(state.trafficFactor, 1);
  state.clock = 17 * 60;
  update(state, 1 / 30);
  assert.equal(state.trafficFactor, CONFIG.traffic.rushFactor);
  assert.ok(state.events.some((e) => /Rush hour/.test(e.text)));
});

// ----------------------------------------------------------- the chains ---

test('a traffic accident blocks the road and hurts people', () => {
  const state = shift();
  const wreck = trafficAccident(state, () => true);
  assert.ok(wreck, 'no accident');
  assert.equal(state.blockades.length, 1);
  assert.ok(state.patients.length >= 1);
  assert.ok(state.events.some((e) => /Traffic accident/.test(e.text)));
  assert.ok(driveTilesBlocked(state, wreck));
});

test('a wreck left alone sets a nearby building alight', () => {
  const state = shift();
  const wreck = trafficAccident(state, () => true);
  const burning = () => state.buildings.filter((b) => b.state === 'burning').length;
  assert.equal(burning(), 0);
  state.time = wreck.fuelAt + 1;
  updateChains(state);
  assert.equal(wreck.fuelDone, true);
  assert.ok(burning() >= 1 || state.events.some((e) => /burns out/.test(e.text)), 'nothing happened');
  if (burning() > 0) {
    assert.ok(state.events.some((e) => /Fuel leak/.test(e.text)));
    const b = state.buildings.find((x) => x.state === 'burning' && x.incidentType === 'chain');
    assert.equal(b.reward, CONFIG.incidents.reward.chain);
  }
});

test('clearing the wreck in time pays a bonus and the fuel never catches', () => {
  const state = shift();
  const wreck = trafficAccident(state, () => true);
  const credits = state.credits;
  // A crew clears it: feed the clear time in directly through the same call the crews use.
  const engine = state.engines[0];
  assert.equal(commandDispatchBlockade(state, wreck.id), true);
  assert.equal(engine.blockadeId, wreck.id);
  let seconds = 0;
  while (state.blockades.length > 0 && seconds < 300) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.equal(state.blockades.length, 0, `still blocked after ${seconds.toFixed(0)} s`);
  assert.ok(state.credits >= credits + CONFIG.incidents.reward.crash + CONFIG.blockade.quickBonus - 20, 'no reward');
  assert.equal(state.stats.cleared, 1);
  assert.ok(wreck.saved.every((i) => state.nav.drive[i] === 1), 'the road did not reopen');
  assert.ok(!state.buildings.some((b) => b.incidentType === 'chain'));
});

test('a pile-up is three wrecks in a row, with many injured', () => {
  const state = shift();
  const n = pileUp(state, () => true);
  assert.ok(n >= 2, `only ${n} wrecks`);
  assert.ok(state.blockades.every((b) => b.big));
  assert.ok(state.patients.length >= 3);
  assert.ok(state.events.some((e) => e.tone === 'big' && /pile-up/i.test(e.text)));
});

test('a warehouse fire that runs hot explodes: neighbours, injured and debris in the road', () => {
  const state = shift();
  const warehouse = state.buildings.find((b) => b.type === 'warehouse' && b.id !== 'b2');
  ignite(state, warehouse, 'test');
  warehouse.fire = 0.95;
  explode(state, warehouse);
  assert.ok(state.events.some((e) => /EXPLOSION/.test(e.text)));
  assert.ok(state.patients.length >= 2, 'nobody was hurt');
  assert.ok(state.blockades.some((b) => b.debris), 'no debris in the street');
});

test('a hot warehouse fire eventually triggers the explosion by itself', () => {
  const state = shift();
  const warehouse = state.buildings.find((b) => b.type === 'warehouse');
  ignite(state, warehouse, 'test');
  warehouse.integrity = 1e6;
  warehouse.maxIntegrity = 1e6;
  for (let i = 0; i < 30 * 200 && !warehouse.exploded; i++) {
    warehouse.fire = 1;
    update(state, 1 / 30);
  }
  assert.equal(warehouse.exploded, true);
});

// ------------------------------------------------------------- hospitals ---

test('every commercial centre has a hospital', () => {
  const state = shift();
  assert.ok(state.city.hospitals.length >= 6, `${state.city.hospitals.length} hospitals`);
  assert.ok(state.city.hospitals.every((b) => b.type === 'hospital'));
});

test('a critical patient is stabilised, carried to a hospital, and paid for', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const station = state.city.station;
  const near = state.buildings
    .filter((b) => b.id !== 'station' && b.type !== 'warehouse' && b.type !== 'hospital')
    .sort((a, b) => Math.hypot(a.x - station.x, a.y - station.y) - Math.hypot(b.x - station.x, b.y - station.y))[0];
  const patient = spawnPatient(state, near, 0.95);
  assert.equal(patient.critical, true);
  const credits = state.credits;
  selectUnit(state, ambulance.id);
  assert.equal(commandDispatchPatient(state, patient.id), true);

  let seconds = 0;
  while ((state.stats.transported ?? 0) < 1 && seconds < 400) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.equal(state.stats.transported, 1, `not delivered after ${seconds.toFixed(0)} s (${ambulance.status})`);
  assert.equal(ambulance.cargo.length, 0);
  assert.ok(state.credits >= credits + CONFIG.economy.treated + CONFIG.medical.transportFee - 60, 'no transport fee');
  assert.ok(state.events.some((e) => /delivered 1 patient/.test(e.text)));
});

test('a minor patient is treated on the spot and never needs the hospital', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const station = state.city.station;
  const near = state.buildings
    .filter((b) => b.id !== 'station' && b.type !== 'warehouse')
    .sort((a, b) => Math.hypot(a.x - station.x, a.y - station.y) - Math.hypot(b.x - station.x, b.y - station.y))[0];
  const patient = spawnPatient(state, near, 0.3);
  assert.equal(patient.critical, false);
  selectUnit(state, ambulance.id);
  commandDispatchPatient(state, patient.id);
  for (let i = 0; i < 30 * 120 && !patient.treated; i++) update(state, 1 / 30);
  assert.equal(patient.treated, true);
  assert.equal(ambulance.cargo.length, 0);
});

// ------------------------------------------------------------------ save ---

test('blockades, wind and stretcher cases survive a save, and the road is still sealed', () => {
  const state = shift();
  const wreck = trafficAccident(state, () => true);
  wreck.progress = 0.4;
  state.wind.dir = 1.234;
  const ambulance = commandBuyVehicle(state, 'ambulance');
  ambulance.cargo.push({ name: 'Test', severity: 0.9 });

  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.equal(loaded.blockades.length, 1);
  assert.equal(loaded.blockades[0].progress, 0.4);
  assert.ok(driveTilesBlocked(loaded, loaded.blockades[0]));
  assert.equal(loaded.wind.dir, 1.234);
  assert.equal(loaded.engines.find((e) => e.type === 'ambulance').cargo.length, 1);
});
