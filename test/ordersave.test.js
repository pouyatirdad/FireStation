import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatch, commandDispatchAll, serialize, loadState,
} from '../src/systems/game.js';
import { createCareer, careerSlotData, loadCareerSlot } from '../src/systems/modes.js';
import { KEYS, readSlot, writeSlot } from '../src/systems/saves.js';
import { ignite } from '../src/systems/fire.js';
import { spawnPatient } from '../src/systems/medical.js';
import { startWildfire } from '../src/systems/wildfire.js';
import { applyPreset } from '../src/systems/presets.js';
import { TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 99999;
  return state;
}

/** Save to JSON text and load again, as a browser refresh would. */
const reload = (state) => loadState(JSON.parse(JSON.stringify(serialize(state))));

const house = (state, min = 28, max = 50) => {
  const st = state.city.station;
  return state.buildings.find((b) => b.type === 'house' && b.state === 'ok'
    && Math.hypot(b.x - st.x, b.y - st.y) > min && Math.hypot(b.x - st.x, b.y - st.y) < max);
};

const memory = () => {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

test('a vehicle driving to a fire keeps its route through a save and load, and arrives', () => {
  const state = shift();
  const b = house(state);
  ignite(state, b, 'test');
  commandDispatch(state, b.id);
  for (let i = 0; i < 60 * 2; i++) update(state, 1 / 60);
  const engine = state.engines[0];
  assert.ok(engine.path.length > 0, 'still driving when saved');

  const loaded = reload(state);
  const e2 = loaded.engines[0];
  assert.equal(e2.path.length, engine.path.length);
  assert.deepEqual(e2.path.map((p) => [Math.round(p.x), Math.round(p.y)]), engine.path.map((p) => [Math.round(p.x), Math.round(p.y)]));
  assert.equal(e2.targetId, b.id);
  assert.equal(e2.arrived, false);
  assert.deepEqual(e2.goal, engine.goal);
  assert.equal(e2.status, engine.status);

  const start = [e2.x, e2.y];
  for (let i = 0; i < 60 * 12; i++) update(loaded, 1 / 60);
  assert.ok(Math.hypot(e2.x - start[0], e2.y - start[1]) > 100, 'it kept driving');
  for (let i = 0; i < 60 * 120 && loaded.buildings.find((x) => x.id === b.id).state === 'burning'; i++) update(loaded, 1 / 60);
  assert.notEqual(loaded.buildings.find((x) => x.id === b.id).state, 'burning', 'and the fire was put out');
  assert.ok(loaded.stats.saved >= 1);
});

test('an engine already on scene stays on scene: the crew keep working and nobody is re-sent', () => {
  const state = shift();
  const b = house(state, 18, 30);
  ignite(state, b, 'test');
  b.fire = 0.9; // a fire that takes a while
  commandDispatch(state, b.id);
  for (let i = 0; i < 60 * 40 && !state.crew.some((c) => !c.riding); i++) update(state, 1 / 60);
  const engine = state.engines[0];
  assert.equal(engine.arrived, true);
  const out = state.crew.filter((c) => !c.riding).length;
  assert.ok(out > 0);

  const loaded = reload(state);
  assert.equal(loaded.engines[0].arrived, true);
  assert.equal(loaded.crew.filter((c) => !c.riding).length, out, 'the same crew are out');
  assert.equal(loaded.engines[0].path.length, 0);
  for (let i = 0; i < 60 * 150 && loaded.buildings.find((x) => x.id === b.id).state === 'burning'; i++) update(loaded, 1 / 60);
  assert.notEqual(loaded.buildings.find((x) => x.id === b.id).state, 'burning');
});

test('an ambulance on its way to a patient keeps both the route and the claim', () => {
  const state = shift();
  commandBuyVehicle(state, 'ambulance');
  const b = house(state);
  const patient = spawnPatient(state, b, 0.6);
  state.selected = { kind: 'patient', id: patient.id };
  commandDispatch(state);
  for (let i = 0; i < 60; i++) update(state, 1 / 60);
  const amb = state.engines.find((e) => e.type === 'ambulance');
  assert.equal(amb.patientId, patient.id);
  assert.ok(amb.path.length > 0);
  assert.equal(state.patients[0].claimedBy, amb.id);

  const loaded = reload(state);
  const a2 = loaded.engines.find((e) => e.type === 'ambulance');
  assert.equal(a2.patientId, patient.id);
  assert.equal(a2.path.length, amb.path.length);
  assert.equal(loaded.patients[0].claimedBy, amb.id, 'the claim survived');
  for (let i = 0; i < 60 * 120 && !loaded.patients.every((p) => p.treated) && loaded.patients.length > 0; i++) update(loaded, 1 / 60);
  assert.ok((loaded.stats.treated ?? 0) >= 1, 'the patient was treated');
});

test('a vehicle standing by at a preset incident keeps standing by', () => {
  const state = shift();
  commandBuyVehicle(state, 'ambulance');
  const b = house(state);
  ignite(state, b, 'test');
  applyPreset(state, state.presets[0].id, { kind: 'building', id: b.id });
  for (let i = 0; i < 60 * 2; i++) update(state, 1 / 60);
  const loaded = reload(state);
  const amb = loaded.engines.find((e) => e.type === 'ambulance');
  assert.deepEqual(amb.standbyFor, { kind: 'building', id: b.id });
  assert.ok(amb.path.length > 0);
});

test('aircraft keep their mission: an air tanker keeps circling a forest fire after a load', () => {
  const state = shift();
  const plane = commandBuyVehicle(state, 'airtanker');
  const wf = startWildfire(state, 80 * TILE, 70 * TILE, 1500);
  state.selected = { kind: 'wildfire', id: wf.id };
  state.selected = { kind: 'unit', id: plane.id };
  commandDispatch(state);
  state.selected = { kind: 'wildfire', id: wf.id };
  commandDispatch(state);
  for (let i = 0; i < 60 * 5; i++) update(state, 1 / 60);
  assert.ok(plane.mission, 'on a mission');

  const loaded = reload(state);
  const p2 = loaded.engines.find((e) => e.type === 'airtanker');
  assert.ok(p2.mission);
  assert.equal(p2.mission.wid, plane.mission.wid);
  assert.equal(p2.mission.mode, plane.mission.mode);
  const before = loaded.wildfires[0].intensity;
  for (let i = 0; i < 60 * 90; i++) update(loaded, 1 / 60);
  assert.ok(loaded.wildfires.length === 0 || loaded.wildfires[0].intensity < before, 'it kept dropping water');
});

test('a whole response survives: several vehicles, several fires, save, load, finish', () => {
  const state = shift();
  for (const t of ['engine', 'engine', 'ladder', 'ambulance']) commandBuyVehicle(state, t);
  const st = state.city.station;
  const fires = state.buildings.filter((b) => b.type === 'house' && Math.hypot(b.x - st.x, b.y - st.y) > 18 && Math.hypot(b.x - st.x, b.y - st.y) < 45).slice(0, 3);
  for (const b of fires) ignite(state, b, 'test');
  commandDispatchAll(state);
  for (let i = 0; i < 60 * 1.5; i++) update(state, 1 / 60);
  const moving = state.engines.filter((e) => e.path.length > 0).length;
  assert.ok(moving >= 2);

  const loaded = reload(state);
  assert.equal(loaded.engines.filter((e) => e.path.length > 0).length, moving);
  for (let i = 0; i < 60 * 200; i++) {
    update(loaded, 1 / 60);
    if (i % 300 === 0) commandDispatchAll(loaded);
  }
  assert.ok(fires.every((b) => loaded.buildings.find((x) => x.id === b.id).state !== 'burning'));
});

test('saves written before routes were kept still load, with vehicles at rest as before', () => {
  const state = shift();
  const b = house(state);
  ignite(state, b, 'test');
  commandDispatch(state, b.id);
  for (let i = 0; i < 60 * 2; i++) update(state, 1 / 60);
  const data = JSON.parse(JSON.stringify(serialize(state)));
  for (const e of data.engines) for (const k of ['path', 'goal', 'arrived', 'packTimer', 'wildfireId', 'blockadeId', 'victimId', 'patientId', 'standbyFor', 'mission', 'status']) delete e[k];
  for (const p of data.patients) { delete p.claimedBy; delete p.medicId; }
  const loaded = loadState(data);
  assert.equal(loaded.engines[0].path.length, 0);
  assert.equal(loaded.engines[0].targetId, b.id);
  assert.equal(loaded.engines[0].status, 'in quarters');
  assert.doesNotThrow(() => { for (let i = 0; i < 60 * 30; i++) update(loaded, 1 / 60); });
});

test('damaged order data is cleaned, never trusted', () => {
  const state = shift();
  const data = JSON.parse(JSON.stringify(serialize(state)));
  Object.assign(data.engines[0], {
    path: [{ x: 'a', y: 1 }, null, { x: NaN, y: 2 }, { x: 100, y: 100 }, 5],
    goal: { x: 1.5, y: 'z' },
    arrived: 'yes',
    packTimer: 9999,
    wildfireId: { evil: true },
    blockadeId: 12,
    victimId: 'v'.repeat(500),
    patientId: '',
    standbyFor: { kind: 4, id: 'x' },
    mission: { x: 'q', y: 3, mode: 'dance' },
    status: 'x'.repeat(200),
  });
  const loaded = loadState(data);
  const e = loaded.engines[0];
  assert.deepEqual(e.path, [{ x: 100, y: 100 }], 'only the valid point is kept');
  assert.equal(e.goal, null);
  assert.ok(e.packTimer <= 10);
  assert.equal(e.wildfireId, null);
  assert.equal(e.blockadeId, null);
  assert.equal(e.victimId, null);
  assert.equal(e.patientId, null);
  assert.equal(e.standbyFor, null);
  assert.equal(e.mission, null);
  assert.equal(e.status, 'in quarters');
  assert.doesNotThrow(() => { for (let i = 0; i < 120; i++) update(loaded, 1 / 60); });
});

test('a career refresh mid-response keeps the vehicle driving', () => {
  const state = createCareer({ name: 'Orders' });
  startShift(state);
  state.incidentsEnabled = false;
  const b = house(state);
  ignite(state, b, 'test');
  commandDispatch(state, b.id);
  for (let i = 0; i < 60 * 2; i++) update(state, 1 / 60);
  assert.ok(state.engines[0].path.length > 0);

  const storage = memory();
  assert.equal(writeSlot(storage, KEYS.career, careerSlotData(state)).ok, true);
  const loaded = loadCareerSlot(readSlot(storage, KEYS.career));
  const e = loaded.engines[0];
  assert.equal(e.path.length, state.engines[0].path.length);
  assert.equal(e.targetId, b.id);
  assert.ok(e.crewIds.length === 3 && loaded.crew.filter((c) => c.engineId === e.id).every((c) => c.personId));
  for (let i = 0; i < 60 * 150 && loaded.buildings.find((x) => x.id === b.id).state === 'burning'; i++) update(loaded, 1 / 60);
  assert.notEqual(loaded.buildings.find((x) => x.id === b.id).state, 'burning');
});
