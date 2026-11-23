// Incident intelligence: what dispatch knows about an incident. Everything here
// is derived from data the incident already has (the building's type, fire,
// people trapped, chemicals; the wind; the clock), and every line comes from the
// same few factors computed once, so two lines can never contradict each other.

import { TILE } from '../core/config.js';
import { fireResistance } from './fire.js';
import { recommendedPresets } from './presets.js';
import { daylightLevel } from './weather.js';

const LEVELS = ['Low', 'Moderate', 'High', 'Severe', 'Extreme'];

const windWord = (s) => (s < 0.2 ? 'calm' : s < 0.5 ? 'a light wind' : s < 0.8 ? 'a strong wind' : 'a gale');
const compass = (dir) => ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'][Math.round((((dir % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];

function environment(state) {
  const w = state.wind;
  const light = daylightLevel(state.clock);
  return {
    wind: w ? `${windWord(w.speed)}${w.speed >= 0.2 ? ` blowing towards the ${compass(w.dir)}` : ''}` : 'no wind data',
    daylight: light > 0.6 ? 'daylight' : light > 0.3 ? 'dusk or dawn' : 'night',
    traffic: (state.trafficFactor ?? 1) < 1 ? 'rush hour — slow roads' : 'normal traffic',
    weather: state.weather?.label ?? null,
  };
}

const level = (n) => Math.max(1, Math.min(5, Math.round(n)));

function buildingIntel(state, b) {
  const burning = b.state === 'burning';
  const fire = burning ? b.fire : 0;
  const trapped = b.trapped ?? 0;
  const resistance = fireResistance(b);
  const chemicals = Boolean(b.hazmat) || b.type === 'tankfarm';
  const utilityCut = Boolean(b.utilityCut);

  // One severity from the same ingredients the lines below read.
  const sev = 1 + fire * 2 + Math.min(2, trapped * 0.4) + (chemicals ? 0.8 : 0) + (b.big ? 0.6 : 0) + (resistance > 1.35 ? 0.4 : 0);

  let explosion = 'none';
  let explosionWhy = '';
  if (chemicals && !utilityCut) {
    explosion = fire >= 0.3 ? 'high' : burning ? 'medium' : 'low';
    explosionWhy = b.type === 'tankfarm' ? 'fuel tanks' : 'chemicals stored on site';
  } else if (chemicals && utilityCut) {
    explosion = 'low';
    explosionWhy = 'gas and power are cut';
  } else if (burning && /gas|explosion/i.test(b.incidentLabel ?? '')) {
    explosion = 'medium';
    explosionWhy = 'gas supply';
  }

  const secondary = [];
  const near = state.buildings.filter((o) => o !== b && o.state === 'ok'
    && Math.hypot(o.x + o.w / 2 - (b.x + b.w / 2), o.y + o.h / 2 - (b.y + b.h / 2)) <= 5 + (b.w + b.h) / 4).length;
  if (burning && near > 0) secondary.push(`Fire could spread to ${near} neighbouring building${near === 1 ? '' : 's'}`);
  if (chemicals && burning) secondary.push('Toxic smoke — a hazard zone round the building');
  if (explosion === 'high') secondary.push('Explosion would damage neighbours and block streets');
  if (burning && trapped > 0 && (b.integrity ?? 1) < (b.maxIntegrity ?? 1) * 0.5) secondary.push('Structure is weakening — collapse would kill those inside');
  if (b.collapse) secondary.push('Secondary collapse possible while crews work');
  if (!burning && trapped > 0) secondary.push('No fire yet, but conditions inside are getting worse');

  const equipment = [];
  if (trapped > 0) equipment.push('Rescue crew');
  if (b.collapse || trapped >= 4) equipment.push('Cutting gear (rescue unit)');
  if ((b.floors ?? 1) >= 5 && burning) equipment.push('Ladder (upper floors)');
  if (resistance > 1.35 && burning) equipment.push('Extra water: tanker or hydrant supply');
  if (chemicals) equipment.push('Hazmat unit or certified crew');
  if (b.waterfront && burning) equipment.push('Fireboat can reach it');
  if (fire > 0 || state.patients.some((p) => p.buildingId === b.id)) equipment.push('Ambulance standing by');
  if (equipment.length === 0) equipment.push('One engine');

  const needed = Math.max(1, Math.min(4, 1 + Math.floor(fire * 2) + (b.big ? 1 : 0)));
  return {
    kind: 'building',
    title: b.incidentLabel ?? (burning ? 'Structure fire' : trapped > 0 ? 'Rescue call' : b.name),
    severity: { level: level(sev), label: LEVELS[level(sev) - 1] },
    danger: LEVELS[level(sev + (explosion === 'high' ? 1 : 0)) - 1],
    explosion: { level: explosion, why: explosionWhy },
    secondary,
    trapped: trapped > 0 ? { count: trapped, text: `${trapped} trapped inside` } : { count: 0, text: 'Nobody reported inside' },
    equipment,
    units: needed,
    difficulty: burning ? resistance : null,
  };
}

function wildfireIntel(state, w) {
  const radius = w.radius / TILE;
  const threatened = state.buildings.filter((b) => b.state === 'ok'
    && Math.hypot((b.x + b.w / 2) * TILE - w.x, (b.y + b.h / 2) * TILE - w.y) <= w.radius + 10 * TILE).length;
  const sev = 1 + w.intensity * 2 + Math.min(2, radius / 8) + (state.wind?.speed ?? 0);
  const secondary = [];
  if (threatened > 0) secondary.push(`${threatened} building${threatened === 1 ? '' : 's'} within reach of embers`);
  if ((state.wind?.speed ?? 0) > 0.5) secondary.push('Strong wind will drive it downwind');
  secondary.push('Smoke across nearby roads');
  return {
    kind: 'wildfire',
    title: w.name ?? 'Forest fire',
    severity: { level: level(sev), label: LEVELS[level(sev) - 1] },
    danger: LEVELS[level(sev - 0.5) - 1],
    explosion: { level: 'none', why: '' },
    secondary,
    trapped: { count: 0, text: 'No people reported in the fire' },
    equipment: ['Engines and tankers on the edge', 'Air support (helicopter or air tanker)', 'Chainsaw crew to cut tracks'],
    units: Math.max(1, Math.min(4, Math.round(w.radius / (TILE * 6)))),
    difficulty: null,
  };
}

function patientIntel(state, p) {
  return {
    kind: 'patient',
    title: p.critical ? 'Critical casualty' : 'Injured person',
    severity: { level: level(1 + p.severity * 4), label: LEVELS[level(1 + p.severity * 4) - 1] },
    danger: p.life < p.maxLife * 0.35 ? 'High — deteriorating' : 'Low',
    explosion: { level: 'none', why: '' },
    secondary: p.critical ? ['Needs a hospital after treatment'] : [],
    trapped: { count: 0, text: `${Math.max(0, Math.ceil(p.life))} s of survival time left` },
    equipment: [p.critical ? 'Ambulance with a stretcher' : 'Paramedics'],
    units: 1,
    difficulty: null,
  };
}

function victimIntel(state, v) {
  return {
    kind: 'victim',
    title: 'Person in the water',
    severity: { level: 4, label: 'Severe' },
    danger: v.life < v.maxLife * 0.4 ? 'Extreme — going under' : 'High',
    explosion: { level: 'none', why: '' },
    secondary: ['Ambulance needed once they are out'],
    trapped: { count: 0, text: `${Math.max(0, Math.ceil(v.life))} s left` },
    equipment: ['Divers: a rescue boat, or an engine or rescue unit with diving gear'],
    units: 1,
    difficulty: null,
  };
}

function blockadeIntel(state, w) {
  const fuel = w.fuelAt != null && !w.fuelDone;
  const sev = 1 + (w.big ? 1.5 : 0) + (fuel ? 1 : 0);
  return {
    kind: 'blockade',
    title: w.name ?? 'Road blocked',
    severity: { level: level(sev), label: LEVELS[level(sev) - 1] },
    danger: fuel ? 'High — leaking fuel' : 'Low',
    explosion: { level: fuel ? 'medium' : 'none', why: fuel ? 'fuel from the wreck' : '' },
    secondary: ['Traffic queues behind it', ...(fuel ? ['Fuel may ignite a neighbouring building'] : [])],
    trapped: { count: 0, text: 'Nobody reported trapped' },
    equipment: ['Fire crew to clear it', 'Rescue cutter makes it faster'],
    units: 1,
    difficulty: null,
  };
}

/** Everything dispatch knows about an incident, or null if it is over. */
export function incidentIntel(state, kind, id) {
  let intel = null;
  if (kind === 'building') {
    const b = state.buildings.find((x) => x.id === id);
    if (b) intel = buildingIntel(state, b);
  } else if (kind === 'wildfire') {
    const w = state.wildfires.find((x) => x.id === id);
    if (w) intel = wildfireIntel(state, w);
  } else if (kind === 'patient') {
    const p = state.patients.find((x) => x.id === id);
    if (p) intel = patientIntel(state, p);
  } else if (kind === 'victim') {
    const v = state.victims.find((x) => x.id === id);
    if (v) intel = victimIntel(state, v);
  } else if (kind === 'blockade') {
    const w = state.blockades.find((x) => x.id === id);
    if (w) intel = blockadeIntel(state, w);
  }
  if (!intel) return null;
  intel.environment = environment(state);
  intel.recommended = recommendedPresets(state, { kind, id }).map((p) => p.name);
  return intel;
}
