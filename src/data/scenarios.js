// Scenario data: the built-in challenges and the format custom scenarios share.
//
// A scenario is plain data (JSON-safe) so it can be saved, edited, shared and
// extended later (a map editor would only add new `location` kinds):
//
//   id, name, text, version
//   start      { seed, clock, credits, fleet: [{ type, station }], weather, windSpeed, windDir }
//   rules      { noHydrants, noLoan, noBuy, random, randomRate }
//   incidents  [{ at, kind, location, intensity, trapped, injured, scene, disaster }]
//   timeLimit  seconds, or null
//   success    { resolveAll, surviveTime, maxCasualties, minSaved, minCredits }
//   failure    { maxCasualties, maxLost, minCredits }

import { CONFIG } from '../core/config.js';
import { WEATHER } from '../systems/weather.js';
import { SCENES } from '../systems/scenes.js';

export const SCENARIO_VERSION = 1;

export const INCIDENT_KINDS = {
  'building-fire': 'Building fire',
  wildfire: 'Forest fire',
  pileup: 'Highway pile-up',
  crash: 'Traffic accident',
  medical: 'Medical emergency',
  water: 'Person in the water',
  leak: 'Chemical leak',
  collapse: 'Building collapse',
  scene: 'Story scene',
  disaster: 'Major disaster',
};

export const LOCATION_TYPES = ['house', 'apartment', 'shop', 'office', 'hotel', 'warehouse', 'factory', 'tower', 'mall', 'school', 'tankfarm', 'villa', 'pharmacy'];
export const DISASTER_KINDS = ['earthquake', 'hurricane', 'airport', 'industrial', 'siege', 'blocks'];

const d = (type, station = 0) => ({ type, station });
const many = (type, n, station = 0) => Array.from({ length: n }, () => d(type, station));

export const CHALLENGES = [
  {
    id: 'one-engine', name: 'One Engine Only', version: 1, builtin: true,
    text: 'A single engine and its crew for ten minutes. Pick your fights.',
    start: { clock: 8 * 60, credits: 1500, fleet: [d('engine')] },
    rules: { random: true, randomRate: 1 },
    incidents: [{ at: 15, kind: 'building-fire', location: { kind: 'auto' }, intensity: 0.2, trapped: 1, injured: 0 }],
    timeLimit: 600,
    success: { surviveTime: true, maxCasualties: 3 },
    failure: { maxCasualties: 6 },
  },
  {
    id: 'no-water', name: 'No Water Supply', version: 1, builtin: true,
    text: 'The mains are down: hydrants are dead. Tankers and the station tank are all you have.',
    start: { clock: 9 * 60, credits: 2000, fleet: [d('engine'), d('tanker'), d('tanker')] },
    rules: { noHydrants: true, random: false },
    incidents: [
      { at: 10, kind: 'building-fire', location: { kind: 'type', type: 'warehouse' }, intensity: 0.4, trapped: 0, injured: 0 },
      { at: 150, kind: 'building-fire', location: { kind: 'type', type: 'office' }, intensity: 0.3, trapped: 2, injured: 1 },
    ],
    timeLimit: 600,
    success: { resolveAll: true },
    failure: { maxLost: 3 },
  },
  {
    id: 'night', name: 'Night Emergency', version: 1, builtin: true,
    text: 'From 22:00, more calls than usual and little light. Keep the casualties down.',
    start: { clock: 22 * 60, credits: 3000, fleet: [d('engine'), d('ladder'), d('ambulance')] },
    rules: { random: true, randomRate: 1.4 },
    incidents: [],
    timeLimit: 600,
    success: { surviveTime: true, maxCasualties: 2, minSaved: 4 },
    failure: { maxCasualties: 5 },
  },
  {
    id: 'highway', name: 'Highway Disaster', version: 1, builtin: true,
    text: 'A pile-up on the avenue, then a second crash. Clear the road and treat everyone.',
    start: { clock: 17 * 60, credits: 2500, fleet: [d('rescue'), d('ambulance'), d('ambulance'), d('engine'), d('engine'), d('tanker')] },
    rules: { random: false },
    incidents: [
      { at: 8, kind: 'pileup', location: { kind: 'auto' }, intensity: 0.5, trapped: 0, injured: 0 },
      { at: 90, kind: 'crash', location: { kind: 'auto' }, intensity: 0.4, trapped: 0, injured: 0 },
    ],
    timeLimit: 480,
    success: { resolveAll: true },
    failure: { maxCasualties: 4 },
  },
  {
    id: 'forest-siege', name: 'Forest Under Siege', version: 1, builtin: true,
    text: 'Several forest fires in a gale, with embers reaching the roads. Aircraft help.',
    start: { clock: 13 * 60, credits: 3000, weather: 'heat', windSpeed: 0.9, windDir: 40, fleet: [d('engine'), d('engine'), d('tanker'), d('tanker'), d('helicopter')] },
    rules: { random: false },
    incidents: [{ at: 5, kind: 'disaster', disaster: 'siege', location: { kind: 'auto' }, intensity: 0.5, trapped: 0, injured: 0 }],
    timeLimit: 720,
    success: { resolveAll: true },
    failure: { maxLost: 6 },
  },
  {
    id: 'budget-crisis', name: 'Budget Crisis', version: 1, builtin: true,
    text: 'Almost no money and no loans. Earn your way to $2,500 before the time runs out.',
    start: { clock: 8 * 60, credits: 600, fleet: [d('engine')] },
    rules: { noLoan: true, noBuy: false, random: true, randomRate: 1 },
    incidents: [],
    timeLimit: 600,
    success: { surviveTime: true, minCredits: 2500 },
    failure: { minCredits: -3000 },
  },
  {
    id: 'mass-casualty', name: 'Mass Casualty', version: 1, builtin: true,
    text: 'A collapse with many buried and many hurt. Treat and transport, dig out the rest.',
    start: { clock: 14 * 60, credits: 2500, fleet: [d('ambulance'), d('ambulance'), d('ambulance'), d('ambubus'), d('rescue'), d('medcar'), d('medcar')] },
    rules: { random: false },
    incidents: [
      { at: 8, kind: 'collapse', location: { kind: 'type', type: 'apartment' }, intensity: 0.2, trapped: 5, injured: 6 },
      { at: 70, kind: 'medical', location: { kind: 'auto' }, intensity: 0.8, trapped: 0, injured: 3 },
    ],
    timeLimit: 600,
    success: { resolveAll: true },
    failure: { maxCasualties: 5 },
  },
  {
    id: 'industrial', name: 'Industrial Emergency', version: 1, builtin: true,
    text: 'An explosion, a toxic leak and a tank fire at the works. Hazmat protection matters.',
    start: { clock: 10 * 60, credits: 3500, fleet: [d('engine'), d('engine'), d('hazmat'), d('rescue'), d('ambulance'), d('ambulance'), d('tanker')] },
    rules: { random: false },
    incidents: [
      { at: 8, kind: 'scene', scene: 'dust', location: { kind: 'auto' }, intensity: 0.5, trapped: 0, injured: 0 },
      { at: 40, kind: 'scene', scene: 'toxicleak', location: { kind: 'auto' }, intensity: 0.5, trapped: 0, injured: 0 },
      { at: 90, kind: 'scene', scene: 'tankvent', location: { kind: 'auto' }, intensity: 0.5, trapped: 0, injured: 0 },
    ],
    timeLimit: 600,
    success: { resolveAll: true },
    failure: { maxCasualties: 5 },
  },
];

export const findChallenge = (id) => CHALLENGES.find((c) => c.id === id) ?? null;

export function newScenarioTemplate() {
  return {
    id: null, name: 'New scenario', text: '', version: SCENARIO_VERSION, builtin: false,
    start: { clock: 9 * 60, credits: 3000, weather: 'clear', windSpeed: 0.4, windDir: 90, fleet: [d('engine'), d('ambulance')] },
    rules: { noHydrants: false, noLoan: false, noBuy: false, random: false, randomRate: 1 },
    incidents: [{ at: 10, kind: 'building-fire', location: { kind: 'auto' }, intensity: 0.3, trapped: 0, injured: 0 }],
    timeLimit: 600,
    success: { resolveAll: true },
    failure: {},
  };
}

const isInt = (n) => Number.isInteger(n);
const num = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Check a scenario; returns `{ ok, errors, scenario }` with the scenario
 * normalised (clamped, defaults filled) when it is valid. `city` (optional, `{ buildings }`)
 * lets building locations be checked against the real map.
 */
export function validateScenario(input, city = null) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['Not a scenario'], scenario: null };
  const name = String(input.name ?? '').trim();
  if (!name) errors.push('Give the scenario a name');
  if (name.length > 40) errors.push('The name is too long (40 characters at most)');

  const start = input.start ?? {};
  const weather = start.weather ?? 'clear';
  if (!WEATHER[weather]) errors.push(`Unknown weather: ${weather}`);
  const credits = num(start.credits) ? start.credits : NaN;
  if (!(credits >= 0 && credits <= 200000)) errors.push('Starting credits must be 0 to 200,000');
  const clock = num(start.clock) ? start.clock : NaN;
  if (!(clock >= 0 && clock < 1440)) errors.push('Start time must be within the day');
  const windSpeed = start.windSpeed == null ? null : start.windSpeed;
  if (windSpeed != null && !(num(windSpeed) && windSpeed >= 0 && windSpeed <= 1)) errors.push('Wind strength must be 0 to 1');
  const windDir = start.windDir == null ? null : start.windDir;
  if (windDir != null && !(num(windDir) && windDir >= 0 && windDir < 360)) errors.push('Wind direction must be 0 to 359 degrees');

  const fleet = [];
  for (const f of Array.isArray(start.fleet) ? start.fleet : []) {
    if (!f || !CONFIG.vehicles[f.type]) {
      errors.push(`Unknown vehicle: ${f?.type}`);
      continue;
    }
    fleet.push({ type: f.type, station: f.station === 2 || CONFIG.vehicles[f.type].boat ? 2 : 0 });
  }
  if (fleet.length === 0) errors.push('Add at least one vehicle');
  if (fleet.length > 16) errors.push('At most 16 vehicles');
  if (fleet.some((f) => CONFIG.vehicles[f.type].boat)) errors.push('Boats need the dock; leave them out of scenarios');

  const rules = {
    noHydrants: Boolean(input.rules?.noHydrants),
    noLoan: Boolean(input.rules?.noLoan),
    noBuy: Boolean(input.rules?.noBuy),
    random: Boolean(input.rules?.random),
    randomRate: num(input.rules?.randomRate) ? Math.min(3, Math.max(0.3, input.rules.randomRate)) : 1,
  };

  const timeLimit = input.timeLimit == null ? null : input.timeLimit;
  if (timeLimit != null && !(num(timeLimit) && timeLimit >= 60 && timeLimit <= 3600)) errors.push('Time limit must be between 60 and 3600 seconds');

  const incidents = [];
  const list = Array.isArray(input.incidents) ? input.incidents : [];
  if (list.length > 20) errors.push('At most 20 scripted incidents');
  list.forEach((it, i) => {
    const tag = `Incident ${i + 1}`;
    if (!INCIDENT_KINDS[it?.kind]) return errors.push(`${tag}: unknown type`);
    if (!(num(it.at) && it.at >= 0 && it.at <= 3600)) return errors.push(`${tag}: start time must be 0 to 3600 seconds`);
    if (timeLimit != null && it.at >= timeLimit) return errors.push(`${tag}: starts after the time limit`);
    const intensity = num(it.intensity) ? it.intensity : 0.3;
    if (intensity < 0.05 || intensity > 1) return errors.push(`${tag}: fire intensity must be 0.05 to 1`);
    const trapped = it.trapped ?? 0;
    const injured = it.injured ?? 0;
    if (!isInt(trapped) || trapped < 0 || trapped > 12) return errors.push(`${tag}: trapped people must be 0 to 12`);
    if (!isInt(injured) || injured < 0 || injured > 10) return errors.push(`${tag}: injured people must be 0 to 10`);
    const loc = it.location ?? { kind: 'auto' };
    if (!['auto', 'type', 'building'].includes(loc.kind)) return errors.push(`${tag}: unknown location kind`);
    if (loc.kind === 'type' && !LOCATION_TYPES.includes(loc.type)) return errors.push(`${tag}: unknown building type`);
    if (loc.kind === 'building') {
      if (!loc.buildingId) return errors.push(`${tag}: choose a building`);
      if (city && !city.buildings.some((b) => b.id === loc.buildingId)) return errors.push(`${tag}: that building does not exist`);
    }
    if (it.kind === 'scene' && !SCENES.some((s) => s.id === it.scene && !s.site)) return errors.push(`${tag}: unknown scene`);
    if (it.kind === 'disaster' && !DISASTER_KINDS.includes(it.disaster)) return errors.push(`${tag}: unknown disaster`);
    incidents.push({
      at: it.at, kind: it.kind, location: { ...loc }, intensity, trapped, injured,
      ...(it.kind === 'scene' ? { scene: it.scene } : {}), ...(it.kind === 'disaster' ? { disaster: it.disaster } : {}),
    });
  });
  if (incidents.length === 0 && !rules.random) errors.push('Add an incident, or turn on random calls');

  const s = input.success ?? {};
  const success = { resolveAll: Boolean(s.resolveAll), surviveTime: Boolean(s.surviveTime) };
  for (const k of ['maxCasualties', 'minSaved', 'minCredits']) {
    if (s[k] == null) continue;
    if (!num(s[k])) errors.push(`Success: ${k} must be a number`);
    else success[k] = s[k];
  }
  if (!success.resolveAll && !success.surviveTime) errors.push('Choose a success condition: resolve everything, or survive the time limit');
  if (success.surviveTime && timeLimit == null) errors.push('Survive the time limit needs a time limit');
  if (success.resolveAll && incidents.length === 0) errors.push('Resolve everything needs at least one scripted incident');

  const f = input.failure ?? {};
  const failure = {};
  for (const k of ['maxCasualties', 'maxLost', 'minCredits']) {
    if (f[k] == null) continue;
    if (!num(f[k])) errors.push(`Failure: ${k} must be a number`);
    else failure[k] = f[k];
  }

  if (errors.length) return { ok: false, errors, scenario: null };
  return {
    ok: true,
    errors: [],
    scenario: {
      id: input.id ?? null, name, text: String(input.text ?? '').slice(0, 200), version: SCENARIO_VERSION, builtin: Boolean(input.builtin),
      start: { seed: num(start.seed) ? start.seed : null, clock, credits, weather, windSpeed, windDir, fleet },
      rules, incidents: incidents.sort((a, b) => a.at - b.at), timeLimit, success, failure,
    },
  };
}

// ----------------------------------------------------- the custom library ---

/** Add or replace a custom scenario in a list; returns `{ ok, errors, list }`. Pure: storage is the caller's job. */
export function saveScenarioTo(list, input, city = null) {
  const v = validateScenario(input, city);
  if (!v.ok) return { ok: false, errors: v.errors, list };
  const scenario = v.scenario;
  scenario.builtin = false;
  if (!scenario.id) scenario.id = `custom-${Date.now().toString(36)}-${list.length + 1}`;
  if (list.some((s) => s.id !== scenario.id && s.name.toLowerCase() === scenario.name.toLowerCase())) {
    return { ok: false, errors: ['Another scenario has that name'], list };
  }
  const next = list.some((s) => s.id === scenario.id) ? list.map((s) => (s.id === scenario.id ? scenario : s)) : [...list, scenario];
  return { ok: true, errors: [], list: next, scenario };
}

export const deleteScenarioFrom = (list, id) => list.filter((s) => s.id !== id);

/** Keep only the entries of a stored list that still validate (a corrupt entry is dropped, not fatal). */
export function restoreScenarios(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const v = validateScenario(entry);
    if (v.ok) out.push({ ...v.scenario, id: entry.id ?? v.scenario.id });
  }
  return out;
}
