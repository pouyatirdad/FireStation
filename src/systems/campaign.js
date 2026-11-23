// The campaign: everything a career keeps between shifts — the department's
// level and reputation, money, fleet, stations and their upgrades, people,
// objectives, finance history and career totals. A *shift* (the city, the fires,
// the units on the road) is separate and is rebuilt from the campaign each time.
//
// This module is data and rules only; building a shift from a campaign (which
// needs `createGame`) lives in careerGame.js.

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { addEvent } from './events.js';
import { on } from './hooks.js';
import { emptyTotals, shiftDelta } from './careerStats.js';
import { buildReport } from './report.js';
import { awardXp, closeShiftForPersonnel, createStartingCrew, personById } from './personnel.js';
import { createFinance, payShiftBonus } from './finance.js';
import { createObjectives, issueDaily, updateObjectives } from './objectives.js';
import { defaultPresets } from './presets.js';
import { wireStations } from './stations.js';
import { isCareer, personOf } from './modifiers.js';
import { SCENARIOS_START } from '../data/startScenarios.js';

export const CAMPAIGN_VERSION = 1;

export function createCampaign({ name = 'Harbor City Fire Department', scenario = 'harbor', seed = null } = {}) {
  const start = SCENARIOS_START[scenario] ?? SCENARIOS_START.harbor;
  const useSeed = seed ?? start.seed;
  return {
    version: CAMPAIGN_VERSION,
    id: `career-${Date.now().toString(36)}`,
    name: String(name).trim().slice(0, 40) || 'Fire Department',
    scenario,
    seed: useSeed, // the city seed
    created: Date.now(),
    level: 1,
    reputation: CONFIG.career.reputation.start,
    shifts: 0,
    totals: emptyTotals(),
    personnel: [],
    nextPersonId: 1,
    candidates: [],
    candidatesUntil: 0,
    rngCounter: 0,
    stations: {},
    fleet: start.fleet.map((f) => ({ ...f })),
    ownedStations: null, // filled in when the first shift is built
    balance: start.credits,
    finance: createFinance(),
    objectives: createObjectives(),
    history: { months: [], shifts: [] },
    presets: defaultPresets(),
    unlocked: [],
  };
}

/** The first people of a new career. Needs a built shift state (the roster ids come from the campaign). */
export function seedRoster(state) {
  const start = SCENARIOS_START[state.campaign.scenario] ?? SCENARIOS_START.harbor;
  if (state.campaign.personnel.length === 0) createStartingCrew(state, start.roster);
}

// ---------------------------------------------------------------- levels ---

export function levelProgress(campaign) {
  const next = CONFIG.career.levels.find((l) => l.id === campaign.level + 1) ?? null;
  return {
    current: CONFIG.career.levels.find((l) => l.id === campaign.level) ?? CONFIG.career.levels[0],
    next,
    repNeeded: next ? next.rep : null,
    shiftsNeeded: next ? next.shifts : null,
    ready: Boolean(next && campaign.reputation >= next.rep && campaign.shifts >= next.shifts),
  };
}

/** Promote the department if it has earned it. Returns the new level or null. */
export function checkLevelUp(state) {
  const c = state.campaign;
  let leveled = null;
  for (;;) {
    const p = levelProgress(c);
    if (!p.ready) break;
    c.level = p.next.id;
    leveled = p.next;
    const unlocks = [
      p.next.vehicles.length ? `vehicles: ${p.next.vehicles.map((v) => CONFIG.vehicles[v]?.label ?? v).join(', ')}` : '',
      `up to ${p.next.stations === 99 ? 'any number of' : p.next.stations} stations`,
      `upgrades to level ${p.next.upgradeCap}`,
    ].filter(Boolean).join('; ');
    addEvent(state, `PROMOTION — ${p.next.name}! Unlocked ${unlocks}`, 'big');
  }
  return leveled;
}

// ------------------------------------------------------------- reputation ---

export const repChange = (state, delta) => {
  const c = state.campaign;
  if (!c) return;
  c.reputation = clamp(c.reputation + delta, 0, 100);
};

/** Hooks that make a shift feed the campaign: experience, reputation, counters. */
export function wireCareer(state) {
  wireStations(state);

  on(state, 'incident:done', (st, { incident, outcome, people }) => {
    if (!isCareer(st)) return;
    const X = CONFIG.personnel.xp;
    const fast = incident.response != null && incident.response <= CONFIG.career.reputation.targetResponse;
    if (outcome === 'resolved') {
      repChange(st, (incident.big ? 0.8 : 0.35) * (fast ? 1.3 : 1));
      for (const id of people) {
        const person = personById(st, id);
        if (!person) continue;
        person.stats.incidents += 1;
        if (incident.kind === 'fire' || incident.kind === 'wildfire') {
          awardXp(st, person, 'firefighting', X.perKnockdown);
          person.stats.knockdowns += 1;
        } else if (incident.kind === 'rescue') {
          awardXp(st, person, 'rescue', X.perRescue);
          person.stats.rescues += 1;
        } else if (incident.kind === 'patient') {
          awardXp(st, person, 'medical', X.perTreatment);
          person.stats.treatments += 1;
        } else if (incident.kind === 'water') {
          awardXp(st, person, 'rescue', X.perRescue);
          person.stats.rescues += 1;
        } else {
          awardXp(st, person, 'technical', X.perClearance);
        }
      }
    } else {
      repChange(st, incident.big ? -2 : -1.1);
    }
  });
}

// ---------------------------------------------------------------- readiness ---

/** 0..1: how many seats on how many vehicles have a fit, rested person in them. */
export function readiness(state) {
  let seats = 0;
  let manned = 0;
  for (const e of state.engines) {
    const n = e.spec.crew ?? 0;
    if (n === 0) continue;
    seats += n;
    for (const id of e.crewIds) {
      const crew = state.crew.find((c) => c.id === id);
      const p = personOf(state, crew);
      if (p && p.fatigue < CONFIG.personnel.fatigue.exhausted) manned += 1;
    }
  }
  return seats === 0 ? 1 : manned / seats;
}

// ----------------------------------------------------------------- the end ---

/**
 * Close the shift: build the report, pay the performance bonus, move the
 * reputation, add the shift to the career totals, give everyone experience and
 * check for promotion. Safe to call twice; the second call returns the first result.
 */
/** Why the shift cannot be filed yet, or null. A shift must run at least half its length. */
export function shiftBlock(state) {
  const needed = CONFIG.career.shiftLength * CONFIG.career.minShiftShare;
  if (state.shiftDue || state.time >= needed) return null;
  return `File the shift after ${Math.ceil((needed - state.time) / 60)} more minute(s): a shift must run at least half its length`;
}

export function endShift(state) {
  if (!isCareer(state)) return null;
  if (state.shiftSummary) return state.shiftSummary;
  const c = state.campaign;
  const block = shiftBlock(state);
  if (block) {
    addEvent(state, block, 'warn');
    return null;
  }
  const report = buildReport(state);
  const s = shiftDelta(state);

  // Totals.
  const t = c.totals;
  t.resolved += s.resolved;
  t.failed += s.failed;
  t.rescued += s.rescued;
  t.treated += s.treated;
  t.saved += s.saved;
  t.lost += s.lost;
  t.cleared += s.cleared;
  t.fatalities += s.fatalities;
  t.injuries += s.injuries;
  t.forestFires += s.forestFires;
  t.responses += s.responses;
  t.responseSum += s.responseSum;
  t.incomeTotal += report.money.income;
  t.expensesTotal += report.money.expenses;
  if (report.rating.grade === 'S') t.sShifts += 1;

  // Reputation: a blend of the same factors the grade uses, plus readiness.
  const w = CONFIG.career.reputation.weights;
  const p = report.rating.parts;
  const ready = readiness(state);
  const target = 100 * (w.response * p.response + w.rescue * p.resolution + w.outcome * p.property
    + w.safety * p.safety + w.finance * p.finance + w.readiness * ready);
  const before = c.reputation;
  c.reputation = clamp(c.reputation * 0.7 + target * 0.3, 0, 100);

  c.shifts += 1;
  payShiftBonus(state, report.rating.grade, state.time / CONFIG.career.shiftLength);
  closeShiftForPersonnel(state);
  updateObjectives(state, 0, true);
  const leveled = checkLevelUp(state);

  c.history.shifts.push({
    n: c.shifts, grade: report.rating.grade, score: report.rating.score,
    net: report.money.net, resolved: s.resolved, rescued: s.rescued, reputation: Math.round(c.reputation),
  });
  if (c.history.shifts.length > 30) c.history.shifts.shift();

  // What carries into the next shift.
  c.balance = state.credits;
  c.fleet = state.engines.map((e) => ({ type: e.type, station: e.spec.boat ? 2 : (state.city.bays[e.bayIndex]?.station ?? 0) }));
  c.ownedStations = [...state.ownedStations];
  c.presets = state.presets.map((x) => ({ ...x, units: { ...x.units } }));

  state.shiftSummary = { report, readiness: ready, reputationBefore: before, reputationAfter: c.reputation, leveled, shiftNumber: c.shifts };
  return state.shiftSummary;
}

/** Prepare a freshly built shift: today's objectives. */
export function openShift(state) {
  issueDaily(state);
}
