// How people, stations and support agencies change what the simulation does.
//
// This is a leaf module (it imports only the config) so the unit, fire and medical
// code can ask "how fast does this crew work?" without depending on career mode.
// In Quick Response there are no personnel records and every answer is 1.

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';

export const isCareer = (state) => state.mode === 'career' && Boolean(state.campaign);

/** The personnel record behind a crew unit, or null (Quick Response, or an unstaffed unit). */
export function personOf(state, crew) {
  if (!crew?.personId || !isCareer(state)) return null;
  const list = state.campaign.personnel;
  for (let i = 0; i < list.length; i++) if (list[i].id === crew.personId) return list[i];
  return null;
}

/** 1 when rested, falling to 1 - penalty as fatigue goes from half to full. */
export function fatigueFactor(person) {
  const f = CONFIG.personnel.fatigue;
  return 1 - f.penalty * clamp(((person?.fatigue ?? 0) - 0.5) / 0.5, 0, 1);
}

export const skillBonus = (level) => 1 + CONFIG.personnel.skillBonus * (Math.max(1, level) - 1);

/**
 * How much faster (or slower) than the base rate this crew member works at a
 * skill ('firefighting' | 'rescue' | 'medical' | 'driving' | 'technical').
 */
export function workRate(state, crew, skill) {
  const person = personOf(state, crew);
  if (!person) return 1;
  return skillBonus(person.skills?.[skill] ?? 1) * fatigueFactor(person);
}

/** An upgrade level at a station (0 if none, or in Quick Response). */
export function upgradeLevel(state, station, key) {
  if (!isCareer(state)) return 0;
  return state.campaign.stations?.[station]?.upgrades?.[key] ?? 0;
}

/** The station a vehicle is based at (index into city.stations). */
export const stationOfEngine = (state, engine) => state.city.bays[engine.bayIndex]?.station ?? 0;

/** Support units that are on scene and affect the area round a point. */
export function supportAt(state, agency, x, y) {
  const list = state.support?.active;
  if (!list) return null;
  for (const s of list) {
    if (s.agency !== agency || state.time < s.arriveAt || state.time > s.until) continue;
    if (Math.hypot(s.x - x, s.y - y) <= s.radius) return s;
  }
  return null;
}

/**
 * Extra speed for a road vehicle: its best driver's skill and tiredness, the
 * communication centre at its home station, and police traffic control.
 * Multiplied on top of the traffic factor.
 */
export function speedMod(state, engine) {
  let mod = 1;
  if (isCareer(state)) {
    let best = 1;
    for (const id of engine.crewIds) {
      const crew = state.crew.find((c) => c.id === id);
      const person = personOf(state, crew);
      if (person) best = Math.max(best, skillBonus(person.skills.driving) * fatigueFactor(person));
    }
    mod *= best;
    if (engine.status === 'responding' || engine.status === 'transporting') {
      mod *= 1 + CONFIG.upgrades.comms.per * upgradeLevel(state, stationOfEngine(state, engine), 'comms');
    }
  }
  if (!engine.spec.flying && !engine.spec.boat && supportAt(state, 'police', engine.x, engine.y)) {
    // Streets closed ahead of the engine: no rush-hour slowdown, and a little more.
    mod *= Math.max(1, 1 / (state.trafficFactor || 1)) * 1.08;
  }
  return mod;
}

/** Workers clear a wreck faster with police holding the traffic back. */
export function clearRate(state, x, y) {
  return supportAt(state, 'police', x, y) ? 1.5 : 1;
}

const diveMods = (state, crew) => {
  const person = personOf(state, crew);
  if (!person) return null;
  const d = CONFIG.water.dive;
  return person.certs?.includes('diving') ? d.certified : d.uncertified;
};

/** Career only: how fast a diver brings someone out (the certificate speeds it up, its absence slows it). */
export const diveRate = (state, crew) => diveMods(state, crew)?.rescue ?? 1;

/** Career only: how far from its vehicle a diver swims, as a multiple of the vehicle's dive range. */
export const diveReach = (state, crew) => diveMods(state, crew)?.range ?? 1;

/** Is this crew member protected against hazardous materials? */
export function hazmatProtected(state, crew, engine) {
  if (engine?.spec?.hazmat) return true;
  const person = personOf(state, crew);
  return Boolean(person?.certs?.includes('hazmat'));
}

