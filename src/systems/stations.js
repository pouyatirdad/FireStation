// Stations as facilities: upgrades with real effects, department-level gating,
// coverage of the city's districts and a comparison between stations.
//
//   garage      more bays          (units.js `stationCapacity`)
//   training    more trainees, faster courses   (personnel.js)
//   medical     faster recovery from fatigue and injury   (personnel.js)
//   workshop    cheaper vehicle maintenance     (finance.js)
//   comms       responders drive faster          (modifiers.js `speedMod`)
//   storage     more tools in every vehicle locker  (applyStationEffects below)
//   tower       forest fires start smaller within range (the 'wildfire:start' hook)

import { CONFIG, TILE } from '../core/config.js';
import { addEvent } from './events.js';
import { spend, money } from './economy.js';
import { on } from './hooks.js';
import { isCareer, upgradeLevel } from './modifiers.js';
import { ownsStation } from './units.js';
import { districtName } from './places.js';

export const UPGRADE_KEYS = ['garage', 'training', 'medical', 'workshop', 'comms', 'storage', 'tower'];

export const levelInfo = (campaign) => CONFIG.career.levels.find((l) => l.id === campaign.level) ?? CONFIG.career.levels[0];

export function stationRecord(state, index) {
  const stations = state.campaign.stations;
  if (!stations[index]) stations[index] = { level: 1, upgrades: {}, budget: 0, spentMonth: 0 };
  return stations[index];
}

export const stationLevel = (state, index) => {
  const r = state.campaign.stations[index];
  if (!r) return 1;
  return 1 + Object.values(r.upgrades ?? {}).reduce((a, b) => a + b, 0);
};

export const upgradeCost = (key, nextLevel) => CONFIG.upgrades[key].cost * nextLevel;

/** Why an upgrade cannot be bought, or null if it can. */
export function upgradeBlock(state, station, key) {
  const def = CONFIG.upgrades[key];
  if (!def || !UPGRADE_KEYS.includes(key)) return 'Unknown upgrade';
  if (!ownsStation(state, station)) return 'You do not own that station';
  if (state.city.stations[station]?.sea) return 'Not available at the dock';
  const level = upgradeLevel(state, station, key);
  if (level >= def.max) return 'Fully upgraded';
  const cap = levelInfo(state.campaign).upgradeCap;
  if (level >= cap) return `Needs a higher department level (cap ${cap})`;
  const cost = upgradeCost(key, level + 1);
  if (state.credits < cost) return `Needs ${money(cost)}`;
  return stationBudgetBlock(state, station, cost);
}

export function buyUpgrade(state, station, key) {
  if (!isCareer(state)) return false;
  const block = upgradeBlock(state, station, key);
  if (block) {
    addEvent(state, `${CONFIG.upgrades[key]?.label ?? 'Upgrade'}: ${block}`, 'warn');
    return false;
  }
  const level = upgradeLevel(state, station, key) + 1;
  spend(state, upgradeCost(key, level), 'upgrade');
  chargeStation(state, station, upgradeCost(key, level));
  const rec = stationRecord(state, station);
  rec.upgrades[key] = level;
  rec.level = stationLevel(state, station);
  applyStationEffects(state);
  addEvent(state, `${state.city.stations[station].name}: ${CONFIG.upgrades[key].label} level ${level}`, 'good');
  return true;
}

/** Locker space: each storage level adds one of every tool a vehicle already carries. */
export function applyStationEffects(state) {
  if (!isCareer(state)) return;
  for (const e of state.engines) {
    const base = e.base?.tools;
    if (!base) continue;
    const i = state.city.bays[e.bayIndex]?.station ?? 0;
    const extra = CONFIG.upgrades.storage.per * upgradeLevel(state, i, 'storage');
    e.spec.tools = Object.fromEntries(Object.entries(base).map(([k, n]) => [k, n + extra]));
  }
}

// ----------------------------------------------------------------- gating ---

export function vehicleUnlocked(state, type) {
  if (!isCareer(state)) return true;
  const level = state.campaign.level;
  return CONFIG.career.levels.some((l) => l.id <= level && l.vehicles.includes(type));
}

/** Why a vehicle type cannot be bought in a career yet, or null. */
export function vehicleBlock(state, type) {
  if (vehicleUnlocked(state, type)) return null;
  const need = CONFIG.career.levels.find((l) => l.vehicles.includes(type));
  return need ? `Unlocked at ${need.name}` : 'Not available';
}

export function stationsAllowed(state) {
  return isCareer(state) ? levelInfo(state.campaign).stations : Infinity;
}

export function ownedStationCount(state) {
  return state.city.stations.filter((st, i) => !st.sea && state.ownedStations[i]).length;
}

/** Why another station cannot be opened yet, or null. */
export function stationBlock(state) {
  if (!isCareer(state)) return null;
  if (ownedStationCount(state) >= stationsAllowed(state)) return `Your department level allows ${stationsAllowed(state)} station${stationsAllowed(state) === 1 ? '' : 's'}`;
  return null;
}

// --------------------------------------------------------------- coverage ---

/** Travel seconds a typical engine needs for a straight run of `tiles`, allowing for street detours. */
const secondsFor = (tiles) => (tiles * 1.35) / CONFIG.vehicles.engine.speed;

/**
 * For each named district: the nearest owned station and the expected travel
 * time to it. Districts over `limit` seconds are underserved.
 */
export function coverage(state, limit = 75) {
  const owned = [];
  state.city.stations.forEach((st, i) => {
    if (!ownsStation(state, i) || st.sea) return;
    owned.push({ i, st, x: st.building.x + st.building.w / 2, y: st.building.y + st.building.h / 2 });
  });
  const rows = [];
  for (const d of state.city.districts ?? []) {
    const cx = d.x / TILE;
    const cy = d.y / TILE;
    let best = null;
    let bestD = Infinity;
    for (const s of owned) {
      const dd = Math.hypot(s.x - cx, s.y - cy);
      if (dd < bestD) {
        bestD = dd;
        best = s;
      }
    }
    if (!best) continue;
    const seconds = secondsFor(bestD);
    rows.push({ district: districtName(state, d.x, d.y) ?? d.name, station: best.st.name, tiles: bestD, seconds, underserved: seconds > limit });
  }
  rows.sort((a, b) => b.seconds - a.seconds);
  let covered = 0;
  for (const b of state.buildings) {
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    if (owned.some((s) => secondsFor(Math.hypot(s.x - bx, s.y - by)) <= limit)) covered += 1;
  }
  return { rows, underserved: rows.filter((r) => r.underserved), share: state.buildings.length ? covered / state.buildings.length : 1 };
}

/** One row per owned station for the comparison table. */
export function compareStations(state) {
  const report = state.report?.stations ?? {};
  const fin = state.campaign?.finance;
  const rows = [];
  state.city.stations.forEach((st, i) => {
    if (!state.ownedStations[i]) return;
    const rec = state.campaign?.stations?.[i];
    const r = report[i];
    rows.push({
      index: i,
      name: st.name,
      level: rec ? stationLevel(state, i) : 1,
      vehicles: state.engines.filter((e) => state.city.bays[e.bayIndex]?.station === i).length,
      staff: (state.campaign?.personnel ?? []).filter((p) => p.station === i && p.vehicleId).length,
      incidents: r?.incidents ?? 0,
      resolved: r?.resolved ?? 0,
      avgResponse: r && r.responses ? r.responseSum / r.responses : null,
      cost: fin?.stationCosts?.[i] ?? 0,
      budget: rec?.budget ?? 0,
      spentMonth: rec?.spentMonth ?? 0,
    });
  });
  return rows;
}

const MAX_BUDGET = 1000000;

/**
 * Station budgets. Each station has a monthly allowance (0 means unlimited). What a
 * station costs this month is tracked in `spentMonth`: its upkeep as it is charged,
 * and what is bought for it (vehicles, upgrades, training). Mandatory upkeep is always
 * paid, but a purchase that would take the station over its budget is refused.
 */
export function setStationBudget(state, index, amount) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET || !state.ownedStations[index]) return false;
  const rec = stationRecord(state, index);
  rec.budget = n;
  rec.warned = false;
  rec.warnedNear = false;
  addEvent(state, n > 0 ? `${state.city.stations[index].name}: monthly budget set to ${money(n)}` : `${state.city.stations[index].name}: budget limit removed`, 'info');
  if (n > 0 && (rec.spentMonth ?? 0) > n) {
    rec.warned = true;
    addEvent(state, `${state.city.stations[index].name} has already spent ${money(rec.spentMonth)} this month, over the new budget — purchases wait until next month`, 'warn');
  }
  return true;
}

/** Why spending `amount` for this station would break its budget, or null. */
export function stationBudgetBlock(state, station, amount) {
  if (!isCareer(state)) return null;
  const rec = state.campaign.stations[station];
  if (!rec || !(rec.budget > 0)) return null;
  const after = (rec.spentMonth ?? 0) + amount;
  if (after <= rec.budget) return null;
  return `Over ${state.city.stations[station]?.name ?? 'the station'}'s budget (${money(after)} of ${money(rec.budget)}) — raise it in Stations`;
}

/** Record money spent for a station this month, and warn as it nears and passes its budget. */
export function chargeStation(state, station, amount) {
  if (!isCareer(state) || !(amount > 0)) return;
  const rec = stationRecord(state, station);
  rec.spentMonth = (rec.spentMonth ?? 0) + amount;
  if (!(rec.budget > 0)) return;
  const name = state.city.stations[station]?.name ?? 'The station';
  if (rec.spentMonth > rec.budget && !rec.warned) {
    rec.warned = true;
    addEvent(state, `${name} is over its monthly budget (${money(rec.spentMonth)} of ${money(rec.budget)}) — only upkeep is paid until next month`, 'warn');
  } else if (rec.spentMonth >= rec.budget * 0.8 && !rec.warnedNear && !rec.warned) {
    rec.warnedNear = true;
    addEvent(state, `${name} has used ${Math.round((rec.spentMonth / rec.budget) * 100)}% of its monthly budget`, 'warn');
  }
}

/** A vehicle sold back reduces what the station has spent (never below nothing). */
export function refundStation(state, station, amount) {
  if (!isCareer(state) || !(amount > 0)) return;
  const rec = stationRecord(state, station);
  rec.spentMonth = Math.max(0, (rec.spentMonth ?? 0) - amount);
}

/** Allocated against expected funding, and each station's use of its budget. */
export function budgetSummary(state) {
  let allocated = 0;
  const rows = [];
  state.city.stations.forEach((st, i) => {
    if (!state.ownedStations[i]) return;
    const rec = state.campaign.stations[i];
    const budget = rec?.budget ?? 0;
    allocated += budget;
    rows.push({ index: i, name: st.name, budget, spent: rec?.spentMonth ?? 0 });
  });
  return { allocated, rows };
}

// ------------------------------------------------------------------ hooks ---

/** Wire the station effects that happen on events. Called once per game. */
export function wireStations(state) {
  // A fire watch tower spots a forest fire early, so it starts smaller.
  on(state, 'wildfire:start', (st, wf) => {
    if (!isCareer(st)) return;
    let best = null;
    st.city.stations.forEach((station, i) => {
      if (!ownsStation(st, i)) return;
      const level = upgradeLevel(st, i, 'tower');
      if (!level) return;
      const b = station.building;
      const d = Math.hypot((b.x + b.w / 2) * TILE - wf.x, (b.y + b.h / 2) * TILE - wf.y) / TILE;
      if (d <= CONFIG.upgrades.towerRange && (!best || level > best.level)) best = { level, name: station.name };
    });
    if (!best) return;
    const cut = 1 - CONFIG.upgrades.tower.per * best.level;
    wf.radius *= cut;
    wf.intensity = Math.max(0.2, wf.intensity - 0.08 * best.level);
    addEvent(st, `${best.name}'s watch tower spotted the fire early — it is smaller than it would have been`, 'good');
  });
  // Station budgets: tally maintenance as it is charged, warn when over.
  on(state, 'finance:hour', (st, data) => {
    for (const [i, v] of Object.entries(data.perStation)) chargeStation(st, Number(i), v);
  });
  on(state, 'finance:month', (st) => {
    for (const rec of Object.values(st.campaign.stations)) {
      rec.spentMonth = 0;
      rec.warned = false;
      rec.warnedNear = false;
    }
  });
}

