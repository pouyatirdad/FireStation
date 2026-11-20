// Running a scenario: a built-in challenge or a custom one (data/scenarios.js).
//
// `attachScenario` sets up a freshly created game from the scenario's starting
// conditions; `updateScenario` plays the scripted incidents at their times and
// judges the result. It is a separate mode (`state.mode === 'challenge'`) with
// its own save slot, so it can never touch a career.

import { TILE } from '../core/config.js';
import { addEvent } from './events.js';
import { ignite } from './fire.js';
import { collapseBuilding } from './collapse.js';
import { startLeak } from './hazmat.js';
import { openIncidents, playScene, spawnIncidentKind } from './incidents.js';
import { spawnPatient } from './medical.js';
import { createReport } from './report.js';
import { startWildfire } from './wildfire.js';
import { startDisaster } from './disasters.js';
import { setWeather } from './weather.js';
import { addVehicle, clearFleet } from './units.js';
import { ensureHotkeys } from '../core/hotkeys.js';

const DEFAULT_TYPES = {
  leak: ['factory', 'warehouse', 'pharmacy'],
  collapse: ['apartment', 'house', 'shop'],
  medical: ['house', 'apartment', 'shop', 'office', 'hotel', 'mall', 'school'],
};

/** Set a new game up from a scenario's starting conditions. */
export function attachScenario(state, def) {
  const copy = JSON.parse(JSON.stringify(def));
  state.mode = 'challenge';
  state.scenario = {
    def: copy, script: copy.incidents.map((it) => ({ ...it, done: false })), used: [], result: null, acc: 0,
  };
  state.rules = { ...copy.rules };
  state.incidentsEnabled = Boolean(copy.rules.random);
  state.incidentPace = 1 / (copy.rules.randomRate || 1);
  state.clock = copy.start.clock;
  state.credits = copy.start.credits;
  state.ownedStations = state.city.stations.map((_, i) => i === 0);
  setWeather(state, copy.start.weather ?? 'clear');
  if (copy.start.windSpeed != null && state.wind) {
    state.wind.speed = copy.start.windSpeed;
    state.wind.targetSpeed = copy.start.windSpeed;
    state.rules.windLock = true;
  }
  if (copy.start.windDir != null && state.wind) {
    const dir = (copy.start.windDir * Math.PI) / 180;
    state.wind.dir = dir;
    state.wind.targetDir = dir;
  }
  clearFleet(state);
  for (const f of copy.start.fleet) addVehicle(state, f.type, f.station === 2 ? null : 0);
  ensureHotkeys(state);
  state.activeEngineId = state.engines[0]?.id ?? null;
  // The first incident can come at once; random calls start after a breather.
  state.nextCallAt = 25;
  state.report = createReport(state);
  return state;
}

// ----------------------------------------------------------------- script ---

function resolveBuilding(state, item, defaults) {
  const loc = item.location ?? { kind: 'auto' };
  const used = state.scenario.used;
  if (loc.kind === 'building') {
    const b = state.buildings.find((x) => x.id === loc.buildingId);
    return b && b.state === 'ok' ? b : null;
  }
  const types = loc.kind === 'type' ? [loc.type] : defaults;
  const hq = state.city.station;
  const hx = hq.x + hq.w / 2;
  const hy = hq.y + hq.h / 2;
  const pool = state.buildings
    .filter((b) => b.state === 'ok' && b.type !== 'station' && b.type !== 'hospital' && (!types || types.includes(b.type)) && !used.includes(b.id))
    .map((b) => ({ b, d: Math.hypot(b.x + b.w / 2 - hx, b.y + b.h / 2 - hy) }))
    .sort((p, q) => p.d - q.d || (p.b.id < q.b.id ? -1 : 1));
  // Close enough to matter, far enough not to sit on the apron; the same pick every replay.
  const pick = pool.find((p) => p.d >= 14) ?? pool[0];
  return pick?.b ?? null;
}

function injure(state, b, n, severity) {
  for (let i = 0; i < n; i++) spawnPatient(state, b, Math.min(1, severity + i * 0.04), 'Casualty at');
}

function runItem(state, item) {
  const sc = state.scenario;
  let made = null;
  switch (item.kind) {
    case 'building-fire': {
      const b = resolveBuilding(state, item, null);
      if (!b) break;
      b.reward = 700;
      b.incidentLabel = 'Scripted fire';
      ignite(state, b, 'call');
      b.fire = Math.max(b.fire, item.intensity);
      if (item.trapped > 0) b.trapped = item.trapped;
      injure(state, b, item.injured, 0.5);
      addEvent(state, `Fire at ${b.name}${item.trapped ? ` — ${item.trapped} trapped` : ''}`, 'fire');
      made = b;
      break;
    }
    case 'leak': {
      const b = resolveBuilding(state, item, DEFAULT_TYPES.leak);
      if (!b) break;
      b.reward = 900;
      b.incidentLabel = 'Chemical leak';
      startLeak(state, b, Math.max(0.5, item.intensity));
      injure(state, b, item.injured, 0.4);
      if (item.trapped > 0) b.trapped = item.trapped;
      addEvent(state, `Chemical leak at ${b.name} — a hazard zone is forming`, 'warn');
      made = b;
      break;
    }
    case 'collapse': {
      const b = resolveBuilding(state, item, DEFAULT_TYPES.collapse);
      if (!b) break;
      b.reward = 1200;
      b.incidentLabel = 'Building collapse';
      collapseBuilding(state, b, Math.max(1, item.trapped || 3));
      injure(state, b, item.injured, 0.6);
      addEvent(state, `${b.name} has collapsed — ${b.trapped} people buried`, 'big');
      made = b;
      break;
    }
    case 'medical': {
      const b = resolveBuilding(state, item, DEFAULT_TYPES.medical);
      if (!b) break;
      injure(state, b, Math.max(1, item.injured), Math.max(0.3, item.intensity));
      made = b;
      break;
    }
    case 'wildfire': {
      const tiles = state.city.forestTiles ?? [];
      if (tiles.length === 0) break;
      const t = tiles[(sc.script.indexOf(item) * 37 + 11) % tiles.length];
      made = startWildfire(state, (t.x + 0.5) * TILE, (t.y + 0.5) * TILE, 2200);
      made.intensity = Math.max(made.intensity, item.intensity);
      break;
    }
    case 'pileup': made = spawnIncidentKind(state, 'pileup'); break;
    case 'crash': made = spawnIncidentKind(state, 'crash'); break;
    case 'water': made = spawnIncidentKind(state, 'water'); break;
    case 'scene': {
      const b = item.location?.kind === 'auto' ? null : resolveBuilding(state, item, null);
      made = playScene(state, item.scene, b);
      break;
    }
    case 'disaster': made = startDisaster(state, item.disaster); break;
    default: break;
  }
  if (made?.id) sc.used.push(made.id);
  return made;
}

// -------------------------------------------------------------- judgement ---

export function scenarioScore(state, won) {
  const s = state.stats;
  const def = state.scenario.def;
  let score = 1000 + 120 * s.saved + 60 * s.rescued + 40 * (s.treated ?? 0) - 400 * s.casualties - 200 * s.lost + Math.round(state.credits / 10);
  if (won && def.timeLimit) score += Math.max(0, Math.round((def.timeLimit - state.time) * 2));
  if (!won) score = Math.round(score * 0.5);
  return Math.max(won ? 100 : 0, Math.round(score));
}

function thresholds(state, success) {
  const reasons = [];
  if (success.maxCasualties != null && state.stats.casualties > success.maxCasualties) reasons.push(`more than ${success.maxCasualties} casualties`);
  if (success.minSaved != null && state.stats.saved < success.minSaved) reasons.push(`fewer than ${success.minSaved} fires put out`);
  if (success.minCredits != null && state.credits < success.minCredits) reasons.push(`under $${success.minCredits.toLocaleString('en-US')}`);
  return reasons;
}

function finish(state, won, reasons) {
  const sc = state.scenario;
  sc.result = { status: won ? 'won' : 'lost', score: scenarioScore(state, won), reasons, time: state.time };
  state.over = true;
  addEvent(state, won ? `${sc.def.name} complete — score ${sc.result.score}` : `${sc.def.name} failed — ${reasons.join(', ')}`, won ? 'good' : 'bad');
}

/** Status for the HUD: what is left to do. */
export function scenarioProgress(state) {
  const sc = state.scenario;
  if (!sc) return null;
  return {
    name: sc.def.name,
    remaining: sc.def.timeLimit != null ? Math.max(0, sc.def.timeLimit - state.time) : null,
    scripted: sc.script.length,
    started: sc.script.filter((i) => i.done).length,
    open: openIncidents(state),
    result: sc.result,
  };
}

export function updateScenario(state, dt) {
  const sc = state.scenario;
  if (!sc || sc.result) return;
  for (const item of sc.script) {
    if (!item.done && state.time >= item.at) {
      item.done = true;
      runItem(state, item);
    }
  }
  sc.acc += dt;
  if (sc.acc < 0.5) return;
  sc.acc = 0;

  const def = sc.def;
  const f = def.failure ?? {};
  const fails = [];
  if (f.maxCasualties != null && state.stats.casualties > f.maxCasualties) fails.push(`${state.stats.casualties} people died`);
  if (f.maxLost != null && state.stats.lost > f.maxLost) fails.push(`${state.stats.lost} buildings lost`);
  if (f.minCredits != null && state.credits < f.minCredits) fails.push('the department ran out of money');
  if (fails.length) return finish(state, false, fails);

  const scriptDone = sc.script.every((i) => i.done) && !state.disaster;
  const ok = def.success;
  if (ok.resolveAll && scriptDone && openIncidents(state) === 0 && state.time >= (sc.script.at(-1)?.at ?? 0) + 3) {
    const missing = thresholds(state, ok);
    return finish(state, missing.length === 0, missing);
  }
  if (def.timeLimit != null && state.time >= def.timeLimit) {
    if (ok.surviveTime) {
      const missing = thresholds(state, ok);
      return finish(state, missing.length === 0, missing);
    }
    return finish(state, false, ['time ran out with incidents still open']);
  }
}
