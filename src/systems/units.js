// The engine companies and their crews: driving the road network, laying hose,
// pulling people out and putting water on a fire.
//
// A shift starts with one engine and three firefighters. More engines can be
// bought at the station; each one is independent — its own tank, hose, deck gun
// and crew — and the selection tells the orders where to go.

import { CONFIG, TILE } from '../core/config.js';
import { SEA_Y } from '../data/city.js';
import { ensureHotkeys, freeHotkey } from '../core/hotkeys.js';
import { angleTo, approachAngle, clamp, closestOnRect, dist, distToRect } from '../core/math.js';
import {
  findPath, nearestPassable, passable, smoothPath, standTileForRect, tileOf,
} from './grid.js';
import { addEvent } from './events.js';
import { activeFires, buildingRect } from './fire.js';
import { streamImpact, spawnChips, spawnRescue } from './effects.js';
import { placeNear } from './places.js';
import { rescuePerson } from './civilians.js';
import { earn, spend } from './economy.js';
import {
  findPatient, hospitalInReach, isMedical, nearestHospital, nearestPatient, nearestPharmacy,
  restockKits, treatPatient, unloadCargo,
} from './medical.js';
import { workOnBlockade } from './blockades.js';
import { findVictim, rescueVictim } from './water.js';

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

  const first = spawnVehicle(state, 'engine', 0);
  state.activeEngineId = first.id;
  syncUnits(state);
}

function syncUnits(state) {
  state.units = [...state.engines, ...state.crew];
}

export const vehicleSpec = (type) => CONFIG.vehicles[type] ?? null;
export const vehicleCost = (type) => CONFIG.vehicles[type]?.cost ?? 0;

export const isFirefighter = (engine) => !engine?.spec?.medical && !engine?.spec?.diver;

// ------------------------------------------------------------- equipment ---

/** What a crew member carries when they first step out: hose, medical bag or dive kit. */
export function defaultTool(engine) {
  if (engine?.spec?.medical) return 'medkit';
  if (engine?.spec?.diver) return 'diving';
  return (engine?.spec?.hoseRange ?? 0) > 0 ? 'hose' : null;
}

/** How many of a tool the vehicle's lockers hold. Hose is unlimited on a pump. */
export function toolCount(engine, tool) {
  if (tool === 'hose') return (engine?.spec?.hoseRange ?? 0) > 0 ? Infinity : 0;
  return engine?.spec?.tools?.[tool] ?? 0;
}

/** The tools a vehicle's crew can take, hose first. */
export function vehicleTools(engine) {
  if (!isFirefighter(engine) || engine.spec.flying || engine.spec.boat) return [];
  const list = toolCount(engine, 'hose') > 0 ? ['hose'] : [];
  for (const tool of Object.keys(engine.spec.tools ?? {})) if (toolCount(engine, tool) > 0) list.push(tool);
  return list;
}

/** Tools of a kind still in the lockers (out with a crew, or being fetched, counts as taken). */
export function toolsFree(state, engine, tool) {
  const total = toolCount(engine, tool);
  if (total === Infinity) return Infinity;
  const out = crewOf(state, engine).filter((c) => !c.riding && (c.tool === tool || c.fetch === tool)).length;
  return Math.max(0, total - out);
}

/** Can this vehicle put a diver in the water? */
export const canDive = (engine) => Boolean(engine?.spec?.diver) || toolCount(engine, 'diving') > 0;

/** Back aboard: equipment goes back in the lockers and every job is dropped. */
function board(crew, engine) {
  crew.riding = true;
  crew.path = [];
  crew.spraying = false;
  crew.targetId = null;
  crew.rescueTimer = 0;
  crew.rescueId = null;
  crew.wildfireId = null;
  crew.tool = defaultTool(engine);
  crew.fetch = null;
  crew.fetchTimer = 0;
  crew.cut = null;
  crew.boarding = false;
  crew.status = 'aboard';
}

/** Put one crew member on the ground beside the vehicle. */
function stepOut(state, engine, crew, slot = 0) {
  const offset = CREW_OFFSETS[slot % CREW_OFFSETS.length];
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
  crew.targetId = null;
  crew.spraying = false;
  crew.think = 0;
  crew.warned = false;
  crew.rescueTimer = 0;
  crew.rescueId = null;
  crew.wildfireId = null;
  crew.patientId = null;
  crew.victimId = null;
  crew.treatTimer = 0;
  crew.idleFor = 0;
  crew.cut = null;
  crew.boarding = false;
  crew.status = 'deployed';
}

/**
 * Send a crew member to their vehicle for a tool. Someone aboard steps out
 * with it; someone already on the ground walks back to the lockers first.
 */
export function equipCrew(state, crew, tool) {
  const engine = crew ? engineOfCrew(state, crew) : null;
  if (!engine || !CONFIG.tools[tool]) return false;
  if (crew.medic) return false;
  if (!crew.riding && (crew.fetch === tool || (crew.tool === tool && !crew.fetch))) return true;
  if (toolCount(engine, tool) <= 0) {
    addEvent(state, `${engine.name} does not carry a ${CONFIG.tools[tool].label.toLowerCase()}`, 'warn');
    return false;
  }
  if (toolsFree(state, engine, tool) <= 0 && crew.tool !== tool) {
    addEvent(state, `Every ${CONFIG.tools[tool].label.toLowerCase()} on ${engine.name} is already in use`, 'warn');
    return false;
  }
  if (crew.riding) {
    if (engine.path.length > 0 || engine.packTimer > 0) {
      addEvent(state, `Stop ${engine.name} before anyone gets out`, 'warn');
      return false;
    }
    const out = crewOf(state, engine).filter((c) => !c.riding).length;
    stepOut(state, engine, crew, out);
  }
  if (crew.victimId) {
    const v = findVictim(state, crew.victimId);
    if (v && v.diverId === crew.id) v.diverId = null;
  }
  crew.cut = null;
  crew.path = [];
  crew.targetId = null;
  crew.wildfireId = null;
  crew.victimId = null;
  crew.spraying = false;
  crew.boarding = false;
  crew.tool = null;
  crew.fetch = tool;
  crew.fetchTimer = 0;
  crew.think = 0;
  crew.status = tool === 'diving' ? 'suiting up' : 'fetching';
  return true;
}

/** The crew member a vehicle should hand a tool to: someone aboard, else the nearest one out. */
export function crewForTool(state, engine, tool) {
  const crews = crewOf(state, engine).filter((c) => !c.medic);
  const aboard = crews.find((c) => c.riding);
  if (aboard && engine.path.length === 0 && engine.packTimer === 0) return aboard;
  let best = null;
  let bestD = Infinity;
  for (const c of crews) {
    if (c.riding || c.tool === tool || c.fetch === tool) continue;
    const d = dist(c.x, c.y, engine.x, engine.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ?? aboard ?? null;
}

// ----------------------------------------------------------- woodcutting ---

/** Forest that a chainsaw can open up: wooded, not already a track, not a building or water. */
export function cuttable(state, x, y) {
  const city = state.city;
  if (x < 0 || y < 0 || x >= city.w || y >= city.h) return false;
  const i = y * city.w + x;
  return Boolean(city.woods?.[i]) && !state.nav.drive[i] && !city.blocked[i] && !city.water[i];
}

/** Fell the trees on a tile: it becomes a dirt track vehicles can drive. */
export function cutTile(state, x, y) {
  if (!cuttable(state, x, y)) return false;
  const i = y * state.city.w + x;
  state.cut[i] = 1;
  state.nav.drive[i] = 1;
  state.cutCount = (state.cutCount ?? 0) + 1;
  return true;
}

/** Re-open the tracks a saved shift had cut. */
export function restoreCuts(state, list = []) {
  for (const i of list) {
    if (!(i >= 0 && i < state.cut.length)) continue;
    state.cut[i] = 1;
    state.nav.drive[i] = 1;
  }
  state.cutCount = list.length;
}

export function cutList(state) {
  const out = [];
  for (let i = 0; i < state.cut.length; i++) if (state.cut[i]) out.push(i);
  return out;
}

/**
 * A crew member with a chainsaw cuts a track from the nearest drivable ground
 * toward a point in the forest, two tiles wide, so a vehicle can follow.
 */
export function orderCut(state, crew, wx, wy) {
  if (!crew || crew.riding || crew.tool !== 'chainsaw') return false;
  const target = tileOf(wx, wy);
  const city = state.city;
  if (!city.woods?.[target.y * city.w + target.x]) {
    addEvent(state, `${crew.name}: cut where there are trees`, 'warn');
    return false;
  }
  const here = tileOf(crew.x, crew.y);
  const start = nearestPassable(state.nav, 'drive', here.x, here.y, 14)
    ?? nearestPassable(state.nav, 'drive', target.x, target.y, 80);
  if (!start) {
    addEvent(state, `${crew.name}: no road or track to cut from`, 'warn');
    return false;
  }
  crew.cut = { tx: target.x, ty: target.y, hx: start.x, hy: start.y, timer: 0, done: 0 };
  crew.path = [];
  crew.targetId = null;
  crew.wildfireId = null;
  crew.think = 0;
  crew.status = 'moving';
  addEvent(state, `${crew.name} cutting a track into the woods near ${placeNear(state, wx, wy)}`, 'info');
  return true;
}

/** The next step of a cutting job: the tile ahead, and the one beside it for the second lane. */
function nextCut(state, job) {
  const dx = job.tx - job.hx;
  const dy = job.ty - job.hy;
  if (dx === 0 && dy === 0) return null;
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const x = job.hx + (alongX ? Math.sign(dx) : 0);
  const y = job.hy + (alongX ? 0 : Math.sign(dy));
  if (passable(state.nav, 'drive', x, y)) return { x, y, skip: true };
  if (!cuttable(state, x, y)) return { x, y, blocked: true };
  const sides = alongX ? [[x, y + 1], [x, y - 1]] : [[x + 1, y], [x - 1, y]];
  const side = sides.find(([sx, sy]) => cuttable(state, sx, sy));
  return { x, y, side: side ? { x: side[0], y: side[1] } : null };
}

/** The stations the player owns (Station 1 always; Station 2 once bought). */
export const ownsStation = (state, index) => Boolean(state.ownedStations?.[index] ?? index === 0);

/** A free bay at an owned station, preferring `station` if given. -1 if none. */
export function freeBay(state, station = null, sea = false) {
  const taken = new Set(state.engines.map((e) => e.bayIndex));
  const order = station != null ? [station] : state.city.stations.map((_, i) => i);
  for (const st of order) {
    if (!ownsStation(state, st)) continue;
    // Boats berth at the dock, everything else parks on an apron.
    if (Boolean(state.city.stations[st]?.sea) !== sea) continue;
    for (let i = 0; i < state.city.bays.length; i++) {
      if (state.city.bays[i].station === st && !taken.has(i)) return i;
    }
  }
  return -1;
}

export const totalBays = (state) => state.city.bays.filter((b) => !b.sea && ownsStation(state, b.station)).length;
export const totalBerths = (state) => state.city.bays.filter((b) => b.sea && ownsStation(state, b.station)).length;

function spawnVehicle(state, type, station = null) {
  const base = CONFIG.vehicles[type];
  if (!base) return null;
  const bayIndex = freeBay(state, base.boat ? 2 : station === 2 ? null : station, Boolean(base.boat));
  if (bayIndex < 0) return null;
  const spec = { ...base };
  state.vehicleCount[type] = (state.vehicleCount[type] ?? 0) + 1;
  const number = state.vehicleCount[type];
  const bay = state.city.bays[bayIndex];
  const engine = {
    id: `${type}${number}`,
    kind: 'engine',
    type,
    spec,
    base,
    number,
    bayIndex,
    hotkey: freeHotkey(state),
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
    kits: spec.kits ?? 0,
    kitAcc: 0,
    patientId: null,
    cargo: [],
    goal: null,
    blockadeId: null,
    victimId: null,
    mission: null,
    worked: false,
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
    patientId: null,
    treatTimer: 0,
    idleFor: 0,
    victimId: null,
    medic: Boolean(engine.spec?.medical),
    tool: defaultTool(engine),
    fetch: null,
    fetchTimer: 0,
    cut: null,
    boarding: false,
    status: 'aboard',
  };
  engine.crewIds.push(crew.id);
  state.crew.push(crew);
  return crew;
}

/** Buy a vehicle of any type, if a bay is free at the chosen station and it is affordable. */
export function buyVehicle(state, type = 'engine', station = null) {
  const spec = CONFIG.vehicles[type];
  if (!spec) return null;
  if (spec.boat) {
    station = 2;
    if (!ownsStation(state, 2)) {
      addEvent(state, 'Open the Harbour Dock first — boats berth there', 'warn');
      return null;
    }
  } else if (station === 2) {
    station = null;
  }
  if (station != null && !ownsStation(state, station)) {
    addEvent(state, `${state.city.stations[station]?.name ?? 'That station'} has not been bought yet`, 'warn');
    return null;
  }
  if (freeBay(state, station, Boolean(spec.boat)) < 0) {
    addEvent(
      state,
      spec.boat ? 'Every berth at the dock is taken'
        : station != null ? `${state.city.stations[station].name} has no free bay` : 'All apparatus bays are full',
      'warn',
    );
    return null;
  }
  if (state.credits < spec.cost) {
    addEvent(state, `Not enough credits — $${spec.cost.toLocaleString('en-US')} needed`, 'warn');
    return null;
  }
  spend(state, spec.cost, 'vehicle');
  const engine = spawnVehicle(state, type, station);
  syncUnits(state);
  state.activeEngineId = engine.id;
  const home = state.city.stations[state.city.bays[engine.bayIndex].station]?.name ?? 'the station';
  addEvent(state, `${engine.name} in service at ${home}`, 'good');
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
  earn(state, refund, 'vehicle');
  state.patients?.forEach((p) => { if (p.claimedBy === engine.id) p.claimedBy = null; });
  if (state.selected?.id === engine.id) state.selected = null;
  if (state.activeEngineId === engine.id) state.activeEngineId = state.engines[0]?.id ?? null;
  addEvent(state, `${engine.name} sold — $${refund.toLocaleString('en-US')}`, 'info');
  return refund;
}

export function buyEngine(state) {
  return buyVehicle(state, 'engine');
}

function vehicleBase(state, type, overrides = {}) {
  const base = CONFIG.vehicles[type] ?? CONFIG.vehicles.engine;
  const spec = { ...base };
  return {
    kind: 'engine',
    type,
    spec,
    base,
    number: 1,
    bayIndex: 0,
    hotkey: '',
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
    kits: spec.kits ?? 0,
    kitAcc: 0,
    patientId: null,
    cargo: [],
    goal: null,
    blockadeId: null,
    victimId: null,
    mission: null,
    worked: false,
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
      hotkey: entry.hotkey ?? '',
      x: entry.x ?? state.city.spawn.x,
      y: entry.y ?? state.city.spawn.y,
      angle: entry.angle ?? state.city.spawn.angle,
      water: entry.water ?? CONFIG.vehicles[type].capacity,
      targetId: entry.targetId ?? null,
      supply: entry.supply ?? null,
      kits: entry.kits ?? CONFIG.vehicles[type].kits ?? 0,
      cargo: (entry.cargo ?? []).map((c) => ({ ...c })),
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
      patientId: null,
      treatTimer: 0,
      idleFor: 0,
      victimId: null,
      medic: Boolean(engine.spec?.medical),
      tool: entry.riding !== false ? defaultTool(engine) : entry.tool ?? defaultTool(engine),
      fetch: null,
      fetchTimer: 0,
      cut: entry.riding !== false || !entry.cut ? null : { ...entry.cut, timer: 0 },
      boarding: false,
      status: entry.riding !== false ? 'aboard' : 'standing by',
    };
    state.nextCrew = Math.max(state.nextCrew, number + 1);
    engine.crewIds.push(crew.id);
    state.crew.push(crew);
  }

  state.units = [...state.engines, ...state.crew];
  ensureHotkeys(state);
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
  return state.city.stations.some((st, i) => {
    if (!ownsStation(state, i)) return false;
    const b = st.building;
    return dist(engine.x, engine.y, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE) < 8 * TILE;
  });
}

/** Spray power multiplier: fire training. (x and y are kept for callers that pass the crew's position.) */
export function firePower(state, x, y) {
  return 1 + CONFIG.economy.training.fire * (state.training?.fire ?? 0);
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

/** The nearest water tile to a world point within `maxTiles`, or null. */
export function nearestWater(state, x, y, maxTiles) {
  const city = state.city;
  const cx = Math.floor(x / TILE);
  const cy = Math.floor(y / TILE);
  let best = null;
  let bestD = Infinity;
  for (let ty = Math.max(0, cy - maxTiles); ty <= Math.min(city.h - 1, cy + maxTiles); ty++) {
    for (let tx = Math.max(0, cx - maxTiles); tx <= Math.min(city.w - 1, cx + maxTiles); tx++) {
      if (!city.water[ty * city.w + tx]) continue;
      const d = (tx - cx) ** 2 + (ty - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: tx, y: ty };
      }
    }
  }
  return best;
}

/** Can a fireboat put water on something at (x, y) from the water? */
export function boatCanReach(state, engine, x, y, extraTiles = 0) {
  const reach = engine.spec.turretRange + extraTiles;
  const tile = nearestWater(state, x, y, Math.ceil(reach));
  if (!tile) return false;
  return Math.hypot((tile.x + 0.5) * TILE - x, (tile.y + 0.5) * TILE - y) <= reach * TILE;
}

/** A boat sails to the water tile nearest the target, within its reach. */
function orderBoat(state, engine, wx, wy, buildingId, wildfireId) {
  const building = buildingOf(state, buildingId);
  const wf = wildfireId ? (state.wildfires ?? []).find((w) => w.id === wildfireId) : null;
  let goal = null;
  if ((building || wf) && engine.spec.turretRange > 0) {
    let px;
    let py;
    let slack = 0;
    if (building) {
      px = (building.x + building.w / 2) * TILE;
      py = (building.y + building.h / 2) * TILE;
      slack = Math.max(building.w, building.h) / 2;
    } else {
      px = wf.x;
      py = wf.y;
      slack = wf.radius / TILE;
    }
    if (!boatCanReach(state, engine, px, py, slack)) {
      addEvent(state, `${engine.name}: no water within reach of ${building?.name ?? 'that fire'}`, 'warn');
      return false;
    }
    goal = nearestWater(state, px, py, Math.ceil(engine.spec.turretRange + slack));
  } else {
    goal = nearestPassable(state.nav, 'sail', Math.floor(wx / TILE), Math.floor(wy / TILE), 30);
    if (!goal) {
      addEvent(state, `${engine.name}: that is not on the water`, 'warn');
      return false;
    }
  }
  const tiles = findPath(state.nav, 'sail', tileOf(engine.x, engine.y), goal);
  if (!tiles) {
    addEvent(state, `${engine.name}: no route by water`, 'warn');
    return false;
  }
  engine.path = smoothPath(state.nav, 'sail', { x: engine.x, y: engine.y }, tiles);
  engine.supply = null;
  engine.targetId = building?.id ?? null;
  engine.wildfireId = wildfireId;
  engine.blockadeId = null;
  engine.goal = null; // boats are not re-routed round road blockages
  engine.arrived = false;
  engine.packTimer = 0;
  engine.status = 'responding';
  return true;
}

/** An air tanker is given a target to circle; with none it flies home. */
function orderPlane(state, engine, wx, wy, buildingId, wildfireId) {
  const building = buildingOf(state, buildingId);
  const wf = wildfireId ? (state.wildfires ?? []).find((w) => w.id === wildfireId) : null;
  engine.path = [];
  engine.supply = null;
  engine.goal = null;
  engine.blockadeId = null;
  engine.packTimer = 0;
  if (!building && !wf) {
    engine.mission = null;
    engine.targetId = null;
    engine.wildfireId = null;
    engine.status = 'returning';
    return true;
  }
  engine.mission = {
    x: building ? (building.x + building.w / 2) * TILE : wf.x,
    y: building ? (building.y + building.h / 2) * TILE : wf.y,
    tid: building?.id ?? null,
    wid: wf?.id ?? null,
    mode: engine.water < engine.capacity * 0.3 ? 'refill' : 'attack',
  };
  engine.targetId = building?.id ?? null;
  engine.wildfireId = wf?.id ?? null;
  engine.arrived = false;
  engine.status = 'responding';
  return true;
}

/** A helicopter flies straight there and hovers within reach of the target. */
function orderFlight(state, engine, wx, wy, buildingId, wildfireId) {
  const building = buildingOf(state, buildingId);
  let target = { x: wx, y: wy };
  if (building) {
    const rect = buildingRect(building);
    const near = closestOnRect(engine.x, engine.y, rect);
    const dx = engine.x - near.x;
    const dy = engine.y - near.y;
    const len = Math.hypot(dx, dy) || 1;
    const hover = Math.min(len, engine.spec.turretRange * 0.55 * TILE);
    target = { x: near.x + (dx / len) * hover, y: near.y + (dy / len) * hover };
  } else if (wildfireId) {
    const wf = (state.wildfires ?? []).find((w) => w.id === wildfireId);
    if (wf) {
      const dx = engine.x - wf.x;
      const dy = engine.y - wf.y;
      const len = Math.hypot(dx, dy) || 1;
      const inside = Math.min(wf.radius * 0.5, len);
      target = { x: wf.x + (dx / len) * inside, y: wf.y + (dy / len) * inside };
    }
  }
  engine.path = dist(engine.x, engine.y, target.x, target.y) < 12 ? [] : [target];
  engine.supply = null;
  engine.targetId = building?.id ?? null;
  engine.wildfireId = wildfireId;
  engine.blockadeId = null;
  engine.goal = null;
  engine.arrived = engine.path.length === 0;
  engine.packTimer = 0;
  engine.status = 'responding';
  return true;
}

// A road vehicle is about 1.2 tiles wide; its route may not cut a corner closer
// than this to anything that is not road.
const BODY_HALF = TILE * 0.46;
const PARK_GAP = 2.7; // tiles between two parked vehicles (each is about 2.6 long)

/** Where the other road vehicles are, or are heading: places not to park on. */
function takenSpots(state, engine) {
  const spots = [];
  for (const e of state.engines) {
    if (e === engine || e.spec.flying || e.spec.boat) continue;
    if (e.path.length > 0 && e.goal) spots.push({ x: (e.goal.x + 0.5) * TILE, y: (e.goal.y + 0.5) * TILE });
    else if (e.path.length === 0) spots.push({ x: e.x, y: e.y });
  }
  return spots;
}

const spotFree = (spots, tx, ty) => spots.every(
  (s) => Math.hypot((tx + 0.5) * TILE - s.x, (ty + 0.5) * TILE - s.y) >= PARK_GAP * TILE,
);

/**
 * The street tile nearest (cx, cy) where nobody else is parked or heading, so
 * several vehicles sent to one scene each get a place of their own.
 */
function parkingTile(state, engine, cx, cy, maxR = 14) {
  const spots = takenSpots(state, engine);
  const gx = Math.floor(cx / TILE);
  const gy = Math.floor(cy / TILE);
  for (let r = 0; r <= maxR; r++) {
    let best = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (!passable(state.nav, 'drive', x, y) || !spotFree(spots, x, y)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * A street tile beside a hydrant that is near enough to a building for this
 * vehicle's hose, the hydrant nearest the building first. Null if there is none.
 */
function hydrantParking(state, engine, building) {
  const rect = buildingRect(building);
  const hose = (engine.spec.hoseRange - 1) * TILE;
  const spots = takenSpots(state, engine);
  let best = null;
  let bestD = Infinity;
  for (const h of state.city.hydrants) {
    const hx = (h.x + 0.5) * TILE;
    const hy = (h.y + 0.5) * TILE;
    const d = distToRect(hx, hy, rect);
    if (d > hose + CONFIG.refillRange * TILE || d >= bestD) continue;
    const tile = nearestPassable(state.nav, 'drive', h.x, h.y, 3);
    if (!tile || !spotFree(spots, tile.x, tile.y)) continue;
    const px = (tile.x + 0.5) * TILE;
    const py = (tile.y + 0.5) * TILE;
    if (dist(px, py, hx, hy) > CONFIG.refillRange * TILE * 0.9) continue;
    if (distToRect(px, py, rect) > hose) continue;
    bestD = d;
    best = tile;
  }
  return best;
}

export function orderEngine(state, engine, wx, wy, buildingId = null, wildfireId = null) {
  if (!engine) return false;
  if (engine.spec.plane) return orderPlane(state, engine, wx, wy, buildingId, wildfireId);
  if (engine.spec.flying) return orderFlight(state, engine, wx, wy, buildingId, wildfireId);
  if (engine.spec.boat) return orderBoat(state, engine, wx, wy, buildingId, wildfireId);
  const building = buildingOf(state, buildingId);
  let goal = null;
  if (building) {
    const rect = buildingRect(building);
    const onFire = building.state === 'burning' || (building.trapped ?? 0) > 0;
    if (engine.spec.hydrantOnly && onFire) {
      // No pump of its own: park beside a hydrant the hose can reach the fire from.
      goal = hydrantParking(state, engine, building);
      if (!goal) {
        addEvent(state, `${engine.name}: no hydrant within hose reach of ${building.name}`, 'warn');
        return false;
      }
    } else {
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      goal = parkingTile(state, engine, cx, cy, 14)
        ?? nearestPassable(state.nav, 'drive', Math.floor(cx / TILE), Math.floor(cy / TILE), 14);
    }
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
  engine.path = smoothPath(state.nav, 'drive', { x: engine.x, y: engine.y }, tiles, BODY_HALF);
  engine.targetId = building?.id ?? null;
  engine.wildfireId = wildfireId;
  engine.blockadeId = null;
  engine.victimId = null;
  engine.goal = goal;
  engine.arrived = false;
  engine.packTimer = crewOut ? 1.4 : 0;
  engine.status = 'responding';
  return true;
}

/** Drive to the nearest street to a wildfire and deploy the crew there. */
export function orderEngineToWildfire(state, engine, wildfire) {
  if (!engine || !wildfire) return false;
  if (engine.spec.hydrantOnly) {
    addEvent(state, `${engine.name} has no water of its own — there are no hydrants in the forest`, 'warn');
    return false;
  }
  if (engine.spec.flying) return orderEngine(state, engine, wildfire.x, wildfire.y, null, wildfire.id);
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

/**
 * Everyone aboard steps out. `tools` hands out equipment first, in order
 * (`{ cutter: 2 }`: two of them take the cutters); the rest take the hose.
 * With `only`, just the crew members who get one of those tools step out.
 */
export function deployCrew(state, engine, target = null, tools = null, only = false) {
  const aboard = crewOf(state, engine).filter((c) => c.riding);
  if (aboard.length === 0) return 0;
  const already = crewOf(state, engine).length - aboard.length;
  const handOut = [];
  for (const [tool, want] of Object.entries(tools ?? {})) {
    const n = Math.min(want, toolsFree(state, engine, tool));
    for (let i = 0; i < n; i++) handOut.push(tool);
  }
  let n = 0;
  for (const crew of aboard) {
    const tool = handOut[n] ?? null;
    if (only && !tool) break;
    stepOut(state, engine, crew, already + n);
    crew.targetId = target?.id ?? null;
    crew.tool = defaultTool(engine);
    if (tool) {
      crew.tool = null;
      crew.fetch = tool;
      crew.fetchTimer = 0;
      crew.status = tool === 'diving' ? 'suiting up' : 'fetching';
    }
    n++;
  }
  if (n > 0) addEvent(state, target ? `${n} crew deployed to ${target.name}` : `${n} crew deployed`, 'info');
  return n;
}

export function recallCrew(state, engine) {
  let n = 0;
  for (const crew of crewOf(state, engine)) {
    if (crew.riding) continue;
    board(crew, engine);
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

/** Re-plan every moving vehicle's route; called when a road is blocked or reopened. */
export function repathEngines(state) {
  for (const engine of state.engines) {
    if (engine.path.length === 0 || !engine.goal) continue;
    const tiles = findPath(state.nav, 'drive', tileOf(engine.x, engine.y), engine.goal);
    if (!tiles) {
      engine.path = [];
      engine.goal = null;
      engine.targetId = null;
      engine.wildfireId = null;
      engine.patientId = null;
      engine.blockadeId = null;
      engine.status = 'blocked';
      addEvent(state, `${engine.name}: every route is blocked — stopped`, 'warn');
      continue;
    }
    engine.path = smoothPath(state.nav, 'drive', { x: engine.x, y: engine.y }, tiles, BODY_HALF);
  }
}

/** Drive to a wreck and put the crew to work on it. */
export function orderEngineToBlockade(state, engine, blockade) {
  if (!engine || !blockade || !isFirefighter(engine) || engine.spec.flying || engine.spec.boat) return false;
  const ok = orderEngine(state, engine, blockade.x, blockade.y);
  if (!ok) return false;
  engine.blockadeId = blockade.id;
  return true;
}

/** Closest free fire vehicle for a wreck; one carrying rescue cutters counts as nearer. */
export function pickEngineForBlockade(state, blockade) {
  let best = null;
  let bestScore = Infinity;
  for (const engine of state.engines) {
    if (!isFirefighter(engine) || engine.spec.flying || engine.spec.boat) continue;
    const free = !engine.targetId && !engine.wildfireId && !engine.blockadeId
      && engine.path.length === 0 && engine.packTimer === 0;
    const d = dist(engine.x, engine.y, blockade.x, blockade.y) * (toolCount(engine, 'cutter') > 0 ? 0.6 : 1) + (free ? 0 : 1e6);
    if (d < bestScore) {
      bestScore = d;
      best = engine;
    }
  }
  return best;
}

/**
 * Send divers to a person in the water: a rescue boat sails to them; an engine
 * or rescue unit with diving gear drives to the nearest bank.
 */
export function orderEngineToVictim(state, engine, victim) {
  if (!canDive(engine) || !victim) return false;
  if (!engine.spec.diver && toolsFree(state, engine, 'diving') <= 0) {
    addEvent(state, `${engine.name}: its diving gear is already in use`, 'warn');
    return false;
  }
  const ok = engine.spec.boat
    ? orderBoat(state, engine, victim.x, victim.y, null, null)
    : orderEngine(state, engine, victim.x, victim.y);
  if (!ok) return false;
  engine.victimId = victim.id;
  return true;
}

/** Vehicles that can put a diver in, nearest first (boats count as nearer: they are right on the water). */
export function diveVehiclesFor(state, victim) {
  return state.engines
    .filter((e) => canDive(e) && (e.spec.diver || toolsFree(state, e, 'diving') > 0))
    .map((e) => {
      const free = !e.victimId && !e.targetId && !e.wildfireId && e.path.length === 0 && e.packTimer === 0;
      return { e, score: Math.hypot(e.x - victim.x, e.y - victim.y) * (e.spec.boat ? 0.7 : 1) + (free ? 0 : 1e6) };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.e);
}

/** Take the stretcher cases to the nearest hospital. */
export function sendToHospital(state, engine) {
  if (!engine || !isMedical(engine)) return false;
  const hospital = nearestHospital(state, engine.x, engine.y);
  if (!hospital) {
    addEvent(state, 'No hospital in the city', 'warn');
    return false;
  }
  if (hospitalInReach(state, engine) && (engine.cargo?.length ?? 0) > 0) {
    unloadCargo(state, engine, hospital);
    return true;
  }
  recallCrew(state, engine);
  const ok = orderEngine(
    state,
    engine,
    (hospital.x + hospital.w / 2) * TILE,
    (hospital.y + hospital.h / 2) * TILE,
    hospital.id,
  );
  if (ok) {
    engine.targetId = null;
    engine.patientId = null;
    if ((engine.cargo?.length ?? 0) > 0) {
      addEvent(state, `${engine.name} taking ${engine.cargo.length} patient${engine.cargo.length === 1 ? '' : 's'} to ${hospital.name}`, 'info');
    }
  }
  return ok;
}

/** Send an ambulance to an injured person. */
export function orderAmbulanceToPatient(state, engine, patient) {
  if (!engine || !patient || !isMedical(engine) || patient.treated) return false;
  if ((engine.kits ?? 0) < 1) {
    addEvent(state, `${engine.name} has no medical kits — restock at a pharmacy`, 'warn');
    return false;
  }
  const ok = orderEngine(state, engine, patient.x, patient.y);
  if (!ok) return false;
  engine.patientId = patient.id;
  engine.worked = true;
  patient.claimedBy = engine.id;
  return true;
}

/** The ambulance that should take a call: nearest one that is free and stocked. */
export function pickAmbulanceFor(state, patient) {
  let best = null;
  let bestD = Infinity;
  for (const engine of state.engines) {
    if (!isMedical(engine) || (engine.kits ?? 0) < 1) continue;
    const busy = engine.patientId && findPatient(state, engine.patientId);
    const d = dist(engine.x, engine.y, patient.x, patient.y) + (busy ? 1e6 : 0);
    if (d < bestD) {
      bestD = d;
      best = engine;
    }
  }
  return best;
}

/** Drive an ambulance to the nearest pharmacy to restock. */
export function sendToPharmacy(state, engine) {
  if (!engine || !isMedical(engine)) return false;
  const pharmacy = nearestPharmacy(state, engine.x, engine.y);
  if (!pharmacy) {
    addEvent(state, 'No pharmacy in the city', 'warn');
    return false;
  }
  const ok = orderEngine(
    state,
    engine,
    (pharmacy.x + pharmacy.w / 2) * TILE,
    (pharmacy.y + pharmacy.h / 2) * TILE,
    pharmacy.id,
  );
  if (ok) {
    engine.targetId = null;
    engine.patientId = null;
    addEvent(state, `${engine.name} heading to ${pharmacy.name} to restock`, 'info');
  }
  return ok;
}

/**
 * The fire that most needs an engine right now. Every vehicle already sent to a
 * fire counts against it, so the next one goes to a fire that has nobody yet.
 */
export function urgentFire(state, except = null) {
  const fires = activeFires(state);
  if (fires.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const b of fires) {
    const engaged = state.engines.filter((e) => e !== except && e.targetId === b.id).length;
    const score = b.fire * 60 + (1 - b.integrity / b.maxIntegrity) * 25 - engaged * 45;
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
    if (!isFirefighter(engine)) continue;
    // A fireboat can only help where there is water in reach.
    if (engine.spec.boat && !boatCanReach(state, engine, cx, cy, Math.max(target.w, target.h) / 2)) continue;
    // A pumpless car is only any use where a hydrant is within hose reach; it
    // goes after the real engines.
    if (engine.spec.hydrantOnly && !hydrantParking(state, engine, target)) continue;
    const d = dist(engine.x, engine.y, cx, cy) * (engine.spec.hydrantOnly ? 1.6 : 1);
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
  const target = buildingOf(state, buildingId) ?? urgentFire(state, engine);
  if (!target) {
    addEvent(state, 'No active fires — the district is quiet', 'info');
    return false;
  }
  const chosen = engine && isFirefighter(engine) ? engine : pickEngineFor(state, target);
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
  if (engine.spec.flying || (engine.spec.boat && !engine.spec.diver)) {
    engine.goal = null;
    engine.status = 'on scene';
    return;
  }
  if (isMedical(engine)) {
    const reach = engine.spec.medRange * TILE * 0.9;
    if (engine.patientId || nearestPatient(state, engine.x, engine.y, { maxDist: reach })) {
      deployCrew(state, engine, null);
    }
    engine.goal = null;
    engine.status = 'on scene';
    return;
  }
  const target = buildingOf(state, engine.targetId);
  // A car with no pump hooks its supply line to the hydrant it parked beside.
  if (engine.spec.hydrantOnly && !engine.supply) {
    const hydrant = hydrantInReach(state, engine);
    if (hydrant) {
      engine.supply = { x: (hydrant.x + 0.5) * TILE, y: (hydrant.y + 0.5) * TILE };
      addEvent(state, `${engine.name}: supply line connected`, 'good');
    }
  }
  // A burning building, or one with people still trapped inside, gets the crew out.
  if (target && (target.state === 'burning' || (target.trapped ?? 0) > 0)) {
    const reach = distToRect(engine.x, engine.y, buildingRect(target));
    if (reach <= engine.spec.hoseRange * TILE) {
      deployCrew(state, engine, target);
    } else {
      addEvent(state, `${engine.name} is too far from ${target.name} to reach it`, 'warn');
    }
  } else if (engine.wildfireId) {
    const wildfire = (state.wildfires ?? []).find((w) => w.id === engine.wildfireId);
    if (wildfire) deployCrew(state, engine, null);
    engine.wildfireId = null;
  } else if (engine.blockadeId) {
    // The cutters come out first; everyone else helps by hand.
    if (state.blockades.some((b) => b.id === engine.blockadeId)) deployCrew(state, engine, null, { cutter: 2 });
    engine.blockadeId = null;
  } else if (engine.victimId) {
    // A boat's crew are already divers; a fire vehicle sends out only the ones
    // it has diving gear for, and they suit up on the bank.
    if (findVictim(state, engine.victimId)) {
      if (engine.spec.diver) deployCrew(state, engine, null);
      else deployCrew(state, engine, null, { diving: 2 }, true);
    }
    engine.victimId = null;
  }
  engine.goal = null;
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
  // Aircraft dip into the sea or the river; boats are always on it.
  const overWater = Boolean(engine.spec.flying || engine.spec.boat)
    && state.city.water[tileY * state.city.w + tileX] === 1;
  if (!onApron && !engine.supply && !overWater) {
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

/** The deck gun (or an aircraft's bucket): automatic on whatever burns within reach. */
function runTurret(state, engine, dt) {
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
      power: engine.spec.turretPower * firePower(state, engine.x, engine.y),
      targetId: target.id,
      engineId: engine.id,
    });
    engine.water = Math.max(0, engine.water - engine.spec.turretWater * dt);
    if (engine.water <= 0 && !engine.emptyWarned) {
      engine.emptyWarned = true;
      addEvent(state, `${engine.name} is out of water — find a hydrant`, 'warn');
    }
  } else if (engine.spec.turretRange > 0 && engine.water > 0) {
    // No building to hit: the deck gun (or a helicopter's bucket) works a forest fire in reach.
    const reach = engine.spec.turretRange * TILE;
    let wf = null;
    let wfD = Infinity;
    for (const w of state.wildfires ?? []) {
      const edge = Math.hypot(w.x - engine.x, w.y - engine.y) - w.radius;
      if (edge <= reach && edge < wfD) {
        wfD = edge;
        wf = w;
      }
    }
    if (wf) {
      engine.pumping = true;
      const d = Math.hypot(wf.x - engine.x, wf.y - engine.y) || 1;
      const inward = Math.max(0, Math.min(wf.radius * 0.6, d));
      const tx = engine.x + ((wf.x - engine.x) / d) * Math.max(0, d - wf.radius + inward);
      const ty = engine.y + ((wf.y - engine.y) / d) * Math.max(0, d - wf.radius + inward);
      engine.angle = approachAngle(engine.angle, angleTo(engine.x, engine.y, tx, ty), 5 * dt);
      state.streams.push({
        kind: 'turret',
        sx: engine.x + Math.cos(engine.angle) * 6,
        sy: engine.y - 10 + Math.sin(engine.angle) * 6,
        tx,
        ty,
        power: engine.spec.turretPower * firePower(state, engine.x, engine.y),
        wildfireId: wf.id,
        engineId: engine.id,
      });
      engine.water = Math.max(0, engine.water - engine.spec.turretWater * dt);
      if (engine.water <= 0 && !engine.emptyWarned) {
        engine.emptyWarned = true;
        addEvent(state, `${engine.name} is out of water — ${engine.spec.flying ? 'dip in the harbour or land at a station' : 'find a hydrant'}`, 'warn');
      }
    }
  }

}

/** Wind an air tanker's orbit: the point on a circle round (cx, cy) to steer for. */
function orbitAim(engine, cx, cy, r) {
  const a = Math.atan2(engine.y - cy, engine.x - cx) + 0.55;
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
}

function updatePlane(state, engine, dt) {
  const city = state.city;
  const cruise = engine.spec.speed * TILE;
  let m = engine.mission;

  if (m) {
    const b = m.tid ? buildingOf(state, m.tid) : null;
    const wf = m.wid ? (state.wildfires ?? []).find((w) => w.id === m.wid) : null;
    if ((m.tid && (!b || b.state !== 'burning')) || (m.wid && !wf)) {
      engine.mission = null;
      m = null;
      engine.targetId = null;
      engine.wildfireId = null;
      addEvent(state, `${engine.name}: target is out — returning to base`, 'info');
    } else if (wf) {
      m.x = wf.x;
      m.y = wf.y;
    }
  }

  let aim;
  let centre;
  if (m) {
    if (m.mode === 'attack' && engine.water < engine.capacity * 0.12) m.mode = 'refill';
    else if (m.mode === 'refill' && engine.water >= engine.capacity * 0.97) m.mode = 'attack';
    if (m.mode === 'refill') {
      // Skim the sea: circle a point out in the harbour until the tank is full.
      centre = {
        x: Math.min(Math.max(engine.x, 20 * TILE), (city.w - 20) * TILE),
        y: (SEA_Y + 16) * TILE,
      };
    } else {
      centre = { x: m.x, y: m.y };
    }
    aim = orbitAim(engine, centre.x, centre.y, 5 * TILE);
  } else {
    const bay = city.bays[engine.bayIndex] ?? city.bays[0];
    aim = { x: bay.x, y: bay.y };
    centre = aim;
  }

  const toAim = dist(engine.x, engine.y, aim.x, aim.y);
  const landed = !m && toAim < 24;
  if (landed) {
    engine.x = aim.x;
    engine.y = aim.y;
    engine.angle = approachAngle(engine.angle, city.spawn.angle, 3 * dt);
  } else {
    // Slow into the orbit, cruise in between; turn at a fixed rate.
    const slow = m && dist(engine.x, engine.y, centre.x, centre.y) < 14 * TILE;
    const speed = slow ? cruise * 0.4 : cruise;
    engine.angle = approachAngle(engine.angle, angleTo(engine.x, engine.y, aim.x, aim.y), 3.2 * dt);
    engine.x += Math.cos(engine.angle) * speed * dt;
    engine.y += Math.sin(engine.angle) * speed * dt;
  }

  engine.pumping = false;
  engine.refilling = false;
  if (m && m.mode === 'attack') runTurret(state, engine, dt);
  refillEngine(state, engine, dt);

  engine.status = landed
    ? (engine.refilling ? 'refilling' : 'in quarters')
    : m
      ? (m.mode === 'refill' ? 'refilling' : engine.pumping ? 'pumping' : 'responding')
      : 'returning';
  if (m && m.mode === 'refill' && !engine.refilling) engine.status = 'responding';
}

function updateEngine(state, engine, dt) {
  if (engine.packTimer > 0) {
    engine.packTimer -= dt;
    engine.status = 'packing up';
    if (engine.packTimer <= 0) {
      engine.packTimer = 0;
      for (const crew of crewOf(state, engine)) board(crew, engine);
    }
    return;
  }

  if (engine.spec.plane) {
    updatePlane(state, engine, dt);
    return;
  }

  if (engine.path.length > 0) {
    followPath(engine, dt, engine.spec.speed * TILE * (engine.spec.flying || engine.spec.boat ? 1 : state.trafficFactor ?? 1));
    engine.pumping = false;
    engine.refilling = false;
    if (engine.path.length === 0) arriveEngine(state, engine);
    engine.status = (engine.cargo?.length ?? 0) > 0 ? 'transporting' : 'responding';
    return;
  }

  if (isMedical(engine)) {
    updateAmbulance(state, engine, dt);
    return;
  }

  if (engine.targetId && !engine.arrived) arriveEngine(state, engine);

  // A fire that is out is no longer a reason to stay marked on scene.
  if (engine.targetId && engine.arrived) {
    const current = buildingOf(state, engine.targetId);
    if (!current || current.state !== 'burning') engine.targetId = null;
  }

  runTurret(state, engine, dt);

  refillEngine(state, engine, dt);

  // A tank that has run dry is no use at a fire: drive back to the station to
  // refill (once; the order can be overridden, and it re-arms after a refill). Beside
  // a hydrant it stays: connect the line (G) instead.
  if (engine.water > engine.capacity * 0.5) engine.dryHome = false;
  if (engine.water <= 0 && engine.capacity > 0 && engine.capacity < 50000 && !engine.dryHome
    && !engine.refilling && !engine.supply && isFirefighter(engine) && !engine.spec.boat
    && !hydrantInReach(state, engine)) {
    engine.dryHome = true;
    addEvent(state, `${engine.name} is out of water — returning to the station to refill`, 'warn');
    sendEngineHome(state, engine);
  }

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

function updateAmbulance(state, engine, dt) {
  if (engine.patientId) {
    const patient = findPatient(state, engine.patientId);
    if (!patient || patient.treated) engine.patientId = null;
  }

  // Stretcher cases: deliver if at a hospital, otherwise set off once the crew are back aboard.
  if ((engine.cargo?.length ?? 0) > 0) {
    const hospital = hospitalInReach(state, engine);
    if (hospital) {
      unloadCargo(state, engine, hospital);
    } else if (state.time >= (engine.hospitalRetry ?? 0)) {
      const out = crewOf(state, engine).filter((c) => !c.riding);
      if (out.length > 0 && engine.cargo.length >= engine.spec.carry) recallCrew(state, engine);
      else if (out.length === 0) {
        engine.hospitalRetry = state.time + 5;
        sendToHospital(state, engine);
      }
    }
  }

  const tileX = Math.floor(engine.x / TILE);
  const tileY = Math.floor(engine.y / TILE);
  const onApron = state.city.apron[tileY * state.city.w + tileX] === 1;
  const restocking = restockKits(state, engine, dt, onApron);
  if (restocking && engine.kits >= engine.spec.kits && !engine.fullNotified) {
    engine.fullNotified = true;
    addEvent(state, `${engine.name}: kits restocked`, 'good');
  } else if (engine.kits < engine.spec.kits * 0.75) {
    engine.fullNotified = false;
  }

  if (engine.kits < 1 && !engine.emptyWarned) {
    engine.emptyWarned = true;
    addEvent(state, `${engine.name} is out of medical kits — find a pharmacy`, 'warn');
  }
  if (engine.kits >= 1) engine.emptyWarned = false;

  // The work is done and there is nothing on board: back to the base hospital.
  const crewOut = crewOf(state, engine).some((c) => !c.riding);
  if (nearStation(state, engine)) engine.worked = false;
  if (engine.worked && !restocking && !crewOut && !engine.patientId
    && (engine.cargo?.length ?? 0) === 0 && !nearStation(state, engine)) {
    engine.returnIn = (engine.returnIn ?? 2.5) - dt;
    if (engine.returnIn <= 0) {
      engine.returnIn = 2.5;
      engine.worked = false;
      if (sendEngineHome(state, engine)) addEvent(state, `${engine.name} returning to the base hospital`, 'info');
    }
  } else {
    engine.returnIn = 2.5;
  }

  if (restocking) engine.status = 'restocking';
  else if (nearStation(state, engine)) engine.status = 'in quarters';
  else if (engine.arrived) engine.status = 'on scene';
  else engine.status = 'standing by';
}

function updateDiver(state, crew, engine, dt) {
  const range = (engine.spec.diveRange ?? CONFIG.tools.diving.range) * TILE;
  let victim = crew.victimId ? findVictim(state, crew.victimId) : null;
  if (!victim) {
    crew.victimId = null;
    crew.rescueTimer = 0;
    let bestD = range;
    for (const v of state.victims) {
      if (v.diverId && v.diverId !== crew.id) continue;
      const d = dist(engine.x, engine.y, v.x, v.y);
      if (d < bestD) {
        bestD = d;
        victim = v;
      }
    }
    if (victim) {
      crew.victimId = victim.id;
      victim.diverId = crew.id;
    }
  }

  if (!victim) {
    crew.status = 'standing by';
    crew.idleFor += dt;
    if (engine.spec.diver) {
      // A rescue boat waits for all its divers, then takes them aboard.
      const out = crewOf(state, engine).filter((c) => !c.riding);
      if (out.length > 0 && out.every((c) => c.idleFor > 6)) recallCrew(state, engine);
    } else if (crew.idleFor > 6) {
      // Nobody left in the water: swim back and stow the gear.
      crew.boarding = true;
      crew.think = 0;
    }
    return;
  }
  crew.idleFor = 0;

  if (dist(crew.x, crew.y, victim.x, victim.y) > 1.5 * TILE) {
    crew.rescueTimer = 0;
    victim.rescueTimer = 0;
    crew.status = 'swimming';
    crew.think -= dt;
    if (crew.think <= 0 || crew.path.length === 0) {
      crew.think = 0.8;
      const tiles = findPath(state.nav, 'swim', tileOf(crew.x, crew.y), tileOf(victim.x, victim.y));
      if (tiles) crew.path = smoothPath(state.nav, 'swim', { x: crew.x, y: crew.y }, tiles);
    }
    followPath(crew, dt, 3.2 * TILE, { x: engine.x, y: engine.y, r: range });
    return;
  }

  crew.path.length = 0;
  crew.angle = angleTo(crew.x, crew.y, victim.x, victim.y);
  crew.status = 'rescuing';
  crew.rescueTimer += dt;
  victim.rescueTimer = crew.rescueTimer;
  const need = engine.spec.rescueTime * (1 - CONFIG.economy.training.rescue * (state.training?.rescue ?? 0));
  if (crew.rescueTimer >= need) {
    crew.rescueTimer = 0;
    rescueVictim(state, victim);
    crew.victimId = null;
  }
}

function updateMedic(state, crew, engine, dt) {
  const range = engine.spec.medRange * TILE;
  const speed = CONFIG.crew.speed * TILE;

  let patient = crew.patientId ? findPatient(state, crew.patientId) : null;
  if (patient && patient.treated) patient = null;
  if (!patient) {
    crew.patientId = null;
    crew.treatTimer = 0;
    let bestD = range;
    for (const p of state.patients) {
      if (p.treated || (p.medicId && p.medicId !== crew.id)) continue;
      const d = dist(engine.x, engine.y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        patient = p;
      }
    }
    if (patient) {
      crew.patientId = patient.id;
      patient.medicId = crew.id;
    }
  }

  if (!patient) {
    crew.status = 'standing by';
    crew.idleFor += dt;
    // Nobody left to treat: pack up so the ambulance is free to roll.
    const out = crewOf(state, engine).filter((c) => !c.riding);
    if (out.length > 0 && out.every((c) => c.idleFor > 5)) recallCrew(state, engine);
    return;
  }
  crew.idleFor = 0;

  const reach = dist(crew.x, crew.y, patient.x, patient.y);
  if (reach > 1.4 * TILE) {
    crew.treatTimer = 0;
    patient.treatTimer = 0;
    crew.status = 'moving';
    crew.think -= dt;
    if (crew.think <= 0 || crew.path.length === 0) {
      crew.think = 0.8;
      const goal = nearestPassable(
        state.nav, 'walk', Math.floor(patient.x / TILE), Math.floor(patient.y / TILE), 4,
      );
      const tiles = goal ? findPath(state.nav, 'walk', tileOf(crew.x, crew.y), goal) : null;
      if (tiles) crew.path = smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles);
    }
    followPath(crew, dt, speed, { x: engine.x, y: engine.y, r: range });
    return;
  }

  crew.path.length = 0;
  crew.angle = angleTo(crew.x, crew.y, patient.x, patient.y);
  if (engine.kits < 1) {
    crew.status = 'no kits';
    return;
  }
  crew.status = 'treating';
  crew.treatTimer += dt;
  patient.treatTimer = crew.treatTimer;
  if (crew.treatTimer >= engine.spec.treatTime * (1 - CONFIG.economy.training.medic * (state.training?.medic ?? 0))) {
    crew.treatTimer = 0;
    treatPatient(state, patient, engine);
    crew.patientId = null;
  }
}

/** With no fire to fight, a crew within reach of a wreck clears it. Returns true if busy. */
function updateCrewBlockade(state, crew, engine, dt) {
  const hoseRange = engine.spec.hoseRange * TILE;
  let best = null;
  let bestRect = null;
  let bestD = Infinity;
  for (const b of state.blockades) {
    const rect = { x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h };
    const d = distToRect(engine.x, engine.y, rect);
    if (d > hoseRange - 2.5 * TILE || d >= bestD) continue;
    bestD = d;
    best = b;
    bestRect = rect;
  }
  if (!best) return false;

  crew.spraying = false;
  if (distToRect(crew.x, crew.y, bestRect) <= 2.2 * TILE) {
    crew.path.length = 0;
    crew.status = 'clearing';
    workOnBlockade(state, best, dt * (crew.tool === 'cutter' ? CONFIG.tools.cutter.bonus : 1));
    return true;
  }

  crew.status = 'moving';
  crew.think -= dt;
  if (crew.think <= 0 || crew.path.length === 0) {
    crew.think = 0.8;
    const goal = standTileForRect(state.nav, bestRect, crew.x, crew.y, 3);
    const tiles = goal ? findPath(state.nav, 'walk', tileOf(crew.x, crew.y), goal) : null;
    if (tiles) crew.path = smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles);
  }
  followPath(crew, dt, CONFIG.crew.speed * TILE, { x: engine.x, y: engine.y, r: hoseRange });
  return true;
}

/** Is there water for the hose: the tank, or for a pumpless car the hydrant line. */
function hasWater(engine) {
  return engine.spec.hydrantOnly ? Boolean(engine.supply) : engine.water > 0;
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
      power: CONFIG.crew.sprayPower * firePower(state, crew.x, crew.y),
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

/** Walk (or swim) somewhere with no hose to hold you back. */
function walkFree(state, crew, dt) {
  if (crew.path.length > 0) {
    followPath(crew, dt, CONFIG.crew.speed * TILE);
    crew.status = 'moving';
  } else {
    crew.status = 'standing by';
  }
}

/** Walk back to a point beside the vehicle: true once there. */
function goToVehicle(state, crew, engine, dt) {
  if (dist(crew.x, crew.y, engine.x, engine.y) <= 1.7 * TILE) {
    crew.path.length = 0;
    return true;
  }
  const mode = state.city.water[tileOf(crew.x, crew.y).y * state.city.w + tileOf(crew.x, crew.y).x] ? 'swim' : 'walk';
  crew.think -= dt;
  if (crew.think <= 0 || crew.path.length === 0) {
    crew.think = 0.8;
    const goal = nearestPassable(state.nav, 'walk', ...Object.values(tileOf(engine.x, engine.y)), 4);
    const tiles = goal ? findPath(state.nav, mode, tileOf(crew.x, crew.y), goal) : null;
    crew.path = tiles ? smoothPath(state.nav, mode, { x: crew.x, y: crew.y }, tiles) : [];
  }
  followPath(crew, dt, (mode === 'swim' ? 3.2 : CONFIG.crew.speed) * TILE);
  return false;
}

/** At the lockers: take the tool (or put on the dive suit), then get to work. */
function updateFetch(state, crew, engine, dt) {
  crew.spraying = false;
  if (!goToVehicle(state, crew, engine, dt)) {
    crew.status = 'returning';
    crew.fetchTimer = 0;
    return;
  }
  crew.status = crew.fetch === 'diving' ? 'suiting up' : 'fetching';
  crew.angle = angleTo(crew.x, crew.y, engine.x, engine.y);
  crew.fetchTimer += dt;
  if (crew.fetchTimer >= CONFIG.fetchTime) {
    crew.tool = crew.fetch;
    crew.fetch = null;
    crew.fetchTimer = 0;
    crew.idleFor = 0;
    crew.status = 'standing by';
  }
}

/** Done with the job: back to the vehicle and aboard. */
function updateBoarding(state, crew, engine, dt) {
  crew.spraying = false;
  crew.status = 'returning';
  if (goToVehicle(state, crew, engine, dt)) board(crew, engine);
}

/** A crew member with a chainsaw, working down a cutting job tile by tile. */
function updateCutter(state, crew, engine, dt) {
  crew.spraying = false;
  const job = crew.cut;
  if (!job) {
    walkFree(state, crew, dt);
    return;
  }
  let next = nextCut(state, job);
  for (let guard = 0; next?.skip && guard < 200; guard++) {
    job.hx = next.x;
    job.hy = next.y;
    next = nextCut(state, job);
  }
  if (!next || next.blocked) {
    crew.cut = null;
    crew.status = 'standing by';
    if (job.done > 0) {
      addEvent(state, `${crew.name}: track cut — ${job.done * 2} tiles of forest opened for vehicles`, 'good');
    } else if (next?.blocked) {
      addEvent(state, `${crew.name}: cannot cut through there`, 'warn');
    }
    return;
  }

  // Work from the end of the track, facing the next trees.
  const hx = (job.hx + 0.5) * TILE;
  const hy = (job.hy + 0.5) * TILE;
  if (dist(crew.x, crew.y, hx, hy) > 0.8 * TILE) {
    crew.status = 'moving';
    crew.think -= dt;
    if (crew.think <= 0 || crew.path.length === 0) {
      crew.think = 1;
      const tiles = findPath(state.nav, 'walk', tileOf(crew.x, crew.y), { x: job.hx, y: job.hy });
      crew.path = tiles ? smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles) : [];
      if (!tiles) {
        crew.cut = null;
        addEvent(state, `${crew.name}: cannot reach the end of the track`, 'warn');
        return;
      }
    }
    followPath(crew, dt, CONFIG.crew.speed * TILE);
    return;
  }

  crew.path.length = 0;
  const tx = (next.x + 0.5) * TILE;
  const ty = (next.y + 0.5) * TILE;
  crew.angle = angleTo(crew.x, crew.y, tx, ty);
  crew.status = 'cutting';
  const skill = 1 + CONFIG.economy.training.rescue * (state.training?.rescue ?? 0);
  job.timer += dt * skill;
  if (state.rng.float() < dt * 14) spawnChips(state, (crew.x + tx) / 2, (crew.y + ty) / 2);
  if (job.timer >= CONFIG.tools.chainsaw.cutTime) {
    job.timer = 0;
    cutTile(state, next.x, next.y);
    if (next.side) cutTile(state, next.side.x, next.side.y);
    job.hx = next.x;
    job.hy = next.y;
    job.done++;
    spawnChips(state, tx, ty, 8);
  }
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
      const goal = nearestPassable(state.nav, 'walk', ...Object.values(tileOf(engine.x, engine.y)), 4);
      const tiles = goal ? findPath(state.nav, 'walk', tileOf(crew.x, crew.y), goal) : null;
      crew.path = tiles ? smoothPath(state.nav, 'walk', { x: crew.x, y: crew.y }, tiles) : [];
    }
    followPath(crew, dt, CONFIG.crew.speed * TILE);
    crew.status = 'returning';
    return;
  }

  if (isMedical(engine)) {
    updateMedic(state, crew, engine, dt);
    return;
  }
  if (crew.fetch) {
    updateFetch(state, crew, engine, dt);
    return;
  }
  if (crew.boarding) {
    updateBoarding(state, crew, engine, dt);
    return;
  }
  if (crew.tool === 'diving') {
    updateDiver(state, crew, engine, dt);
    return;
  }
  if (crew.tool === 'chainsaw') {
    updateCutter(state, crew, engine, dt);
    return;
  }
  if (crew.tool === 'cutter') {
    if (updateCrewBlockade(state, crew, engine, dt)) return;
    walkFree(state, crew, dt);
    return;
  }
  if (crew.tool !== 'hose') {
    walkFree(state, crew, dt);
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
  if (!target && updateCrewBlockade(state, crew, engine, dt)) return;
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
    const rescueTime = (engine.spec.rescueTime ?? CONFIG.crew.rescueTime)
      * (1 - CONFIG.economy.training.rescue * (state.training?.rescue ?? 0));
    if (crew.rescueTimer >= rescueTime) {
      crew.rescueTimer = 0;
      if (rescuePerson(state, target)) spawnRescue(state, crew.x, crew.y);
    }
    return;
  }
  crew.rescueTimer = 0;
  crew.rescueId = null;

  if (reach <= CONFIG.crew.sprayRange * TILE && hoseOk) {
    if (!hasWater(engine)) {
      crew.spraying = false;
      crew.status = engine.spec.hydrantOnly ? 'no hydrant' : 'no water';
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
      power: CONFIG.crew.sprayPower * firePower(state, crew.x, crew.y),
      targetId: target.id,
      crewId: crew.id,
      engineId: engine.id,
    });
    state.hoses.push({ ax: engine.x, ay: engine.y, bx: crew.x, by: crew.y, live: true });
    if (!engine.spec.hydrantOnly) {
      engine.water = Math.max(0, engine.water - CONFIG.crew.sprayWater * dt);
      if (engine.water <= 0 && !engine.emptyWarned) {
        engine.emptyWarned = true;
        addEvent(state, `${engine.name} is out of water — find a hydrant`, 'warn');
      }
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
