import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, serialize, loadState, commandBuyVehicle, commandDispatchAll } from '../src/systems/game.js';
import { createCareer, careerSlotData, loadCareerSlot, nextCareerShift } from '../src/systems/modes.js';
import { ignite } from '../src/systems/fire.js';
import { spawnPatient } from '../src/systems/medical.js';
import { startTraining } from '../src/systems/personnel.js';
import {
  KEYS, archiveSlot, listBackups, readSlot, restoreBackup, writeSlot, inspectRaw,
} from '../src/systems/saves.js';

function memory(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function legacy() {
  const state = createGame(7);
  startShift(state);
  for (let i = 0; i < 300; i++) update(state, 1 / 60);
  const old = { ...serialize(state), version: 16 };
  for (const k of ['mode', 'rules', 'weather', 'presets', 'report', 'support', 'evac', 'disaster', 'scenario', 'shiftDue', 'incidentPace', 'buildingExtras']) delete old[k];
  return JSON.stringify(old);
}

test('a refresh during gameplay: a busy shift saves, reloads and keeps playing', () => {
  const state = createGame(7);
  startShift(state);
  state.credits = 90000;
  commandBuyVehicle(state, 'ladder');
  commandBuyVehicle(state, 'ambulance');
  const st = state.city.station;
  const fires = state.buildings.filter((b) => b.type === 'house' && Math.hypot(b.x - st.x, b.y - st.y) > 15 && Math.hypot(b.x - st.x, b.y - st.y) < 40).slice(0, 3);
  for (const b of fires) ignite(state, b, 'test');
  spawnPatient(state, fires[0], 0.8);
  commandDispatchAll(state);
  for (let i = 0; i < 60 * 20; i++) update(state, 1 / 60);

  const storage = memory();
  assert.equal(writeSlot(storage, KEYS.quick, { kind: 'quick', shift: serialize(state) }).ok, true);
  const loaded = loadState(readSlot(storage, KEYS.quick).shift);
  assert.equal(loaded.time, state.time);
  assert.equal(loaded.credits, state.credits);
  assert.equal(loaded.engines.length, state.engines.length);
  assert.equal(loaded.patients.length, state.patients.length);
  assert.equal(loaded.buildings.filter((b) => b.state === 'burning').length, state.buildings.filter((b) => b.state === 'burning').length);
  assert.deepEqual(loaded.engines.map((e) => [e.id, Math.round(e.x), Math.round(e.y)]), state.engines.map((e) => [e.id, Math.round(e.x), Math.round(e.y)]));
  assert.doesNotThrow(() => { for (let i = 0; i < 60 * 30; i++) update(loaded, 1 / 60); });
  assert.ok(loaded.time > state.time + 29);
});

test('a refresh during a career keeps training, injuries, upgrades and the report', () => {
  const state = createCareer({ name: 'Refresh' });
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 50000;
  state.campaign.level = 2;
  const person = state.campaign.personnel[0];
  startTraining(state, person.id, 'rescue');
  state.campaign.stations[0] = { level: 2, upgrades: { storage: 1 }, budget: 5000, spentMonth: 1200 };
  const b = state.buildings.find((x) => x.type === 'house' && x.state === 'ok');
  ignite(state, b, 'test');
  for (let i = 0; i < 60 * 10; i++) update(state, 1 / 60);

  const storage = memory();
  writeSlot(storage, KEYS.career, careerSlotData(state));
  const slot = readSlot(storage, KEYS.career);
  assert.equal(slot.status, 'ok');
  const loaded = loadCareerSlot(slot);
  const p = loaded.campaign.personnel.find((x) => x.id === person.id);
  assert.equal(p.status, 'training');
  assert.equal(Math.round(p.training.until), Math.round(person.training.until));
  assert.equal(loaded.campaign.stations[0].budget, 5000);
  assert.equal(loaded.campaign.stations[0].spentMonth, 1200);
  assert.equal(Object.keys(loaded.report.open).length, Object.keys(state.report.open).length);
  assert.doesNotThrow(() => { for (let i = 0; i < 60 * 20; i++) update(loaded, 1 / 60); });
});

test('corrupt saves of every kind are reported, kept and never thrown at the player', () => {
  const cases = {
    truncated: '{"format":2,"kind":"career",',
    notAnObject: '12345',
    nullValue: 'null',
    emptyShift: JSON.stringify({ format: 2, kind: 'quick', shift: {} }),
    noFleet: JSON.stringify({ format: 2, kind: 'quick', shift: { version: 17, seed: 7, engines: [] } }),
    badVehicleTypes: JSON.stringify({ format: 2, kind: 'quick', shift: { version: 17, seed: 7, engines: [{ id: 'x', type: 'dragon' }] } }),
    tooOld: JSON.stringify({ version: 3, engines: [{ id: 'e', type: 'engine' }] }),
    careerWithoutCampaign: JSON.stringify({ format: 2, kind: 'career', shift: JSON.parse(legacy()) && { ...JSON.parse(legacy()), version: 17 } }),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const storage = memory({ [KEYS.career]: raw });
    let slot;
    assert.doesNotThrow(() => { slot = readSlot(storage, KEYS.career); }, name);
    assert.equal(slot.status, 'corrupt', name);
    assert.ok(slot.error, name);
    assert.equal(storage.getItem(KEYS.career), raw, `${name}: the slot was not touched`);
    assert.equal(storage.getItem(KEYS.career + '.corrupt'), raw, `${name}: a copy was kept`);
  }
});

test('newer saves of either kind are left alone', () => {
  const futureShift = JSON.stringify({ format: 2, kind: 'quick', shift: { version: 99, seed: 7, engines: [] } });
  const futureEnvelope = JSON.stringify({ format: 7, kind: 'quick', shift: {} });
  const state = createCareer({ name: 'x' });
  const futureCampaign = JSON.parse(JSON.stringify({ format: 2, kind: 'career', ...careerSlotData(state) }));
  futureCampaign.campaign.version = 50;
  const raws = [futureShift, futureEnvelope, JSON.stringify(futureCampaign)];
  for (const raw of raws) {
    const storage = memory({ [KEYS.career]: raw });
    assert.equal(readSlot(storage, KEYS.career).status, 'newer');
    const w = writeSlot(storage, KEYS.career, careerSlotData(state));
    assert.equal(w.ok, false);
    assert.equal(storage.getItem(KEYS.career), raw, 'never overwritten');
  }
});

test('blocked storage is reported, not thrown', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readSlot(blocked, KEYS.quick).status, 'error');
  const w = writeSlot(blocked, KEYS.quick, { kind: 'quick', shift: serialize(createGame(7)) });
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'storage');
  assert.deepEqual(listBackups(blocked), []);
  assert.equal(archiveSlot(blocked, KEYS.quick), false);
});

test('backups are listed, can be restored, and restoring never loses the current save', () => {
  const raw = legacy();
  const storage = memory({ [KEYS.quick]: raw });
  // Loading and re-saving upgrades the old save and leaves a .bak.
  const slot = readSlot(storage, KEYS.quick);
  assert.equal(slot.status, 'migrated');
  writeSlot(storage, KEYS.quick, { kind: 'quick', shift: loadStateToData(slot.shift) });
  assert.equal(storage.getItem(KEYS.quick + '.bak'), raw);

  // A career that was replaced by a new one, and an unreadable save.
  const career = createCareer({ name: 'Old career' });
  writeSlot(storage, KEYS.career, careerSlotData(career));
  archiveSlot(storage, KEYS.career, '.prev');
  const newer = createCareer({ name: 'New career' });
  writeSlot(storage, KEYS.career, careerSlotData(newer));
  storage.setItem(KEYS.challenge + '.corrupt', '{nope');

  const list = listBackups(storage);
  const byKey = Object.fromEntries(list.map((b) => [b.key, b]));
  assert.equal(byKey[KEYS.quick + '.bak'].loadable, true);
  assert.equal(byKey[KEYS.career + '.prev'].loadable, true);
  assert.equal(byKey[KEYS.challenge + '.corrupt'].loadable, false);
  assert.match(byKey[KEYS.challenge + '.corrupt'].error, /read/);

  // Restore the old career: the new one is kept under .replaced and the backup stays.
  const current = storage.getItem(KEYS.career);
  assert.deepEqual(restoreBackup(storage, KEYS.career + '.prev'), { ok: true, slot: 'career' });
  assert.equal(readSlot(storage, KEYS.career).campaign.name, 'Old career');
  assert.equal(storage.getItem(KEYS.career + '.replaced'), current);
  assert.ok(storage.getItem(KEYS.career + '.prev'), 'the backup is still there');
  assert.equal(readSlot(storage, KEYS.career + '.replaced').campaign.name, 'New career');

  // Restoring the .bak brings back the pre-upgrade Quick Response save and it still loads.
  assert.equal(restoreBackup(storage, KEYS.quick + '.bak').ok, true);
  assert.equal(readSlot(storage, KEYS.quick).status, 'migrated');

  // Unloadable or unknown backups are refused and nothing changes.
  const before = [...storage.map.entries()].join('|');
  assert.equal(restoreBackup(storage, KEYS.challenge + '.corrupt').ok, false);
  assert.equal(restoreBackup(storage, 'firestation.nothing').ok, false);
  assert.equal([...storage.map.entries()].join('|'), before);
});

function loadStateToData(shift) {
  return serialize(loadState(shift));
}

test('inspectRaw reports the same verdicts without touching storage', () => {
  assert.equal(inspectRaw(legacy()).status, 'migrated');
  assert.equal(inspectRaw('{').status, 'corrupt');
  assert.equal(inspectRaw(JSON.stringify({ format: 2, kind: 'quick', shift: serialize(createGame(7)) })).status, 'ok');
});

test('a Quick Response save and a career can both be restored independently', () => {
  const storage = memory();
  const q = createGame(7);
  writeSlot(storage, KEYS.quick, { kind: 'quick', shift: serialize(q) });
  archiveSlot(storage, KEYS.quick, '.replaced');
  const c = createCareer({ name: 'Both' });
  writeSlot(storage, KEYS.career, careerSlotData(c));
  archiveSlot(storage, KEYS.career, '.replaced');
  const slots = listBackups(storage).map((b) => b.slot).sort();
  assert.deepEqual(slots, ['career', 'quick']);
});

test('every career shift has its own calls and wind; a loaded shift does not replay its start', () => {
  const first = createCareer({ name: 'Seeds' });
  startShift(first);
  first.time = 600;
  const second = nextCareerShift(first).state;
  startShift(second);
  second.time = 600;
  const third = nextCareerShift(second).state;
  startShift(third);
  assert.equal(new Set([first.rngSeed, second.rngSeed, third.rngSeed]).size, 3, 'a seed per shift');
  assert.notEqual(first.wind.dir, second.wind.dir);
  assert.notEqual(second.wind.dir, third.wind.dir);
  const callsOf = (s) => {
    for (let i = 0; i < 60 * 150; i++) update(s, 1 / 60);
    return Object.entries(s.report.open).map(([k, v]) => `${k}@${Math.round(v.startedAt)}`).join(',');
  };
  assert.notEqual(callsOf(first), callsOf(second), 'different calls in shifts one and two');
  assert.equal(first.city.buildings.length, second.city.buildings.length, 'the city is the same');

  // Saving and loading mid-shift keeps the shift's seed but not the position in the sequence.
  const loaded = loadCareerSlot({ shift: JSON.parse(JSON.stringify(serialize(third))), campaign: JSON.parse(JSON.stringify(third.campaign)) });
  assert.equal(loaded.rngSeed, third.rngSeed);
  const fresh = createGame(third.seed);
  assert.notEqual(loaded.rng.float(), fresh.rng.float());
});
