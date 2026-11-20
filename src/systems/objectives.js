// Objectives: main goals, secondary and long-term goals, and a few daily ones.
// Progress is read off the same numbers the rest of the game keeps (shift stats,
// the report, the roster), added to the career totals of earlier shifts, so an
// objective can be met over several shifts. Completion is saved in the campaign.

import { addEvent } from './events.js';
import { earn, money } from './economy.js';
import { liveTotals } from './careerStats.js';

export const OBJECTIVES = [
  // main
  { id: 'first-shift', group: 'main', label: 'Complete your first shift', metric: (t) => t.shifts, target: 1, reward: { credits: 1500, rep: 4 } },
  { id: 'second-station', group: 'main', label: 'Build a second station', metric: (t) => t.stations, target: 2, reward: { credits: 2500, rep: 5 } },
  { id: 'hire-10', group: 'main', label: 'Hire 10 firefighters', metric: (t) => t.roster, target: 10, reward: { credits: 2000, rep: 4 } },
  { id: 'rescue-100', group: 'main', label: 'Rescue 100 citizens', metric: (t) => t.rescued, target: 100, reward: { credits: 5000, rep: 8 } },
  { id: 'city-dept', group: 'main', label: 'Reach City Department', metric: (t) => t.level, target: 3, reward: { credits: 6000, rep: 6 } },
  // secondary
  { id: 'resolve-20', group: 'secondary', label: 'Complete 20 incidents', metric: (t) => t.resolved, target: 20, reward: { credits: 1800, rep: 3 } },
  { id: 'rescue-specialists', group: 'secondary', label: 'Train 5 rescue specialists (rescue skill 4)', metric: (t) => t.rescueSpecialists, target: 5, reward: { credits: 2200, rep: 3 } },
  { id: 'fast-response', group: 'secondary', label: 'Average response under 90 seconds (10+ responses)', metric: (t) => (t.responses >= 10 && t.avgResponse != null && t.avgResponse < 90 ? 1 : 0), target: 1, reward: { credits: 3000, rep: 5 } },
  { id: 'forest-5', group: 'secondary', label: 'Resolve 5 forest fires', metric: (t) => t.forestFires, target: 5, reward: { credits: 3200, rep: 4 } },
  { id: 'special-vehicle', group: 'secondary', label: 'Buy a specialised rescue vehicle', metric: (t) => t.specialVehicles, target: 1, reward: { credits: 1500, rep: 2 } },
  { id: 'trained-5', group: 'secondary', label: 'Finish 5 training courses', metric: (t) => t.trainings, target: 5, reward: { credits: 1500, rep: 2 } },
  // long-term
  { id: 'resolve-200', group: 'long', label: 'Complete 200 incidents', metric: (t) => t.resolved, target: 200, reward: { credits: 12000, rep: 10 } },
  { id: 'rescue-500', group: 'long', label: 'Rescue 500 citizens', metric: (t) => t.rescued, target: 500, reward: { credits: 15000, rep: 10 } },
  { id: 'grade-s', group: 'long', label: 'Finish a shift with grade S', metric: (t) => t.sShifts, target: 1, reward: { credits: 8000, rep: 8 } },
  { id: 'stations-5', group: 'long', label: 'Run five stations', metric: (t) => t.stations, target: 5, reward: { credits: 10000, rep: 6 } },
  { id: 'national', group: 'long', label: 'Become the National Emergency Service', metric: (t) => t.level, target: 6, reward: { credits: 25000, rep: 10 } },
];

// Daily objectives are measured from the start of the shift they are issued in.
export const DAILY_POOL = [
  { id: 'd-resolve-3', group: 'daily', label: 'Resolve 3 incidents this shift', metric: (t) => t.resolved, target: 3, reward: { credits: 700, rep: 1 } },
  { id: 'd-rescue-5', group: 'daily', label: 'Rescue 5 people this shift', metric: (t) => t.rescued, target: 5, reward: { credits: 800, rep: 1 } },
  { id: 'd-treat-4', group: 'daily', label: 'Treat 4 injured people this shift', metric: (t) => t.treated, target: 4, reward: { credits: 700, rep: 1 } },
  { id: 'd-save-3', group: 'daily', label: 'Knock down 3 fires this shift', metric: (t) => t.saved, target: 3, reward: { credits: 700, rep: 1 } },
  { id: 'd-clear-2', group: 'daily', label: 'Reopen 2 blocked roads this shift', metric: (t) => t.cleared, target: 2, reward: { credits: 600, rep: 1 } },
];

const all = () => [...OBJECTIVES, ...DAILY_POOL];
export const objectiveDef = (id) => all().find((o) => o.id === id) ?? null;

export function createObjectives() {
  return { completed: {}, daily: { ids: [], base: {}, issuedShift: -1 } };
}

/** Pick today's three objectives (a new set each shift). */
export function issueDaily(state) {
  const c = state.campaign;
  const rng = (c.rngCounter = (c.rngCounter ?? 0) + 1);
  const pool = [...DAILY_POOL];
  const ids = [];
  let seed = (c.seed ?? 1) * 97 + c.shifts * 13 + rng;
  while (ids.length < 3 && pool.length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    ids.push(pool.splice(seed % pool.length, 1)[0].id);
  }
  const now = liveTotals(state);
  c.objectives.daily = { ids, base: { ...now }, issuedShift: c.shifts };
  return ids;
}

export function progressOf(state, def) {
  const now = liveTotals(state);
  let value = def.metric(now);
  if (def.group === 'daily') {
    const base = state.campaign.objectives.daily.base;
    value = Math.max(0, value - def.metric(base));
  }
  return { value, target: def.target, fraction: Math.min(1, value / def.target) };
}

export function isDone(state, id) {
  return Boolean(state.campaign.objectives.completed[id]);
}

/** Every objective for the screen: group, progress and whether it is done. */
export function listObjectives(state) {
  const c = state.campaign;
  const daily = c.objectives.daily.ids.map((id) => objectiveDef(id)).filter(Boolean);
  return [...OBJECTIVES, ...daily].map((def) => ({
    ...def,
    done: isDone(state, def.id),
    ...progressOf(state, def),
  }));
}

/** Check for completions. Cheap; run about once a second. */
export function updateObjectives(state, dt, force = false) {
  const c = state.campaign;
  if (!c) return;
  state.objAcc = (state.objAcc ?? 0) + dt;
  if (!force && state.objAcc < 1) return;
  state.objAcc = 0;
  for (const def of listObjectives(state)) {
    if (def.done || def.value < def.target) continue;
    c.objectives.completed[def.id] = c.shifts;
    const r = def.reward;
    if (r.credits) earn(state, r.credits, 'bonus');
    if (r.rep) c.reputation = Math.min(100, c.reputation + r.rep);
    addEvent(state, `Objective complete: ${def.label} — ${money(r.credits ?? 0)}${r.rep ? `, reputation +${r.rep}` : ''}`, 'good');
  }
}

