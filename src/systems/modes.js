// Game modes and the orders the new screens give.
//
//   Quick Response  the original game: createGame in game.js
//   Career          a persistent department: a campaign plus a shift built from it
//   Challenge       a built-in or custom scenario, scored, with its own save slot
//
// This module builds a shift from a campaign or scenario (it needs `createGame`)
// and is the one place the career, preset, agency and evacuation commands live,
// so the UI has a single list of what it can ask for.

import { CONFIG } from '../core/config.js';
import { createGame, loadState, serialize } from './game.js';
import { Rng } from '../core/math.js';
import { createWind } from './wind.js';
import { addVehicle, clearFleet, removeCrewMember } from './units.js';
import { createCampaign, endShift, openShift, seedRoster, wireCareer } from './campaign.js';
import {
  assignPerson, autoStaff, dismissPerson, hirePerson, openShiftForPersonnel, refreshCandidates,
  startTraining, unassignPerson,
} from './personnel.js';
import { applyStationEffects, buyUpgrade, setStationBudget } from './stations.js';
import { requestEmergencyFunding, setBudget } from './finance.js';
import { createReport } from './report.js';
import { attachScenario } from './challenges.js';
import { isCareer } from './modifiers.js';
import {
  applyPreset, cancelDispatch, createPreset, deletePreset, redirectDispatch, updatePreset,
} from './presets.js';
import { callAgency } from './agencies.js';
import { evacuateIncident } from './evacuation.js';
import { addEvent } from './events.js';

// ------------------------------------------------------------------ career ---

/** Build a shift from the campaign: its city, money, fleet, stations and people. */
export function buildCareerShift(campaign, first = false) {
  const state = createGame(campaign.seed);
  state.mode = 'career';
  state.campaign = campaign;
  // Every shift of a career has its own calls and its own wind (the city stays the same).
  state.rngSeed = campaign.seed * 7919 + 13 + (campaign.shifts + 1) * 1000003;
  state.rng = new Rng(state.rngSeed);
  state.wind = createWind(new Rng(state.rngSeed + 104729));
  state.credits = campaign.balance;
  state.ownedStations = campaign.ownedStations
    ? state.city.stations.map((_, i) => Boolean(campaign.ownedStations[i] ?? i === 0))
    : state.city.stations.map((_, i) => i === 0);
  state.presets = campaign.presets.map((p) => ({ ...p, units: { ...p.units } }));
  clearFleet(state);
  for (const f of campaign.fleet) addVehicle(state, f.type, f.station ?? 0);
  if (state.engines.length === 0) addVehicle(state, 'engine', 0);
  state.activeEngineId = state.engines[0]?.id ?? null;
  if (first) seedRoster(state);
  openShiftForPersonnel(state);
  for (const engine of state.engines) {
    for (const crew of [...state.crew.filter((c) => c.engineId === engine.id)]) removeCrewMember(state, crew);
  }
  autoStaff(state);
  applyStationEffects(state);
  refreshCandidates(state, true);
  wireCareer(state);
  openShift(state);
  state.report = createReport(state);
  return state;
}

export function createCareer(options = {}) {
  const campaign = createCampaign(options);
  return buildCareerShift(campaign, true);
}

/** File the shift report and build the next shift. Returns `{ state, summary }`. */
export function nextCareerShift(state) {
  const summary = endShift(state);
  if (!summary) return null;
  const next = buildCareerShift(state.campaign, false);
  next.lastSummary = summary;
  addEvent(next, `Shift ${state.campaign.shifts + 1} begins`, 'info');
  return { state: next, summary };
}

/** Rebuild a career shift from a slot read by saves.readSlot. */
export function loadCareerSlot(slot) {
  const state = loadState(slot.shift, slot.campaign);
  wireCareer(state);
  const campaign = state.campaign;
  // Seats: crew units remember their person; the person remembers the seat.
  for (const crew of [...state.crew]) {
    const person = crew.personId ? campaign.personnel.find((p) => p.id === crew.personId) : null;
    if (!person || person.vehicleId) {
      removeCrewMember(state, crew);
      continue;
    }
    person.vehicleId = crew.engineId;
    person.station = state.city.bays[state.engines.find((e) => e.id === crew.engineId)?.bayIndex]?.station ?? 0;
  }
  autoStaff(state);
  return state;
}

/** What gets written to the career slot. */
export function careerSlotData(state) {
  return { kind: 'career', shift: serialize(state), campaign: JSON.parse(JSON.stringify(state.campaign)) };
}

// --------------------------------------------------------------- scenarios ---

export function createScenarioGame(def) {
  const state = createGame(def.start?.seed ?? CONFIG.city.seed);
  attachScenario(state, def);
  return state;
}

export function scenarioSlotData(state) {
  return { kind: 'challenge', shift: serialize(state) };
}

// ------------------------------------------------------- career commands ---

const career = (state) => (isCareer(state) ? true : (addEvent(state, 'That needs Career mode', 'warn'), false));

export const commandHire = (state, id) => career(state) && hirePerson(state, id);
export const commandDismiss = (state, id) => career(state) && dismissPerson(state, id);
export const commandAssign = (state, personId, engineId) => career(state) && Boolean(assignPerson(state, personId, engineId));
export const commandUnassign = (state, personId) => career(state) && unassignPerson(state, personId);
export const commandTrain = (state, personId, course) => career(state) && startTraining(state, personId, course);
export const commandUpgrade = (state, station, key) => career(state) && buyUpgrade(state, station, key);
export const commandBudget = (state, category, amount) => career(state) && setBudget(state, category, amount);
export const commandStationBudget = (state, index, amount) => career(state) && setStationBudget(state, index, amount);
export const commandEmergencyFunding = (state) => career(state) && requestEmergencyFunding(state);

// ------------------------------------------------- operations commands ---

export const commandPreset = (state, id, target) => applyPreset(state, id, target);
export const commandSavePreset = (state, input, id = null) => (id ? updatePreset(state, id, input) : createPreset(state, input));
export const commandDeletePreset = (state, id) => deletePreset(state, id);
export const commandCancelDispatch = (state, engineId) => cancelDispatch(state, engineId);
export const commandRedirect = (state, engineId, target) => redirectDispatch(state, engineId, target);
export const commandAgency = (state, agency, target) => callAgency(state, agency, target);
export const commandEvacuate = (state, kind, id) => evacuateIncident(state, kind, id);
