// Civilians: the people inside the buildings when the alarm comes in.
//
// At ignition most of them get out on their own (the little figures running to
// the street); the rest are trapped and must be brought out by a firefighter.
// If the building comes down first, they are lost.
//
// This module owns the fleeing figures and the rescue bookkeeping. It never
// imports the fire system, so fire can call `evacuate` without a cycle.

import { CONFIG, TILE } from '../core/config.js';
import { findPath, passable, smoothPath, standTileForRect, tileCenter } from './grid.js';
import { addEvent } from './events.js';
import { earn, money } from './economy.js';
import { injureEvacuees, injureRescued } from './medical.js';

const FLEE_COLORS = ['#3d6fb0', '#b0553d', '#4f7a45', '#8a5a9e', '#b08a3a', '#5e6b78'];
const MAX_FLEEING = 24;
const MAX_VISIBLE_PER_FIRE = 5;

export const trappedCount = (building) => building.trapped ?? 0;

export function evacuate(state, building) {
  if (building.evacuated) return;
  building.evacuated = true;

  const occupants = building.occupants ?? 0;
  building.occupants = 0;
  if (occupants <= 0) {
    building.trapped = 0;
    return;
  }

  let trapped = Math.round(occupants * state.rng.range(0.03, 0.2));
  if (occupants >= 2 && trapped === 0 && state.rng.chance(0.35)) trapped = 1;
  trapped = Math.min(trapped, 3, occupants);
  building.trapped = trapped;

  const escaping = occupants - trapped;
  state.stats.escaped += escaping;
  spawnFleeing(state, building, escaping);
  injureEvacuees(state, building, escaping);

  if (trapped > 0) {
    addEvent(
      state,
      `${trapped} ${trapped === 1 ? 'person' : 'people'} trapped in ${building.name}`,
      'bad',
    );
  }
}

function pickExit(state, start) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const angle = state.rng.range(0, Math.PI * 2);
    const radius = state.rng.range(7, 14) * TILE;
    const tx = Math.floor((start.x + Math.cos(angle) * radius) / TILE);
    const ty = Math.floor((start.y + Math.sin(angle) * radius) / TILE);
    if (passable(state.nav, 'walk', tx, ty) && !(tx === start.x && ty === start.y)) {
      return { x: tx, y: ty };
    }
  }
  return null;
}

function spawnFleeing(state, building, count) {
  if (count <= 0) return;
  const rect = {
    x: building.x * TILE,
    y: building.y * TILE,
    w: building.w * TILE,
    h: building.h * TILE,
  };
  const start = standTileForRect(state.nav, rect, rect.x + rect.w / 2, rect.y + rect.h / 2, 5);
  if (!start) return;

  const visible = Math.min(count, MAX_VISIBLE_PER_FIRE, MAX_FLEEING - state.fleeing.length);
  const origin = tileCenter(start.x, start.y);
  for (let i = 0; i < visible; i++) {
    const goal = pickExit(state, origin);
    if (!goal) continue;
    const tiles = findPath(state.nav, 'walk', start, goal);
    if (!tiles) continue;
    const x = origin.x + state.rng.range(-9, 9);
    const y = origin.y + state.rng.range(-9, 9);
    state.fleeing.push({
      x,
      y,
      angle: 0,
      path: smoothPath(state.nav, 'walk', { x, y }, tiles),
      speed: state.rng.range(2.1, 3.1) * TILE,
      color: state.rng.pick(FLEE_COLORS),
      phase: state.rng.range(0, Math.PI * 2),
    });
  }
}

export function updateFleeing(state, dt) {
  for (let i = state.fleeing.length - 1; i >= 0; i--) {
    const person = state.fleeing[i];
    let budget = person.speed * dt;
    while (budget > 0 && person.path.length > 0) {
      const wp = person.path[0];
      const dx = wp.x - person.x;
      const dy = wp.y - person.y;
      const d = Math.hypot(dx, dy);
      if (d < 2) {
        person.path.shift();
        continue;
      }
      const step = Math.min(budget, d);
      person.x += (dx / d) * step;
      person.y += (dy / d) * step;
      person.angle = Math.atan2(dy, dx);
      budget -= step;
      if (step >= d - 0.001) person.path.shift();
    }
    if (person.path.length === 0) {
      // Round the corner and they are gone — counted as escaped already.
      state.fleeing[i] = state.fleeing[state.fleeing.length - 1];
      state.fleeing.pop();
    }
  }
}

/** One person brought out by a firefighter. */
export function rescuePerson(state, building) {
  if ((building.trapped ?? 0) <= 0) return false;
  building.trapped -= 1;
  state.stats.rescued += 1;
  state.rating = Math.min(CONFIG.rating.start, state.rating + 3);
  earn(state, CONFIG.economy.rescued, 'rescue');
  addEvent(state, `Rescued one from ${building.name}`, 'good');
  injureRescued(state, building);
  if (building.trapped === 0) {
    addEvent(state, `All clear at ${building.name}`, 'good');
    if (building.incidentType === 'rescue' && (building.reward ?? 0) > 0) {
      const reward = building.reward;
      building.reward = 0;
      building.incidentType = 'done';
      earn(state, reward, 'incident');
      addEvent(state, `Rescue complete — ${money(reward)} — ${building.name}`, 'good');
    }
  }
  return true;
}
