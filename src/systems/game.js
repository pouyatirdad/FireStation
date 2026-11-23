// The shift: one city, one engine, one crew, and a district that keeps catching
// fire. This module owns the tick order (alarms, units, fire, effects), the
// rating, and the small vocabulary of orders the UI can give.

import { CONFIG, TILE } from '../core/config.js';
import { Rng, formatClock } from '../core/math.js';
import { createCity } from '../data/city.js';
import { buildNav } from './grid.js';
import {
  activeEngine, buildingOf, buyVehicle, freeBay, createUnits, deployCrew, dispatchEngine,
  engineForUnit, orderAmbulanceToPatient, orderCrew, orderEngine, orderEngineToWildfire,
  orderEngineToBlockade, pickAmbulanceFor, pickEngineForBlockade, recallCrew, repathEngines,
  sellVehicle, sendEngineHome, sendToHospital, sendToPharmacy,
  toggleHydrant, updateUnits, isFirefighter, unstaffed,
  boatCanReach, diveVehiclesFor, orderEngineToVictim,
  canDive, crewForTool, equipCrew, orderCut,
} from './units.js';
import {
  findVictim, nearestVictim, updateVictims,
} from './water.js';
import {
  repayLoan, takeLoan, toggleInsurance,
} from './economy.js';
import {
  acceptContract, createContracts, updateContracts,
} from './contracts.js';
import {
  createTraffic, findBlockade, updateTraffic,
} from './blockades.js';
import { explode, updateChains } from './chains.js';
import { dispatchAll, returnAll } from './dispatch.js';
import { bindHotkey, engineByKey } from '../core/hotkeys.js';
import { createWind, updateWind } from './wind.js';
import { createLedger, spend, updateEconomy } from './economy.js';
import {
  findPatient, isMedical, nearestPatient, updatePatients,
} from './medical.js';
import { activeFires, ignite, snapshotBuildings, updateFire } from './fire.js';
import { addEvent } from './events.js';
import { spawnDebris, updateEffects } from './effects.js';
import { updateFleeing } from './civilians.js';
import { updateIncidents } from './incidents.js';
import { updateWildfires } from './wildfire.js';
import { applyStationEffects, chargeStation, refundStation, stationBlock, stationBudgetBlock, vehicleBlock } from './stations.js';
import { createReport, observe } from './report.js';
import { defaultPresets } from './presets.js';
import { createSupport, updateSupport } from './agencies.js';
import { createEvacuation, updateEvacuation } from './evacuation.js';
import { updateHazards } from './hazmat.js';
import { updateCollapse } from './collapse.js';
import { updateDisaster } from './disasters.js';
import { updatePersonnel, releaseVehicle, staffVehicle } from './personnel.js';
import { updateCareerFinance } from './finance.js';
import { updateObjectives } from './objectives.js';
import { updateScenario } from './challenges.js';
import { isCareer, stationOfEngine } from './modifiers.js';
import {
  SHIFT_VERSION, clone, loadSections, ownedKeys, registerPersistence, reserveIds, saveSections, LEGACY_KEYS,
} from './persistence.js';

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
    rngSeed: seed * 7919 + 13, // the seed of this shift's calls; a career gives every shift its own
    rng: new Rng(seed * 7919 + 13),
    rating: CONFIG.rating.start,
    credits: CONFIG.economy.start,
    stats: { saved: 0, lost: 0, alarms: 0, rescued: 0, casualties: 0, escaped: 0, treated: 0 },
    ledger: createLedger(),
    ownedStations: city.stations.map((_, i) => i === 0),
    victims: [],
    loan: 0,
    insured: false,
    contracts: createContracts(),
    patients: [],
    blockades: [],
    wind: createWind(new Rng(seed * 104729 + 7)),
    events: [],
    eventSeq: 0,
    streams: [],
    hoses: [],
    fx: [],
    fleeing: [],
    wildfires: [],
    // Forest tiles felled by chainsaw crews: tracks vehicles can drive.
    cut: new Uint8Array(city.w * city.h),
    cutCount: 0,
    nextCallAt: CONFIG.incidents.firstCall,
    nextBigAt: CONFIG.incidents.bigAfter + 30,
    selected: null,
    mode: 'quick', // 'quick' | 'career' | 'challenge'
    campaign: null,
    scenario: null,
    rules: {},
    weather: { kind: 'clear', label: 'Clear', roadFactor: 1 },
    presets: defaultPresets(),
    support: createSupport(),
    evac: createEvacuation(),
    hazards: [],
    disaster: null,
    // UI-only scratch space: pointer hover, minimap rect, last toast shown.
    ui: { hover: null, minimap: null, seenEvent: 0 },
    ids: {}, // id counters per kind of entity, saved with the shift
  };

  state.report = createReport(state);
  createUnits(state);
  createTraffic(state);
  state.onDestroyed = (building) => spawnDebris(state, building);
  state.onExplosion = (building) => explode(state, building);
  state.onBlockadeChange = () => repathEngines(state);
  snapshotBuildings(state);
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

  updateWind(state, dt);
  updateIncidents(state, dt);
  updateChains(state);
  updateTraffic(state, dt);
  updateEconomy(state, dt);
  updateContracts(state);
  updatePatients(state, dt);
  updateVictims(state, dt);
  updateUnits(state, dt);
  updateFire(state, dt);
  updateWildfires(state, dt);
  updateFleeing(state, dt);
  updateEffects(state, dt);

  // Operations, people and money (each is a no-op where it does not apply).
  updateHazards(state, dt);
  updateCollapse(state, dt);
  updateEvacuation(state, dt);
  updateSupport(state);
  updateDisaster(state, dt);
  updatePersonnel(state, dt);
  updateCareerFinance(state, dt);
  updateObjectives(state, dt);
  updateScenario(state, dt);
  observe(state, dt);

  if (isCareer(state) && !state.shiftDue && state.time >= CONFIG.career.shiftLength) {
    state.shiftDue = true;
    addEvent(state, 'The shift is over — open the Career tab to file the shift report', 'big');
  }
}

// ------------------------------------------------------------- selection ---

export function getSelected(state) {
  const sel = state.selected;
  if (!sel) return null;
  if (sel.kind === 'patient') return findPatient(state, sel.id);
  if (sel.kind === 'blockade') return findBlockade(state, sel.id);
  if (sel.kind === 'victim') return findVictim(state, sel.id);
  if (sel.kind === 'wildfire') {
    return (state.wildfires ?? []).find((w) => w.id === sel.id) ?? null;
  }
  if (sel.kind === 'unit') return state.units.find((u) => u.id === sel.id) ?? null;
  return state.buildings.find((b) => b.id === sel.id) ?? null;
}

export function selectWildfire(state, id) {
  state.selected = id ? { kind: 'wildfire', id } : null;
}

export function selectVictim(state, id) {
  state.selected = id ? { kind: 'victim', id } : null;
}

export function selectBlockade(state, id) {
  state.selected = id ? { kind: 'blockade', id } : null;
}

export function selectPatient(state, id) {
  state.selected = id ? { kind: 'patient', id } : null;
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

  // Someone in the water: a generous target, picked before anything else on the ground.
  for (const v of state.victims ?? []) {
    if (Math.hypot(v.x - wx, v.y - wy) <= 20 + pad) return { kind: 'victim', id: v.id };
  }

  // Wrecks and debris: the whole blocked rectangle is the target.
  for (const b of state.blockades ?? []) {
    if (Math.abs(wx - b.x) <= b.w / 2 + pad && Math.abs(wy - b.y) <= b.h / 2 + pad) {
      return { kind: 'blockade', id: b.id };
    }
  }

  // A person on the ground is small; give them a generous target.
  let patient = null;
  let patientD = Infinity;
  for (const p of state.patients ?? []) {
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d <= 16 + pad && d < patientD) {
      patientD = d;
      patient = { kind: 'patient', id: p.id };
    }
  }
  if (patient) return patient;

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
  if (selected.kind === 'patient') return commandDispatchPatient(state, selected.id);
  if (selected.kind === 'blockade') return commandDispatchBlockade(state, selected.id);
  if (selected.kind === 'victim') return commandDispatchVictim(state, selected.id);
  if (selected.kind === 'engine') return orderEngine(state, selected, wx, wy, buildingId);
  if (selected.kind === 'crew') {
    // With a chainsaw, a right-click in the woods means "cut a track to here".
    const city = state.city;
    const tile = Math.floor(wy / TILE) * city.w + Math.floor(wx / TILE);
    if (selected.tool === 'chainsaw' && !buildingId && city.woods?.[tile] && !state.nav.drive[tile]) {
      return orderCut(state, selected, wx, wy);
    }
    return orderCrew(state, selected, wx, wy, buildingId);
  }
  // A building is selected: send the active engine to it if it is alight.
  if (selected.state === 'burning') return commandDispatch(state, selected.id);
  return false;
}

function closestIdleEngine(state, x, y, radiusTiles = 0) {
  let idle = null;
  let idleD = Infinity;
  let near = null;
  let nearD = Infinity;
  for (const engine of state.engines) {
    if (!isFirefighter(engine) || engine.spec.hydrantOnly || unstaffed(state, engine)) continue;
    // A fireboat only helps where there is water in reach of the fire.
    if (engine.spec.boat && !boatCanReach(state, engine, x, y, radiusTiles)) continue;
    // Aircraft are the right tool for a forest fire, wherever they are parked.
    const d = Math.hypot(engine.x - x, engine.y - y) * (engine.spec.flying ? 0.45 : 1);
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
  const chosen = engine ?? closestIdleEngine(state, wildfire.x, wildfire.y, wildfire.radius / TILE);
  if (!chosen) return false;
  selectUnit(state, chosen.id);
  return orderEngineToWildfire(state, chosen, wildfire);
}

/** Send an ambulance to an injured person: the selected one, else the nearest stocked one. */
export function commandDispatchPatient(state, id) {
  const patient = findPatient(state, id);
  if (!patient || patient.treated) return false;
  const selected = getSelected(state);
  const picked = selected && selected.kind !== 'patient' ? engineForUnit(state, selected) : null;
  const engine = picked && isMedical(picked) ? picked : pickAmbulanceFor(state, patient);
  if (!engine) {
    addEvent(state, 'No ambulance available — buy one at the station', 'warn');
    return false;
  }
  if (!orderAmbulanceToPatient(state, engine, patient)) return false;
  selectUnit(state, engine.id);
  return true;
}

/** Send divers to someone in the water: the selected diver vehicle, else the nearest that can get there. */
export function commandDispatchVictim(state, id) {
  const victim = findVictim(state, id);
  if (!victim) return false;
  const selected = getSelected(state);
  const picked = selected && selected.kind !== 'victim' ? engineForUnit(state, selected) : null;
  const candidates = canDive(picked) ? [picked] : diveVehiclesFor(state, victim);
  if (candidates.length === 0) {
    addEvent(state, 'No diving gear free — engines and rescue units carry it, or buy a rescue boat', 'warn');
    return false;
  }
  for (const engine of candidates) {
    if (orderEngineToVictim(state, engine, victim)) {
      selectUnit(state, engine.id);
      return true;
    }
  }
  return false;
}

/** Send a crew to clear a wreck: the selected fire vehicle, else the best free one. */
export function commandDispatchBlockade(state, id) {
  const blockade = findBlockade(state, id);
  if (!blockade) return false;
  const selected = getSelected(state);
  const picked = selected && selected.kind !== 'blockade' ? engineForUnit(state, selected) : null;
  const engine = picked && !isMedical(picked) ? picked : pickEngineForBlockade(state, blockade);
  if (!engine) {
    addEvent(state, 'No fire vehicle available to clear the road', 'warn');
    return false;
  }
  if (!orderEngineToBlockade(state, engine, blockade)) return false;
  selectUnit(state, engine.id);
  return true;
}

/** Send the selected ambulance to the hospital with whoever is on board. */
export function commandHospital(state) {
  const engine = engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  if (!engine || !isMedical(engine)) {
    addEvent(state, 'Select an ambulance to send it to a hospital', 'warn');
    return false;
  }
  if ((engine.cargo?.length ?? 0) === 0) {
    addEvent(state, `${engine.name} has no patients on board`, 'info');
    return false;
  }
  return sendToHospital(state, engine);
}

/** Send the selected ambulance to restock at the nearest pharmacy. */
export function commandPharmacy(state) {
  const engine = engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  if (!engine || !isMedical(engine)) {
    addEvent(state, 'Select an ambulance to send it to a pharmacy', 'warn');
    return false;
  }
  return sendToPharmacy(state, engine);
}

/**
 * Fire-service work that is not a burning building: the nearest forest fire, or
 * the nearest building with someone trapped inside that has not caught fire.
 */
function nearestFireJob(state, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if ((b.trapped ?? 0) <= 0 || b.state === 'burning' || b.state === 'rubble') continue;
    const d = Math.hypot((b.x + b.w / 2) * TILE - x, (b.y + b.h / 2) * TILE - y);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'building', id: b.id };
    }
  }
  for (const w of state.wildfires ?? []) {
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'wildfire', id: w.id };
    }
  }
  return best;
}

export function commandDispatch(state, buildingId = null) {
  const selected = getSelected(state);
  if (selected?.kind === 'wildfire') return commandDispatchWildfire(state, selected.id);
  if (selected?.kind === 'patient') return commandDispatchPatient(state, selected.id);
  if (selected?.kind === 'blockade') return commandDispatchBlockade(state, selected.id);
  if (selected?.kind === 'victim') return commandDispatchVictim(state, selected.id);
  const engine = selected ? engineForUnit(state, selected) : null;
  if (engine?.spec?.diver) {
    const victim = nearestVictim(state, engine.x, engine.y, { unclaimed: true }) ?? nearestVictim(state, engine.x, engine.y);
    if (!victim) {
      addEvent(state, 'Nobody is in the water', 'info');
      return false;
    }
    return commandDispatchVictim(state, victim.id);
  }
  if (engine && isMedical(engine)) {
    if ((engine.cargo?.length ?? 0) > 0) return commandHospital(state);
    const patient = nearestPatient(state, engine.x, engine.y, { unclaimed: true })
      ?? nearestPatient(state, engine.x, engine.y);
    if (!patient) {
      addEvent(state, 'Nobody needs an ambulance right now', 'info');
      return false;
    }
    return commandDispatchPatient(state, patient.id);
  }
  // A building picked on the map (buildings carry no `kind`; the selection does).
  const pickedBuilding = state.selected?.kind === 'building' ? selected : null;
  const quiet = activeFires(state).length === 0;
  const hq = state.city.station;
  const origin = engine ?? { x: (hq.x + hq.w / 2) * TILE, y: (hq.y + hq.h / 2) * TILE };

  if (!engine && !buildingId && !pickedBuilding && quiet) {
    const swimmer = nearestVictim(state, origin.x, origin.y, { unclaimed: true });
    if (swimmer) return commandDispatchVictim(state, swimmer.id);
    const patient = nearestPatient(state, origin.x, origin.y, { unclaimed: true });
    if (patient) return commandDispatchPatient(state, patient.id);
  }

  let target = buildingOf(state, buildingId)
    ?? (pickedBuilding && (pickedBuilding.state === 'burning' || (pickedBuilding.trapped ?? 0) > 0) ? pickedBuilding : null);

  // Nothing is alight: the fire service still has work — a forest fire, or
  // someone trapped in a building that has not caught yet.
  if (!target && quiet) {
    const job = nearestFireJob(state, origin.x, origin.y);
    if (job?.kind === 'wildfire') return commandDispatchWildfire(state, job.id);
    if (job) target = buildingOf(state, job.id);
  }

  if (!engine && !target && quiet) {
    const wreck = state.blockades[0];
    if (wreck) return commandDispatchBlockade(state, wreck.id);
  }
  // The selected engine already has a job and no particular fire was named: call
  // the next free vehicle instead, so pressing D again reinforces a different
  // scene rather than shuffling the same engine about.
  let sending = engine;
  if (engine && !target && isFirefighter(engine) && (engine.targetId || engine.wildfireId || engine.path.length > 0)) {
    const spare = state.engines.some((e) => e !== engine && isFirefighter(e) && !e.spec.boat
      && !e.targetId && !e.wildfireId && e.path.length === 0 && e.packTimer === 0);
    if (spare) sending = null;
  }
  const chosen = dispatchEngine(state, sending, target?.id ?? null);
  if (chosen) {
    selectUnit(state, chosen.id);
    return true;
  }
  return false;
}

/**
 * Dispatch everything: every free vehicle goes to an incident of its own (fires,
 * forest fires, injured people, people in the water, wrecks), the nearest ones
 * first, and spare vehicles reinforce the biggest fires.
 */
export function commandDispatchAll(state) {
  const result = dispatchAll(state);
  return result.sent + result.hospital > 0 ? result : false;
}

/** Back all: every vehicle goes back to its station (loaded ambulances via the hospital). */
export function commandReturnAll(state) {
  const result = returnAll(state);
  return result.sent + result.hospital > 0 ? result : false;
}

/** Select the vehicle bound to a key. Returns true if there is one. */
export function selectUnitByKey(state, key) {
  const engine = engineByKey(state, key);
  if (!engine) return false;
  selectUnit(state, engine.id);
  return true;
}

/** Rebind a vehicle's selection key (a key a unit may use; '' clears it). */
export function commandBindKey(state, id, key) {
  const engine = state.engines.find((e) => e.id === id);
  return bindHotkey(state, engine, key);
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

/**
 * Hand out a tool. With a firefighter selected, they fetch it from their own
 * vehicle; with a vehicle selected, someone aboard steps out with it (or the
 * nearest crew member on the ground goes back for it).
 */
export function commandEquip(state, tool) {
  const selected = getSelected(state);
  const engine = engineForUnit(state, selected) ?? activeEngine(state);
  if (!engine) return false;
  const crew = selected?.kind === 'crew' ? selected : crewForTool(state, engine, tool);
  if (!crew) {
    addEvent(state, `${engine.name} has nobody to take it`, 'warn');
    return false;
  }
  const ok = equipCrew(state, crew, tool);
  if (ok && selected?.kind !== 'crew') selectUnit(state, crew.id);
  return ok;
}

/** Connect or disconnect the selected engine's supply line to a hydrant. */
export function commandHydrant(state) {
  const engine = engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  return toggleHydrant(state, engine);
}

/** Buy a vehicle of any type, optionally for a particular station (0 or 1). */
export function commandBuyVehicle(state, type = 'engine', station = null) {
  const block = vehicleBlock(state, type);
  if (block) {
    addEvent(state, `${CONFIG.vehicles[type]?.label ?? type}: ${block}`, 'warn');
    return null;
  }
  // A career station only buys what its monthly budget allows.
  const spec = CONFIG.vehicles[type];
  if (spec && isCareer(state)) {
    const bay = freeBay(state, spec.boat ? 2 : station, Boolean(spec.boat));
    const home = bay >= 0 ? state.city.bays[bay].station : null;
    const over = home != null ? stationBudgetBlock(state, home, spec.cost) : null;
    if (over) {
      addEvent(state, `${spec.label}: ${over}`, 'warn');
      return null;
    }
  }
  const engine = buyVehicle(state, type, station);
  if (engine) {
    if (isCareer(state)) {
      chargeStation(state, stationOfEngine(state, engine), engine.spec.cost);
      staffVehicle(state, engine);
      applyStationEffects(state);
      if (engine.spec.crew > 0 && engine.crewIds.length < engine.spec.crew) {
        addEvent(state, `${engine.name} is short of crew — hire more firefighters`, 'warn');
      }
    }
    selectUnit(state, engine.id);
  }
  return engine;
}

/** Open Station 2 (index 1), the Harbour Dock (index 2) or one of the regional and airport stations (3 and up). */
export function commandBuyStation(state, index = 1) {
  const station = state.city.stations[index];
  if (!station || index === 0) return false;
  if (state.ownedStations[index]) {
    addEvent(state, `${station.name} is already open`, 'info');
    return false;
  }
  const blocked = index === 2 ? null : stationBlock(state);
  if (blocked) {
    addEvent(state, blocked, 'warn');
    return false;
  }
  const price = index === 2 ? CONFIG.economy.dockPrice
    : station.kind === 'airport' ? CONFIG.economy.airportStationPrice
      : station.kind === 'region' ? CONFIG.economy.regionStationPrice
        : CONFIG.economy.stationPrice;
  if (state.credits < price) {
    addEvent(state, `Not enough credits — $${price.toLocaleString('en-US')} for ${station.name}`, 'warn');
    return false;
  }
  spend(state, price, 'station');
  state.ownedStations[index] = true;
  addEvent(
    state,
    index === 2 ? 'The Harbour Dock is open — sixteen berths for boats'
      : index === 1 ? 'Station 2 is open — sixteen more bays across the city'
        : `${station.name} is open — sixteen more bays and calls from its district`,
    'good',
  );
  return true;
}

export const commandLoan = (state, amount) => takeLoan(state, amount);
export const commandRepay = (state, amount) => repayLoan(state, amount);
export const commandInsurance = (state) => toggleInsurance(state);
export const commandAcceptContract = (state, id) => acceptContract(state, id);

export function commandBuyEngine(state) {
  return commandBuyVehicle(state, 'engine');
}

/** Sell the selected vehicle. */
export function commandSellVehicle(state, id = null) {
  const engine = id
    ? state.engines.find((e) => e.id === id)
    : engineForUnit(state, getSelected(state)) ?? activeEngine(state);
  if (engine) releaseVehicle(state, engine);
  const home = engine ? stationOfEngine(state, engine) : null;
  const refund = sellVehicle(state, engine);
  if (refund && home != null) refundStation(state, home, refund);
  return refund;
}

// Re-exported so the UI has one module to talk to for orders.
export { orderEngine, orderCrew };

// ------------------------------------------------------------------- save ---
//
// The shift is saved by the persistence registry (persistence.js): every system registers the part it owns
// (units.js the fleet, medical.js the patients, fire.js the buildings, and so on). What stays here is what
// belongs to the shift as a whole: the clock, the money, the mode, the id counters, and the repair of
// references between entities.

const fin = (v, fallback, min = -Infinity, max = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

registerPersistence({
  key: 'mode',
  keys: ['mode', 'rules'],
  fields: ['mode', 'rules', 'campaign'],
  order: 5,
  save: (state) => ({ mode: state.mode, rules: clone(state.rules) }),
  load: (state, data, ctx) => {
    const career = data.mode === 'career';
    state.mode = career && ctx.campaign ? 'career' : data.mode === 'challenge' && data.scenario ? 'challenge' : 'quick';
    if (career && !ctx.campaign) ctx.issues.push('this was a career save but its career data is missing: loaded as a Quick Response shift');
    state.campaign = state.mode === 'career' ? ctx.campaign : null;
    state.rules = data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules) ? { ...data.rules } : {};
  },
});

registerPersistence({
  key: 'core',
  keys: [
    'seed', 'time', 'clock', 'credits', 'rating', 'stats', 'incidentsEnabled', 'nextCallAt', 'nextBigAt', 'eventSeq',
    'events', 'loan', 'insured', 'ownedStations', 'shiftDue', 'incidentPace', 'rngSeed', 'cycleIndex',
  ],
  fields: [
    'seed', 'time', 'clock', 'credits', 'rating', 'stats', 'incidentsEnabled', 'nextCallAt', 'nextBigAt', 'eventSeq',
    'events', 'loan', 'insured', 'ownedStations', 'shiftDue', 'incidentPace', 'rngSeed', 'cycleIndex', 'saveExtras',
  ],
  order: 10,
  save: (state) => ({
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
    loan: state.loan,
    insured: state.insured,
    ownedStations: [...state.ownedStations],
    shiftDue: Boolean(state.shiftDue),
    incidentPace: state.incidentPace ?? 1,
    rngSeed: state.rngSeed,
    cycleIndex: Number.isFinite(state.cycleIndex) ? state.cycleIndex : null,
  }),
  load: (state, data, ctx) => {
    state.time = fin(data.time, 0, 0);
    state.clock = fin(data.clock, CONFIG.clockStart);
    state.credits = fin(data.credits, CONFIG.economy.start);
    state.rating = fin(data.rating, CONFIG.rating.start, 0, 100);
    const stats = data.stats && typeof data.stats === 'object' && !Array.isArray(data.stats) ? data.stats : {};
    for (const [k, v] of Object.entries(stats)) {
      if (typeof v === 'number' && Number.isFinite(v)) state.stats[k] = v;
      else ctx.issues.push(`stat ${k} was damaged and was ignored`);
    }
    state.events = (Array.isArray(data.events) ? data.events : [])
      .filter((e) => e && typeof e === 'object' && typeof e.text === 'string').slice(0, 60).map((e) => ({ ...e }));
    state.eventSeq = fin(data.eventSeq, state.events.length, 0);
    state.incidentsEnabled = data.incidentsEnabled !== false;
    state.nextCallAt = fin(data.nextCallAt, CONFIG.incidents.firstCall);
    state.nextBigAt = fin(data.nextBigAt, CONFIG.incidents.bigAfter + 30);
    state.ownedStations = state.city.stations.map((_, i) => Boolean(data.ownedStations?.[i] ?? i === 0));
    state.loan = fin(data.loan, 0, 0);
    state.insured = Boolean(data.insured);
    state.shiftDue = Boolean(data.shiftDue);
    state.incidentPace = fin(data.incidentPace, 1, 0, 100);
    if (Number.isFinite(data.rngSeed)) state.rngSeed = data.rngSeed;
    if (Number.isFinite(data.cycleIndex)) state.cycleIndex = data.cycleIndex;
  },
});

/**
 * Every reference from one entity to another must point at something that exists; one that does not (a
 * damaged or hand-edited save, or a vehicle sent to something that ended in the same tick) is cleared, and
 * the repair is reported.
 */
function repairReferences(state, issues) {
  const ids = (list) => new Set((list ?? []).map((x) => x.id));
  const buildings = ids(state.buildings);
  const engines = ids(state.engines);
  const crew = ids(state.crew);
  const patients = ids(state.patients);
  const victims = ids(state.victims);
  const wildfires = ids(state.wildfires);
  const blockades = ids(state.blockades);
  const hospitals = ids(state.city.hospitals);
  const fix = (owner, field, set, label) => {
    if (owner[field] != null && !set.has(owner[field])) {
      issues.push(`${label} pointed at a ${field} that does not exist; cleared`);
      owner[field] = null;
    }
  };
  for (const e of state.engines) {
    const L = `vehicle ${e.id}`;
    fix(e, 'targetId', buildings, L);
    fix(e, 'wildfireId', wildfires, L);
    fix(e, 'blockadeId', blockades, L);
    fix(e, 'victimId', victims, L);
    fix(e, 'patientId', patients, L);
    fix(e, 'hospitalId', hospitals, L);
    if (e.standbyFor) {
      const pool = { building: buildings, wildfire: wildfires, patient: patients, victim: victims, blockade: blockades }[e.standbyFor.kind];
      if (!pool || !pool.has(e.standbyFor.id)) e.standbyFor = null;
    }
  }
  for (const c of state.crew) {
    const L = `crew ${c.id}`;
    fix(c, 'targetId', buildings, L);
    fix(c, 'rescueId', buildings, L);
    fix(c, 'wildfireId', wildfires, L);
    fix(c, 'patientId', patients, L);
    fix(c, 'victimId', victims, L);
  }
  for (const p of state.patients) {
    fix(p, 'claimedBy', engines, `patient ${p.id}`);
    fix(p, 'medicId', crew, `patient ${p.id}`);
  }
  for (const v of state.victims) fix(v, 'diverId', crew, `victim ${v.id}`);
}

registerPersistence({
  key: 'references',
  keys: [],
  order: 95,
  save: () => ({}),
  load: (state, data, ctx) => repairReferences(state, ctx.issues),
});

registerPersistence({
  key: 'luck',
  keys: [],
  order: 96,
  save: () => ({}),
  // A loaded shift carries on with fresh luck instead of replaying the calls it started with.
  load: (state) => { state.rng = new Rng(state.rngSeed + Math.floor(state.time) * 31 + 1); },
});

registerPersistence({
  key: 'ids',
  order: 99,
  save: (state) => ({ ...state.ids }),
  load: (state, data) => {
    reserveIds(state, data.ids, {
      patient: state.patients, victim: state.victims, wreck: state.blockades, wildfire: state.wildfires, evac: state.evac?.zones,
    });
  },
});

/**
 * The shift as plain JSON. Whatever a save carried that no section knows (a field from a newer build, a
 * hand-added one) is kept in `state.saveExtras` when it is loaded and written back here.
 */
export function serialize(state) {
  return { version: SHIFT_VERSION, ...saveSections(state), ...(state.saveExtras ?? {}) };
}

export function loadState(data, campaign = null) {
  const input = data && typeof data === 'object' ? data : {};
  const state = createGame(Number.isFinite(input.seed) ? input.seed : CONFIG.city.seed);
  const issues = [];
  loadSections(state, input, { campaign, issues });
  const known = ownedKeys();
  const extras = {};
  for (const [k, v] of Object.entries(input)) {
    if (k !== 'version' && !known.has(k) && !LEGACY_KEYS.includes(k)) extras[k] = v;
  }
  if (Object.keys(extras).length > 0) {
    state.saveExtras = extras;
    issues.push(`the save has fields this version does not know (${Object.keys(extras).join(', ')}); they are kept`);
  }
  if (isCareer(state)) applyStationEffects(state);
  state.running = true;
  state.paused = false;
  state.loadReport = { issues };
  return state;
}
