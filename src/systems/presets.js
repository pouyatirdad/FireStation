// Dispatch presets: named vehicle combinations ("Building fire: 2 engines, a
// ladder, an ambulance and a rescue unit") that go to one incident with one
// action. A preset says what it wants; `planPreset` finds the free vehicles that
// can do the job, soonest first, and says plainly what is missing.
//
// Presets are data on `state.presets`, saved with the shift and (in a career) with
// the campaign. Orders go through the same `order` the dispatch-all code uses.

import { CONFIG, TILE } from '../core/config.js';
import { dist } from '../core/math.js';
import { addEvent } from './events.js';
import { cost, isFree, order } from './dispatch.js';
import { estimate, currentTarget, incidentPoint } from './eta.js';
import { isMedical } from './medical.js';
import { orderEngine, sendEngineHome, ownsStation, unstaffed } from './units.js';
import { findPatient } from './medical.js';


export const INCIDENT_KINDS = {
  fire: 'Building fire',
  wildfire: 'Forest fire',
  accident: 'Traffic accident',
  medical: 'Medical',
  water: 'Water rescue',
  hazmat: 'Hazmat',
  any: 'Any incident',
};

const MAX_NAME = 32;
const MAX_PER_TYPE = 8;
const MAX_TOTAL = 14;

export function defaultPresets() {
  return [
    { id: 'preset-building', name: 'Building fire', incident: 'fire', units: { engine: 2, ladder: 1, ambulance: 1, rescue: 1 } },
    { id: 'preset-forest', name: 'Forest fire', incident: 'wildfire', units: { engine: 2, tanker: 1, helicopter: 1 } },
    { id: 'preset-accident', name: 'Major traffic accident', incident: 'accident', units: { rescue: 1, ambulance: 2, engine: 1 } },
    { id: 'preset-medical', name: 'Medical emergency', incident: 'medical', units: { ambulance: 1 } },
    { id: 'preset-water', name: 'Water rescue', incident: 'water', units: { rescueboat: 1, ambulance: 1 } },
    { id: 'preset-hazmat', name: 'Hazmat incident', incident: 'hazmat', units: { hazmat: 1, engine: 1, ambulance: 1 } },
  ];
}

export function restorePresets(list) {
  if (!Array.isArray(list)) return defaultPresets();
  const clean = [];
  for (const p of list) {
    const v = validatePreset(p, []);
    if (v.ok) clean.push(v.preset);
  }
  return clean;
}

/** Check a preset; returns `{ ok, preset }` (normalised) or `{ ok: false, error }`. */
export function validatePreset(input, others = []) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Not a preset' };
  const name = String(input.name ?? '').trim().slice(0, MAX_NAME);
  if (!name) return { ok: false, error: 'Give the preset a name' };
  if (others.some((o) => o.id !== input.id && o.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Another preset has that name' };
  }
  const incident = input.incident in INCIDENT_KINDS ? input.incident : 'any';
  const units = {};
  let total = 0;
  for (const [type, raw] of Object.entries(input.units ?? {})) {
    if (!CONFIG.vehicles[type]) return { ok: false, error: `Unknown vehicle: ${type}` };
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: `Bad count for ${type}` };
    if (n === 0) continue;
    if (n > MAX_PER_TYPE) return { ok: false, error: `At most ${MAX_PER_TYPE} of one type` };
    units[type] = n;
    total += n;
  }
  if (total === 0) return { ok: false, error: 'Add at least one vehicle' };
  if (total > MAX_TOTAL) return { ok: false, error: `At most ${MAX_TOTAL} vehicles in a preset` };
  return { ok: true, preset: { id: input.id ?? null, name, incident, units } };
}

let seq = 1;

export function createPreset(state, input) {
  const v = validatePreset(input, state.presets);
  if (!v.ok) return v;
  let id;
  do id = `preset-${Date.now().toString(36)}-${seq++}`; while (state.presets.some((p) => p.id === id));
  v.preset.id = id;
  state.presets.push(v.preset);
  return v;
}

export function updatePreset(state, id, input) {
  const index = state.presets.findIndex((p) => p.id === id);
  if (index < 0) return { ok: false, error: 'No such preset' };
  const v = validatePreset({ ...input, id }, state.presets);
  if (!v.ok) return v;
  state.presets[index] = v.preset;
  return v;
}

export function deletePreset(state, id) {
  const before = state.presets.length;
  state.presets = state.presets.filter((p) => p.id !== id);
  return state.presets.length < before;
}

export const findPreset = (state, id) => state.presets.find((p) => p.id === id) ?? null;

// --------------------------------------------------------------- targets ---

const KIND_OF = { building: 'fire', wildfire: 'wildfire', patient: 'patient', victim: 'victim', blockade: 'blockade' };

/** A dispatch job (the shape `dispatch.js` orders from) for an incident, or null. */
export function jobFor(state, target) {
  const p = incidentPoint(state, target.kind, target.id);
  if (!p) return null;
  let ref;
  if (target.kind === 'building') ref = state.buildings.find((b) => b.id === target.id);
  else if (target.kind === 'wildfire') ref = state.wildfires.find((w) => w.id === target.id);
  else if (target.kind === 'patient') ref = findPatient(state, target.id);
  else if (target.kind === 'victim') ref = state.victims.find((v) => v.id === target.id);
  else ref = state.blockades.find((b) => b.id === target.id);
  if (!ref) return null;
  return { key: target.id, kind: KIND_OF[target.kind], kindOfTarget: target.kind, ref, x: p.x, y: p.y };
}

/** Which preset kind suits an incident. */
export function presetKindFor(state, target) {
  if (target.kind === 'wildfire') return 'wildfire';
  if (target.kind === 'patient') return 'medical';
  if (target.kind === 'victim') return 'water';
  if (target.kind === 'blockade') return 'accident';
  const b = state.buildings.find((x) => x.id === target.id);
  return b?.hazmat ? 'hazmat' : 'fire';
}

/** Presets that fit an incident: the matching kind first, then the general ones. */
export function recommendedPresets(state, target) {
  const kind = presetKindFor(state, target);
  return [
    ...state.presets.filter((p) => p.incident === kind),
    ...state.presets.filter((p) => p.incident === 'any'),
  ];
}

// ------------------------------------------------------------- stations ---

/** Owned land stations by distance from a point, with how many vehicles are free there. */
export function nearestStations(state, x, y) {
  const out = [];
  state.city.stations.forEach((st, i) => {
    if (!ownsStation(state, i) || st.sea) return;
    const b = st.building;
    const sx = (b.x + b.w / 2) * TILE;
    const sy = (b.y + b.h / 2) * TILE;
    const here = state.engines.filter((e) => state.city.bays[e.bayIndex]?.station === i);
    out.push({
      index: i, name: st.name, distance: dist(sx, sy, x, y) / TILE,
      vehicles: here.length, available: here.filter((e) => isFree(state, e) && !unstaffed(state, e)).length,
    });
  });
  return out.sort((a, b) => a.distance - b.distance);
}

export function availableVehicles(state) {
  const counts = {};
  for (const e of state.engines) {
    if (!isFree(state, e) || unstaffed(state, e)) continue;
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return counts;
}

// ------------------------------------------------------------------ plan ---

/** Medical vehicles sent to a fire, a wreck or a forest fire stand by near it (there is nobody to treat yet). */
const standby = (engine, job) => isMedical(engine) && job.kind !== 'patient';

/** How well a vehicle suits a job (lower is better; Infinity if it cannot do it). */
function fitness(state, engine, job) {
  if (standby(engine, job)) return (engine.kits ?? 0) >= 1 ? dist(engine.x, engine.y, job.x, job.y) : Infinity;
  return cost(state, engine, job);
}

function sendTo(state, engine, job) {
  if (!standby(engine, job)) return order(state, engine, job);
  const ok = orderEngine(state, engine, job.x, job.y, null);
  if (ok) engine.standbyFor = { kind: job.kindOfTarget, id: job.key };
  return ok;
}

/** Is this vehicle already on its way to (or standing by at) this incident? */
const onJob = (state, engine, target) => {
  const t = currentTarget(engine);
  if (t && t.kind === target.kind && t.id === target.id) return true;
  const s = engine.standbyFor;
  if (!s || s.kind !== target.kind || s.id !== target.id) return false;
  const p = incidentPoint(state, target.kind, target.id);
  return Boolean(p) && (engine.path.length > 0 || dist(engine.x, engine.y, p.x, p.y) < 14 * TILE);
};

/**
 * Work out who a preset would send. Vehicles already on this incident count
 * towards the preset, so pressing it twice does not send a second set.
 */
export function planPreset(state, preset, target) {
  const job = jobFor(state, target);
  const plan = { preset: preset.name, assignments: [], already: [], missing: {}, warnings: [], station: null, job };
  if (!job) {
    plan.warnings.push('That incident is over');
    return plan;
  }
  plan.station = nearestStations(state, job.x, job.y)[0] ?? null;
  const used = new Set();
  for (const [type, want] of Object.entries(preset.units)) {
    const on = state.engines.filter((e) => e.type === type && onJob(state, e, target) && !used.has(e.id));
    for (const e of on.slice(0, want)) {
      used.add(e.id);
      plan.already.push(e);
    }
    let need = want - Math.min(want, on.length);
    if (need <= 0) continue;
    const ranked = [];
    for (const e of state.engines) {
      if (e.type !== type || used.has(e.id) || !isFree(state, e)) continue;
      if (unstaffed(state, e)) continue;
      if (!Number.isFinite(fitness(state, e, job))) continue;
      const eta = estimate(state, e, job.x, job.y);
      if (!eta.reachable) continue;
      ranked.push({ engine: e, seconds: eta.seconds });
    }
    ranked.sort((a, b) => a.seconds - b.seconds);
    for (const r of ranked.slice(0, need)) {
      used.add(r.engine.id);
      plan.assignments.push(r);
      need -= 1;
    }
    if (need > 0) plan.missing[type] = need;
  }
  for (const [type, n] of Object.entries(plan.missing)) {
    const owned = state.engines.filter((e) => e.type === type).length;
    plan.warnings.push(owned === 0
      ? `No ${CONFIG.vehicles[type].label} in the fleet (${n} wanted)`
      : `${n} more ${CONFIG.vehicles[type].label} wanted — all busy or unable to reach`);
  }
  if (plan.assignments.length === 0 && plan.already.length === 0 && plan.warnings.length === 0) {
    plan.warnings.push('Nothing to send');
  }
  return plan;
}

/** Send a preset to an incident. Returns the plan with `sent` filled in. */
export function applyPreset(state, presetId, target) {
  const preset = findPreset(state, presetId);
  if (!preset) return null;
  const plan = planPreset(state, preset, target);
  plan.sent = 0;
  if (!plan.job) return plan;
  for (const a of plan.assignments) {
    if (sendTo(state, a.engine, plan.job)) plan.sent += 1;
    else plan.warnings.push(`${a.engine.name} could not take the order`);
  }
  if (plan.sent > 0) {
    addEvent(state, `${preset.name}: ${plan.sent} unit${plan.sent === 1 ? '' : 's'} dispatched` +
      (plan.already.length ? ` (${plan.already.length} already there)` : ''), 'good');
  } else if (plan.already.length > 0 && Object.keys(plan.missing).length === 0) {
    addEvent(state, `${preset.name}: the full response is already on its way`, 'info');
  }
  for (const w of plan.warnings) addEvent(state, `Dispatch: ${w}`, 'warn');
  return plan;
}

// ---------------------------------------------------- orders in progress ---

/** Call a vehicle off its job; it returns to its station. */
export function cancelDispatch(state, engineId) {
  const engine = state.engines.find((e) => e.id === engineId);
  if (!engine || !currentTarget(engine)) return false;
  engine.targetId = null;
  engine.wildfireId = null;
  engine.blockadeId = null;
  engine.victimId = null;
  if (engine.patientId) {
    const patient = findPatient(state, engine.patientId);
    if (patient && patient.claimedBy === engine.id) patient.claimedBy = null;
    engine.patientId = null;
  }
  engine.mission = null;
  engine.standbyFor = null;
  const ok = sendEngineHome(state, engine);
  addEvent(state, `${engine.name} called off`, 'info');
  return ok;
}

/** Send a vehicle that is already out to a different incident. */
export function redirectDispatch(state, engineId, target) {
  const engine = state.engines.find((e) => e.id === engineId);
  const job = jobFor(state, target);
  if (!engine || !job) return false;
  if (!Number.isFinite(cost(state, engine, job))) {
    addEvent(state, `${engine.name} cannot work that incident`, 'warn');
    return false;
  }
  const ok = order(state, engine, job);
  if (ok) addEvent(state, `${engine.name} redirected`, 'info');
  return ok;
}
