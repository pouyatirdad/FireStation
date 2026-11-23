// Support agencies: police, emergency medical service, civil protection, utility
// services and the coast guard. Each is a call-out with a cost, a response time,
// a cooldown and one effect, not a simulated service of its own.
//
//   police      traffic control round the scene: no rush-hour penalty for your
//               vehicles there, wrecks cleared faster (modifiers.supportAt)
//   ems         treats up to four injured people near the scene
//   civil       a shelter and a faster evacuation of the area (evacuation.js)
//   utility     cuts gas and power to a building: no explosion, slower fire
//   coastguard  pulls people out of the water near the scene

import { CONFIG, TILE } from '../core/config.js';
import { addEvent } from './events.js';
import { spend, money } from './economy.js';
import { isCareer } from './modifiers.js';
import { deliverPatients, hospitalById, nearestHospital, treatPatient } from './medical.js';
import { rescueVictim } from './water.js';
import { startEvacuation } from './evacuation.js';
import { incidentPoint } from './eta.js';

/** Department level at which each agency can be called in a career. */
export const UNLOCK = { police: 1, ems: 1, civil: 2, utility: 2, coastguard: 3 };
const RADIUS = { police: 14, ems: 20, civil: 14, utility: 3, coastguard: 25 };

export function createSupport() {
  return { active: [], cooldowns: {}, seq: 1, calls: 0 };
}

export function restoreSupport(data) {
  const s = createSupport();
  if (!data) return s;
  return {
    ...s,
    ...data,
    active: Array.isArray(data.active)
      ? data.active.map((a) => ({ ...a, cargo: Array.isArray(a.cargo) ? a.cargo.map((c) => ({ ...c })) : undefined }))
      : [],
    cooldowns: { ...(data.cooldowns ?? {}) },
  };
}

export function agencyStatus(state, agency) {
  const cfg = CONFIG.agencies[agency];
  if (!cfg) return null;
  const cooldown = Math.max(0, (state.support.cooldowns[agency] ?? 0) - state.time);
  const need = UNLOCK[agency] ?? 1;
  const locked = isCareer(state) && state.campaign.level < need;
  const running = state.support.active.some((a) => a.agency === agency);
  let reason = null;
  if (locked) reason = `Unlocked at department level ${need}`;
  else if (cooldown > 0) reason = `Available again in ${Math.ceil(cooldown)} s`;
  else if (state.credits < cfg.cost) reason = `Needs ${money(cfg.cost)}`;
  return { agency, label: cfg.label, text: cfg.text, cost: cfg.cost, delay: cfg.delay, cooldown, locked, running, ready: !reason, reason };
}

export function allAgencies(state) {
  return Object.keys(CONFIG.agencies).map((a) => agencyStatus(state, a));
}

/** Call an agency to a place: `target` is `{ kind, id }` of an incident or `{ x, y }`. */
export function callAgency(state, agency, target) {
  const status = agencyStatus(state, agency);
  if (!status) return null;
  if (!status.ready) {
    addEvent(state, `${status.label}: ${status.reason}`, 'warn');
    return null;
  }
  const point = target.kind ? incidentPoint(state, target.kind, target.id) : { x: target.x, y: target.y };
  if (!point) {
    addEvent(state, `${status.label}: that incident is over`, 'warn');
    return null;
  }
  const cfg = CONFIG.agencies[agency];
  spend(state, cfg.cost, 'agency');
  const call = {
    id: `support${state.support.seq++}`, agency, x: point.x, y: point.y, radius: RADIUS[agency] * TILE,
    calledAt: state.time, arriveAt: state.time + cfg.delay, until: state.time + cfg.delay + cfg.duration,
    targetKind: target.kind ?? null, targetId: target.id ?? null, applied: false,
  };
  state.support.active.push(call);
  state.support.cooldowns[agency] = state.time + cfg.cooldown;
  state.support.calls += 1;
  addEvent(state, `${cfg.label} called — arriving in ${cfg.delay} s (${money(cfg.cost)})`, 'info');
  return call;
}

function applyOnArrival(state, call) {
  call.applied = true;
  const label = CONFIG.agencies[call.agency].label;
  if (call.agency === 'ems') {
    // A crew with a full bag: it treats the worst cases near the scene and takes the critical ones to a hospital.
    const bag = { kits: 99, cargo: [], spec: { carry: CONFIG.agencies.ems.carry }, worked: false, name: label };
    const near = state.patients
      .filter((p) => !p.treated && Math.hypot(p.x - call.x, p.y - call.y) <= call.radius)
      .sort((a, b) => a.life - b.life)
      .slice(0, 4);
    for (const p of near) treatPatient(state, p, bag);
    call.cargo = bag.cargo;
    addEvent(state, `${label} on scene — ${near.length} patient${near.length === 1 ? '' : 's'} treated`, 'good');
  } else if (call.agency === 'civil') {
    const zone = state.evac.zones.find((z) => Math.hypot(z.x - call.x, z.y - call.y) <= z.radius);
    if (!zone) startEvacuation(state, { x: call.x, y: call.y, label: 'the scene' });
    addEvent(state, `${label} on scene — shelter open, evacuation running at double pace`, 'good');
  } else if (call.agency === 'utility') {
    const b = call.targetKind === 'building' ? state.buildings.find((x) => x.id === call.targetId) : nearestBuilding(state, call.x, call.y);
    if (b) {
      b.utilityCut = true;
      addEvent(state, `${label} on scene — gas and power cut at ${b.name}`, 'good');
    }
  } else if (call.agency === 'coastguard') {
    const near = state.victims
      .filter((v) => Math.hypot(v.x - call.x, v.y - call.y) <= call.radius)
      .slice(0, 3);
    for (const v of near) rescueVictim(state, v);
    addEvent(state, `${label} on scene — ${near.length} pulled from the water`, near.length ? 'good' : 'info');
  } else {
    addEvent(state, `${label} on scene — streets closed round the incident`, 'good');
  }
}

function nearestBuilding(state, x, y) {
  let best = null;
  let bestD = 8 * TILE;
  for (const b of state.buildings) {
    if (b.state === 'rubble') continue;
    const d = Math.hypot((b.x + b.w / 2) * TILE - x, (b.y + b.h / 2) * TILE - y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * The service's own ambulance takes its critical patients to a hospital: the nearest one that is open when
 * it sets off, and again when it gets there (a hospital lost on the way is not used; it drives on to the next).
 * Nobody is left behind: with no hospital open the patients wait aboard and it tries again.
 */
const emsDrive = (from, h) => Math.hypot((h.x + h.w / 2) * TILE - from.x, (h.y + h.h / 2) * TILE - from.y)
  / (CONFIG.vehicles.ambulance.speed * TILE);

function deliverEmsCargo(state, call) {
  const cargo = call.cargo;
  if (!cargo || cargo.length === 0) return;
  if (call.deliverAt != null && state.time < call.deliverAt) return; // still driving
  const hospital = nearestHospital(state, call.x, call.y);
  if (!hospital) {
    if (!call.waiting) addEvent(state, `${CONFIG.agencies.ems.label}: no hospital open — patients wait aboard`, 'warn');
    call.waiting = true;
    call.hospitalId = null;
    call.deliverAt = state.time + CONFIG.medical.hospital.retry;
    return;
  }
  call.waiting = false;
  if (call.hospitalId == null) {
    // Setting off from the scene.
    call.hospitalId = hospital.id;
    call.deliverAt = state.time + emsDrive(call, hospital);
    return;
  }
  if (call.hospitalId !== hospital.id) {
    // The hospital it was heading for is gone: on to the next, from where the first one stands.
    const lost = hospitalById(state, call.hospitalId) ?? call;
    const from = lost.w ? { x: (lost.x + lost.w / 2) * TILE, y: (lost.y + lost.h / 2) * TILE } : lost;
    addEvent(state, `${CONFIG.agencies.ems.label}: hospital out of service — diverted to ${hospital.name}`, 'warn');
    call.hospitalId = hospital.id;
    call.deliverAt = state.time + emsDrive(from, hospital);
    return;
  }
  deliverPatients(state, CONFIG.agencies.ems.label, cargo, hospital);
}

export function updateSupport(state) {
  const s = state.support;
  if (!s || s.active.length === 0) return;
  for (const call of s.active) {
    if (!call.applied && state.time >= call.arriveAt) applyOnArrival(state, call);
    if (call.agency === 'ems' && call.applied) deliverEmsCargo(state, call);
  }
  // A call stays on the books until its patients have been delivered.
  s.active = s.active.filter((c) => state.time <= c.until || (c.cargo?.length ?? 0) > 0);
}
