// Backups, storage failures, interrupted writes, newer saves, and the version chain.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, serialize } from '../src/systems/game.js';
import {
  BACKUP_EVERY_MS, GENERATIONS, KEYS, SHIFT_VERSION, listBackups, migrateCampaign, migrateShift, normalizeCampaign,
  readSlot, restoreBackup, writeSlot,
} from '../src/systems/saves.js';
import { CAMPAIGN_VERSION, createCampaign } from '../src/systems/campaign.js';
import { roundTrip } from './busy-game.js';

const KEY = KEYS.quick;
const MIN = 60000;

/** A storage stand-in: a size limit, and ways of failing. */
class Store {
  constructor({ cap = Infinity, truncate = false, blocked = false } = {}) {
    this.m = new Map();
    Object.assign(this, { cap, truncate, blocked });
  }

  size(except = null) { let n = 0; for (const [k, v] of this.m) if (k !== except) n += v.length; return n; }

  getItem(k) { if (this.blocked) throw new Error('blocked'); return this.m.has(k) ? this.m.get(k) : null; }

  setItem(k, v) {
    if (this.blocked) throw new Error('blocked');
    if (this.size(k) + v.length > this.cap) throw new Error('QuotaExceededError');
    const cut = this.truncate && k === this.truncate;
    if (cut) this.truncate = false; // only the one write to the live slot is cut short
    this.m.set(k, cut ? v.slice(0, Math.floor(v.length / 2)) : v);
  }

  removeItem(k) { this.m.delete(k); }
}

const base = roundTrip(serialize(createGame(7)));
/** A shift whose `time` says which save it is. */
const shiftAt = (n, bulk = 0) => ({ ...base, time: n, events: bulk ? [{ id: 1, text: 'x'.repeat(bulk), kind: 'info', t: 0 }] : [] });
const timeOf = (store, key) => JSON.parse(store.getItem(key)).shift.time;
const put = (store, n, at, bulk = 0) => writeSlot(store, KEY, { kind: 'quick', shift: shiftAt(n, bulk) }, { now: at });

// ---------------------------------------------------------------- rotation ---

test('the last three saves are kept, a few minutes apart', () => {
  const s = new Store();
  for (let i = 1; i <= 6; i++) assert.ok(put(s, i, i * 3 * MIN).ok);
  assert.equal(timeOf(s, KEY), 6);
  assert.deepEqual([1, 2, 3].map((g) => timeOf(s, `${KEY}.gen${g}`)), [5, 4, 3]);
  assert.equal(GENERATIONS, 3);
  assert.equal(s.getItem(`${KEY}.gen4`), null, 'no fourth generation');
});

test('an autosave every few seconds does not wash the history away', () => {
  const s = new Store();
  for (let i = 0; i < 12; i++) put(s, i, i * 30000); // twelve saves in six minutes, 30 s apart
  assert.ok(BACKUP_EVERY_MS >= 60000);
  const gens = [1, 2, 3].map((g) => (s.getItem(`${KEY}.gen${g}`) ? timeOf(s, `${KEY}.gen${g}`) : null));
  assert.ok(gens[0] !== null && gens[1] !== null, 'history exists');
  assert.ok(gens[0] - gens[1] >= 4, `the generations are spread out, not the last three autosaves (${gens.join(', ')})`);
});

test('backups are listed, loadable, and restoring one keeps the save it replaces', () => {
  const s = new Store();
  for (let i = 1; i <= 4; i++) put(s, i, i * 3 * MIN);
  const list = listBackups(s).filter((b) => /^gen/.test(b.suffix));
  assert.deepEqual(list.map((b) => b.suffix).sort(), ['gen1', 'gen2', 'gen3']);
  assert.ok(list.every((b) => b.loadable));
  assert.equal(restoreBackup(s, `${KEY}.gen2`).ok, true);
  assert.equal(timeOf(s, KEY), 2);
  assert.equal(timeOf(s, `${KEY}.replaced`), 4, 'the save it replaced is kept');
  assert.equal(timeOf(s, `${KEY}.gen2`), 2, 'and the backup itself is still there');
});

// --------------------------------------------------------------- failures ---

test('storage that is full: the live save survives, older backups make room, nothing crashes', () => {
  const sample = JSON.stringify({ format: 2, kind: 'quick', savedAt: 0, check: { engines: 1, crews: 1, patients: 0 }, shift: shiftAt(1) }).length;
  const s = new Store({ cap: Math.floor(sample * 3.4) });
  for (let i = 1; i <= 3; i++) assert.ok(put(s, i, i * 3 * MIN).ok, `save ${i}`);
  const r = put(s, 4, 12 * MIN);
  assert.ok(r.ok, 'the save still goes through');
  assert.equal(timeOf(s, KEY), 4);
  assert.ok(s.size() <= s.cap);
});

test('a save too big for the browser fails cleanly and the previous save is exactly as it was', () => {
  const s = new Store({ cap: 400000 });
  assert.ok(put(s, 1, 3 * MIN).ok);
  assert.ok(put(s, 2, 6 * MIN).ok);
  const live = s.getItem(KEY);
  const r = put(s, 3, 9 * MIN, 500000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quota');
  assert.match(r.error, /previous save is unchanged/);
  assert.equal(s.getItem(KEY), live, 'the live save was not touched');
  // nothing that was saved is gone: the live save and the earlier one are both still readable
  const times = [KEY, `${KEY}.gen1`, `${KEY}.gen2`].filter((k) => s.getItem(k)).map((k) => timeOf(s, k));
  assert.ok(times.includes(1) && times.includes(2), `saves still present: ${times}`);
});

test('a write that is cut short (the browser stored half of it) is detected and the old save is put back', () => {
  const s = new Store();
  assert.ok(put(s, 1, 3 * MIN).ok);
  const live = s.getItem(KEY);
  s.truncate = KEY;
  const r = put(s, 2, 6 * MIN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'verify');
  assert.equal(s.getItem(KEY), live);
  assert.equal(timeOf(s, KEY), 1);
});

test('blocked storage: no exception, an honest answer', () => {
  const s = new Store({ blocked: true });
  const r = put(s, 1, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'storage');
  assert.equal(readSlot(s, KEY).status, 'error');
});

// ------------------------------------------------------------ interrupted ---

test('a live save cut off mid-write is replaced by the newest readable backup, and a copy is kept', () => {
  const s = new Store();
  for (let i = 1; i <= 3; i++) put(s, i, i * 3 * MIN);
  const good = s.getItem(KEY);
  s.m.set(KEY, good.slice(0, Math.floor(good.length / 2))); // power cut
  const r = readSlot(s, KEY);
  assert.ok(['ok', 'migrated'].includes(r.status));
  assert.equal(r.recoveredFrom, `${KEY}.gen1`);
  assert.equal(r.shift.time, 2, 'the save before the damaged one');
  assert.match(r.warnings.join(' '), /previous one was loaded/);
  assert.ok(s.getItem(`${KEY}.corrupt`), 'the damaged text is kept, never deleted');
});

test('a damaged live save with no backup is reported, not guessed at', () => {
  const s = new Store();
  put(s, 1, 0);
  const good = s.getItem(KEY);
  s.m.set(KEY, good.slice(0, 300));
  const r = readSlot(s, KEY);
  assert.equal(r.status, 'corrupt');
  assert.ok(s.getItem(`${KEY}.corrupt`));
});

test('a save that parses but is incomplete (vehicles missing) is not trusted', () => {
  const s = new Store();
  for (let i = 1; i <= 2; i++) put(s, i, i * 3 * MIN);
  const env = JSON.parse(s.getItem(KEY));
  env.check.engines = env.shift.engines.length + 3; // the writer recorded more vehicles than are there
  s.m.set(KEY, JSON.stringify(env));
  const r = readSlot(s, KEY);
  assert.equal(r.recoveredFrom, `${KEY}.gen1`);
  assert.match(r.damaged, /incomplete/);
});

// ------------------------------------------------------------ newer saves ---

test('a save from a newer game is never read down or overwritten', () => {
  const s = new Store();
  put(s, 1, 0);
  const env = JSON.parse(s.getItem(KEY));
  env.shift.version = SHIFT_VERSION + 1;
  s.m.set(KEY, JSON.stringify(env));
  const before = s.getItem(KEY);
  assert.equal(readSlot(s, KEY).status, 'newer');
  const r = put(s, 2, 10 * MIN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'newer');
  assert.equal(s.getItem(KEY), before);
  assert.equal(s.getItem(`${KEY}.gen1`), null, 'and nothing was shuffled into the backups');
  assert.equal(s.getItem(`${KEY}.corrupt`), null, 'a newer save is not "corrupt"');
});

test('a career from a newer game is protected too', () => {
  const s = new Store();
  const campaign = createCampaign({ name: 'x' });
  const k = KEYS.career;
  assert.ok(writeSlot(s, k, { kind: 'career', shift: shiftAt(1), campaign }, { now: 0 }).ok);
  const env = JSON.parse(s.getItem(k));
  env.campaign.version = CAMPAIGN_VERSION + 1;
  s.m.set(k, JSON.stringify(env));
  assert.equal(readSlot(s, k).status, 'newer');
  const r = writeSlot(s, k, { kind: 'career', shift: shiftAt(2), campaign }, { now: 5 * MIN });
  assert.equal(r.reason, 'newer');
  assert.equal(JSON.parse(s.getItem(k)).campaign.version, CAMPAIGN_VERSION + 1);
});

// --------------------------------------------------------------- versions ---

test('the current versions are shift 18 and campaign 2', () => {
  assert.equal(SHIFT_VERSION, 18);
  assert.equal(CAMPAIGN_VERSION, 2);
  assert.equal(createCampaign({ name: 'x' }).version, 2);
});

test('shift migration: 16 and 17 reach 18 with safe defaults; older and newer are refused', () => {
  const old = { ...base };
  delete old.ids;
  for (const v of [16, 17]) {
    const m = migrateShift({ ...old, version: v });
    assert.equal(m.ok, true, `version ${v}`);
    assert.equal(m.data.version, 18);
    assert.equal(typeof m.data.ids, 'object');
    assert.equal(m.from, v);
  }
  assert.equal(migrateShift({ ...old, version: 15 }).ok, false);
  assert.equal(migrateShift({ ...old, version: 19 }).newer, true);
  assert.equal(migrateShift({ nothing: true }).ok, false);
  assert.equal(migrateShift(null).ok, false);
});

test('campaign migration: 1 reaches 2 additively; newer is refused; junk is not a campaign', () => {
  const v1 = roundTrip(createCampaign({ name: 'Old' }));
  v1.version = 1;
  delete v1.meta;
  const m = migrateCampaign(v1);
  assert.equal(m.ok, true);
  assert.equal(m.data.version, 2);
  assert.deepEqual(m.data.meta, { migratedFrom: 1 });
  const n = normalizeCampaign(v1);
  assert.equal(n.version, 2);
  assert.equal(n.name, 'Old');
  assert.equal(migrateCampaign({ ...v1, version: 3 }).newer, true);
  assert.deepEqual(normalizeCampaign({ ...v1, version: 3 }), { newer: true });
  assert.equal(normalizeCampaign('nope'), null);
  assert.equal(migrateCampaign({ version: 0 }).ok, false);
});
