import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatch, serialize, loadState,
} from '../src/systems/game.js';
import {
  spawnPatient, hospitalAvailable, availableHospitals, nearestHospital,
} from '../src/systems/medical.js';
import { chooseHospital } from '../src/systems/units.js';
import { estimate } from '../src/systems/eta.js';
import { callAgency } from '../src/systems/agencies.js';
import { CONFIG, TILE } from '../src/core/config.js';

const RULE = CONFIG.medical.hospital;
const RULE_DEFAULT = { ...RULE };
const reset = () => Object.assign(RULE, RULE_DEFAULT);

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 999999;
  return state;
}

/** A house a little way from the station: somewhere for a patient to be hurt. */
function house(state, min = 20, max = 45) {
  const st = state.city.station;
  return state.buildings.find((b) => b.type === 'house' && b.state === 'ok'
    && Math.hypot(b.x - st.x, b.y - st.y) > min && Math.hypot(b.x - st.x, b.y - st.y) < max);
}

const run = (state, seconds) => { for (let i = 0; i < seconds * 60; i++) update(state, 1 / 60); };

/** Run until `done(state)` or `limit` seconds pass; returns the seconds it took, or null. */
function runUntil(state, done, limit = 300) {
  for (let t = 0; t < limit * 60; t++) {
    update(state, 1 / 60);
    if (done(state)) return t / 60;
  }
  return null;
}

/** An ambulance sent to a critical patient; returns { state, ambulance, patient }. */
function criticalCall(state = shift(), severity = 0.9) {
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const patient = spawnPatient(state, house(state), severity);
  state.selected = { kind: 'patient', id: patient.id };
  assert.ok(commandDispatch(state), 'the ambulance took the order');
  return { state, ambulance, patient };
}

/** Run until the ambulance has a patient aboard and is driving to a hospital. */
function untilDriving(state, ambulance) {
  const t = runUntil(state, () => ambulance.cargo.length > 0 && ambulance.hospitalId && ambulance.path.length > 0);
  assert.notEqual(t, null, 'the ambulance never set off for a hospital with a patient');
}

const rubble = (hospital) => { hospital.state = 'rubble'; };

test.afterEach(reset);

// ------------------------------------------------------------ availability ---

test('any standing hospital is available by default; the 0.17 rule (owned bases only) is a setting', () => {
  const state = shift();
  const all = state.city.hospitals;
  assert.ok(all.length > 3, 'the city has several hospitals');
  assert.equal(availableHospitals(state).length, all.length, 'every intact hospital is available');
  RULE.anyIntact = false;
  const owned = availableHospitals(state);
  assert.ok(owned.length < all.length, 'only hospitals in open bases remain');
  assert.ok(owned.every((h) => state.ownedStations[h.base ?? 0] ?? (h.base ?? 0) === 0));
});

test('a destroyed or burning hospital is unavailable at once', () => {
  const state = shift();
  const h = state.city.hospitals[0];
  assert.ok(hospitalAvailable(state, h));
  rubble(h);
  assert.equal(hospitalAvailable(state, h), false, 'rubble takes no patients');
  assert.ok(!availableHospitals(state).includes(h));
  const burning = state.city.hospitals[1];
  burning.state = 'burning';
  assert.equal(hospitalAvailable(state, burning), false, 'a hospital on fire takes no patients');
  RULE.avoidBurning = false;
  assert.equal(hospitalAvailable(state, burning), true, 'unless the setting is off');
});

test('the hospital is chosen by driving time and is never slower than the others it was compared with', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  ambulance.x = (house(state).x + 0.5) * TILE;
  ambulance.y = (house(state).y + 0.5) * TILE;
  const chosen = chooseHospital(state, ambulance);
  assert.ok(chosen, 'a hospital is chosen');
  const seconds = (h) => estimate(state, ambulance, (h.x + h.w / 2) * TILE, (h.y + h.h / 2) * TILE).seconds;
  const best = seconds(chosen);
  const nearest = [...availableHospitals(state)]
    .sort((a, b) => Math.hypot(a.x - house(state).x, a.y - house(state).y) - Math.hypot(b.x - house(state).x, b.y - house(state).y))
    .slice(0, RULE.candidates);
  for (const h of nearest) assert.ok(best <= seconds(h) + 1e-6, `${h.name} is not faster than the chosen ${chosen.name}`);
  RULE.byRoute = false;
  assert.equal(chooseHospital(state, ambulance), nearestHospital(state, ambulance.x, ambulance.y), 'straight line when the setting is off');
});

// --------------------------------------------------------------- transport ---

test('a critical patient reaches a hospital once: paid, counted, nobody left over', () => {
  const { state, ambulance } = criticalCall();
  const before = state.credits;
  const t = runUntil(state, (s) => (s.stats.transported ?? 0) >= 1);
  assert.notEqual(t, null, 'the patient was delivered');
  assert.equal(state.stats.transported, 1);
  assert.equal(ambulance.cargo.length, 0);
  assert.equal(state.stats.casualties, 0);
  assert.equal(state.ledger.by.transport, CONFIG.medical.transportFee);
  assert.ok(state.credits > before);
  run(state, 60);
  assert.equal(state.stats.transported, 1, 'delivered once, not again');
  assert.equal(state.patients.filter((p) => !p.treated).length, 0);
});

test('when the hospital it is heading for is destroyed, the ambulance goes to another', () => {
  const { state, ambulance } = criticalCall();
  untilDriving(state, ambulance);
  const first = ambulance.hospitalId;
  rubble(state.city.hospitals.find((h) => h.id === first));
  run(state, 2);
  assert.ok(ambulance.hospitalId && ambulance.hospitalId !== first, 'it picked a different hospital');
  assert.ok(hospitalAvailable(state, state.city.hospitals.find((h) => h.id === ambulance.hospitalId)));
  assert.equal(ambulance.cargo.length, 1, 'the patient is still aboard');
  assert.ok(state.events.some((e) => /out of service/.test(e.text)), 'the player is told');
  const t = runUntil(state, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.notEqual(t, null, 'and was delivered there');
  assert.equal(state.stats.transported, 1);
  assert.equal(state.stats.casualties, 0);
  assert.equal(state.ledger.by.transport, CONFIG.medical.transportFee, 'one fee, not two');
});

test('with no hospital standing the patient stays aboard, one warning is given, and delivery follows once one stands', () => {
  const { state, ambulance } = criticalCall();
  untilDriving(state, ambulance);
  for (const h of state.city.hospitals) rubble(h);
  run(state, 120);
  assert.equal(ambulance.cargo.length, 1, 'still aboard');
  assert.equal(state.stats.transported ?? 0, 0);
  const warnings = state.events.filter((e) => /no hospital/i.test(e.text));
  assert.equal(warnings.length, 1, 'said once, not at every retry');
  state.city.hospitals[2].state = 'ok';
  const t = runUntil(state, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.notEqual(t, null, 'delivered when a hospital came back');
  assert.equal(ambulance.cargo.length, 0);
  assert.equal(state.stats.transported, 1);
});

test('two critical patients: everyone is accounted for, fees match the transported count', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const h = house(state);
  const a = spawnPatient(state, h, 0.9);
  spawnPatient(state, h, 0.95);
  state.selected = { kind: 'patient', id: a.id };
  commandDispatch(state);
  runUntil(state, (s) => (s.stats.transported ?? 0) >= 2 || s.stats.casualties > 0, 400);
  const delivered = state.stats.transported ?? 0;
  assert.equal(delivered + state.stats.casualties + ambulance.cargo.length
    + state.patients.filter((p) => !p.treated).length, 2, 'two people, two outcomes');
  assert.equal(state.ledger.by.transport ?? 0, delivered * CONFIG.medical.transportFee);
});

// ----------------------------------------------------------- save and load ---

test('save and load while transporting loses and duplicates nobody, and keeps the chosen hospital', () => {
  const { state, ambulance } = criticalCall();
  untilDriving(state, ambulance);
  const saved = JSON.parse(JSON.stringify(serialize(state)));
  const loaded = loadState(saved);
  const copy = loaded.engines.find((e) => e.id === ambulance.id);
  assert.equal(copy.cargo.length, 1);
  assert.equal(copy.hospitalId, ambulance.hospitalId);
  assert.ok(copy.path.length > 0, 'still driving');
  const t = runUntil(loaded, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.notEqual(t, null);
  assert.equal(loaded.stats.transported, 1);
  assert.equal(copy.cargo.length, 0);
  assert.equal(loaded.stats.casualties, 0);
  // and the original, run on without a save, agrees
  runUntil(state, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.equal(state.stats.transported, 1);
});

test('save and load after the destination was destroyed still diverts, and still delivers exactly once', () => {
  const { state, ambulance } = criticalCall();
  untilDriving(state, ambulance);
  const first = ambulance.hospitalId;
  rubble(state.city.hospitals.find((h) => h.id === first));
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  const copy = loaded.engines.find((e) => e.id === ambulance.id);
  // the destroyed hospital is saved as rubble (buildings keep their state)
  assert.equal(loaded.city.hospitals.find((h) => h.id === first).state, 'rubble');
  const t = runUntil(loaded, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.notEqual(t, null);
  assert.notEqual(copy.hospitalId, first);
  assert.equal(loaded.stats.transported, 1);
  assert.equal(loaded.ledger.by.transport, CONFIG.medical.transportFee);
});

test('an old save with no hospital on the order loads and the ambulance still finds one', () => {
  const { state, ambulance } = criticalCall();
  untilDriving(state, ambulance);
  const saved = JSON.parse(JSON.stringify(serialize(state)));
  for (const e of saved.engines) delete e.hospitalId;
  const loaded = loadState(saved);
  const t = runUntil(loaded, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.notEqual(t, null);
  assert.equal(loaded.stats.transported, 1);
});

// --------------------------------------------------------------- EMS call ---

function emsAt(state, patients) {
  const h = house(state);
  const list = patients.map((s) => spawnPatient(state, h, s));
  const call = callAgency(state, 'ems', { kind: 'patient', id: list[0].id });
  assert.ok(call, 'the service was called');
  return { call, list };
}

test('the emergency medical service takes its critical patients to a hospital and is paid for it', () => {
  const state = shift();
  emsAt(state, [0.95, 0.9, 0.3]);
  const t = runUntil(state, (s) => (s.stats.transported ?? 0) >= 2, 400);
  assert.notEqual(t, null, 'both critical patients were delivered');
  assert.equal(state.stats.treated, 3, 'all three were treated');
  assert.equal(state.stats.transported, 2, 'only the two critical ones were transported');
  assert.equal(state.ledger.by.transport, 2 * CONFIG.medical.transportFee);
  assert.equal(state.patients.filter((p) => !p.treated).length, 0);
  assert.equal(state.support.active.filter((c) => (c.cargo?.length ?? 0) > 0).length, 0);
});

test('the emergency medical service diverts when its hospital is lost, and waits when there is none', () => {
  const state = shift();
  const { call } = emsAt(state, [0.95]);
  runUntil(state, () => call.hospitalId != null, 200);
  assert.ok(call.hospitalId, 'it set off for a hospital');
  const first = call.hospitalId;
  for (const h of state.city.hospitals) rubble(h);
  run(state, 400);
  assert.equal(call.cargo.length, 1, 'the patient waits aboard');
  assert.equal(state.stats.transported ?? 0, 0);
  assert.equal(state.events.filter((e) => /no hospital open/.test(e.text)).length, 1, 'one warning');
  const back = state.city.hospitals.find((h) => h.id !== first);
  back.state = 'ok';
  const t = runUntil(state, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.notEqual(t, null);
  assert.equal(state.stats.transported, 1);
  assert.equal(state.ledger.by.transport, CONFIG.medical.transportFee);
});

test('save and load while the emergency medical service is on its way to a hospital', () => {
  const state = shift();
  const { call } = emsAt(state, [0.95, 0.92]);
  runUntil(state, () => call.hospitalId != null && state.time < call.deliverAt, 200);
  assert.equal(call.cargo.length, 2);
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  const copy = loaded.support.active.find((c) => c.id === call.id);
  assert.equal(copy.cargo.length, 2, 'both still aboard after the load');
  const t = runUntil(loaded, (s) => (s.stats.transported ?? 0) >= 2, 400);
  assert.notEqual(t, null);
  assert.equal(loaded.stats.transported, 2);
  assert.equal(loaded.ledger.by.transport, 2 * CONFIG.medical.transportFee);
});

// ----------------------------------------------------------- old behaviour ---

test('with the new rules off an ambulance still delivers to the hospital of an owned base', () => {
  Object.assign(RULE, { anyIntact: false, byRoute: false, avoidBurning: false });
  const { state, ambulance } = criticalCall();
  untilDriving(state, ambulance);
  const h = state.city.hospitals.find((x) => x.id === ambulance.hospitalId);
  assert.ok(state.ownedStations[h.base ?? 0] ?? (h.base ?? 0) === 0, 'it is heading for a hospital in an open base');
  const t = runUntil(state, (s) => (s.stats.transported ?? 0) >= 1, 400);
  assert.notEqual(t, null);
});
