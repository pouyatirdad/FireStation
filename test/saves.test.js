import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, serialize, loadState } from '../src/systems/game.js';
import {
  KEYS, SHIFT_VERSION, hasSlot, loadResults, migrateShift, normalizeShift, readSlot, recordResult,
  writeSlot, loadScenarioLibrary, storeScenarioLibrary,
} from '../src/systems/saves.js';
import { createCareer, careerSlotData, loadCareerSlot, nextCareerShift } from '../src/systems/modes.js';
import { newScenarioTemplate } from '../src/data/scenarios.js';

function memory(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function legacyShift() {
  const state = createGame(7);
  startShift(state);
  for (let i = 0; i < 600; i++) update(state, 1 / 60);
  const data = serialize(state);
  // What version 16 wrote: none of the later fields.
  const old = { ...data, version: 16 };
  for (const k of ['mode', 'rules', 'weather', 'presets', 'report', 'support', 'evac', 'disaster', 'scenario', 'shiftDue', 'incidentPace', 'buildingExtras']) delete old[k];
  return old;
}

test('a version 16 Quick Response save migrates and loads', () => {
  const old = legacyShift();
  const m = migrateShift(old);
  assert.equal(m.ok, true);
  assert.equal(m.from, 16);
  assert.equal(m.data.version, SHIFT_VERSION);
  const state = loadState(m.data);
  assert.equal(state.mode, 'quick');
  assert.ok(state.presets.length > 0, 'default presets');
  assert.ok(state.report, 'a report tracker');
  assert.equal(state.credits, old.credits);
  assert.equal(state.engines.length, old.engines.length);
});

test('a bare legacy save in the slot loads, and its first overwrite keeps a backup', () => {
  const old = legacyShift();
  const storage = memory({ [KEYS.quick]: JSON.stringify(old) });
  const slot = readSlot(storage, KEYS.quick);
  assert.equal(slot.status, 'migrated');
  assert.equal(slot.kind, 'quick');

  const state = loadState(slot.shift);
  const w = writeSlot(storage, KEYS.quick, { kind: 'quick', shift: serialize(state) });
  assert.equal(w.ok, true);
  assert.equal(storage.getItem(KEYS.quick + '.bak'), JSON.stringify(old), 'the old save is kept');
  assert.equal(readSlot(storage, KEYS.quick).status, 'ok');
});

test('a save from a newer game is never read down or overwritten', () => {
  const future = JSON.stringify({ format: 99, kind: 'quick', shift: { version: 99 } });
  const storage = memory({ [KEYS.quick]: future });
  assert.equal(readSlot(storage, KEYS.quick).status, 'newer');
  const state = createGame(7);
  const w = writeSlot(storage, KEYS.quick, { kind: 'quick', shift: serialize(state) });
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'newer');
  assert.equal(storage.getItem(KEYS.quick), future);
});

test('a corrupt save is reported and a copy kept, never deleted', () => {
  const storage = memory({ [KEYS.career]: '{"format":2,"kind":"career",' });
  const slot = readSlot(storage, KEYS.career);
  assert.equal(slot.status, 'corrupt');
  assert.equal(storage.getItem(KEYS.career + '.corrupt'), '{"format":2,"kind":"career",');
  assert.equal(storage.getItem(KEYS.career), '{"format":2,"kind":"career",');
});

test('damaged fields get safe defaults instead of failing the load', () => {
  const old = legacyShift();
  old.credits = 'lots';
  old.patients = 'nope';
  old.rating = 9999;
  delete old.clock;
  const n = normalizeShift(migrateShift(old).data);
  assert.equal(n.ok, true);
  assert.ok(Number.isFinite(n.data.credits));
  assert.deepEqual(n.data.patients, []);
  assert.equal(n.data.rating, 100);
  assert.ok(Number.isFinite(n.data.clock));
  assert.ok(n.errors.some((e) => e.includes('patients')));
  assert.doesNotThrow(() => loadState(n.data));

  const noFleet = { ...legacyShift(), engines: [] };
  assert.equal(normalizeShift(noFleet).ok, false);
  assert.equal(migrateShift({ nothing: true }).ok, false);
  assert.equal(migrateShift({ version: 3 }).ok, false);
});

test('a career saves and loads with its people, seats and progress', () => {
  const state = createCareer({ name: 'Round trip' });
  startShift(state);
  state.incidentsEnabled = false;
  for (let i = 0; i < 600; i++) update(state, 1 / 60);
  state.campaign.reputation = 41;
  state.campaign.personnel[0].skills.rescue = 6;

  const storage = memory();
  assert.equal(writeSlot(storage, KEYS.career, careerSlotData(state)).ok, true);
  const slot = readSlot(storage, KEYS.career);
  assert.equal(slot.status, 'ok');
  assert.equal(slot.kind, 'career');

  const loaded = loadCareerSlot(slot);
  assert.equal(loaded.mode, 'career');
  assert.equal(loaded.campaign.name, 'Round trip');
  assert.equal(loaded.campaign.reputation, 41);
  assert.equal(loaded.campaign.personnel.length, state.campaign.personnel.length);
  assert.equal(loaded.campaign.personnel[0].skills.rescue, 6);
  assert.equal(loaded.credits, state.credits);
  // Every crew unit still has its person and the person knows the seat.
  for (const crew of loaded.crew) {
    const person = loaded.campaign.personnel.find((p) => p.id === crew.personId);
    assert.ok(person, 'crew without a person');
    assert.equal(person.vehicleId, crew.engineId);
  }
  assert.equal(loaded.crew.length, state.crew.length);
});

test('a damaged person record in a career is repaired on load', () => {
  const state = createCareer({ name: 'Damaged' });
  const data = careerSlotData(state);
  data.campaign.personnel[0].skills = { firefighting: 'x', rescue: 99 };
  data.campaign.personnel[1].fatigue = 7;
  data.campaign.level = 42;
  const storage = memory();
  writeSlot(storage, KEYS.career, data);
  const loaded = loadCareerSlot(readSlot(storage, KEYS.career));
  const p = loaded.campaign.personnel[0];
  assert.equal(p.skills.firefighting, 1);
  assert.equal(p.skills.rescue, 10);
  assert.equal(loaded.campaign.personnel[1].fatigue, 1);
  assert.equal(loaded.campaign.level, 6);
});

test('quick, career and challenge slots are independent', () => {
  const storage = memory();
  const quick = createGame(7);
  writeSlot(storage, KEYS.quick, { kind: 'quick', shift: serialize(quick) });
  const career = createCareer({ name: 'Mine' });
  writeSlot(storage, KEYS.career, careerSlotData(career));
  assert.equal(hasSlot(storage, KEYS.quick), true);
  assert.equal(hasSlot(storage, KEYS.career), true);
  assert.equal(hasSlot(storage, KEYS.challenge), false);
  recordResult(storage, 'night', { status: 'won', score: 1500 });
  const career2 = readSlot(storage, KEYS.career);
  assert.equal(career2.campaign.name, 'Mine', 'a challenge result did not touch the career');
});

test('challenge results keep the best score; custom scenarios survive a bad entry', () => {
  const storage = memory();
  assert.deepEqual(loadResults(storage), {});
  recordResult(storage, 'night', { status: 'won', score: 1500 });
  const second = recordResult(storage, 'night', { status: 'won', score: 900 });
  assert.equal(second.isBest, false);
  assert.equal(loadResults(storage).night.score, 1500);
  assert.equal(loadResults(storage).night.plays, 2);
  recordResult(storage, 'night', { status: 'lost', score: 9999 });
  assert.equal(loadResults(storage).night.score, 1500, 'a loss does not count as a best');

  const good = { ...newScenarioTemplate(), id: 'custom-1' };
  storeScenarioLibrary(storage, [good, { name: '', start: {} }, 'junk']);
  const lib = loadScenarioLibrary(storage);
  assert.equal(lib.length, 1);
  assert.equal(lib[0].id, 'custom-1');
});

test('a finished career shift can be saved only after the next shift exists', () => {
  const state = createCareer({ name: 'Two shifts' });
  startShift(state);
  state.time = 600;
  const r = nextCareerShift(state);
  assert.ok(r.summary.report.rating.grade);
  assert.equal(r.state.campaign.shifts, 1);
  assert.equal(r.state.time, 0);
  const storage = memory();
  assert.equal(writeSlot(storage, KEYS.career, careerSlotData(r.state)).ok, true);
  const loaded = loadCareerSlot(readSlot(storage, KEYS.career));
  assert.equal(loaded.campaign.shifts, 1);
});
