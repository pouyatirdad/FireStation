// The engine companies and their crews: driving the road network, laying hose,
// pulling people out and putting water on a fire.
//
// A shift starts with one engine and three firefighters. More engines can be
// bought at the station; each one is independent — its own tank, hose, deck gun
// and crew — and the selection tells the orders where to go.

import { CONFIG, TILE } from '../core/config.js';
import { angleTo, approachAngle, dist, distToRect } from '../core/math.js';
import {
  findPath, nearestPassable, passable, smoothPath, standTileForRect, tileOf,
} from './grid.js';
import { addEvent } from './events.js';
import { activeFires, buildingRect } from './fire.js';
import { streamImpact, spawnRescue } from './effects.js';
import { rescuePerson } from './civilians.js';

const CREW_OFFSETS = [
  { a: 0.85, r: 26 },
  { a: -0.85, r: 26 },
  { a: Math.PI + 0.4, r: 30 },
  { a: Math.PI - 0.4, r: 30 },
];

// ------------------------------------------------------------- creation ---

export function createUnits(state) {
  state.engines = [];
  state.crew = [];
  state.units = [];
  state.vehicleCount = {};
  state.nextCrew = 1;

  const first = spawnVehicle(state, 'engine');
  state.activeEngineId = first.id;
  syncUnits(state);
}

function syncUnits(state) {
  state.units = [...state.engines, ...state.crew];
}

export const vehicleSpec = (type) => CONFIG.vehicles[type] ?? null;
export const vehicleCost = (type) => CONFIG.vehicles[type]?.cost ?? 0;

function spawnVehicle(state, type) {
  const spec = CONFIG.vehicles[type];
  if (!spec) return null;
  state.vehicleCount[type] = (state.vehicleCount[type] ?? 0) + 1;
  const number = state.vehicleCount[type];
  const bayIndex = state.engines.length % state.city.bays.length;
  const bay = state.city.bays[bayIndex];
  const engine = {
    id: `${type}${number}`,
    kind: 'engine',
    type,
    spec,
    number,
    bayIndex,
    name: `${spec.label} ${number}`,
    x: bay.x,
    y: bay.y,
    angle: state.city.spawn.angle,
    path: [],
    targetId: null,
    wildfireId: null,
    arrived: false,
    packTimer: 0,
    water: spec.capacity,
    capacity: spec.capacity,
    refilling: false,
    pumping: false,
    supply: null,
    emptyWarned: false,
    fullNotified: false,
    lowWarned: false,
    status: 'in quarters',
    crewIds: [],
  };
  state.engines.push(engine);
  for (let i = 0; i < spec.crew; i++) spawnCrew(state, engine);
  return engine;
}

function spawnCrew(state, engine) {
  const number = state.nextCrew++;
  const crew = {
    id: `crew${number}`,
    kind: 'crew',
    number,
    name: `Crew ${number}`,
    engineId: engine.id,
    x: engine.x,
    y: engine.y,
    angle: engine.angle,
    path: [],
    riding: true,
    targetId: null,
    spraying: false,
    think: 0,
    warned: false,
    rescueTimer: 0,
    rescueId: null,
    wildfireId: null,
    status: 'aboard',
  };
  engine.crewIds.push(crew.id);
  state.crew.push(crew);
  return crew;
}

/** Buy a vehicle of any type at the station, if a bay is free and it is affordable. */
export function buyVehicle(state, type = 'engine') {
  const spec = CONFIG.vehicles[type];
  if (!spec) return null;
  if (state.engines.length >= state.city.bays.length) {
    addEvent(state, 'All apparatus bays are full', 'warn');
    return null;
  }
  if (state.credits < spec.cost) {
    addEvent(state, `Not enough credits — $${spec.cost.toLocaleString('en-US')} needed`, 'warn');
    return null;
  }
  state.credits -= spec.cost;
  const engine = spawnVehicle(state, type);
  syncUnits(state);
  state.activeEngineId = engine.id;
  addEvent(state, `${engine.name} in service`, 'good');
  return engine;
}

/** Sell a vehicle back to the station for a share of its price. */
export function sellVehicle(state, engine) {
  if (!engine || !state.engines.includes(engine)) return 0;
  const refund = Math.round((engine.spec?.cost ?? 0) * (engine.spec?.refund ?? 0.6));
  state.engines = state.engines.filter((e) => e !== engine);
  const ids = new Set(engine.crewIds);
  state.crew = state.crew.filter((c) => !ids.has(c.id));
  syncUnits(state);
  state.credits += refund;
  if (state.selected?.id === engine.id) state.selected = null;
  if (state.activeEngineId === engine.id) state.activeEngineId = state.engines[0]?.id ?? null;
  addEvent(state, `${engine.name} sold — $${refund.toLocaleString('en-US')}`, 'info');
  return refund;
}

export function buyEngine(state) {
  return buyVehicle(state, 'engine');
}

function vehicleBase(state, type, overrides = {}) {
  const spec = CONFIG.vehicles[type] ?? CONFIG.vehicles.engine;
  return {
    kind: 'engine',
    type,
    spec,
    number: 1,
    bayIndex: 0,
    name: spec.label,
    x: state.city.spawn.x,
    y: state.city.spawn.y,
    angle: state.city.spawn.angle,
    path: [],
    targetId: null,
    wildfireId: null,
    arrived: false,
    packTimer: 0,
    water: spec.capacity,
    capacity: spec.capacity,
    refilling: false,
    pumping: false,
    supply: null,
    emptyWarned: false,
    fullNotified: false,
    lowWarned: false,
    status: 'in quarters',
    crewIds: [],
    ...overrides,
  };
}

/** Rebuild the fleet from a save file. */
export function restoreFleet(state, saved = {}) {
  state.engines = [];
  state.crew = [];
  state.vehicleCount = {};
  state.nextCrew = 1;

  for (const entry of saved.engines ?? []) {
    const type = CONFIG.vehicles[entry.type] ? entry.type : 'engine';
    const engine = vehicleBase(state, type, {
      id: entry.id,
      number: entry.number ?? 1,
      name: entry.name ?? CONFIG.vehicles[type].label,
      bayIndex: entry.bayIndex ?? 0,
      x: entry.x ?? state.city.spawn.x,
      y: entry.y ?? state.city.spawn.y,
      angle: entry.angle ?? state.city.spawn.angle,
      water: entry.water ?? CONFIG.vehicles[type].capacity,
      targetId: entry.targetId ?? null,
      supply: entry.supply ?? null,
    });
    state.vehicleCount[type] = Math.max(state.vehicleCount[type] ?? 0, engine.number);
    state.engines.push(engine);
  }

  for (const entry of saved.crews ?? []) {
    const engine = state.engines.find((e) => e.id === entry.engineId);
    if (!engine) continue;
    const number = entry.number ?? state.nextCrew;
    const crew = {
      id: entry.id ?? `crew${number}`,
      kind: 'crew',
      number,
      name: entry.name ?? `Crew ${number}`,
      engineId: engine.id,
      x: entry.x ?? engine.x,
      y: entry.y ?? engine.y,
      angle: 0,
      path: [],
      riding: entry.riding !== false,
      targetId: entry.targetId ?? null,
      spraying: false,
      think: 0,
      warned: false,
      rescueTimer: 0,
      rescueId: null,
      wildfireId: entry.wildfireId ?? null,
      status: entry.riding !== false ? 'aboard' : 'standing by',
    };
    state.nextCrew = Math.max(state.nextCrew, number + 1);
    engine.crewIds.push(crew.id);
    state.crew.push(crew);
  }

  state.units = [...state.engines, ...state.crew];
  state.activeEngineId = state.engines[0]?.id ?? null;
  state.selected = null;
  return state.engines;
}

export function findUnit(state, id) {
  return state.units.find((u) => u.id === id) ?? null;
}

export function buildingOf(state, id) {
  return id ? state.buildings.find((b) => b.id === id) ?? null : null;
}

export function crewOf(state, engine) {
  return engine.crewIds
    .map((id) => state.crew.find((c) => c.id === id))
    .filter(Boolean);
}

export function engineOfCrew(state, crew) {
  return state.engines.find((e) => e.id === crew.engineId) ?? null;
}

/** The engine a selected unit belongs to (an engine is its own). */
export function engineForUnit(state, unit) {
  if (!unit) return null;
  if (unit.kind === 'engine') return unit;
  return engineOfCrew(state, unit);
}

export function activeEngine(state) {
  return state.engines.find((e) => e.id === state.activeEngineId) ?? state.engines[0] ?? null;
}

// -------------------------------------------------------------- helpers ---

function nearStation(state, engine) {
  const station = state.city.station;
  const cx = (station.x + station.w / 2) * TILE;
  const cy = (station.y + station.h / 2) * TILE;
  return dist(engine.x, engine.y, cx, cy) < 8 * TILE;
}

function hydrantInReach(state, engine) {
  const range = CONFIG.refillRange * TILE;
  for (const h of state.city.hydrants) {
    const hx = (h.x + 0.5) * TILE;
    const hy = (h.y + 0.5) * TILE;
    if (dist(engine.x, engine.y, hx, hy) <= range) return h;
  }
  return null;
}

export { hydrantInReach };

/** The nearest hydrant the engine could hook up to, without the range check. */
export function nearestHydrant(state, engine) {
  let best = null;
  let bestD = Infinity;
  for (const h of state.city.hydrants) {
    const hx = (h.x + 0.5) * TILE;
    const hy = (h.y + 0.5) * TILE;
    const d = dist(engine.x, engine.y, hx, hy);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best ? { hydrant: best, distance: bestD } : null;
}

// ---------------------------------------------------------------- orders ---

export function orderEngine(state, engine, wx, wy, buildingId = null, wildfireId = null) {
  if (!engine) return false;
  const building = buildingOf(state, buildingId);
  let goal = null;
  if (building) {
    const rect = buildingRect(building);
    goal = nearestPassable(
      state.nav,
      'drive',
      Math.floor((rect.x + rect.w / 2) / TILE),
      Math.floor((rect.y + rect.h / 2) / TILE),
      14,
    );
  }
  if (!goal) {
    goal = nearestPassable(state.nav, 'drive', Math.floor(wx / TILE), Math.floor(wy / TILE), 14);
  }
  if (!goal) {
    addEvent(state, `${engine.name}: no street there`, 'warn');
    return false;
  }
  const tiles = findPath(state.nav, 'drive', tileOf(engine.x, engine.y), goal);
  if (!tiles) {
    addEvent(state, `${engine.name}: no route to that address`, 'warn');
    return false;
  }
  // You cannot drive away with a hose still bolted to a hydrant.
  if (engine.supply) {
    engine.supply = null;
    addEvent(state, `${engine.name}: supply line detached`, 'info');
  }
  const crewOut = crewOf(state, engine).some((c) => !c.riding);
  engine.path = smoothPath(state.nav, 'drive', { x: engine.x, y: engine.y }, tiles);
  engine.targetId = building?.id ?? null;
  engine.wildfireId = wildfireId;
  engine.arrived = false;
  engine.packTimer = crewOut ? 1.4 : 0;
  engine.status = 'responding';
  return true;
}

/** Drive to the nearest street to a wildfire and deploy the crew there. */
export function orderEngineToWildfire(state, engine, wildfire) {
  if (!engine || !wildfire) return false;
  const goal = nearestPassable(
    state.nav,
    'drive',
    Math.floor(wildfire.x / TILE),
    Math.floor(wildfire.y / TILE),
    24,
  );
  if (!goal) {
    addEvent(state, `${engine.name}: no street reaches that fire`, 'warn');
    return false;
  }
  return orderEngine(
    state,
    engine,
    (goal.x + 0.5) * TILE,
    (goal.y + 0.5) * TILE,
    null,
    wildfire.id,
  );
}

export function orderCrew(state, crew, wx, wy, buildingId = null) {
  if (!crew || crew.riding) return false;
  const building = buildingOf(state, buildingId);
  const goal = building
    ? standTileForRect(state.nav, buildingRect(building), crew.x, crew.y)
    : nearestPassable(state.nav, 'walk', Math.floor(wx / TILE), Math.floor(wy / TILE), 8);
  if (!goal) return false;
  const tiles = findPath(state.nav, 'walk', tileOf(crew.x, crew.y), goal);
  if (!tiles) return false;
  crew.path = smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles);
  crew.targetId = building?.id ?? null;
  crew.think = 0;
  crew.status = 'moving';
  return true;
}

export function deployCrew(state, engine, target = null) {
  const aboard = crewOf(state, engine).filter((c) => c.riding);
  if (aboard.length === 0) return 0;
  let n = 0;
  for (const crew of aboard) {
    const offset = CREW_OFFSETS[n % CREW_OFFSETS.length];
    const angle = engine.angle + offset.a;
    let x = engine.x + Math.cos(angle) * offset.r;
    let y = engine.y + Math.sin(angle) * offset.r;
    if (!passable(state.nav, 'walk', Math.floor(x / TILE), Math.floor(y / TILE))) {
      x = engine.x;
      y = engine.y;
    }
    crew.riding = false;
    crew.x = x;
    crew.y = y;
    crew.path = [];
    crew.targetId = target?.id ?? null;
    crew.spraying = false;
    crew.think = 0;
    crew.warned = false;
    crew.rescueTimer = 0;
    crew.rescueId = null;
    crew.wildfireId = null;
    crew.status = 'deployed';
    n++;
  }
  addEvent(state, target ? `${n} crew deployed to ${target.name}` : `${n} crew deployed`, 'info');
  return n;
}

export function recallCrew(state, engine) {
  let n = 0;
  for (const crew of crewOf(state, engine)) {
    if (crew.riding) continue;
    crew.riding = true;
    crew.path = [];
    crew.spraying = false;
    crew.targetId = null;
    crew.rescueTimer = 0;
    crew.rescueId = null;
    crew.wildfireId = null;
    crew.status = 'aboard';
    n++;
  }
  if (n > 0) addEvent(state, 'Crew recalled to the engine', 'info');
  return n;
}

export function sendEngineHome(state, engine) {
  if (!engine) return false;
  const bay = state.city.bays[engine.bayIndex] ?? state.city.bays[0];
  return orderEngine(state, engine, bay.x, bay.y);
}

/**
 * Hook the engine's supply line to the hydrant it is parked beside, or let go
 * of it. A connected engine has an unlimited water supply while it stays put.
 */
export function toggleHydrant(state, engine) {
  if (!engine) return false;
  if (engine.supply) {
    engine.supply = null;
    addEvent(state, `${engine.name}: supply line detached`, 'info');
    return false;
  }
  if (engine.path.length > 0 || engine.packTimer > 0) {
    addEvent(state, `${engine.name}: stop before connecting the hydrant`, 'warn');
    return false;
  }
  const hydrant = hydrantInReach(state, engine);
  if (!hydrant) {
    addEvent(state, `${engine.name}: no hydrant within reach`, 'warn');
    return false;
  }
  engine.supply = {
    x: (hydrant.x + 0.5) * TILE,
    y: (hydrant.y + 0.5) * TILE,
  };
  addEvent(state, `${engine.name}: supply line connected`, 'good');
  return true;
}

/** The fire that most needs an engine right now. */
export function urgentFire(state) {
  const fires = activeFires(state);
  if (fires.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const b of fires) {
    const rect = buildingRect(b);
    const score = b.fire * 60 + (1 - b.integrity / b.maxIntegrity) * 25;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

function pickEngineFor(state, target) {
  const cx = (target.x + target.w / 2) * TILE;
  const cy = (target.y + target.h / 2) * TILE;
  let idle = null;
  let idleD = Infinity;
  let near = null;
  let nearD = Infinity;
  for (const engine of state.engines) {
    const d = dist(engine.x, engine.y, cx, cy);
    if (d < nearD) {
      nearD = d;
      near = engine;
    }
    const free = !engine.targetId && engine.path.length === 0 && engine.packTimer === 0;
    if (free && d < idleD) {
      idleD = d;
      idle = engine;
    }
  }
  return idle ?? near;
}

/**
 * Send an engine to a fire. With no engine given, the nearest idle one goes;
 * otherwise the given engine takes it (the player's explicit choice).
 */
export function dispatchEngine(state, engine = null, buildingId = null) {
  const target = buildingOf(state, buildingId) ?? urgentFire(state);
  if (!target) {
    addEvent(state, 'No active fires — the district is quiet', 'info');
    return false;
  }
  const chosen = engine ?? pickEngineFor(state, target);
  if (!chosen) return null;
  const ok = orderEngine(
    state,
    chosen,
    (target.x + target.w / 2) * TILE,
    (target.y + target.h / 2) * TILE,
    target.id,
  );
  return ok ? chosen : null;
}

// ---------------------------------------------------------------- update ---

export function updateUnits(state, dt) {
  for (const engine of state.engines) updateEngine(state, engine, dt);
  for (const crew of state.crew) updateCrew(state, crew, dt);
}

function followPath(unit, dt, speed, limit = null) {
  let budget = speed * dt;
  const turn = (unit.kind === 'engine' ? 5.5 : 12) * dt;
  while (budget > 0 && unit.path.length > 0) {
    const wp = unit.path[0];
    const dx = wp.x - unit.x;
    const dy = wp.y - unit.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.01) {
      unit.path.shift();
      continue;
    }
    const step = Math.min(budget, d);
    const nx = unit.x + (dx / d) * step;
    const ny = unit.y + (dy / d) * step;
    if (limit && Math.hypot(nx - limit.x, ny - limit.y) > limit.r) {
      unit.path.length = 0;
      return false;
    }
    unit.x = nx;
    unit.y = ny;
    unit.angle = approachAngle(unit.angle, Math.atan2(dy, dx), turn);
    budget -= step;
    if (step >= d - 0.001) unit.path.shift();
  }
  return unit.path.length === 0;
}

function arriveEngine(state, engine) {
  engine.arrived = true;
  const target = buildingOf(state, engine.targetId);
  if (target && target.state === 'burning') {
    const reach = distToRect(engine.x, engine.y, buildingRect(target));
    if (reach <= engine.spec.hoseRange * TILE) {
      deployCrew(state, engine, target);
    } else {
      addEvent(state, `${engine.name} is too far from ${target.name} to lay hose`, 'warn');
    }
  } else if (engine.wildfireId) {
    const wildfire = (state.wildfires ?? []).find((w) => w.id === engine.wildfireId);
    if (wildfire) deployCrew(state, engine, null);
    engine.wildfireId = null;
  }
  engine.status = 'on scene';
}

function turretTarget(state, engine) {
  const assigned = buildingOf(state, engine.targetId);
  const reach = engine.spec.turretRange * TILE;
  if (assigned && assigned.state === 'burning' && distToRect(engine.x, engine.y, buildingRect(assigned)) <= reach) {
    return assigned;
  }
  let best = null;
  let bestD = Infinity;
  for (const b of activeFires(state)) {
    const d = distToRect(engine.x, engine.y, buildingRect(b));
    if (d <= reach && d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function refillEngine(state, engine, dt) {
  if (engine.water >= engine.capacity) {
    engine.refilling = false;
    return;
  }
  const tileX = Math.floor(engine.x / TILE);
  const tileY = Math.floor(engine.y / TILE);
  const onApron = state.city.apron[tileY * state.city.w + tileX] === 1;
  if (!onApron && !engine.supply) {
    engine.refilling = false;
    return;
  }
  engine.water = Math.min(engine.capacity, engine.water + engine.spec.refillRate * dt);
  engine.refilling = true;
  if (engine.water >= engine.capacity - 1e-6) {
    if (!engine.fullNotified) {
      engine.fullNotified = true;
      addEvent(state, `${engine.name}: tank full`, 'good');
    }
  } else if (engine.water < engine.capacity * 0.9) {
    engine.fullNotified = false;
  }
  if (engine.water > engine.capacity * 0.15) engine.emptyWarned = false;
}

function updateEngine(state, engine, dt) {
  if (engine.packTimer > 0) {
    engine.packTimer -= dt;
    engine.status = 'packing up';
    if (engine.packTimer <= 0) {
      engine.packTimer = 0;
      for (const crew of crewOf(state, engine)) {
        crew.riding = true;
        crew.path = [];
        crew.targetId = null;
        crew.spraying = false;
        crew.rescueTimer = 0;
        crew.rescueId = null;
        crew.wildfireId = null;
        crew.status = 'aboard';
      }
    }
    return;
  }

  if (engine.path.length > 0) {
    followPath(engine, dt, engine.spec.speed * TILE);
    engine.pumping = false;
    engine.refilling = false;
    if (engine.path.length === 0) arriveEngine(state, engine);
    engine.status = 'responding';
    return;
  }

  if (engine.targetId && !engine.arrived) arriveEngine(state, engine);

  // A fire that is out is no longer a reason to stay marked on scene.
  if (engine.targetId && engine.arrived) {
    const current = buildingOf(state, engine.targetId);
    if (!current || current.state !== 'burning') engine.targetId = null;
  }

  // Deck gun: automatic once the engine is parked within reach of a fire.
  engine.pumping = false;
  const target = turretTarget(state, engine);
  if (target && engine.water > 0) {
    engine.pumping = true;
    const impact = streamImpact(target, engine.x, engine.y);
    engine.angle = approachAngle(
      engine.angle,
      angleTo(engine.x, engine.y, impact.x, impact.y),
      5 * dt,
    );
    state.streams.push({
      kind: 'turret',
      sx: engine.x + Math.cos(engine.angle) * 6,
      sy: engine.y - 10 + Math.sin(engine.angle) * 6,
      tx: impact.x,
      ty: impact.y,
      power: engine.spec.turretPower,
      targetId: target.id,
      engineId: engine.id,
    });
    engine.water = Math.max(0, engine.water - engine.spec.turretWater * dt);
    if (engine.water <= 0 && !engine.emptyWarned) {
      engine.emptyWarned = true;
      addEvent(state, `${engine.name} is out of water — find a hydrant`, 'warn');
    }
  }

  refillEngine(state, engine, dt);

  if (engine.water < engine.capacity * 0.2 && !engine.lowWarned) {
    engine.lowWarned = true;
    addEvent(state, `${engine.name} water low — find a hydrant`, 'warn');
  }
  if (engine.water > engine.capacity * 0.5) engine.lowWarned = false;

  if (engine.pumping) engine.status = 'pumping';
  else if (engine.refilling) engine.status = 'refilling';
  else if (nearStation(state, engine)) engine.status = 'in quarters';
  else if (engine.targetId) engine.status = 'on scene';
  else engine.status = 'standing by';
}

function chooseTarget(state, crew, engine) {
  let best = null;
  let bestScore = Infinity;
  for (const b of state.buildings) {
    if (b.state === 'rubble') continue;
    const trapped = b.trapped ?? 0;
    if (b.state !== 'burning' && trapped <= 0) continue;
    const rect = buildingRect(b);
    if (distToRect(engine.x, engine.y, rect) > engine.spec.hoseRange * TILE) continue;
    const d = distToRect(crew.x, crew.y, rect);
    if (d > CONFIG.crew.engageRange * TILE) continue;
    // Life before property: trapped people outrank a fire on the next block.
    const score = d - (trapped > 0 ? 600 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

function wildfireTarget(state, crew, engine) {
  let best = null;
  let bestD = Infinity;
  const hose = engine.spec.hoseRange * TILE;
  for (const wf of state.wildfires ?? []) {
    const crewEdge = Math.hypot(wf.x - crew.x, wf.y - crew.y) - wf.radius;
    const engineEdge = Math.hypot(wf.x - engine.x, wf.y - engine.y) - wf.radius;
    if (engineEdge > hose) continue;
    if (crewEdge > CONFIG.crew.engageRange * TILE) continue;
    if (crewEdge < bestD) {
      bestD = crewEdge;
      best = wf;
    }
  }
  return best;
}

function updateCrewWildfire(state, crew, engine, wildfire, dt) {
  if (!state.wildfires?.includes(wildfire)) return false;

  const hoseRange = engine.spec.hoseRange * TILE;
  const dx = crew.x - wildfire.x;
  const dy = crew.y - wildfire.y;
  const centerDist = Math.hypot(dx, dy) || 1;
  const edgeDist = Math.max(0, centerDist - wildfire.radius);
  const hoseOk = dist(crew.x, crew.y, engine.x, engine.y) <= hoseRange;

  if (edgeDist <= CONFIG.crew.sprayRange * TILE && hoseOk) {
    if (engine.water <= 0) {
      crew.spraying = false;
      crew.status = 'no water';
      return true;
    }
    const ux = dx / centerDist;
    const uy = dy / centerDist;
    const tx = wildfire.x + ux * wildfire.radius;
    const ty = wildfire.y + uy * wildfire.radius;
    crew.spraying = true;
    crew.status = 'spraying';
    crew.angle = Math.atan2(ty - crew.y, tx - crew.x);
    state.streams.push({
      kind: 'crew',
      sx: crew.x + Math.cos(crew.angle) * 10,
      sy: crew.y + Math.sin(crew.angle) * 10 - 4,
      tx,
      ty,
      power: CONFIG.crew.sprayPower,
      wildfireId: wildfire.id,
      crewId: crew.id,
      engineId: engine.id,
    });
    state.hoses.push({ ax: engine.x, ay: engine.y, bx: crew.x, by: crew.y, live: true });
    engine.water = Math.max(0, engine.water - CONFIG.crew.sprayWater * dt);
    if (engine.water <= 0 && !engine.emptyWarned) {
      engine.emptyWarned = true;
      addEvent(state, `${engine.name} is out of water — find a hydrant`, 'warn');
    }
    return true;
  }

  crew.spraying = false;
  crew.status = 'moving';
  crew.think -= dt;
  if (crew.think <= 0) {
    crew.think = 0.9;
    const ux = dx / centerDist;
    const uy = dy / centerDist;
    const px = wildfire.x + ux * (wildfire.radius + 1.6 * TILE);
    const py = wildfire.y + uy * (wildfire.radius + 1.6 * TILE);
    const goal = nearestPassable(
      state.nav,
      'walk',
      Math.floor(px / TILE),
      Math.floor(py / TILE),
      8,
    );
    const tiles = goal ? findPath(state.nav, 'walk', tileOf(crew.x, crew.y), goal) : null;
    if (tiles) crew.path = smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles);
  }
  followPath(crew, dt, CONFIG.crew.speed * TILE, { x: engine.x, y: engine.y, r: hoseRange });
  return true;
}

function updateCrew(state, crew, dt) {
  const engine = engineOfCrew(state, crew);
  if (!engine) return;
  const hoseRange = engine.spec.hoseRange * TILE;

  if (crew.riding) {
    crew.x = engine.x;
    crew.y = engine.y;
    crew.spraying = false;
    crew.rescueTimer = 0;
    crew.rescueId = null;
    crew.wildfireId = null;
    crew.status = 'aboard';
    return;
  }

  // Packing up: everyone runs back to the engine while it waits.
  if (engine.packTimer > 0) {
    crew.think -= dt;
    if (crew.think <= 0) {
      crew.think = 0.4;
      const goal = nearestPassable(state.nav, 'walk', tileOf(engine.x, engine.y), 4);
      const tiles = goal ? findPath(state.nav, 'walk', tileOf(crew.x, crew.y), goal) : null;
      crew.path = tiles ? smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles) : [];
    }
    followPath(crew, dt, CONFIG.crew.speed * TILE);
    crew.status = 'returning';
    return;
  }

  let target = buildingOf(state, crew.targetId);
  if (target && target.state !== 'burning' && (target.trapped ?? 0) <= 0) {
    target = null;
    crew.targetId = null;
  }

  // A wildfire in reach is a job in its own right.
  let wildfire = crew.wildfireId
    ? (state.wildfires ?? []).find((w) => w.id === crew.wildfireId)
    : null;
  if (crew.wildfireId && !wildfire) crew.wildfireId = null;
  if (!wildfire && !crew.targetId) {
    wildfire = wildfireTarget(state, crew, engine);
    if (wildfire) crew.wildfireId = wildfire.id;
  }
  if (wildfire) {
    crew.targetId = null;
    if (updateCrewWildfire(state, crew, engine, wildfire, dt)) return;
    crew.wildfireId = null;
  }

  if (crew.path.length > 0) {
    followPath(crew, dt, CONFIG.crew.speed * TILE, { x: engine.x, y: engine.y, r: hoseRange });
    crew.status = 'moving';
    if (crew.path.length > 0) return;
  }

  if (!target) {
    target = chooseTarget(state, crew, engine);
    if (target) crew.targetId = target.id;
  }
  if (!target) {
    crew.spraying = false;
    crew.rescueTimer = 0;
    crew.rescueId = null;
    crew.status = dist(crew.x, crew.y, engine.x, engine.y) <= hoseRange ? 'standing by' : 'out of hose';
    return;
  }

  const rect = buildingRect(target);
  const reachFromEngine = distToRect(engine.x, engine.y, rect) <= engine.spec.hoseRange * TILE;
  if (!reachFromEngine) {
    crew.targetId = null;
    crew.spraying = false;
    crew.rescueTimer = 0;
    crew.rescueId = null;
    crew.status = 'beyond hose reach';
    if (!crew.warned) {
      crew.warned = true;
      addEvent(state, `${crew.name}: ${target.name} is beyond hose reach`, 'warn');
    }
    return;
  }
  crew.warned = false;

  const reach = distToRect(crew.x, crew.y, rect);
  const hoseOk = dist(crew.x, crew.y, engine.x, engine.y) <= hoseRange;

  // Search and rescue comes first: while anyone is trapped and the crew is at
  // the building, they bring people out instead of putting water on it.
  const trapped = target.trapped ?? 0;
  if (trapped > 0 && reach <= CONFIG.crew.sprayRange * TILE && hoseOk) {
    crew.spraying = false;
    crew.status = 'rescuing';
    state.hoses.push({ ax: engine.x, ay: engine.y, bx: crew.x, by: crew.y, live: true });
    if (crew.rescueId !== target.id) {
      crew.rescueId = target.id;
      crew.rescueTimer = 0;
    }
    crew.rescueTimer += dt;
    if (crew.rescueTimer >= (engine.spec.rescueTime ?? CONFIG.crew.rescueTime)) {
      crew.rescueTimer = 0;
      if (rescuePerson(state, target)) spawnRescue(state, crew.x, crew.y);
    }
    return;
  }
  crew.rescueTimer = 0;
  crew.rescueId = null;

  if (reach <= CONFIG.crew.sprayRange * TILE && hoseOk) {
    if (engine.water <= 0) {
      crew.spraying = false;
      crew.status = 'no water';
      return;
    }
    crew.spraying = true;
    crew.status = 'spraying';
    const impact = streamImpact(target, crew.x, crew.y);
    crew.angle = angleTo(crew.x, crew.y, impact.x, impact.y);
    state.streams.push({
      kind: 'crew',
      sx: crew.x + Math.cos(crew.angle) * 10,
      sy: crew.y + Math.sin(crew.angle) * 10 - 4,
      tx: impact.x,
      ty: impact.y,
      power: CONFIG.crew.sprayPower,
      targetId: target.id,
      crewId: crew.id,
      engineId: engine.id,
    });
    state.hoses.push({ ax: engine.x, ay: engine.y, bx: crew.x, by: crew.y, live: true });
    engine.water = Math.max(0, engine.water - CONFIG.crew.sprayWater * dt);
    if (engine.water <= 0 && !engine.emptyWarned) {
      engine.emptyWarned = true;
      addEvent(state, `${engine.name} is out of water — find a hydrant`, 'warn');
    }
    return;
  }

  // Walk to the fire until either the building is in range or the hose is taut.
  crew.spraying = false;
  crew.status = 'moving';
  state.hoses.push({ ax: engine.x, ay: engine.y, bx: crew.x, by: crew.y, live: false });
  crew.think -= dt;
  if (crew.think <= 0) {
    crew.think = 0.8;
    const goal = standTileForRect(state.nav, rect, crew.x, crew.y);
    if (goal) {
      const tiles = findPath(state.nav, 'walk', tileOf(crew.x, crew.y), goal);
      if (tiles) crew.path = smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles);
    }
  }
  followPath(crew, dt, CONFIG.crew.speed * TILE, { x: engine.x, y: engine.y, r: hoseRange });
  if (crew.path.length === 0 && dist(crew.x, crew.y, engine.x, engine.y) > hoseRange * 0.97) {
    crew.status = 'at hose limit';
  }
}
