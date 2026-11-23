// Save and load correctness: idempotence, every kind of state surviving, per-game ids, and what happens to
// damaged, duplicated and unknown data.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, serialize, loadState, commandBuyVehicle, commandDispatch,
} from '../src/systems/game.js';
import { spawnPatient } from '../src/systems/medical.js';
import { drowningCall } from '../src/systems/water.js';
import { nextId } from '../src/systems/persistence.js';
import { SHIFT_VERSION } from '../src/systems/saves.js';
import { busyGame, diffJson, roundTrip } from './busy-game.js';

const games = new Map();
const game = (mode) => {
  if (!games.has(mode)) games.set(mode, busyGame(mode));
  return games.get(mode);
};
const reload = (state) => loadState(roundTrip(serialize(state)), state.campaign ? roundTrip(state.campaign) : null);
const run = (s, seconds) => { for (let i = 0; i < seconds * 60; i++) update(s, 1 / 60); };

// -------------------------------------------------------------- idempotence ---

/**
 * What a first load may change: it clears a reference to something that no longer exists (a vehicle's `goal` without
 * a route, a crew member's patient who has been taken away). Anything else that differs is a field the save lost.
 */
const CLEARED = /.(goal|[a-zA-Z]*Id|claimedBy)(.|$)|.(goal|[a-zA-Z]*Id|claimedBy): /;

for (const mode of ['quick', 'career', 'challenge']) {
  test(`idempotence (${mode}): serialize(load(serialize(state))) is the same save, and a second load changes nothing`, () => {
    const s = game(mode);
    const first = roundTrip(serialize(s));
    const campaign = s.campaign ? roundTrip(s.campaign) : null;
    const loaded = loadState(roundTrip(first), campaign);
    const again = roundTrip(serialize(loaded));
    assert.equal(first.version, SHIFT_VERSION);
    const changed = diffJson(first, again);
    const unexpected = changed.filter((d) => !CLEARED.test(d));
    assert.deepEqual(unexpected, [], 'a first load may only clear references that point at nothing');
    // after that it is a fixed point: the same save, however often it is loaded
    const third = roundTrip(serialize(loadState(roundTrip(again), campaign)));
    assert.deepEqual(diffJson(again, third), []);
  });
}

test('the save is much smaller than the 1,100 buildings it used to list', () => {
  const text = JSON.stringify(serialize(game('quick')));
  assert.ok(text.length < 60000, `a busy Quick Response save is ${text.length} characters`);
  const data = roundTrip(serialize(game('quick')));
  assert.ok(data.buildings.length < 150, `${data.buildings.length} buildings saved (only the ones that changed)`);
});

// ----------------------------------------- everything that was missing in 17 ---

test('timers, tasks, routes and the rest of an entity\'s state come back exactly', () => {
  const s = busyGame('quick', { seconds: 150 });
  const engine = s.engines[0];
  const crew = s.crew.find((c) => c.engineId === engine.id);
  const b = s.buildings.find((x) => x.type === 'house');
  const patient = s.patients[0] ?? spawnPatient(s, b, 0.8);
  const victim = s.victims[0] ?? drowningCall(s, () => true) ?? s.victims[0];
  Object.assign(engine, {
    kitAcc: 0.4, worked: true, returnIn: 1.25, hospitalRetry: 321.5, dryHome: true, emptyWarned: true, fullNotified: true,
    lowWarned: true, noHospital: true, hospitalId: s.city.hospitals[1].id,
    cargo: [{ name: 'a house', severity: 0.9 }],
  });
  Object.assign(crew, {
    riding: false, path: [{ x: 100.5, y: 200.5 }, { x: 150, y: 250 }], rescueTimer: 1.5, treatTimer: 2.25, idleFor: 3.5,
    fetch: 'hose', fetchTimer: 0.75, boarding: true, think: 0.3, contamination: 0.4, warned: true, warnedHazard: true,
    angle: 1.2, status: 'standing by', tool: 'chainsaw',
  });
  Object.assign(b, { spreadTimer: 2.5, dryTime: 33, runaway: true, ignitedAt: 12.5, state: 'burning', fire: 0.4 });
  Object.assign(patient, { leaveAt: 99.5, treatTimer: 1.75, reason: 'fall', claimedBy: engine.id });
  Object.assign(victim, { rescueTimer: 2.25, diverId: crew.id });
  const wf = s.wildfires[0];
  if (wf) wf.spreadTimer = 3.5;
  const blockade = s.blockades[0];
  if (blockade) blockade.createdAt = 17.5;

  const t = reload(s);
  const e2 = t.engines.find((e) => e.id === engine.id);
  for (const k of ['kitAcc', 'worked', 'returnIn', 'hospitalRetry', 'dryHome', 'emptyWarned', 'fullNotified', 'lowWarned', 'noHospital', 'hospitalId']) {
    assert.deepEqual(e2[k], engine[k], `engine.${k}`);
  }
  assert.deepEqual(e2.cargo, engine.cargo);
  const c2 = t.crew.find((c) => c.id === crew.id);
  for (const k of ['riding', 'path', 'rescueTimer', 'treatTimer', 'idleFor', 'fetch', 'fetchTimer', 'boarding', 'think', 'contamination', 'warned', 'warnedHazard', 'angle', 'status', 'tool']) {
    assert.deepEqual(c2[k], crew[k], `crew.${k}`);
  }
  const b2 = t.buildings.find((x) => x.id === b.id);
  for (const k of ['spreadTimer', 'dryTime', 'runaway', 'ignitedAt', 'state', 'fire']) assert.deepEqual(b2[k], b[k], `building.${k}`);
  const p2 = t.patients.find((p) => p.id === patient.id);
  for (const k of ['leaveAt', 'treatTimer', 'reason', 'claimedBy']) assert.deepEqual(p2[k], patient[k], `patient.${k}`);
  const v2 = t.victims.find((v) => v.id === victim.id);
  for (const k of ['rescueTimer', 'diverId']) assert.deepEqual(v2[k], victim[k], `victim.${k}`);
  if (wf) assert.equal(t.wildfires.find((w) => w.id === wf.id).spreadTimer, 3.5);
  if (blockade) assert.equal(t.blockades.find((x) => x.id === blockade.id).createdAt, 17.5);
});

test('a crew member who is aboard cannot be loaded with a job, whatever the save says', () => {
  const s = busyGame('quick', { seconds: 60 });
  const data = roundTrip(serialize(s));
  const entry = data.crews.find((c) => c.riding);
  Object.assign(entry, { path: [{ x: 1, y: 1 }], rescueId: 'x', fetch: 'hose', boarding: true });
  const t = loadState(data);
  const c = t.crew.find((x) => x.id === entry.id);
  assert.deepEqual([c.path.length, c.rescueId, c.fetch, c.boarding, c.status], [0, null, null, false, 'aboard']);
});

test('hospital and diving state from milestone 1 survive: destination, stretcher cases, the EMS call-out', () => {
  const s = busyGame('quick', { seconds: 150 });
  const ambulance = s.engines.find((e) => e.type === 'ambulance');
  ambulance.cargo = [{ name: 'x', severity: 0.9 }, { name: 'y', severity: 0.8 }];
  ambulance.hospitalId = s.city.hospitals[2].id;
  s.support.active.push({
    id: 'support99', agency: 'ems', x: 10, y: 10, radius: 100, calledAt: 0, arriveAt: 1, until: 2, applied: true,
    cargo: [{ name: 'z', severity: 1 }], hospitalId: s.city.hospitals[0].id, deliverAt: s.time + 50, waiting: false,
  });
  const t = reload(s);
  const a2 = t.engines.find((e) => e.id === ambulance.id);
  assert.deepEqual(a2.cargo, ambulance.cargo);
  assert.equal(a2.hospitalId, ambulance.hospitalId);
  const call = t.support.active.find((c) => c.id === 'support99');
  assert.deepEqual(call.cargo, [{ name: 'z', severity: 1 }]);
  assert.equal(call.hospitalId, s.city.hospitals[0].id);
  assert.equal(call.deliverAt, s.time + 50);
});

test('a save in the middle of an operation does not change what happens next', () => {
  const s = busyGame('quick', { seconds: 160 });
  s.incidentsEnabled = false;
  const t = reload(s);
  t.incidentsEnabled = false;
  run(s, 90);
  run(t, 90);
  for (const k of ['saved', 'lost', 'rescued', 'casualties', 'treated', 'transported']) {
    assert.equal(t.stats[k] ?? 0, s.stats[k] ?? 0, `stats.${k} after 90 s`);
  }
  assert.equal(t.patients.length, s.patients.length);
  assert.equal(t.engines.length, s.engines.length);
  assert.ok(Math.abs(t.credits - s.credits) <= 300, `credits ${t.credits} vs ${s.credits}`);
});

// ---------------------------------------------------------------------- ids ---

test('every game numbers its own entities, and ids are saved with the game', () => {
  const a = createGame(7);
  const b = createGame(7);
  assert.equal(nextId(a, 'patient'), 'patient1');
  assert.equal(nextId(a, 'patient'), 'patient2');
  assert.equal(nextId(b, 'patient'), 'patient1', 'a second game starts at 1 again');
  const data = roundTrip(serialize(a));
  assert.equal(data.ids.patient, 2);
});

test('after a load a new entity never gets an id that is already in use', () => {
  const s = busyGame('quick', { seconds: 200 });
  const t = reload(s);
  const before = new Set([...t.patients, ...t.victims, ...t.blockades, ...(t.wildfires ?? [])].map((x) => x.id));
  for (let i = 0; i < 5; i++) {
    const p = spawnPatient(t, t.buildings.find((x) => x.type === 'house'), 0.5);
    if (p) assert.ok(!before.has(p.id), `${p.id} was already taken`);
    if (p) before.add(p.id);
  }
});

test('ids are still safe when the save has no counters (an older save): they follow the highest id in use', () => {
  const s = busyGame('quick', { seconds: 200 });
  const data = roundTrip(serialize(s));
  delete data.ids;
  data.patients = [...data.patients, { ...data.patients[0], id: 'patient41' }].filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
  const t = loadState(data);
  assert.ok((t.ids.patient ?? 0) >= 41);
  assert.equal(nextId(t, 'patient'), `patient${t.ids.patient}`);
  assert.ok(!t.patients.some((p) => p.id === `patient${t.ids.patient}`));
});

// ------------------------------------------------------------------ damage ---

const quickData = () => roundTrip(serialize(busyGame('quick', { seconds: 150 })));
const survives = (data) => {
  const t = loadState(data);
  assert.doesNotThrow(() => run(t, 20));
  return t;
};

test('damaged fields are repaired, reported, and the game still runs', () => {
  const data = quickData();
  Object.assign(data.engines[0], { x: 'left', y: null, water: -50, kits: 99999, name: 12, cargo: 'many', angle: Infinity });
  Object.assign(data.crews[0], { x: NaN, riding: 'maybe', path: 'there', status: ['a'] });
  if (data.patients[0]) Object.assign(data.patients[0], { severity: 9, life: 'soon', x: undefined });
  if (data.victims[0]) Object.assign(data.victims[0], { life: -5, label: 7 });
  data.buildings[0] = { id: data.buildings[0].id, state: 'gone', fire: 'lots', integrity: -3 };
  data.stats.saved = 'many';
  data.credits = 'rich';
  data.events = [null, 5, { text: 'ok', id: 1, kind: 'info' }];
  const t = survives(data);
  assert.ok(Number.isFinite(t.engines[0].x) && Number.isFinite(t.engines[0].y) && t.engines[0].water >= 0);
  assert.ok(t.engines[0].kits <= 999);
  assert.equal(typeof t.engines[0].name, 'string');
  assert.ok(Array.isArray(t.engines[0].cargo));
  assert.ok(Number.isFinite(t.credits));
  assert.equal(typeof t.stats.saved, 'number');
  assert.ok(t.events.every((e) => e && typeof e.text === 'string'), 'only real log entries are kept');
  assert.ok(t.events.some((e) => e.text === 'ok'));
  const issues = t.loadReport.issues.join('\n');
  assert.match(issues, /engine .*\.x was damaged/);
  assert.match(issues, /stat saved was damaged/);
});

test('whole sections damaged: lists replaced by other types do not stop a load', () => {
  const data = quickData();
  data.patients = 'none';
  data.victims = { a: 1 };
  data.blockades = 7;
  data.wildfires = null;
  data.cut = 'x';
  data.support = 5;
  data.evac = [];
  data.report = 'r';
  data.presets = { not: 'a list' };
  const t = survives(data);
  assert.deepEqual([t.patients.length, t.victims.length, t.blockades.length], [0, 0, 0]);
  assert.ok(t.presets.length > 0, 'presets fall back to the defaults');
});

test('references to things that do not exist are cleared', () => {
  const data = quickData();
  Object.assign(data.engines[0], { targetId: 'nowhere', patientId: 'patient404', hospitalId: 'b9999', victimId: 'victim404' });
  const t = survives(data);
  const e = t.engines[0];
  assert.deepEqual([e.targetId, e.patientId, e.hospitalId, e.victimId], [null, null, null, null]);
  assert.match(t.loadReport.issues.join('\n'), /does not exist; cleared/);
});

test('duplicate ids are dropped (the first wins) and reported', () => {
  const data = quickData();
  const e = data.engines[0];
  data.engines.push({ ...e, x: 1, y: 1 });
  data.crews.push({ ...data.crews[0], x: 1 });
  if (data.patients[0]) data.patients.push({ ...data.patients[0], severity: 0.1 });
  const t = survives(data);
  assert.equal(t.engines.filter((x) => x.id === e.id).length, 1);
  assert.equal(t.engines.find((x) => x.id === e.id).x, e.x, 'the first entry won');
  assert.equal(new Set(t.crew.map((c) => c.id)).size, t.crew.length);
  assert.equal(new Set(t.patients.map((p) => p.id)).size, t.patients.length);
  assert.match(t.loadReport.issues.join('\n'), /duplicate id/);
});

test('crew of a vehicle that is not in the save, and buildings that are not in the city, are ignored with a note', () => {
  const data = quickData();
  data.crews.push({ ...data.crews[0], id: 'crew900', engineId: 'ghost' });
  data.buildings.push({ id: 'b-not-here', state: 'burning', fire: 1 });
  const t = survives(data);
  assert.ok(!t.crew.some((c) => c.id === 'crew900'));
  assert.match(t.loadReport.issues.join('\n'), /crew crew900 belongs to a vehicle that is not in the save/);
  assert.match(t.loadReport.issues.join('\n'), /building b-not-here is not in this city/);
});

test('a blockade outside the map is dropped instead of corrupting the road network', () => {
  const data = quickData();
  data.blockades.push({ id: 'wreck77', tx: 999999, ty: 5, tw: 2, th: 1 });
  const t = survives(data);
  assert.ok(!t.blockades.some((b) => b.id === 'wreck77'));
});

test('unknown fields are not lost: on an entity, and at the top of the save', () => {
  const data = quickData();
  data.engines[0].fromTheFuture = { hello: 1 };
  data.mysterySection = [1, 2, 3];
  const t = survives(data);
  assert.deepEqual(t.engines[0].extra, { fromTheFuture: { hello: 1 } });
  assert.match(t.loadReport.issues.join('\n'), /unknown fields: fromTheFuture/);
  assert.match(t.loadReport.issues.join('\n'), /mysterySection/);
  const out = roundTrip(serialize(t));
  assert.deepEqual(out.engines[0].fromTheFuture, { hello: 1 });
  assert.deepEqual(out.mysterySection, [1, 2, 3]);
});

test('a save that is only a fragment still loads into a playable game', () => {
  const t = loadState({ version: 18, engines: [{ id: 'engine1', type: 'engine' }] });
  assert.equal(t.engines.length, 1);
  assert.doesNotThrow(() => run(t, 10));
  const empty = loadState({});
  assert.ok(empty.running);
});

test('a career save without its career data loads as Quick Response and says so', () => {
  const data = roundTrip(serialize(busyGame('career', { seconds: 60 })));
  const t = loadState(data, null);
  assert.equal(t.mode, 'quick');
  assert.match(t.loadReport.issues.join('\n'), /career data is missing/);
});

// -------------------------------------------------------- the old way works ---

test('a version 17 shift (every building listed, extras apart) is read by the same loaders', () => {
  const s = createGame(7);
  startShift(s);
  const b = s.buildings.find((x) => x.type === 'house');
  b.state = 'burning';
  b.fire = 0.5;
  const data = roundTrip(serialize(s));
  data.version = 17;
  data.buildings = s.buildings.map((x) => ({
    id: x.id, state: x.state, fire: x.fire, integrity: x.integrity, trapped: 0, occupants: x.occupants ?? 0, evacuated: false,
    reward: 0, incidentType: null, incidentLabel: null, neglect: 0, hazmat: false, big: false,
  }));
  data.buildingExtras = [{ id: b.id, leak: 0.7, collapse: null, utilityCut: true, evacZone: null, evacOccupants: null }];
  const t = loadState(data);
  const b2 = t.buildings.find((x) => x.id === b.id);
  assert.equal(b2.state, 'burning');
  assert.equal(b2.leak, 0.7);
  assert.equal(b2.utilityCut, true);
});

test('commands still work on a loaded game (orders, dispatch)', () => {
  const s = createGame(7);
  startShift(s);
  s.incidentsEnabled = false;
  s.credits = 50000;
  commandBuyVehicle(s, 'ambulance');
  const p = spawnPatient(s, s.buildings.find((b) => b.type === 'house' && b.state === 'ok'), 0.9);
  const t = reload(s);
  t.selected = { kind: 'patient', id: p.id };
  assert.ok(commandDispatch(t), 'an ambulance takes the order after a load');
});
