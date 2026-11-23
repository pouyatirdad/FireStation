import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatch, serialize, loadState,
} from '../src/systems/game.js';
import { drowningCall } from '../src/systems/water.js';
import {
  applyPreset, defaultPresets, planPreset, restorePresets, validatePreset, fitsSlot, availableVehicles, diverTotal,
} from '../src/systems/presets.js';
import { createCareer } from '../src/systems/modes.js';
import { diveRate } from '../src/systems/modifiers.js';
import { startTraining, updatePersonnel } from '../src/systems/personnel.js';
import { Rng } from '../src/core/math.js';
import { CONFIG } from '../src/core/config.js';

function shift(seed = 17) {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 999999;
  state.rng = new Rng(seed);
  return state;
}

const run = (state, seconds, until = () => false) => {
  for (let i = 0; i < seconds * 60; i++) {
    update(state, 1 / 60);
    if (until(state)) return i / 60;
  }
  return null;
};

// ----------------------------------------------------------------- presets ---

test('the water preset asks for a diving unit, not for a boat by name', () => {
  const water = defaultPresets().find((p) => p.id === 'preset-water');
  assert.deepEqual(water.units, { diver: 1, ambulance: 1 });
  assert.ok(validatePreset({ name: 'Dive team', incident: 'water', units: { diver: 2 } }).ok, 'the diver slot is valid');
  assert.equal(validatePreset({ name: 'x', units: { submarine: 1 } }).ok, false, 'unknown slots are still refused');
});

test('a rescue unit answers the water preset when the city has no rescue boat', () => {
  const state = shift();
  const rescue = commandBuyVehicle(state, 'rescue');
  commandBuyVehicle(state, 'ambulance');
  drowningCall(state, () => true);
  const victim = state.victims[0];
  const plan = planPreset(state, defaultPresets().find((p) => p.id === 'preset-water'), { kind: 'victim', id: victim.id });
  assert.equal(plan.missing.diver, undefined, 'the diving slot is filled');
  assert.ok(plan.assignments.some((a) => a.engine.id === rescue.id), 'by the rescue unit');
  const sent = applyPreset(state, 'preset-water', { kind: 'victim', id: victim.id });
  assert.ok(sent.sent >= 1);
  assert.equal(rescue.victimId, victim.id, 'and it has its order');
});

test('with nothing able to dive the preset says so plainly', () => {
  const state = shift();
  drowningCall(state, () => true);
  const victim = state.victims[0];
  state.engines = state.engines.filter((e) => !fitsSlot(e, 'diver'));
  const plan = planPreset(state, defaultPresets().find((p) => p.id === 'preset-water'), { kind: 'victim', id: victim.id });
  assert.equal(plan.missing.diver, 1);
  assert.ok(plan.warnings.some((w) => /Diving unit/.test(w)), plan.warnings.join('; '));
});

test('slots: a diver slot fits any vehicle that can dive, and the fleet pills count them', () => {
  const state = shift();
  const rescue = commandBuyVehicle(state, 'rescue');
  const ambulance = commandBuyVehicle(state, 'ambulance');
  assert.ok(fitsSlot(rescue, 'diver'));
  assert.equal(fitsSlot(ambulance, 'diver'), false);
  assert.equal(fitsSlot(rescue, 'rescue'), true);
  assert.ok(diverTotal(state) >= 1);
  assert.ok((availableVehicles(state).diver ?? 0) >= 1);
});

test('saved presets: the untouched old water preset becomes a diver slot, edited ones are kept, and it is idempotent', () => {
  const old = { id: 'preset-water', name: 'Water rescue', incident: 'water', units: { rescueboat: 1, ambulance: 1 } };
  const once = restorePresets([old]);
  assert.deepEqual(once[0].units, { diver: 1, ambulance: 1 });
  assert.deepEqual(restorePresets(once)[0].units, { diver: 1, ambulance: 1 }, 'a second pass changes nothing');
  const edited = { ...old, units: { rescueboat: 2, ambulance: 1 } };
  assert.deepEqual(restorePresets([edited])[0].units, { rescueboat: 2, ambulance: 1 }, 'a changed preset is the player\'s');
  const mine = { id: 'preset-x', name: 'Boats', incident: 'water', units: { rescueboat: 1, ambulance: 1 } };
  assert.deepEqual(restorePresets([mine])[0].units, { rescueboat: 1, ambulance: 1 }, 'only the built-in one is migrated');
});

test('a shift saved with the old water preset loads with the new one', () => {
  const state = shift();
  const data = JSON.parse(JSON.stringify(serialize(state)));
  data.presets = data.presets.map((p) => (p.id === 'preset-water' ? { ...p, units: { rescueboat: 1, ambulance: 1 } } : p));
  const loaded = loadState(data);
  assert.deepEqual(loaded.presets.find((p) => p.id === 'preset-water').units, { diver: 1, ambulance: 1 });
});

// ------------------------------------------------------------------ diving ---

function rescueCall(state, vehicle = 'rescue') {
  commandBuyVehicle(state, vehicle);
  drowningCall(state, () => true);
  const victim = state.victims[0];
  assert.ok(victim, 'someone is in the water');
  state.selected = { kind: 'victim', id: victim.id };
  assert.ok(commandDispatch(state), 'the order was accepted');
  return victim;
}

test('divers bring a person out of the water and the rescued person becomes a patient, once', () => {
  const state = shift();
  rescueCall(state);
  const t = run(state, 200, (s) => s.victims.length === 0);
  assert.notEqual(t, null, 'the victim was reached in time');
  assert.equal(state.stats.dived, 1);
  assert.equal(state.stats.casualties, 0);
  assert.equal(state.victims.length, 0);
  assert.ok(state.patients.length <= 1, 'at most one patient from one rescue');
});

test('save and load while divers are working loses nobody', () => {
  const state = shift();
  rescueCall(state);
  assert.notEqual(run(state, 60, (s) => s.crew.some((c) => !c.riding && c.victimId)), null, 'a diver is out after the victim');
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.equal(loaded.victims.length, state.victims.length, 'the person is still in the water');
  const t = run(loaded, 200, (s) => s.victims.length === 0);
  assert.notEqual(t, null, 'the loaded game finishes the rescue');
  assert.equal(loaded.stats.dived, 1);
  assert.equal(loaded.stats.casualties, 0);
});

// ------------------------------------------------------------ career skill ---

test('diving skill is career only: Quick Response is unchanged', () => {
  const quick = shift();
  assert.equal(diveRate(quick, { personId: 'p1' }), 1);
  const crew = { personId: 'p1' };
  const career = {
    mode: 'career',
    campaign: { personnel: [{ id: 'p1', certs: ['diving'] }, { id: 'p2', certs: [] }] },
  };
  assert.equal(diveRate(career, crew), CONFIG.water.dive.certified);
  assert.equal(diveRate(career, { personId: 'p2' }), CONFIG.water.dive.uncertified);
  assert.ok(CONFIG.water.dive.certified > 1 && CONFIG.water.dive.uncertified < 1);
});

function careerRescueSeconds(certified, seed) {
  const state = createCareer({ name: 'x' });
  startShift(state);
  state.incidentsEnabled = false;
  state.rng = new Rng(seed);
  const engine = state.engines[0];
  for (const c of state.crew.filter((x) => x.engineId === engine.id)) {
    const person = state.campaign.personnel.find((p) => p.id === c.personId);
    person.certs = certified ? ['diving'] : [];
  }
  drowningCall(state, () => true);
  state.selected = { kind: 'victim', id: state.victims[0].id };
  commandDispatch(state);
  const t = run(state, 250, (s) => s.victims.length === 0);
  assert.notEqual(t, null);
  assert.equal(state.stats.casualties, 0);
  return t;
}

test('in a career a certified diver is quicker than one without the certificate', () => {
  for (const seed of [17, 34]) {
    const slow = careerRescueSeconds(false, seed);
    const fast = careerRescueSeconds(true, seed);
    assert.ok(fast < slow, `seed ${seed}: certified ${fast.toFixed(1)} s, not certified ${slow.toFixed(1)} s`);
  }
});

test('the Dive Rescue course exists, costs money and time, and gives the certificate', () => {
  const course = CONFIG.training.courses.diving;
  assert.ok(course && course.cert === 'diving' && course.cost > 0 && course.time > 0);
  const state = createCareer({ name: 'x' });
  startShift(state);
  state.credits = 99999;
  const person = state.campaign.personnel.find((p) => p.status === 'active');
  assert.ok(!person.certs.includes('diving'));
  const before = state.credits;
  assert.ok(startTraining(state, person.id, 'diving'), 'training started');
  assert.equal(state.credits, before - course.cost);
  state.time = person.training.until + 1;
  updatePersonnel(state, 1 / 60);
  assert.ok(person.certs.includes('diving'), 'the certificate is held');
  assert.equal(startTraining(state, person.id, 'diving'), false, 'not twice');
});
