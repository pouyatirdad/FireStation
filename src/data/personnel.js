// Firefighter identities. Names come from an internal pool and are drawn from a
// seeded generator, so a candidate list is reproducible and a saved person keeps
// the name they were born with.

import { CONFIG } from '../core/config.js';

const FIRST = [
  'Ava', 'Liam', 'Noor', 'Mateo', 'Sana', 'Jonas', 'Leila', 'Owen', 'Maya', 'Kofi',
  'Ines', 'Rafael', 'Yuki', 'Dara', 'Tomas', 'Amira', 'Felix', 'Nia', 'Omar', 'Elena',
  'Hugo', 'Zara', 'Ivan', 'Mina', 'Caleb', 'Rosa', 'Arman', 'Tess', 'Luca', 'Hana',
  'Pavel', 'Sofia', 'Idris', 'Greta', 'Nikos', 'Alba', 'Kian', 'Mara', 'Joel', 'Sima',
];
const LAST = [
  'Alder', 'Brandt', 'Castillo', 'Dahl', 'Eriksen', 'Fontaine', 'Garza', 'Hayes', 'Ito', 'Jovanovic',
  'Kaya', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quinn', 'Rahimi', 'Santos', 'Torres',
  'Ulmer', 'Vega', 'Walsh', 'Xu', 'Yilmaz', 'Zielinski', 'Marsh', 'Doyle', 'Hartley', 'Novak',
  'Bianchi', 'Carvalho', 'Dubois', 'Engel', 'Farrow', 'Greco', 'Holm', 'Ivanov', 'Keller', 'Lund',
];

export const SKILLS = CONFIG.personnel.skills;

export const SKILL_LABEL = {
  firefighting: 'Firefighting',
  rescue: 'Rescue',
  medical: 'Medical',
  driving: 'Driving',
  technical: 'Technical',
};

/** What each skill actually changes in the simulation, for the personnel screen. */
export const SKILL_EFFECT = {
  firefighting: 'Water on a fire knocks it down faster',
  rescue: 'Trapped and drowning people are brought out faster',
  medical: 'Patients are treated faster',
  driving: 'The vehicle drives faster',
  technical: 'Cutters and chainsaws work faster; unlocks hazmat and technical rescue',
};

export function rankFor(level) {
  const ranks = CONFIG.personnel.ranks;
  let rank = ranks[0];
  for (const r of ranks) if (level >= r.level) rank = r;
  return rank;
}

export const rankLabel = (id) => CONFIG.personnel.ranks.find((r) => r.id === id)?.label ?? 'Recruit';

/**
 * A new person. `quality` (0..1) tilts the skills upwards: candidates for hire
 * vary, the starting crew are average.
 */
export function makePerson(rng, id, quality = 0.3) {
  const skills = {};
  for (const skill of SKILLS) {
    const level = 1 + Math.floor(rng.float() * (1 + 3 * quality + 1.2));
    skills[skill] = Math.min(CONFIG.personnel.maxSkill, level);
  }
  const level = 1;
  return {
    id,
    name: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
    rank: rankFor(level).id,
    level,
    xp: 0,
    skills,
    skillXp: Object.fromEntries(SKILLS.map((s) => [s, 0])),
    certs: [],
    fatigue: 0,
    injuredUntil: 0, // shift time at which they are fit again; 0 = healthy
    status: 'active', // active | injured | training | candidate
    station: null,
    vehicleId: null,
    training: null, // { course, until, station }
    stats: { shifts: 0, incidents: 0, rescues: 0, treatments: 0, knockdowns: 0, injuries: 0, hoursOnDuty: 0 },
  };
}

/** What it costs per game hour to keep this person on the books. */
export const salaryOf = (person) => CONFIG.career.salary[person.rank] ?? CONFIG.career.salary.recruit;

/** A single number for sorting and comparing: the sum of the skills. */
export const overall = (person) => SKILLS.reduce((sum, s) => sum + (person.skills?.[s] ?? 1), 0);
