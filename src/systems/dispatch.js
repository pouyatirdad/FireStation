// "Dispatch all": look at every open incident and every free vehicle and give
// each vehicle its own job, so a big night does not send the whole fleet to one
// fire. Every incident gets exactly one suitable vehicle (nearest pairs first);
// vehicles left over stay in quarters. "Back all" sends everything home.

import { TILE } from '../core/config.js';
import { dist } from '../core/math.js';
import { addEvent } from './events.js';
import { activeFires } from './fire.js';
import { findPatient, isMedical } from './medical.js';
import {
  boatCanReach, canDive, crewOf, isFirefighter, orderAmbulanceToPatient, orderEngine,
  orderEngineToBlockade, orderEngineToVictim, orderEngineToWildfire, sendEngineHome, sendToHospital,
  toolCount, toolsFree,
} from './units.js';

/** Is anyone from this vehicle on the ground and busy (spraying, rescuing, cutting, diving, treating)? */
function crewBusy(state, engine) {
  return crewOf(state, engine).some((c) => !c.riding && (
    c.spraying || c.rescueId || c.wildfireId || c.cut || c.victimId || c.fetch || c.patientId
    || c.treatTimer > 0 || c.tool === 'cutter' || c.tool === 'diving'
  ));
}

/** A vehicle with nothing to do: not driving, not packing up, not tied to a job. */
export function isFree(state, engine) {
  return engine.path.length === 0 && engine.packTimer === 0
    && !engine.targetId && !engine.wildfireId && !engine.blockadeId && !engine.victimId
    && !engine.patientId && !crewBusy(state, engine);
}

/** Every open incident, most urgent first, with how many vehicles it should get. */
export function openJobs(state) {
  const jobs = [];
  const covered = (pred) => state.engines.filter(pred).length;
  for (const b of activeFires(state)) {
    const area = b.w * b.h;
    const want = Math.max(1, Math.min(4, 1 + Math.floor(b.fire * 2) + (area >= 70 ? 1 : 0) + (b.big ? 1 : 0)));
    jobs.push({
      key: b.id, kind: 'fire', tier: 0, want, ref: b,
      x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE,
      urgency: 600 + b.fire * 100 + (b.trapped ?? 0) * 40,
      have: covered((e) => e.targetId === b.id),
    });
  }
  for (const b of state.buildings) {
    if ((b.trapped ?? 0) <= 0 || b.state === 'burning' || b.state === 'rubble') continue;
    jobs.push({
      key: b.id, kind: 'fire', tier: 0, want: 1, ref: b,
      x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE,
      urgency: 700,
      have: covered((e) => e.targetId === b.id),
    });
  }
  for (const w of state.wildfires ?? []) {
    jobs.push({
      key: w.id, kind: 'wildfire', tier: 0, want: Math.max(1, Math.min(4, Math.round(w.radius / (TILE * 6)))), ref: w,
      x: w.x, y: w.y, urgency: 650 + w.intensity * 100,
      // A vehicle counts while it drives there, and again once its crew are out on it.
      have: new Set([
        ...state.engines.filter((e) => e.wildfireId === w.id).map((e) => e.id),
        ...state.crew.filter((c) => !c.riding && c.wildfireId === w.id).map((c) => c.engineId),
      ]).size,
    });
  }
  for (const v of state.victims ?? []) {
    jobs.push({
      key: v.id, kind: 'victim', tier: 0, want: 1, ref: v, x: v.x, y: v.y,
      urgency: 1000 - v.life,
      have: v.diverId || covered((e) => e.victimId === v.id) ? 1 : 0,
    });
  }
  for (const p of state.patients ?? []) {
    if (p.treated) continue;
    jobs.push({
      key: p.id, kind: 'patient', tier: 0, want: 1, ref: p, x: p.x, y: p.y,
      urgency: 500 - p.life + (p.critical ? 80 : 0),
      have: p.claimedBy && findPatient(state, p.id) ? 1 : 0,
    });
  }
  for (const w of state.blockades ?? []) {
    jobs.push({
      key: w.id, kind: 'blockade', tier: 1, want: 1, ref: w, x: w.x, y: w.y,
      urgency: 300 + (w.big ? 50 : 0),
      have: covered((e) => e.blockadeId === w.id),
    });
  }
  jobs.sort((a, b) => b.urgency - a.urgency);
  return jobs;
}

/** A tank (or bucket) that is nearly empty is no use at a fire. */
const lowOnWater = (engine) => engine.capacity > 0 && engine.capacity < 50000
  && engine.water < engine.capacity * 0.15;

/** How well a vehicle suits a job: lower is better, Infinity if it cannot do it. */
function cost(state, engine, job) {
  const d = dist(engine.x, engine.y, job.x, job.y);
  switch (job.kind) {
    case 'fire': {
      if (!isFirefighter(engine) || lowOnWater(engine)) return Infinity;
      if (engine.spec.boat && !boatCanReach(state, engine, job.x, job.y, Math.max(job.ref.w, job.ref.h) / 2)) return Infinity;
      return d * (engine.spec.hydrantOnly ? 1.6 : 1);
    }
    case 'wildfire': {
      if (!isFirefighter(engine) || engine.spec.hydrantOnly || lowOnWater(engine)) return Infinity;
      if (engine.spec.boat && !boatCanReach(state, engine, job.x, job.y, job.ref.radius / TILE)) return Infinity;
      return d * (engine.spec.flying ? 0.45 : 1);
    }
    case 'patient':
      return isMedical(engine) && (engine.kits ?? 0) >= 1 ? d : Infinity;
    case 'victim':
      if (!canDive(engine) || (!engine.spec.diver && toolsFree(state, engine, 'diving') <= 0)) return Infinity;
      return d * (engine.spec.boat ? 0.7 : 1);
    case 'blockade':
      if (!isFirefighter(engine) || engine.spec.flying || engine.spec.boat) return Infinity;
      return d * (toolCount(engine, 'cutter') > 0 ? 0.6 : 1);
    default:
      return Infinity;
  }
}

function order(state, engine, job) {
  switch (job.kind) {
    case 'fire':
      return orderEngine(state, engine, job.x, job.y, job.ref.id);
    case 'wildfire':
      return orderEngineToWildfire(state, engine, job.ref);
    case 'patient':
      return orderAmbulanceToPatient(state, engine, job.ref);
    case 'victim':
      return orderEngineToVictim(state, engine, job.ref);
    case 'blockade':
      return orderEngineToBlockade(state, engine, job.ref);
    default:
      return false;
  }
}

/**
 * Send every free vehicle where it is needed. Returns what happened:
 * `{ sent, jobs, uncovered, hospital }`.
 */
export function dispatchAll(state) {
  const result = { sent: 0, jobs: 0, uncovered: 0, hospital: 0 };

  // Ambulances with patients aboard go to the hospital before anything else.
  for (const engine of state.engines) {
    if (!isMedical(engine) || engine.path.length > 0 || (engine.cargo?.length ?? 0) === 0) continue;
    if (sendToHospital(state, engine)) result.hospital++;
  }

  const jobs = openJobs(state);
  result.jobs = jobs.length;
  if (jobs.length === 0) {
    if (result.hospital === 0) addEvent(state, 'Nothing to dispatch — the district is quiet', 'info');
    return result;
  }

  const free = new Set(state.engines.filter((e) => isFree(state, e) && !((e.cargo?.length ?? 0) > 0)));
  const failed = new Set();

  // One vehicle per incident: life and fire first, then wrecks.
  for (const tier of [0, 1]) {
    for (;;) {
      let best = null;
      let bestCost = Infinity;
      for (const job of jobs) {
        if (job.tier !== tier || job.have >= 1) continue;
        for (const engine of free) {
          if (failed.has(job.key + '|' + engine.id)) continue;
          const c = cost(state, engine, job);
          if (c < bestCost) {
            bestCost = c;
            best = { job, engine };
          }
        }
      }
      if (!best) break;
      if (order(state, best.engine, best.job)) {
        free.delete(best.engine);
        best.job.have++;
        result.sent++;
      } else {
        failed.add(best.job.key + '|' + best.engine.id);
      }
    }
  }

  result.uncovered = jobs.filter((j) => j.have === 0).length;
  if (result.sent > 0) {
    addEvent(
      state,
      `Dispatched ${result.sent} unit${result.sent === 1 ? '' : 's'} to ${jobs.length - result.uncovered} incident${jobs.length - result.uncovered === 1 ? '' : 's'}`,
      'good',
    );
  }
  if (result.uncovered > 0) {
    addEvent(state, `${result.uncovered} incident${result.uncovered === 1 ? ' has' : 's have'} no free unit — buy more vehicles or wait for one to clear`, 'warn');
  } else if (result.sent === 0 && result.hospital === 0) {
    addEvent(state, 'Every incident already has a unit on it', 'info');
  }
  return result;
}


/**
 * Back all: every vehicle that is out goes back to its own base and drops its
 * job. An ambulance with patients aboard takes them to the hospital first (it
 * returns to its base by itself afterwards).
 */
export function returnAll(state) {
  const result = { sent: 0, hospital: 0 };
  for (const engine of state.engines) {
    if (isMedical(engine) && (engine.cargo?.length ?? 0) > 0) {
      if (sendToHospital(state, engine)) result.hospital++;
      continue;
    }
    const bay = state.city.bays[engine.bayIndex];
    const home = bay && engine.path.length === 0 && dist(engine.x, engine.y, bay.x, bay.y) < TILE * 1.5;
    if (home) continue;
    if (engine.patientId) {
      const patient = findPatient(state, engine.patientId);
      if (patient && patient.claimedBy === engine.id) patient.claimedBy = null;
      engine.patientId = null;
    }
    if (sendEngineHome(state, engine)) {
      engine.wildfireId = null;
      engine.blockadeId = null;
      engine.victimId = null;
      engine.targetId = null;
      result.sent++;
    }
  }
  if (result.sent + result.hospital > 0) {
    addEvent(
      state,
      `${result.sent} vehicle${result.sent === 1 ? '' : 's'} returning to base` + (result.hospital > 0 ? `, ${result.hospital} to the hospital first` : ''),
      'info',
    );
  } else {
    addEvent(state, 'Every vehicle is already in quarters', 'info');
  }
  return result;
}
