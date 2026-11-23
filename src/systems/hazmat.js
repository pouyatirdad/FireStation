// Hazmat operations. A building that burns with chemicals in it, or that is
// leaking (`b.leak`, from the chemical-leak and gas scenes), has a hazard zone
// round it. A crew member who works inside the zone without protection (a hazmat
// unit's suits, or a hazmat-certified person) is contaminated; enough exposure
// overcomes them and they become a casualty to treat (in a career the person is
// also injured). Protected crews can contain a leak, and crews are decontaminated
// beside a hazmat unit.

import { CONFIG, TILE } from '../core/config.js';
import { addEvent } from './events.js';
import { earn, money } from './economy.js';
import { injure } from './personnel.js';
import { hazmatProtected, isCareer, personOf } from './modifiers.js';
import { spawnPatientAt } from './medical.js';

const radiusOf = (b, level) => CONFIG.hazard.radius * (0.6 + 0.4 * Math.min(1, level)) * (b.utilityCut ? 0.6 : 1);

export const isLeaking = (b) => (b.leak ?? 0) > 0;
export const hasHazard = (b) => b.hazmat && b.state !== 'rubble' && (b.state === 'burning' || isLeaking(b));

/** Hazard zones right now, rebuilt from the buildings each tick (nothing extra to save). */
export function hazardZones(state) {
  const zones = [];
  for (const b of state.buildings) {
    if (!hasHazard(b)) continue;
    const level = b.state === 'burning' ? Math.max(0.5, b.fire) : b.leak;
    zones.push({
      id: `hazard-${b.id}`, buildingId: b.id, name: b.name,
      x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE, radius: radiusOf(b, level) * TILE, level,
      leak: isLeaking(b), burning: b.state === 'burning',
    });
  }
  return zones;
}

export const zoneAt = (zones, x, y) => zones.find((z) => Math.hypot(z.x - x, z.y - y) <= z.radius) ?? null;

/** A chemical leak at a building: the people nearby are hurt and a zone forms. */
export function startLeak(state, building, strength = 1) {
  building.hazmat = true;
  building.leak = Math.max(building.leak ?? 0, strength);
  return building;
}

export function updateHazards(state, dt) {
  const zones = hazardZones(state);
  state.hazards = zones;
  const H = CONFIG.hazard;
  const hazmatEngines = state.engines.filter((e) => e.spec.hazmat);

  // A leak disperses on its own, slowly (a utility crew's valve work makes it faster);
  // protected crews can contain it sooner. Dispersal pays nothing.
  for (const b of state.buildings) {
    if (!isLeaking(b) || b.state === 'burning') continue;
    b.leak = Math.max(0, b.leak - dt / (b.utilityCut ? 90 : 300));
    if (b.leak <= 0) disperse(state, b);
  }

  for (const crew of state.crew) {
    const engine = state.engines.find((e) => e.id === crew.engineId);
    if (!engine) continue;
    if (crew.contamination == null) crew.contamination = 0;

    if (!crew.riding) {
      const zone = zoneAt(zones, crew.x, crew.y);
      if (zone && !hazmatProtected(state, crew, engine)) {
        crew.contamination += H.contaminationPerSecond * dt * (0.5 + zone.level);
        if (crew.contamination >= 1) {
          crew.contamination = 0.4;
          overcome(state, crew);
        } else if (!crew.warnedHazard) {
          crew.warnedHazard = true;
          addEvent(state, `${engine.name}'s crew are working in a hazard zone without protection!`, 'warn');
        }
      } else if (zone && hazmatProtected(state, crew, engine)) {
        // Suited crews work the leak: they can contain it.
        const b = state.buildings.find((x) => x.id === zone.buildingId);
        if (b && isLeaking(b) && b.state !== 'burning' && Math.hypot(crew.x - zone.x, crew.y - zone.y) <= 5 * TILE) {
          b.leak = Math.max(0, b.leak - dt / 22);
          if (b.leak <= 0) containLeak(state, b);
        }
      }
    }

    // Decontamination: a hazmat unit's wash line, near a station or beside a hazmat unit.
    if (crew.contamination > 0 && !zoneAt(zones, crew.x, crew.y)) {
      const near = hazmatEngines.some((e) => Math.hypot(e.x - crew.x, e.y - crew.y) <= 6 * TILE);
      crew.contamination = Math.max(0, crew.contamination - dt * (near ? 1 / H.decontamination : 1 / 60));
      if (crew.contamination === 0) crew.warnedHazard = false;
    }
  }
}

function overcome(state, crew) {
  const engine = state.engines.find((e) => e.id === crew.engineId);
  addEvent(state, `A firefighter from ${engine?.name ?? 'a crew'} was overcome by fumes`, 'bad');
  spawnPatientAt(state, { x: crew.x, y: crew.y, severity: 0.55, label: 'the hazard zone', reason: 'Firefighter overcome by fumes near' });
  if (isCareer(state)) {
    const person = personOf(state, crew);
    if (person) injure(state, person, 1.3);
  }
}

function disperse(state, b) {
  b.leak = 0;
  b.reward = 0;
  b.hazmat = b.state === 'burning';
  b.incidentLabel = null;
  addEvent(state, `The gas at ${b.name} has dispersed`, 'info');
}

function containLeak(state, b) {
  b.leak = 0;
  b.hazmat = false;
  addEvent(state, `Leak contained at ${b.name}`, 'good');
  if ((b.reward ?? 0) > 0 && b.state === 'ok') {
    const reward = b.reward;
    b.reward = 0;
    earn(state, reward, 'incident');
    addEvent(state, `Hazmat incident closed — ${money(reward)} — ${b.name}`, 'good');
  }
  b.incidentLabel = null;
}

