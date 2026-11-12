import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatch,
  commandDispatchPatient, commandPharmacy, serialize, loadState, selectUnit,
} from '../src/systems/game.js';
import { ignite } from '../src/systems/fire.js';
import { spawnPatient, updatePatients, pharmacyInReach } from '../src/systems/medical.js';
import { CONFIG, TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 20000;
  return state;
}

/** The closest ordinary building to the station, as a place for someone to be hurt. */
function nearBuilding(state) {
  const station = state.city.station;
  return state.buildings
    .filter((b) => b.id !== 'station' && b.type !== 'warehouse')
    .sort((a, b) => Math.hypot(a.x - station.x, a.y - station.y) - Math.hypot(b.x - station.x, b.y - station.y))[0];
}

test('an ambulance is a fleet vehicle with paramedics and medical kits, no water', () => {
  const state = shift();
  const credits = state.credits;
  const ambulance = commandBuyVehicle(state, 'ambulance');
  assert.ok(ambulance, 'could not buy an ambulance');
  assert.equal(ambulance.type, 'ambulance');
  assert.equal(ambulance.kits, CONFIG.vehicles.ambulance.kits);
  assert.equal(ambulance.capacity, 0);
  assert.equal(state.credits, credits - CONFIG.vehicles.ambulance.cost);
  const medics = state.crew.filter((c) => c.engineId === ambulance.id);
  assert.equal(medics.length, 2);
  assert.ok(medics.every((c) => c.medic));
});

test('an ambulance reaches an injured person and treats them for a fee', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const patient = spawnPatient(state, nearBuilding(state), 0.5);
  assert.ok(patient, 'no patient was created');
  const credits = state.credits;

  assert.equal(commandDispatchPatient(state, patient.id), true);
  assert.equal(patient.claimedBy, ambulance.id);

  let seconds = 0;
  while (!patient.treated && seconds < 150) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.equal(patient.treated, true, `not treated after ${seconds.toFixed(0)}s (${ambulance.status})`);
  assert.equal(state.stats.treated, 1);
  assert.equal(ambulance.kits, CONFIG.vehicles.ambulance.kits - 1);
  assert.ok(state.credits >= credits + CONFIG.economy.treated - 5, 'no treatment fee');
});

test('D sends an ambulance to the nearest patient; a fire engine never goes', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const patient = spawnPatient(state, nearBuilding(state), 0.5);
  selectUnit(state, ambulance.id);
  assert.equal(commandDispatch(state), true);
  assert.equal(ambulance.patientId, patient.id);

  // With only a fire engine selected, a patient is not a job for it.
  const engine = state.engines[0];
  selectUnit(state, engine.id);
  const target = state.buildings.find((b) => b.id !== 'station' && b.state === 'ok');
  ignite(state, target, 'test');
  commandDispatch(state);
  assert.equal(engine.patientId, null);
});

test('an untreated patient dies when their clock runs out', () => {
  const state = shift();
  const patient = spawnPatient(state, nearBuilding(state), 1);
  const rating = state.rating;
  const credits = state.credits;
  patient.life = 0.2;
  updatePatients(state, 0.5);
  assert.equal(state.patients.length, 0);
  assert.equal(state.stats.casualties, 1);
  assert.ok(state.rating < rating);
  assert.equal(state.credits, credits - CONFIG.economy.casualtyPenalty);
});

test('a fire leaves some of the people who escape hurt', () => {
  const state = shift();
  let hurt = 0;
  for (const b of state.buildings.filter((x) => x.id !== 'station').slice(0, 60)) {
    b.occupants = 30;
    ignite(state, b, 'test');
    hurt = state.patients.length;
    if (hurt > 0) break;
  }
  assert.ok(hurt > 0, 'sixty busy buildings caught fire and nobody was hurt');
});

test('an ambulance with no kits will not be sent, and restocks beside a pharmacy for a fee', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  const patient = spawnPatient(state, nearBuilding(state), 0.5);
  ambulance.kits = 0;
  selectUnit(state, ambulance.id);
  assert.equal(commandDispatchPatient(state, patient.id), false, 'sent an empty ambulance');

  const pharmacy = state.city.pharmacies[0];
  assert.ok(pharmacy, 'the city has no pharmacy');
  ambulance.x = (pharmacy.x + pharmacy.w / 2) * TILE;
  ambulance.y = (pharmacy.y + pharmacy.h + 1.2) * TILE;
  ambulance.path = [];
  assert.ok(pharmacyInReach(state, ambulance), 'ambulance is not beside the pharmacy');

  const credits = state.credits;
  for (let i = 0; i < 30 * 8; i++) update(state, 1 / 30);
  assert.equal(ambulance.kits, CONFIG.vehicles.ambulance.kits);
  assert.ok(state.credits < credits + 8 * 10, 'kits were free at a pharmacy');
});

test('P sends the selected ambulance to a pharmacy', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  selectUnit(state, ambulance.id);
  assert.equal(commandPharmacy(state), true);
  assert.ok(ambulance.path.length > 0 || ambulance.status === 'responding');
});

test('patients and kits survive a save', () => {
  const state = shift();
  const ambulance = commandBuyVehicle(state, 'ambulance');
  ambulance.kits = 3;
  const patient = spawnPatient(state, nearBuilding(state), 0.5);
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  const restored = loaded.engines.find((e) => e.type === 'ambulance');
  assert.equal(restored.kits, 3);
  assert.equal(loaded.patients.length, 1);
  assert.equal(loaded.patients[0].id, patient.id);
  assert.ok(loaded.crew.some((c) => c.medic));
});
