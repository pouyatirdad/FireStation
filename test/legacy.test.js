// Genuine saves from older versions (test/fixtures/legacy, see its README for how each was made) load into
// the current game with everything they held, and keep working.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadState, serialize, update } from '../src/systems/game.js';
import { KEYS, SHIFT_VERSION, inspectRaw, readSlot, writeSlot } from '../src/systems/saves.js';
import { diffJson, roundTrip } from './busy-game.js';

const dir = new URL('./fixtures/legacy/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', dir), 'utf8'));
const raw = (m) => fs.readFileSync(new URL(m.file, dir), 'utf8');
const run = (s, seconds) => { for (let i = 0; i < seconds * 60; i++) update(s, 1 / 60); };

class Store {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, v); }
  removeItem(k) { this.m.delete(k); }
}

test('the fixtures are what the manifest says they are (an old format, in the middle of an incident)', () => {
  assert.equal(manifest.length, 4);
  for (const m of manifest) {
    const v = JSON.parse(raw(m));
    const shift = v.shift ?? v;
    assert.equal(shift.version, m.shiftVersion, m.file);
    assert.ok(m.shiftVersion < SHIFT_VERSION, `${m.file} is older than the current format`);
    assert.ok(m.patients > 0 && m.cargo > 0, `${m.file} was saved with patients about`);
  }
  assert.equal(manifest[0].envelopeFormat, null, 'the 0.9 save is a bare shift');
  assert.equal(manifest[0].shiftVersion, 16);
  assert.equal(manifest.find((m) => m.generator === 'career').campaignVersion, 1);
});

for (const m of manifest) {
  test(`legacy ${m.game} ${m.generator}: loads whole, with nothing repaired, and plays on`, () => {
    const info = inspectRaw(raw(m));
    assert.equal(info.status, 'migrated', info.error);
    assert.equal(info.from, m.shiftVersion);
    const state = loadState(info.shift, info.campaign);
    assert.deepEqual(state.loadReport.issues, [], 'a genuine old save needs no repair');
    assert.equal(state.mode, m.mode);
    assert.equal(state.engines.length, m.engines);
    assert.equal(state.crew.length, m.crews);
    assert.equal(state.patients.length, m.patients);
    assert.equal(state.victims.length, m.victims);
    assert.equal(state.engines.reduce((n, e) => n + e.cargo.length, 0), m.cargo, 'stretcher cases');
    assert.equal(state.engines.filter((e) => e.path.length > 0).length, m.driving, 'vehicles on the road');
    assert.equal(Math.round(state.time), m.time);
    for (const [k, v] of Object.entries(m.stats)) assert.equal(state.stats[k], v, `stats.${k}`);
    if (m.scenario) assert.equal(state.scenario.id, m.scenario);
    if (m.personnel != null) assert.equal(state.campaign.personnel.length, m.personnel);
    assert.doesNotThrow(() => run(state, 120));
    assert.ok((state.stats.transported ?? 0) >= (m.stats.transported ?? 0), 'nobody delivered is un-delivered');
  });

  test(`legacy ${m.game} ${m.generator}: saved again it is a current save that loads to the same thing`, () => {
    const info = inspectRaw(raw(m));
    const state = loadState(info.shift, info.campaign);
    const now = roundTrip(serialize(state));
    assert.equal(now.version, SHIFT_VERSION);
    assert.ok(JSON.stringify(now).length < raw(m).length / 3, 'and a good deal smaller');
    const again = roundTrip(serialize(loadState(roundTrip(now), info.campaign)));
    assert.deepEqual(diffJson(now, again), []);
  });
}

test('legacy career: the campaign comes up to version 2 with everything the player built', () => {
  const m = manifest.find((x) => x.generator === 'career');
  const old = JSON.parse(raw(m)).campaign;
  const info = inspectRaw(raw(m));
  assert.equal(info.campaign.version, 2);
  assert.deepEqual(info.campaign.meta, { migratedFrom: 1 });
  assert.equal(info.campaign.name, old.name);
  assert.equal(info.campaign.personnel.length, old.personnel.length);
  assert.equal(info.campaign.level, old.level);
  assert.equal(info.campaign.balance, old.balance);
  assert.deepEqual(info.campaign.personnel.map((p) => p.id), old.personnel.map((p) => p.id));
});

test('legacy: reading from a slot, then saving over it, keeps the old save the first time', () => {
  const m = manifest.find((x) => x.generator === 'bare');
  const s = new Store();
  s.setItem(KEYS.quick, raw(m));
  const read = readSlot(s, KEYS.quick);
  assert.equal(read.status, 'migrated');
  const state = loadState(read.shift);
  const w = writeSlot(s, KEYS.quick, { kind: 'quick', shift: serialize(state) });
  assert.ok(w.ok);
  assert.equal(s.getItem(`${KEYS.quick}.bak`), raw(m), 'the 0.9 save is kept byte for byte');
  assert.equal(JSON.parse(s.getItem(KEYS.quick)).shift.version, SHIFT_VERSION);
});

test('legacy: a 0.17.1 envelope written back by 0.18 is not mistaken for a newer save', () => {
  const m = manifest.find((x) => x.generator === 'quick');
  const s = new Store();
  s.setItem(KEYS.quick, raw(m));
  const state = loadState(readSlot(s, KEYS.quick).shift);
  assert.ok(writeSlot(s, KEYS.quick, { kind: 'quick', shift: serialize(state) }).ok);
  assert.ok(writeSlot(s, KEYS.quick, { kind: 'quick', shift: serialize(state) }).ok, 'and again');
});
