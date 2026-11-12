// Injured civilians and the paramedics who treat them.
//
// People hurt by a fire lie on the pavement near the building until an
// ambulance crew reaches them. Each patient has a clock; if it runs out before
// treatment they are lost. Treatment costs one medical kit (restocked at the
// station apron or, faster and for a fee, beside a pharmacy).
//
// This module owns the patient list and the kit economy. The ambulance's driving
// and its crew's walking live in units.js, which calls back in here.

import { CONFIG, TILE } from '../core/config.js';
import { dist, distToRect } from '../core/math.js';
import { addEvent } from './events.js';
import { earn, money, spend } from './economy.js';
import { standTileForRect, tileCenter } from './grid.js';

let seq = 1;

export const isMedical = (engine) => Boolean(engine?.spec?.medical);

const buildingRectOf = (b) => ({
  x: b.x * TILE,
  y: b.y * TILE,
  w: b.w * TILE,
  h: b.h * TILE,
});

/** Put an injured person on the ground beside a building. */
export function spawnPatient(state, building, severity = null) {
  if (state.patients.length >= 40) return null;
  const rect = buildingRectOf(building);
  const stand = standTileForRect(state.nav, rect, rect.x + rect.w / 2, rect.y + rect.h / 2, 4);
  if (!stand) return null;
  const centre = tileCenter(stand.x, stand.y);
  const sev = severity ?? state.rng.range(0.25, 1);
  const [lo, hi] = CONFIG.medical.survive;
  const survive = hi - (hi - lo) * sev;
  const patient = {
    id: `patient${seq++}`,
    kind: 'patient',
    name: 'Injured person',
    x: centre.x + state.rng.range(-10, 10),
    y: centre.y + state.rng.range(-10, 10),
    buildingId: building.id,
    buildingName: building.name,
    severity: sev,
    life: survive,
    maxLife: survive,
    treated: false,
    treatTimer: 0,
    claimedBy: null, // the ambulance heading for them
    leaveAt: 0,
  };
  state.patients.push(patient);
  addEvent(state, `Injured person near ${building.name} — ambulance needed`, 'warn');
  return patient;
}

/** A few of the people who escape a fire are hurt. Called as the fire starts. */
export function injureEvacuees(state, building, escaping) {
  const { injuredChance, maxPerFire } = CONFIG.medical;
  let count = 0;
  for (let i = 0; i < Math.min(escaping, 12) && count < maxPerFire; i++) {
    if (state.rng.chance(injuredChance)) count++;
  }
  for (let i = 0; i < count; i++) spawnPatient(state, building);
  return count;
}

/** Someone a firefighter carried out may need a medic too. */
export function injureRescued(state, building) {
  if (!state.rng.chance(CONFIG.medical.rescuedInjuredChance)) return null;
  return spawnPatient(state, building, state.rng.range(0.4, 1));
}

export function restorePatients(state, list = []) {
  state.patients = list.map((p) => ({
    kind: 'patient',
    name: 'Injured person',
    treatTimer: 0,
    claimedBy: null,
    medicId: null,
    leaveAt: 0,
    ...p,
  }));
  for (const p of state.patients) {
    const match = /(\d+)$/.exec(p.id ?? '');
    if (match) seq = Math.max(seq, Number(match[1]) + 1);
  }
  return state.patients;
}

export const findPatient =(state, id) => state.patients.find((p) => p.id === id) ?? null;

/** The nearest patient still waiting for treatment, optionally unclaimed. */
export function nearestPatient(state, x, y, { unclaimed = false, maxDist = Infinity } = {}) {
  let best = null;
  let bestD = maxDist;
  for (const p of state.patients) {
    if (p.treated) continue;
    if (unclaimed && p.claimedBy) continue;
    const d = dist(x, y, p.x, p.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** A medic finished the job. */
export function treatPatient(state, patient, engine) {
  if (!patient || patient.treated) return false;
  if ((engine.kits ?? 0) < 1) return false;
  engine.kits -= 1;
  patient.treated = true;
  patient.claimedBy = null;
  patient.leaveAt = state.time + 3;
  state.stats.treated = (state.stats.treated ?? 0) + 1;
  state.rating = Math.min(CONFIG.rating.start, state.rating + 2);
  const fee = earn(state, CONFIG.economy.treated, 'treatment');
  addEvent(state, `Patient stabilised near ${patient.buildingName} — ${money(fee)}`, 'good');
  return true;
}

export function updatePatients(state, dt) {
  for (let i = state.patients.length - 1; i >= 0; i--) {
    const p = state.patients[i];
    if (p.treated) {
      if (state.time >= p.leaveAt) state.patients.splice(i, 1);
      continue;
    }
    // Drop claims whose ambulance or paramedic has been called off.
    if (p.claimedBy && !state.engines.some((e) => e.id === p.claimedBy && e.patientId === p.id)) {
      p.claimedBy = null;
    }
    if (p.medicId && !state.crew.some((c) => c.id === p.medicId && c.patientId === p.id && !c.riding)) {
      p.medicId = null;
    }
    p.life -= dt;
    if (p.life <= 0) {
      state.stats.casualties += 1;
      state.rating = Math.max(0, state.rating - 6);
      spend(state, CONFIG.economy.casualtyPenalty, 'casualty');
      addEvent(state, `An injured person near ${p.buildingName} did not survive`, 'bad');
      state.patients.splice(i, 1);
    }
  }
}

// ----------------------------------------------------------------- kits ---

/** The pharmacy whose footprint is within restock range of the vehicle, if any. */
export function pharmacyInReach(state, engine) {
  const range = CONFIG.medical.pharmacyRange * TILE;
  for (const b of state.city.pharmacies ?? []) {
    if (b.state === 'rubble') continue;
    if (distToRect(engine.x, engine.y, buildingRectOf(b)) <= range) return b;
  }
  return null;
}

export function nearestPharmacy(state, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const b of state.city.pharmacies ?? []) {
    if (b.state === 'rubble') continue;
    const d = distToRect(x, y, buildingRectOf(b));
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Top up an ambulance's kits. Free but slow on the station apron; fast and paid
 * for beside a pharmacy. Returns true while it is restocking.
 */
export function restockKits(state, engine, dt, onApron) {
  const max = engine.spec.kits ?? 0;
  if (engine.kits >= max) return false;
  const med = CONFIG.medical;
  if (onApron) {
    engine.kitAcc = (engine.kitAcc ?? 0) + med.stationRestock * dt;
  } else if (pharmacyInReach(state, engine)) {
    if (state.credits < CONFIG.economy.kitPrice) return false;
    engine.kitAcc = (engine.kitAcc ?? 0) + med.pharmacyRestock * dt;
  } else {
    return false;
  }
  while (engine.kitAcc >= 1 && engine.kits < max) {
    engine.kitAcc -= 1;
    engine.kits += 1;
    if (!onApron) spend(state, CONFIG.economy.kitPrice, 'kits');
  }
  if (engine.kits >= max) engine.kitAcc = 0;
  return true;
}
