// The save schemas and the coverage guard: a field that a live entity can have must be declared in its schema as
// saved, derived or transient, so nothing silently falls out of a save.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, serialize } from '../src/systems/game.js';
import {
  SCHEMAS, declaredNames, fieldNames, loadFields, saveFields, uniqueById, applyFields,
} from '../src/systems/schema.js';
import { TRANSIENT_STATE, ownedKeys, ownedStateFields, persistenceSections } from '../src/systems/persistence.js';
import { busyGame } from './busy-game.js';

const MODES = ['quick', 'career', 'challenge'];
const games = new Map();
const game = (mode) => {
  if (!games.has(mode)) games.set(mode, busyGame(mode));
  return games.get(mode);
};

/** The live entity lists of a state, by schema name. */
const entitiesOf = (s) => ({
  building: s.buildings, engine: s.engines, crew: s.crew, patient: s.patients,
  victim: s.victims, blockade: s.blockades, wildfire: s.wildfires ?? [],
});

for (const mode of MODES) {
  test(`coverage guard (${mode}): every field a live entity has is declared by its schema`, () => {
    const s = game(mode);
    const missing = [];
    let seen = 0;
    for (const [kind, list] of Object.entries(entitiesOf(s))) {
      const declared = declaredNames(SCHEMAS[kind]);
      for (const entity of list) {
        seen++;
        for (const key of Object.keys(entity)) {
          if (key !== 'extra' && !declared.has(key)) missing.push(`${kind}.${key}`);
        }
      }
    }
    assert.ok(seen > 1000, 'the busy game has entities to look at');
    assert.deepEqual([...new Set(missing)], [], 'declare these in schema.js as saved, derived or transient');
  });

  test(`coverage guard (${mode}): every field of the live state is owned by a section or marked transient`, () => {
    const s = game(mode);
    const owned = ownedStateFields();
    const missing = Object.keys(s).filter((k) => !owned.has(k) && !(k in TRANSIENT_STATE));
    assert.deepEqual(missing, [], 'register these with a persistence section, or add them to TRANSIENT_STATE with a reason');
  });
}

test('the busy games really have every kind of entity (so the guard is looking at something)', () => {
  const kinds = {};
  for (const mode of MODES) {
    for (const [kind, list] of Object.entries(entitiesOf(game(mode)))) kinds[kind] = (kinds[kind] ?? 0) + list.length;
  }
  for (const [kind, n] of Object.entries(kinds)) assert.ok(n > 0, `no ${kind} in any busy game`);
});

test('every key of a save belongs to a registered section, and every section writes only its keys', () => {
  const data = serialize(game('quick'));
  const owned = ownedKeys();
  for (const key of Object.keys(data)) assert.ok(key === 'version' || owned.has(key), `${key} is written by no section`);
  for (const section of persistenceSections()) {
    for (const k of section.keys) assert.ok(section.keys.length === 0 || k in data, `section ${section.key} did not write ${k}`);
  }
});

test('every derived or transient field has a reason; every schema has an id', () => {
  for (const schema of Object.values(SCHEMAS)) {
    assert.equal(schema.fields.id?.persist, 'saved', `${schema.name} has no saved id`);
    for (const [name, f] of Object.entries(schema.fields)) {
      if (f.persist !== 'saved') assert.ok(typeof f.reason === 'string' && f.reason.length > 3, `${schema.name}.${name} has no reason`);
    }
  }
  for (const [k, why] of Object.entries(TRANSIENT_STATE)) assert.ok(why.length > 3, `${k} has no reason`);
});

test('derived building fields really are derived: they equal a fresh city after a busy game', () => {
  const s = game('quick');
  const fresh = createGame(s.seed);
  const byId = new Map(fresh.buildings.map((b) => [b.id, b]));
  const derived = fieldNames(SCHEMAS.building, 'derived');
  const changed = new Set();
  for (const b of s.buildings) {
    const f = byId.get(b.id);
    for (const k of derived) if (JSON.stringify(b[k]) !== JSON.stringify(f[k])) changed.add(k);
  }
  assert.deepEqual([...changed], [], 'these "derived" fields changed during play, so they must be saved');
});

// ------------------------------------------------------------- the schemas ---

test('a saved entity is written with its saved fields only', () => {
  const s = game('quick');
  const engine = s.engines[0];
  const saved = saveFields(SCHEMAS.engine, engine);
  assert.deepEqual(Object.keys(saved).sort(), fieldNames(SCHEMAS.engine, 'saved').sort());
  for (const k of fieldNames(SCHEMAS.engine, 'transient').concat(fieldNames(SCHEMAS.engine, 'derived'))) assert.ok(!(k in saved), k);
});

test('damaged fields are repaired and reported, the entity is kept', () => {
  const r = loadFields(SCHEMAS.patient, {
    id: 'patient1', x: 'far', y: NaN, severity: 7, life: 'soon', treated: 'yes', claimedBy: 12, buildingName: 'x'.repeat(500),
  }, null, { where: 'patient patient1' });
  assert.equal(r.values.id, 'patient1');
  assert.equal(r.values.x, 0, 'a string where a number belongs falls back to the default');
  assert.equal(r.values.y, 0, 'NaN too');
  assert.equal(r.values.severity, 1, 'out of range is clamped');
  assert.equal(r.values.life, 1);
  assert.equal(r.values.treated, false);
  assert.equal(r.values.claimedBy, null);
  assert.ok(r.values.buildingName.length <= 80);
  assert.ok(r.issues.some((i) => /patient1\.x was damaged/.test(i)));
  assert.ok(r.issues.some((i) => /severity was out of range/.test(i)));
});

test('a missing field takes its default without a complaint', () => {
  const r = loadFields(SCHEMAS.victim, { id: 'victim1', x: 5 });
  assert.equal(r.values.x, 5);
  assert.equal(r.values.rescueTimer, 0);
  assert.deepEqual(r.issues, []);
});

test('unknown fields are kept, written back and reported', () => {
  const r = loadFields(SCHEMAS.victim, { id: 'victim1', x: 5, futureThing: { a: 1 } }, null, { where: 'victim victim1' });
  assert.deepEqual(r.extra, { futureThing: { a: 1 } });
  assert.ok(r.issues.some((i) => /unknown fields: futureThing/.test(i)));
  const entity = { kind: 'victim' };
  applyFields(entity, r);
  assert.deepEqual(saveFields(SCHEMAS.victim, entity).futureThing, { a: 1 });
});

test('bounded numbers, route points and enums are checked', () => {
  const b = loadFields(SCHEMAS.building, { id: 'b1', state: 'melting', fire: 4, trapped: -3 }, { maxIntegrity: 100 });
  assert.equal(b.values.state, 'ok', 'an unknown state falls back');
  assert.equal(b.values.fire, 1);
  assert.equal(b.values.trapped, 0);
  assert.equal(b.values.integrity, 100, 'the default of integrity is the building\'s own maximum');
  const e = loadFields(SCHEMAS.engine, { id: 'e1', path: [{ x: 1, y: 2 }, { x: 'a', y: 2 }, null] });
  assert.deepEqual(e.values.path, [{ x: 1, y: 2 }]);
});

test('duplicate and unusable ids are dropped, the first duplicate wins', () => {
  const { list, issues } = uniqueById([{ id: 'a', n: 1 }, { id: 'a', n: 2 }, { n: 3 }, null, { id: 'b' }, { id: 7 }], 'things');
  assert.deepEqual(list.map((x) => x.id), ['a', 'b']);
  assert.equal(list[0].n, 1);
  assert.equal(issues.length, 4);
});

test('the guard bites: a field nobody declared is found', () => {
  const s = game('quick');
  const engine = s.engines[0];
  engine.hasNoSchema = 1;
  try {
    const undeclared = Object.keys(engine).filter((k) => k !== 'extra' && !declaredNames(SCHEMAS.engine).has(k));
    assert.deepEqual(undeclared, ['hasNoSchema']);
  } finally {
    delete engine.hasNoSchema;
  }
});
