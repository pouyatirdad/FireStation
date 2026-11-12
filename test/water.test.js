import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandBuyStation, commandDispatch,
  commandDispatchVictim, commandDispatchPatient, commandDispatchWildfire, selectUnit, serialize, loadState,
} from '../src/systems/game.js';
import { createCity, SEA_Y, RIVER_HALF_WIDTH, riverCentre } from '../src/data/city.js';
import { buildNav, passable } from '../src/systems/grid.js';
import { boatCanReach, freeBay } from '../src/systems/units.js';
import { drowningCall, spawnVictim } from '../src/systems/water.js';
import { nearestHospital, spawnPatient, unloadCargo } from '../src/systems/medical.js';
import { ignite, unattendedFactor, updateFire } from '../src/systems/fire.js';
import { startWildfire } from '../src/systems/wildfire.js';
import { categoryOf } from '../src/ui/hud.js';
import { CONFIG, TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 80000;
  return state;
}

const city = createCity(7);
const nav = buildNav(city);

// -------------------------------------------------------------------- map ---

test('the south of the map is sea and a river runs down through the east', () => {
  const at = (x, y) => y * city.w + x;
  assert.equal(city.water[at(10, SEA_Y + 3)], 1);
  assert.equal(city.water[at(500, city.h - 1)], 1);
  assert.equal(city.water[at(10, SEA_Y - 5)], 0);
  const y = 120;
  assert.equal(city.water[at(Math.round(riverCentre(y)), y)], 1);
  assert.equal(city.water[at(Math.round(riverCentre(y) + RIVER_HALF_WIDTH + 3), y)], 0);
});

test('no building, hydrant or tree stands in the water', () => {
  for (const b of city.buildings) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        assert.equal(city.water[y * city.w + x], 0, `${b.name} is in the water at ${x},${y}`);
      }
    }
  }
  for (const h of city.hydrants) assert.equal(city.water[h.y * city.w + h.x], 0, 'a hydrant in the river');
});

test('streets cross the river on bridges that people can drive and walk over', () => {
  const bridges = [];
  for (let i = 0; i < city.bridge.length; i++) if (city.bridge[i]) bridges.push(i);
  assert.ok(bridges.length >= 100, `${bridges.length} bridge tiles`);
  for (const i of bridges) {
    const x = i % city.w;
    const y = Math.floor(i / city.w);
    assert.ok(passable(nav, 'drive', x, y), 'a bridge you cannot drive over');
    assert.ok(passable(nav, 'walk', x, y), 'a bridge you cannot walk over');
    assert.ok(passable(nav, 'sail', x, y), 'boats cannot pass under a bridge');
  }
  // Open water: boats and swimmers only.
  const wx = Math.round(riverCentre(50));
  assert.equal(passable(nav, 'walk', wx, 50), false);
  assert.equal(passable(nav, 'drive', wx, 50), false);
  assert.equal(passable(nav, 'sail', wx, 50), true);
  assert.equal(passable(nav, 'swim', wx, 50), true);
});

test('the streets stop at the quay and the harbour dock has sixteen berths on the water', () => {
  for (let y = SEA_Y; y < city.h; y++) assert.equal(city.road[y * city.w + 100], 0, 'a road in the sea');
  const dock = city.stations[2];
  assert.equal(dock.id, 'dock');
  assert.equal(dock.bays.length, 16);
  for (const berth of dock.bays) {
    assert.equal(city.water[Math.floor(berth.y / TILE) * city.w + Math.floor(berth.x / TILE)], 1, 'a berth on dry land');
  }
});

test('the hospitals are in the bases', () => {
  const state = shift();
  assert.equal(nearestHospital(state, 100 * TILE, 100 * TILE).base, 0);
  // Station 2 hospital only counts once the base is open.
  assert.equal(state.city.hospitals.filter((h) => h.base === 1).length, 1);
  const far = nearestHospital(state, 243 * TILE, 147 * TILE);
  assert.equal(far.base, 0, 'used a hospital in a base that is not open');
  commandBuyStation(state, 1);
  assert.equal(nearestHospital(state, 243 * TILE, 147 * TILE).base, 1);
});

// -------------------------------------------------------------- the dock ---

test('boats berth only at the Harbour Dock, which has to be bought', () => {
  const state = shift();
  assert.equal(commandBuyVehicle(state, 'fireboat'), null, 'a boat without a dock');
  assert.equal(commandBuyStation(state, 2), true);
  assert.equal(state.credits, 80000 - CONFIG.economy.dockPrice);
  const boat = commandBuyVehicle(state, 'fireboat');
  assert.ok(boat);
  assert.equal(state.city.bays[boat.bayIndex].sea, true);
  assert.equal(commandBuyVehicle(state, 'engine').bayIndex < 8, true, 'a land vehicle was put in a berth');
  for (let i = 0; i < 15; i++) assert.ok(commandBuyVehicle(state, 'rescueboat'), `berth ${i + 2}`);
  assert.equal(commandBuyVehicle(state, 'rescueboat'), null, 'a seventeenth boat');
  assert.equal(freeBay(state, 2, true), -1);
});

// ----------------------------------------------------------------- divers ---

const riverVictim = (state, y = 150) => {
  const cx = Math.round(riverCentre(y));
  return spawnVictim(state, (cx + 0.5) * TILE, (y + 0.5) * TILE, 'the River');
};

test('a rescue boat sails up the river, divers bring the person out, and they become a patient', () => {
  const state = shift();
  commandBuyStation(state, 2);
  const boat = commandBuyVehicle(state, 'rescueboat');
  assert.equal(state.crew.filter((c) => c.engineId === boat.id && c.tool === 'diving').length, 2);
  const victim = riverVictim(state);
  victim.life = victim.maxLife = 400;
  selectUnit(state, boat.id);
  assert.equal(commandDispatchVictim(state, victim.id), true);
  assert.equal(boat.victimId, victim.id);

  let seconds = 0;
  while ((state.stats.dived ?? 0) < 1 && seconds < 300) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.equal(state.stats.dived, 1, `not rescued after ${seconds.toFixed(0)} s (${boat.status})`);
  assert.equal(state.victims.length, 0);
  const patient = state.patients.find((p) => p.buildingName === 'the River');
  assert.ok(patient, 'the rescued person did not become a patient');
  assert.equal(patient.critical, true);
  assert.ok(state.events.some((e) => /Diver brought someone out/.test(e.text)));
});

test('an engine needs no dive vehicle: its firefighters suit up on the bank and swim out', () => {
  const state = shift();
  const truck = state.engines[0];
  // The first bridge over the river on a street.
  let bridge = null;
  for (let i = 0; i < city.bridge.length && !bridge; i++) if (city.bridge[i]) bridge = { x: i % city.w, y: Math.floor(i / city.w) };
  const victim = spawnVictim(state, (bridge.x + 0.5) * TILE, (bridge.y + 2.5) * TILE, 'the bridge');
  victim.life = victim.maxLife = 600;
  selectUnit(state, truck.id);
  assert.equal(commandDispatchVictim(state, victim.id), true);
  let seconds = 0;
  let divers = 0;
  while ((state.stats.dived ?? 0) < 1 && seconds < 400) {
    update(state, 1 / 30);
    seconds += 1 / 30;
    divers = Math.max(divers, state.crew.filter((c) => c.engineId === truck.id && c.tool === 'diving').length);
  }
  assert.equal(state.stats.dived, 1, `not rescued after ${seconds.toFixed(0)} s (${truck.status})`);
  assert.equal(divers, CONFIG.vehicles.engine.tools.diving, 'the engine did not send out its divers');
  // The hose crew stayed aboard; the divers swim back and stow the gear.
  for (let i = 0; i < 30 * 40; i++) update(state, 1 / 30);
  assert.ok(state.crew.filter((c) => c.engineId === truck.id).every((c) => c.riding), 'the divers never came back aboard');
});

test('someone left in the water drowns when their clock runs out', () => {
  const state = shift();
  const victim = riverVictim(state, 100);
  victim.life = 0.2;
  const rating = state.rating;
  update(state, 0.5);
  assert.equal(state.victims.length, 0);
  assert.equal(state.stats.casualties, 1);
  assert.ok(state.rating < rating);
});

test('a drowning call puts people in the water near a bridge or the quay', () => {
  const state = shift();
  const n = drowningCall(state);
  assert.ok(n >= 1);
  assert.ok(state.victims.length >= 1);
  for (const v of state.victims) {
    assert.equal(state.city.water[Math.floor(v.y / TILE) * state.city.w + Math.floor(v.x / TILE)], 1, 'victim on dry land');
  }
  assert.ok(state.events.some((e) => /divers needed/.test(e.text)));
});

test('victims survive a save', () => {
  const state = shift();
  const v = riverVictim(state);
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.equal(loaded.victims.length, 1);
  assert.equal(loaded.victims[0].id, v.id);
  assert.equal(loaded.ownedStations.length, 3);
});

// -------------------------------------------------------------- fireboat ---

const riversideBuilding = (state) => state.buildings.find((b) => b.type !== 'station' && b.type !== 'hospital'
  && Math.abs(b.x + b.w / 2 - riverCentre(b.y + b.h / 2)) < RIVER_HALF_WIDTH + 12
  && b.y > 40 && b.y < 330 && b.state === 'ok');

test('a fireboat only helps fires within reach of the water', () => {
  const state = shift();
  commandBuyStation(state, 2);
  const boat = commandBuyVehicle(state, 'fireboat');
  const inland = state.buildings.find((b) => b.id === 'b5');
  assert.equal(boatCanReach(state, boat, (inland.x + 1) * TILE, (inland.y + 1) * TILE, 2), false, 'an inland building is in reach');
  const near = riversideBuilding(state);
  assert.ok(near, 'no building by the river');
  assert.equal(boatCanReach(state, boat, (near.x + near.w / 2) * TILE, (near.y + near.h / 2) * TILE, 3), true);
});

test('a fireboat sails to a riverside fire and puts it out', () => {
  const state = shift();
  commandBuyStation(state, 2);
  const boat = commandBuyVehicle(state, 'fireboat');
  const target = riversideBuilding(state);
  ignite(state, target, 'test');
  target.occupants = 0;
  selectUnit(state, boat.id);
  assert.equal(commandDispatch(state, target.id), true, 'the fireboat refused the job');
  assert.ok(boat.path.length > 0);
  let seconds = 0;
  while (target.state === 'burning' && seconds < 400) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.notEqual(target.state, 'burning', `still burning after ${seconds.toFixed(0)} s`);
  assert.ok(boat.water > 0.9 * boat.capacity, 'a fireboat should never run dry');
});

// ------------------------------------------------------------ air tanker ---

test('an air tanker circles a forest fire, drops water, and goes back to the sea to refill', () => {
  const state = shift();
  const plane = commandBuyVehicle(state, 'airtanker');
  const tile = state.city.forestTiles[Math.floor(state.city.forestTiles.length / 2)];
  const wf = startWildfire(state, (tile.x + 0.5) * TILE, (tile.y + 0.5) * TILE, 2200);
  const start = wf.intensity;
  assert.equal(commandDispatchWildfire(state, wf.id), true);
  assert.equal(state.selected.id, plane.id, 'the plane was not chosen for a forest fire');
  assert.ok(plane.mission);

  let minWater = plane.capacity;
  let refilled = false;
  for (let i = 0; i < 30 * 200; i++) {
    update(state, 1 / 30);
    minWater = Math.min(minWater, plane.water);
    if (minWater < plane.capacity * 0.5 && plane.water > minWater + 1000) refilled = true;
    if (!state.wildfires.includes(wf)) break;
  }
  assert.ok(minWater < plane.capacity, 'the plane dropped no water');
  assert.ok(wf.intensity < start || !state.wildfires.includes(wf), 'the fire was not touched');
  assert.ok(refilled || !state.wildfires.includes(wf), 'the plane never went back to refill');
});

test('with its target out, an air tanker returns to its bay and lands', () => {
  const state = shift();
  const plane = commandBuyVehicle(state, 'airtanker');
  const target = state.buildings.find((b) => b.type !== 'station' && b.type !== 'hospital' && Math.hypot(b.x - 54, b.y - 47) > 40);
  ignite(state, target, 'test');
  selectUnit(state, plane.id);
  commandDispatch(state, target.id);
  for (let i = 0; i < 30 * 5; i++) update(state, 1 / 30);
  target.state = 'out';
  target.fire = 0;
  for (let i = 0; i < 30 * 120 && plane.status !== 'in quarters'; i++) update(state, 1 / 30);
  assert.equal(plane.mission, null);
  assert.equal(plane.status, 'in quarters');
});

// --------------------------------------------------------- medical family ---

test('a paramedic car is small and quick; an ambulance bus carries eight', () => {
  const state = shift();
  const car = commandBuyVehicle(state, 'medcar');
  const bus = commandBuyVehicle(state, 'ambubus');
  assert.equal(state.crew.filter((c) => c.engineId === car.id).length, 1);
  assert.equal(state.crew.filter((c) => c.engineId === bus.id).length, 4);
  assert.ok(car.spec.speed > CONFIG.vehicles.ambulance.speed);
  assert.equal(car.spec.carry, 1);
  assert.equal(bus.spec.carry, 8);
  assert.equal(bus.spec.kits, 16);

  const station = state.city.stations[0].building;
  // A full bus hands over eight patients at the base hospital and is paid for each.
  for (let i = 0; i < 8; i++) bus.cargo.push({ name: 'Test', severity: 0.9 });
  const credits = state.credits;
  const hospital = nearestHospital(state, bus.x, bus.y);
  assert.equal(unloadCargo(state, bus, hospital), 8);
  assert.equal(state.credits, credits + 8 * CONFIG.medical.transportFee);
  assert.ok(station);
});

test('when the work is done an ambulance drives back to the base hospital by itself', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const station = state.city.station;
  const near = state.buildings
    .filter((b) => b.type !== 'station' && b.type !== 'hospital' && b.type !== 'warehouse' && Math.hypot(b.x - station.x, b.y - station.y) > 18)
    .sort((a, b) => Math.hypot(a.x - station.x, a.y - station.y) - Math.hypot(b.x - station.x, b.y - station.y))[0];
  const patient = spawnPatient(state, near, 0.3);
  selectUnit(state, ambulance.id);
  assert.equal(commandDispatchPatient(state, patient.id), true);
  let away = false;
  let seconds = 0;
  while (seconds < 240) {
    update(state, 1 / 30);
    seconds += 1 / 30;
    if (patient.treated && ambulance.status !== 'in quarters') away = true;
    if (away && ambulance.status === 'in quarters' && ambulance.path.length === 0) break;
  }
  assert.equal(patient.treated, true);
  assert.equal(ambulance.status, 'in quarters', `still ${ambulance.status} after ${seconds.toFixed(0)} s`);
  assert.ok(state.events.some((e) => /returning to the base hospital/.test(e.text)), 'no return order was logged');
});

test('an ambulance told to wait somewhere is not called home unless it has worked', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  ambulance.x += 40 * TILE;
  ambulance.status = 'standing by';
  ambulance.worked = false;
  for (let i = 0; i < 30 * 8; i++) update(state, 1 / 30);
  assert.equal(ambulance.path.length, 0, 'an idle ambulance drove off by itself');
});

// ----------------------------------------------------------- fire escalation ---

test('a fire nobody fights gets worse: it spreads more and is flagged out of control', () => {
  const state = shift();
  const b = state.buildings.find((x) => x.type !== 'station' && x.type !== 'hospital' && x.state === 'ok');
  b.integrity = b.maxIntegrity = 1e9;
  b.occupants = 0;
  ignite(state, b, 'test');
  assert.equal(unattendedFactor(b), 1);
  for (let i = 0; i < 30 * 80; i++) {
    b.fire = Math.max(b.fire, 0.7);
    update(state, 1 / 30);
  }
  assert.ok(b.dryTime > 70, `only ${b.dryTime} s dry`);
  assert.ok(unattendedFactor(b) > 2, `factor ${unattendedFactor(b)}`);
  assert.equal(b.runaway, true);
  assert.ok(state.events.some((e) => /out of control/.test(e.text)));
});

test('water on a fire resets how long it has been unattended', () => {
  const state = shift();
  const b = state.buildings.find((x) => x.type !== 'station' && x.type !== 'hospital' && x.state === 'ok');
  b.integrity = b.maxIntegrity = 1e9;
  ignite(state, b, 'test');
  b.dryTime = 60;
  for (let i = 0; i < 30 * 40; i++) {
    state.streams = [{ targetId: b.id, power: 0.001 }];
    b.fire = Math.max(b.fire, 0.5);
    updateFire(state, 1 / 30);
  }
  assert.ok(b.dryTime < 10, `still ${b.dryTime} s dry`);
});

// ------------------------------------------------------------------- UI ---

test('the unit list groups vehicles by what they do', () => {
  const state = shift();
  const kinds = {
    engine: 'fire', ambulance: 'medical', ambubus: 'medical', medcar: 'medical',
    helicopter: 'air', airtanker: 'air', rescue: 'fire', rescueboat: 'water', fireboat: 'water',
  };
  commandBuyStation(state, 2);
  for (const [type, group] of Object.entries(kinds)) {
    const engine = state.engines.find((e) => e.type === type) ?? commandBuyVehicle(state, type);
    assert.ok(engine, `could not buy ${type}`);
    assert.equal(categoryOf(engine), group, type);
  }
});
