// Structural collapse. A collapsed building (`b.collapse`) has people buried in
// it. Rescue is slow by hand and faster with cutting gear (units.js reads
// `target.collapse`); the structure can fail again while crews are inside (a
// secondary collapse buries more people and hurts rescuers), and if nobody gets
// the people out in time they are lost.

import { CONFIG, TILE } from '../core/config.js';
import { addEvent } from './events.js';
import { spend } from './economy.js';
import { injure } from './personnel.js';
import { isCareer, personOf } from './modifiers.js';
import { spawnPatientAt } from './medical.js';
import { spawnSmoke } from './effects.js';

const LIMIT = 420; // seconds buried people last

/** Bring a building down on its occupants. */
export function collapseBuilding(state, b, trapped = 3) {
  const n = Math.max(1, trapped);
  b.trapped = Math.max(b.trapped ?? 0, n);
  b.occupants = 0;
  b.evacuated = true;
  b.integrity = Math.min(b.integrity ?? 1, (b.maxIntegrity ?? 1) * 0.45);
  const [lo, hi] = CONFIG.collapse.secondary;
  b.collapse = { initial: b.trapped, at: state.time, secondaryIn: state.rng.range(lo, hi), secondaryDone: false };
  b.incidentType = b.incidentType ?? 'rescue';
  for (let i = 0; i < 8; i++) {
    spawnSmoke(state, (b.x + state.rng.range(0, b.w)) * TILE, (b.y + state.rng.range(0, b.h)) * TILE, 1.6);
  }
  return b;
}

/** Share of the buried people already out, for the incident card. */
export const rescueProgress = (b) => (b.collapse ? 1 - (b.trapped ?? 0) / Math.max(1, b.collapse.initial) : 0);

export function updateCollapse(state, dt) {
  for (const b of state.buildings) {
    const c = b.collapse;
    if (!c) continue;
    if ((b.trapped ?? 0) <= 0) {
      b.collapse = null;
      addEvent(state, `Search and rescue finished at ${b.name}`, 'good');
      continue;
    }
    const cx = (b.x + b.w / 2) * TILE;
    const cy = (b.y + b.h / 2) * TILE;
    const crews = state.crew.filter((x) => !x.riding && Math.hypot(x.x - cx, x.y - cy) <= (Math.max(b.w, b.h) / 2 + 5) * TILE);

    // Crews with technical training shore the structure, buying time.
    const shoring = crews.some((x) => personOf(state, x)?.certs?.includes('technical')) ? 0.5 : 1;
    if (!c.secondaryDone) {
      c.secondaryIn -= dt * (crews.length > 0 ? shoring : 0.4);
      if (c.secondaryIn <= 0) secondary(state, b, c, crews);
    }

    if (state.time - c.at >= LIMIT) {
      const lost = b.trapped;
      b.trapped = 0;
      b.collapse = null;
      state.stats.casualties += lost;
      state.rating = Math.max(0, state.rating - lost * 6);
      spend(state, lost * CONFIG.economy.casualtyPenalty, 'casualty');
      addEvent(state, `${lost} ${lost === 1 ? 'person' : 'people'} could not be reached in the rubble of ${b.name}`, 'bad');
    }
  }
}

function secondary(state, b, c, crews) {
  c.secondaryDone = true;
  const more = state.rng.int(1, 2);
  b.trapped += more;
  c.initial += more;
  addEvent(state, `SECONDARY COLLAPSE at ${b.name} — ${more} more buried${crews.length ? ', rescuers caught in it' : ''}`, 'big');
  for (const crew of crews) {
    if (!state.rng.chance(0.35)) continue;
    const person = personOf(state, crew);
    if (isCareer(state) && person) injure(state, person, 1.2);
    else spawnPatientAt(state, { x: crew.x, y: crew.y, severity: 0.6, label: b.name, reason: 'Rescuer hurt in a secondary collapse at' });
  }
}
