// The department's people: hiring, staffing vehicles, fatigue, injuries,
// experience and training. Career mode only; Quick Response has anonymous crews.
//
// A person is a record in `state.campaign.personnel`. When they crew a vehicle
// their crew unit (`state.crew`) carries `personId`, and `modifiers.workRate`
// reads the record, so skills and tiredness change what the crew actually does.

import { CONFIG } from '../core/config.js';
import { Rng, clamp } from '../core/math.js';
import { makePerson, rankFor, rankLabel, salaryOf } from '../data/personnel.js';
import { addEvent } from './events.js';
import { spend } from './economy.js';
import { isCareer, personOf, stationOfEngine, upgradeLevel } from './modifiers.js';
import { addCrewMember, crewOf, ownsStation, removeCrewMember } from './units.js';

const P = () => CONFIG.personnel;
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

export const people = (state) => state.campaign?.personnel ?? [];
export const personById = (state, id) => people(state).find((p) => p.id === id) ?? null;

const fit = (state, p) => p.status === 'active' && state.time >= (p.injuredUntil ?? 0);

/** People on the books who are fit, not training and not on a vehicle. */
export const reserve = (state) => people(state).filter((p) => fit(state, p) && !p.vehicleId);

export const levelNeed = (level) => 120 * level;

// ------------------------------------------------------------------ hiring ---

function campaignRng(state) {
  const c = state.campaign;
  c.rngCounter = (c.rngCounter ?? 0) + 1;
  return new Rng((c.seed ?? 1) * 31 + c.rngCounter * 7919);
}

export function newPersonId(state) {
  const c = state.campaign;
  c.nextPersonId = (c.nextPersonId ?? 1);
  return `p${c.nextPersonId++}`;
}

/** Keep a short list of people looking for a job; the list turns over now and then. */
export function refreshCandidates(state, force = false) {
  const c = state.campaign;
  if (!c) return [];
  if (!force && c.candidates?.length >= P().candidates && state.time < (c.candidatesUntil ?? 0)) return c.candidates;
  const rng = campaignRng(state);
  const rep = clamp((c.reputation ?? 0) / 100, 0, 1);
  c.candidates = [];
  for (let i = 0; i < P().candidates; i++) {
    const person = makePerson(rng, newPersonId(state), 0.25 + 0.6 * rep);
    person.status = 'candidate';
    // Better people ask for more.
    person.askingFee = Math.round((P().hireCost * (0.8 + 0.07 * Object.values(person.skills).reduce((a, b) => a + b, 0) / 5)) / 10) * 10;
    c.candidates.push(person);
  }
  c.candidatesUntil = state.time + P().candidateLife;
  return c.candidates;
}

/** The first people of a new career: a small average crew, no fee. */
export function createStartingCrew(state, count = P().startRoster) {
  const rng = campaignRng(state);
  const list = [];
  for (let i = 0; i < count; i++) {
    const person = makePerson(rng, newPersonId(state), 0.2);
    person.status = 'active';
    list.push(person);
  }
  state.campaign.personnel.push(...list);
  return list;
}

export function hirePerson(state, candidateId) {
  const c = state.campaign;
  if (!c) return false;
  const person = c.candidates.find((p) => p.id === candidateId);
  if (!person) return false;
  if (c.personnel.length >= P().maxRoster) {
    addEvent(state, 'The roster is full', 'warn');
    return false;
  }
  const fee = person.askingFee ?? P().hireCost;
  if (state.credits < fee) {
    addEvent(state, `Not enough credits to hire ${person.name} — ${money(fee)}`, 'warn');
    return false;
  }
  spend(state, fee, 'recruitment');
  c.candidates = c.candidates.filter((p) => p !== person);
  person.status = 'active';
  delete person.askingFee;
  c.personnel.push(person);
  addEvent(state, `${person.name} hired as a ${rankLabel(person.rank)} — ${money(fee)}`, 'good');
  autoStaff(state);
  return true;
}

/** Let someone go. Their crew place is freed. */
export function dismissPerson(state, personId) {
  const person = personById(state, personId);
  if (!person) return false;
  unassignPerson(state, personId);
  state.campaign.personnel = state.campaign.personnel.filter((p) => p !== person);
  addEvent(state, `${person.name} left the department`, 'info');
  return true;
}

// ------------------------------------------------------------- assignment ---

/** Put a person in a crew seat of a vehicle. Returns the crew unit, or null. */
export function assignPerson(state, personId, engineId) {
  const person = personById(state, personId);
  const engine = state.engines.find((e) => e.id === engineId);
  if (!person || !engine) return null;
  if (!fit(state, person)) {
    addEvent(state, `${person.name} is not available`, 'warn');
    return null;
  }
  if (person.vehicleId === engine.id) return crewOf(state, engine).find((c) => c.personId === person.id) ?? null;
  if (person.vehicleId) unassignPerson(state, personId);
  const crew = addCrewMember(state, engine, person.id);
  if (!crew) {
    addEvent(state, `${engine.name} has no free seat`, 'warn');
    return null;
  }
  person.vehicleId = engine.id;
  person.station = stationOfEngine(state, engine);
  crew.name = person.name;
  return crew;
}

/** Take a person off whatever vehicle they are on. */
export function unassignPerson(state, personId) {
  const person = personById(state, personId);
  if (!person) return false;
  const crew = state.crew.find((c) => c.personId === personId);
  if (crew) removeCrewMember(state, crew);
  person.vehicleId = null;
  return true;
}

/** Fill every empty seat from the reserve, best-suited person first. */
export function autoStaff(state) {
  if (!isCareer(state)) return 0;
  let filled = 0;
  for (const engine of state.engines) {
    const seats = engine.spec.crew ?? 0;
    if (seats === 0) continue;
    while (engine.crewIds.length < seats) {
      const pool = reserve(state);
      if (pool.length === 0) return filled;
      const medical = Boolean(engine.spec.medical);
      const skill = medical ? 'medical' : engine.spec.diver ? 'rescue' : 'firefighting';
      pool.sort((a, b) => (b.skills[skill] - a.skills[skill]) || (a.fatigue - b.fatigue));
      if (!assignPerson(state, pool[0].id, engine.id)) return filled;
      filled++;
    }
  }
  return filled;
}

/** A vehicle is leaving the fleet: its crew go back to the reserve. */
export function releaseVehicle(state, engine) {
  if (!isCareer(state)) return;
  for (const p of people(state)) if (p.vehicleId === engine.id) p.vehicleId = null;
}

/** A new vehicle comes with empty seats in a career; fill what can be filled. */
export function staffVehicle(state, engine) {
  if (!isCareer(state)) return;
  // spawnCrew created anonymous crew; replace them with real people.
  for (const crew of [...crewOf(state, engine)]) if (!crew.personId) removeCrewMember(state, crew);
  autoStaff(state);
}

// ------------------------------------------------------------ experience ---

export function awardXp(state, person, skill, amount) {
  if (!person || !(amount > 0)) return;
  if (skill) {
    const need = () => P().xpPerLevel * person.skills[skill];
    person.skillXp[skill] = (person.skillXp[skill] ?? 0) + amount;
    while (person.skills[skill] < P().maxSkill && person.skillXp[skill] >= need()) {
      person.skillXp[skill] -= need();
      person.skills[skill] += 1;
      addEvent(state, `${person.name}: ${skill} is now level ${person.skills[skill]}`, 'good');
    }
  }
  person.xp += amount;
  while (person.level < 10 && person.xp >= levelNeed(person.level)) {
    person.xp -= levelNeed(person.level);
    person.level += 1;
    addEvent(state, `${person.name} reached level ${person.level}`, 'good');
    const rank = rankFor(person.level);
    if (rank.id !== person.rank) {
      person.rank = rank.id;
      addEvent(state, `${person.name} promoted to ${rank.label}`, 'good');
    }
  }
}

// --------------------------------------------------------------- training ---

export const courseOf = (id) => CONFIG.training.courses[id] ?? null;

export function trainingSlots(state, station) {
  return CONFIG.training.baseSlots + CONFIG.upgrades.training.per * upgradeLevel(state, station, 'training');
}

export function trainees(state, station) {
  return people(state).filter((p) => p.status === 'training' && (p.training?.station ?? 0) === station);
}

/** Why this person cannot take this course right now, or null if they can. */
export function trainingBlock(state, person, courseId) {
  const course = courseOf(courseId);
  if (!course) return 'Unknown course';
  if (person.status === 'training') return 'Already in training';
  if (person.status !== 'active' || state.time < (person.injuredUntil ?? 0)) return 'Not fit for duty';
  if (course.cert && person.certs.includes(course.cert)) return 'Already certified';
  if (!course.cert && person.skills[course.skill] >= P().maxSkill) return 'Skill is already at the top';
  const station = person.station ?? 0;
  if (!ownsStation(state, station)) return 'No station to train at';
  if (trainees(state, station).length >= trainingSlots(state, station)) return 'The training centre is full';
  if (state.credits < course.cost) return `Needs ${money(course.cost)}`;
  return null;
}

export function startTraining(state, personId, courseId) {
  const person = personById(state, personId);
  if (!person) return false;
  const block = trainingBlock(state, person, courseId);
  if (block) {
    addEvent(state, `${person.name}: ${block}`, 'warn');
    return false;
  }
  const course = courseOf(courseId);
  const station = person.station ?? 0;
  spend(state, course.cost, 'training');
  const speed = 1 + 0.25 * upgradeLevel(state, station, 'training');
  unassignPerson(state, personId);
  person.status = 'training';
  person.training = { course: courseId, station, until: state.time + course.time / speed, total: course.time / speed };
  addEvent(state, `${person.name} started ${course.label}`, 'info');
  return true;
}

function finishTraining(state, person) {
  const course = courseOf(person.training.course);
  person.status = 'active';
  person.training = null;
  person.stats.trainings = (person.stats.trainings ?? 0) + 1;
  if (course.cert && !person.certs.includes(course.cert)) person.certs.push(course.cert);
  awardXp(state, person, course.skill, course.xp);
  addEvent(state, `${person.name} finished ${course.label}${course.cert ? ` and is ${course.cert}-certified` : ''}`, 'good');
}

// ----------------------------------------------------------------- update ---

/** One tick of personnel life: tiredness, injuries, recovery, courses. Runs after the units. */
export function updatePersonnel(state, dt) {
  if (!isCareer(state)) return;
  const f = P().fatigue;
  const pending = [];

  for (const crew of state.crew) {
    const person = personOf(state, crew);
    if (!person) continue;
    const engine = state.engines.find((e) => e.id === crew.engineId);
    if (!engine) continue;
    const working = !crew.riding && crew.status !== 'standing by' && crew.status !== 'aboard';
    const driving = crew.riding && engine.path.length > 0;
    const station = stationOfEngine(state, engine);
    const resting = crew.riding && !driving && engine.path.length === 0
      && Math.hypot(engine.x - state.city.bays[engine.bayIndex].x, engine.y - state.city.bays[engine.bayIndex].y) < 64;
    if (working) person.fatigue += f.perSecondWorking * dt;
    else if (driving) person.fatigue += f.perSecondDriving * dt;
    else if (resting) person.fatigue -= f.restPerSecond * dt * (1 + CONFIG.upgrades.medical.per * upgradeLevel(state, station, 'medical'));
    else person.fatigue -= f.restPerSecond * 0.25 * dt;
    person.fatigue = clamp(person.fatigue, 0, 1);
    if (working || driving) person.stats.hoursOnDuty += dt / CONFIG.economy.hourEvery;

    if (working && crew.spraying && crew.targetId) {
      const b = state.buildings.find((x) => x.id === crew.targetId);
      if (b && b.fire >= P().injury.fire) {
        const protection = (P().injury.rankProtection * (person.level - 1)) / 3 + (person.fatigue > f.exhausted ? -0.3 : 0);
        if (state.rng.chance(P().injury.chancePerSecond * dt * (1 - clamp(protection, -0.5, 0.8)))) pending.push(person);
      }
    }
  }

  for (const person of pending) injure(state, person);

  // Rest off the vehicle too.
  for (const person of people(state)) {
    if (!person.vehicleId && person.status === 'active') {
      person.fatigue = clamp(person.fatigue - f.restPerSecond * dt, 0, 1);
    }
    if (person.status === 'injured' && state.time >= person.injuredUntil) {
      person.status = 'active';
      person.injuredUntil = 0;
      addEvent(state, `${person.name} is back on duty`, 'good');
      autoStaff(state);
    } else if (person.status === 'training' && state.time >= person.training.until) {
      finishTraining(state, person);
      autoStaff(state);
    }
  }
}

/** Hurt on the job: out for a while, their seat goes to someone from the reserve. */
export function injure(state, person, severity = 1) {
  if (!person || person.status === 'injured') return false;
  const station = person.station ?? 0;
  const [lo, hi] = P().injury.recovery;
  const base = (lo + (hi - lo) * state.rng.float()) * severity;
  person.status = 'injured';
  person.injuredUntil = state.time + base / (1 + CONFIG.upgrades.medical.per * upgradeLevel(state, station, 'medical'));
  person.stats.injuries += 1;
  person.fatigue = Math.max(person.fatigue, 0.4);
  state.stats.firefighterInjuries = (state.stats.firefighterInjuries ?? 0) + 1;
  unassignPerson(state, person.id);
  addEvent(state, `${person.name} was hurt on the job — off duty for ${Math.round(base / 60)} min`, 'warn');
  autoStaff(state);
  return true;
}

// -------------------------------------------------------------- summaries ---

export function payrollPerHour(state) {
  let total = 0;
  for (const p of people(state)) if (p.status !== 'candidate') total += salaryOf(p);
  return total;
}

export function rosterSummary(state) {
  const list = people(state);
  return {
    total: list.length,
    onVehicles: list.filter((p) => p.vehicleId).length,
    reserve: reserve(state).length,
    injured: list.filter((p) => p.status === 'injured').length,
    training: list.filter((p) => p.status === 'training').length,
    exhausted: list.filter((p) => p.fatigue >= P().fatigue.exhausted).length,
  };
}

/** End of shift: everyone who served gets experience and a rest. */
export function closeShiftForPersonnel(state) {
  for (const p of people(state)) {
    p.stats.shifts += 1;
    if (p.status === 'active') awardXp(state, p, null, P().xp.shift);
    p.fatigue = Math.max(0, p.fatigue - 0.5);
    p.injuredUntil = Math.max(0, (p.injuredUntil ?? 0) - state.time);
    if (p.training) p.training.until = Math.max(0, p.training.until - state.time);
  }
}

/** A new shift starts the clock again: carry injury and training timers over. */
export function openShiftForPersonnel(state) {
  for (const p of people(state)) {
    if (p.status === 'injured') p.injuredUntil = state.time + (p.injuredUntil ?? 0);
    if (p.status === 'training' && p.training) p.training.until = state.time + p.training.until;
    p.vehicleId = null;
  }
}
