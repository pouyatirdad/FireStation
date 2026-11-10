// The shift: one city, one engine, one crew, and a district that keeps catching
// fire. This module owns the tick order (alarms, units, fire, effects), the
// rating, and the small vocabulary of orders the UI can give.

import { CONFIG, TILE } from '../core/config.js';
import { Rng, formatClock } from '../core/math.js';
import { createCity } from '../data/city.js';
import { buildNav } from './grid.js';
import {
  activeEngine, buildingOf, buyVehicle, createUnits, deployCrew, dispatchEngine,
  engineForUnit, orderCrew, orderEngine, orderEngineToWildfire, recallCrew,
  restoreFleet, sellVehicle, sendEngineHome, toggleHydrant, updateUnits,
} from './units.js';
import { activeFires, ignite, updateFire } from './fire.js';
import { addEvent } from './events.js';
import { spawnDebris, updateEffects } from './effects.js';
import { updateFleeing } from './civilians.js';
import { updateIncidents } from './incidents.js';
import { restoreWildfires, updateWildfires } from './wildfire.js';

export function createGame(seed = CONFIG.city.seed) {
  const city = createCity(seed);
  const nav = buildNav(city);

  const state = {
    city,
    nav,
    seed,
    buildings: city.buildings,
    time: 0,
    clock: CONFIG.clockStart,
    running: false,
    paused: false,
    over: false,
    speed: 1,
    incidentsEnabled: true,
    rng: new Rng(seed * 7919 + 13),
    rating: CONFIG.rating.start,
    credits: CONFIG.economy.start,
    stats: { saved: 0, lost: 0, alarms: 0, rescued: 0, casualties: 0, escaped: 0 },
    events: [],
    eventSeq: 0,
    streams: [],
    hoses: [],
    fx: [],
    fleeing: [],
    wildfires: [],
    nextCallAt: CONFIG.incidents.firstCall,
    nextBigAt: CONFIG.incidents.bigAfter + 30,
    selected: null,
    // UI-only scratch space: pointer hover, minimap rect, last toast shown.
    ui: { hover: null, minimap: null, seenEvent: 0 },
  };

  createUnits(state);
  state.onDestroyed = (building) => spawnDebris(state, building);
  return state;
}

export function startShift(state) {
  state.running = true;
  state.paused = false;
  addEvent(state, 'Shift start — Station 1 in service', 'info');
}

export function shiftTime(state) {
  return formatClock(state.clock);
}

export function update(state, dt) {
  if (!state.running || state.paused || state.over) return;

  state.time += dt;
  state.clock += dt * CONFIG.clockRate;

  // Units declare what they are doing this tick; fire and effects consume it.
  state.streams.length = 0;
  state.hoses.length = 0;

  updateIncidents(state, dt);
  updateUnits(state, dt);
  updateFire(state, dt);
  updateWildfires(state, dt);
  updateFleeing(state, dt);
  updateEffects(state, dt);
}

// ------------------------------------------------------------- selection ---

export function getSelected(state) {
  const sel = state.selected;
  if (!sel) return null;
  if (sel.kind === 'wildfire') {
    return (state.wildfires ?? []).find((w) => w.id === sel.id) ?? null;
  }
  if (sel.kind === 'unit') return state.units.find((u) => u.id === sel.id) ?? null;
  return state.buildings.find((b) => b.id === sel.id) ?? null;
}

export function selectWildfire(state, id) {
  state.selected = id ? { kind: 'wildfire', id } : null;
}

export function selectUnit(state, id) {
  state.selected = id ? { kind: 'unit', id } : null;
  const unit = id ? state.units.find((u) => u.id === id) : null;
  if (unit) {
    const engine = engineForUnit(state, unit);
    if (engine) state.activeEngineId = engine.id;
  }
}

export function selectBuilding(state, id) {
  state.selected = id ? { kind: 'building', id } : null;
}

/** What is under a world-space point. Units win over buildings. */
export function pickAt(state, wx, wy, pad = 0) {
  // A wildfire is a large area; test it before anything inside it.
  for (const wf of state.wildfires ?? []) {
    if (Math.hypot(wx - wf.x, wy - wf.y) <= wf.radius + pad) {
      return { kind: 'wildfire', id: wf.id };
    }
  }

  let best = null;
  let bestD = Infinity;
  for (const unit of state.units) {
    if (unit.kind === 'crew' && unit.riding) continue;
    const radius = (unit.kind === 'engine' ? 32 : 11) + pad;
    const d = Math.hypot(unit.x - wx, unit.y - wy);
    if (d <= radius && d < bestD) {
      bestD = d;
      best = { kind: 'unit', id: unit.id };
    }
  }
  if (best) return best;

  // Roofs lean north of their footprint, so test that silhouette too. If two
  // roofs overlap, the one whose base is further south is the one in front.
  let hit = null;
  let hitBase = -Infinity;
  for (const b of state.buildings) {
    const x = b.x * TILE;
    const y = b.y * TILE;
    const w = b.w * TILE;
    const h = b.h * TILE;
    if (wx >= x && wx <= x + w && wy >= y - b.elevation && wy <= y + h) {
      if (y + h > hitBase) {
        hitBase = y + h;
        hit = { kind: 'building', id: b.id };
      }
    }
  }
  return hit;
}

// ---------------------------------------------------------------- orders ---

export function commandMove(state, wx, wy, buildingId = null) {
  const selected = getSelected(state);
  if (!selected) {
    // Right-clicking a burning building with nothing selected dispatches the
    // nearest idle engine — the single most common intention in this game.
    const b = buildingOf(state, buildingId);
    if (b && b.state === 'burning') return commandDispatch(state, b.id);
    return false;
  }
  if (selected.kind === 'wildfire') return commandDispatchWildfire(state, selected.id);
  if (selected.kind === 'engine') return orderEngine(state, selected, wx, wy, buildingId);
  if (selected.kind === 'crew') return orderCrew(state, selected, wx, wy, buildingId);
  // A building is selected: send the active engine to it if it is alight.
  if (selected.state === 'burning') return commandDispatch(state, selected.id);
  return false;
}

function closestIdleEngine(state, x, y) {
  let idle = null;
  let idleD = Infinity;
  let near = null;
  let nearD = Infinity;
  for (const engine of state.engines) {
    const d = Math.hypot(engine.x - x, engine.y - y);
    if (d < nearD) {
      nearD = d;
      near = engine;
    }
    const free = !engine.targetId && !engine.wildfireId
      && engine.path.length === 0 && engine.packTimer === 0;
    if (free && d < idleD) {
      idleD = d;
      idle = engine;
    }
  }
  return idle ?? near;
}

export function commandDispatchWildfire(state, id) {
  const wildfire = (state.wildfires ?? []).find((w) => w.id === id);
  if (!wildfire) return false;
  const selected = getSelected(state);
  const engine = selected && selected.kind !== 'wildfire' ? engineForUnit(state, selected) : null;
  const chosen = engine ?? closestIdleEngine(state, wildfire.x, wildfire.y);
  if (!chosen) return false;
  selectUnit(state, chosen.id);
  return orderEngineToWildfire(state, chosen, wildfire);
}

export function commandDispatch(state, buildingId = null) {
  const selected = getSelected(state);
  if (selected?.kind === 'wildfire') return commandDispatchWildfire(state, selected.id);
  const engine = selected ? engineForUnit(state, selected) : null;
  const target = buildingOf(state, buildingId)
    ?? (selected?.kind === 'building' && selected.state === 'burning' ? selected : null);
  const chosen = dispatchEngine(state, engine, target?.id ?? null);
  if (chosen) {
    selectUnit(state, chosen.id);
    return true;
  }
  return false;
}

export function commandDeploy(state) {
  const engine = engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  if (!engine) return 0;
  if (engine.path.length > 0 || engine.packTimer > 0) {
    addEvent(state, `Stop ${engine.name} before deploying`, 'warn');
    return 0;
  }
  let target = buildingOf(state, engine.targetId);
  if (!target || (target.state !== 'burning' && (target.trapped ?? 0) <= 0)) {
    target = null;
    let best = Infinity;
    for (const b of activeFires(state)) {
      const d = Math.hypot(
        (b.x + b.w / 2) * TILE - engine.x,
        (b.y + b.h / 2) * TILE - engine.y,
      );
      if (d <= engine.spec.hoseRange * TILE && d < best) {
        best = d;
        target = b;
      }
    }
  }
  return deployCrew(state, engine, target);
}

export function commandRecall(state) {
  const engine = engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  return recallCrew(state, engine);
}

export function commandReturnHome(state) {
  const engine = engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  return sendEngineHome(state, engine);
}

/** Connect or disconnect the selected engine's supply line to a hydrant. */
export function commandHydrant(state) {
  const engine = engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  return toggleHydrant(state, engine);
}

/** Buy a vehicle of any type at the station. */
export function commandBuyVehicle(state, type = 'engine') {
  const engine = buyVehicle(state, type);
  if (engine) selectUnit(state, engine.id);
  return engine;
}

export function commandBuyEngine(state) {
  return commandBuyVehicle(state, 'engine');
}

/** Sell the selected vehicle. */
export function commandSellVehicle(state, id = null) {
  const engine = id
    ? state.engines.find((e) => e.id === id)
    : engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  return sellVehicle(state, engine);
}

// Re-exported so the UI has one module to talk to for orders.
export { orderEngine, orderCrew };

// ------------------------------------------------------------------- save ---

export function serialize(state) {
  return {
    version: 1,
    seed: state.seed,
    time: state.time,
    clock: state.clock,
    credits: state.credits,
    rating: state.rating,
    stats: { ...state.stats },
    incidentsEnabled: state.incidentsEnabled !== false,
    nextCallAt: state.nextCallAt,
    nextBigAt: state.nextBigAt,
    eventSeq: state.eventSeq,
    events: state.events.slice(0, 30).map((e) => ({ ...e })),
    buildings: state.buildings.map((b) => ({
      id: b.id,
      state: b.state,
      fire: b.fire,
      integrity: b.integrity,
      trapped: b.trapped ?? 0,
      occupants: b.occupants ?? 0,
      evacuated: Boolean(b.evacuated),
      reward: b.reward ?? 0,
      incidentType: b.incidentType ?? null,
      big: Boolean(b.big),
    })),
    engines: state.engines.map((e) => ({
      id: e.id,
      type: e.type,
      number: e.number,
      name: e.name,
      bayIndex: e.bayIndex,
      x: e.x,
      y: e.y,
      angle: e.angle,
      water: e.water,
      targetId: e.targetId,
      supply: e.supply,
    })),
    crews: state.crew.map((c) => ({
      id: c.id,
      number: c.number,
      name: c.name,
      engineId: c.engineId,
      x: c.x,
      y: c.y,
      riding: c.riding,
      targetId: c.targetId,
      wildfireId: c.wildfireId,
    })),
    wildfires: (state.wildfires ?? []).map((w) => ({ ...w })),
  };
}

export function loadState(data) {
  const state = createGame(data.seed ?? CONFIG.city.seed);
  state.time = data.time ?? 0;
  state.clock = data.clock ?? CONFIG.clockStart;
  state.credits = data.credits ?? CONFIG.economy.start;
  state.rating = data.rating ?? CONFIG.rating.start;
  state.stats = { ...state.stats, ...(data.stats ?? {}) };
  state.events = (data.events ?? []).map((e) => ({ ...e }));
  state.eventSeq = data.eventSeq ?? state.events.length;
  state.incidentsEnabled = data.incidentsEnabled !== false;
  state.nextCallAt = data.nextCallAt ?? CONFIG.incidents.firstCall;
  state.nextBigAt = data.nextBigAt ?? CONFIG.incidents.bigAfter + 30;

  const byId = new Map(state.buildings.map((b) => [b.id, b]));
  for (const saved of data.buildings ?? []) {
    const b = byId.get(saved.id);
    if (!b) continue;
    b.state = saved.state ?? 'ok';
    b.fire = saved.fire ?? 0;
    b.integrity = saved.integrity ?? b.maxIntegrity;
    b.trapped = saved.trapped ?? 0;
    b.occupants = saved.occupants ?? 0;
    b.evacuated = Boolean(saved.evacuated);
    b.reward = saved.reward ?? 0;
    b.incidentType = saved.incidentType ?? null;
    b.big = Boolean(saved.big);
  }

  restoreFleet(state, { engines: data.engines ?? [], crews: data.crews ?? [] });
  restoreWildfires(state, data.wildfires ?? []);
  state.running = true;
  state.paused = false;
  return state;
}
