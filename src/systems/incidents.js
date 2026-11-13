// Calls for service: the incident generator.
//
// Small jobs arrive on a timer from the first minute. Major incidents are held
// back until the shift has been running for `bigAfter` seconds, give much more
// money, and only one can be live at a time.

import { CONFIG, TILE } from '../core/config.js';
import { rectsTouch } from '../core/math.js';
import { addEvent } from './events.js';
import { buildingRect, ignite } from './fire.js';
import { startWildfire } from './wildfire.js';
import { spawnPatient } from './medical.js';
import { pileUp, trafficAccident } from './chains.js';
import { drowningCall } from './water.js';
import { placeNear } from './places.js';
import { SCENES, sceneFits } from './scenes.js';

const SMALL = () => ['structure', 'structure', 'structure', 'rescue', 'block'];
const BIG = ['industrial', 'tower', 'bigBlock', 'forest', 'pileup'];

/**
 * Where the shift is in its build-up. Difficulty climbs through a cycle and
 * then starts over, so it never grows without end: `t` is seconds into the
 * cycle and `level` runs from 0 (quiet start) up towards 1 (the peak).
 */
export function cyclePhase(state) {
  const { cycle } = CONFIG.incidents;
  const index = Math.floor(state.time / cycle);
  const t = state.time - index * cycle;
  return { index, t, level: t / cycle };
}

/**
 * How far from Station 1 (in tiles) a call can come from. It starts as the
 * neighbourhood, grows through the cycle, and shrinks back at the reset.
 */
export function coverageRadius(state) {
  const { start, growPerSecond } = CONFIG.incidents.radius;
  return start + cyclePhase(state).t * growPerSecond;
}

/** How many incidents may be open at once at this point in the cycle. */
export function openLimit(state) {
  const [lo, hi] = CONFIG.incidents.maxOpen;
  return Math.round(lo + (hi - lo) * cyclePhase(state).level);
}

/**
 * Everything on the incident list that still needs someone. A wreck only
 * closes a road, so however many there are they count as one.
 */
export function openIncidents(state) {
  let open = Math.min(state.blockades.length, 1);
  open += state.wildfires.length;
  open += state.patients.filter((p) => !p.treated).length;
  open += state.victims?.length ?? 0;
  for (const b of state.buildings) {
    if (b.state === 'burning' || ((b.trapped ?? 0) > 0 && b.state !== 'rubble')) open++;
  }
  return open;
}

// A call can come from anywhere within reach of any station you own, so
// opening Station 2 brings a second district into the rota.
const inCoverage = (state, x, y, scale = 1) => state.city.stations.some((st, i) => {
  if (!(state.ownedStations?.[i] ?? i === 0)) return false;
  const b = st.building;
  return Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h / 2)) <= coverageRadius(state) * scale;
});

function candidates(state, types = null) {
  const pool = state.buildings.filter((b) => (
    b.state === 'ok'
    && b.type !== 'station'
    && b.type !== 'hospital'
    && (!types || types.includes(b.type))
  ));
  const near = pool.filter((b) => inCoverage(state, b.x + b.w / 2, b.y + b.h / 2));
  return near.length ? near : pool;
}

function pick(state, types = null) {
  const pool = candidates(state, types);
  return pool.length ? state.rng.pick(pool) : null;
}

function price(state, kind, count = 1) {
  const total = CONFIG.incidents.reward[kind] ?? 300;
  return Math.round(total / count);
}

/** A building of one kind of district, within reach of a station you own; null if there is none. */
function pickZone(state, zone, types = null) {
  const pool = state.buildings.filter((b) => (
    b.state === 'ok' && b.zone === zone && (!types || types.includes(b.type))
    && inCoverage(state, b.x + b.w / 2, b.y + b.h / 2)
  ));
  return pool.length ? state.rng.pick(pool) : null;
}

/** Start a fire with a story: a label for the list, a reward and a line in the log. */
function scenario(state, building, { label, kind, text, fire = 0, trapped = 0 }) {
  building.reward = price(state, kind);
  building.incidentType = 'structure';
  building.incidentLabel = label;
  if (trapped > 0) building.trapped = trapped;
  ignite(state, building, 'call');
  if (fire > 0) building.fire = Math.max(building.fire, fire);
  addEvent(state, text, 'fire');
  return building;
}

/**
 * A fire call. What happens depends on the district the building is in: a
 * kitchen fire or a gas explosion in the housing, a floor of people trapped in
 * the business districts, chemicals on the industrial estates and the quay.
 */
function structureFire(state) {
  const b = pick(state);
  if (!b) return null;
  const rng = state.rng;
  const where = placeNear(state, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE);

  if (b.zone === 'housing') {
    if (b.type === 'apartment') {
      const n = rng.int(3, 6);
      return scenario(state, b, {
        label: 'Apartment block fire', kind: 'apartment', fire: 0.3, trapped: n,
        text: `Apartment block fire — ${n} residents cannot get out of ${b.name}`,
      });
    }
    if (rng.chance(0.3)) {
      const house = scenario(state, b, {
        label: 'Gas explosion', kind: 'gas', fire: 0.45,
        text: `Gas explosion at ${b.name} — the house is alight and people are hurt`,
      });
      spawnPatient(state, b, rng.range(0.55, 0.9), 'Gas explosion casualty at');
      spawnPatient(state, b, rng.range(0.3, 0.6), 'Gas explosion casualty at');
      return house;
    }
    const n = rng.chance(0.55) ? rng.int(1, 3) : 0;
    return scenario(state, b, {
      label: 'Kitchen fire', kind: 'kitchen', trapped: n,
      text: n > 0 ? `Kitchen fire at ${b.name} — ${n} still inside upstairs` : `Kitchen fire at ${b.name} — the family is out on the lawn`,
    });
  }

  // The very big buildings have their own stories, wherever they stand.
  if (b.type === 'tower') {
    const n = rng.int(3, 7);
    return scenario(state, b, {
      label: 'High-rise fire', kind: 'tower', fire: 0.2, trapped: n,
      text: `High-rise fire in ${where} — ${n} people trapped above the fire in ${b.name}`,
    });
  }
  if (b.type === 'mall') {
    const n = rng.int(4, 8);
    return scenario(state, b, {
      label: 'Shopping centre fire', kind: 'mall', fire: 0.25, trapped: n,
      text: `Shopping centre fire — ${n} shoppers cut off inside ${b.name}`,
    });
  }
  if (b.type === 'school') {
    const n = rng.int(2, 4);
    return scenario(state, b, {
      label: 'School fire', kind: 'school', fire: 0.2, trapped: n,
      text: `School fire at ${b.name} — the pupils are out, ${n} staff are still inside`,
    });
  }

  if (b.zone === 'company') {
    if (b.type === 'hotel') {
      const n = rng.int(2, 5);
      return scenario(state, b, {
        label: 'Hotel fire', kind: 'hotel', fire: 0.2, trapped: n,
        text: `Hotel fire — ${n} guests trapped on the upper floors of ${b.name}`,
      });
    }
    if (b.type === 'office') {
      const n = rng.int(2, Math.min(6, 2 + Math.floor(b.floors / 2)));
      return scenario(state, b, {
        label: 'Office fire', kind: 'office', fire: 0.2, trapped: n,
        text: `Office fire in ${where} — ${n} staff trapped on the ${b.floors > 4 ? 'upper floors' : 'first floor'} of ${b.name}`,
      });
    }
  }

  if (b.type === 'tankfarm') {
    b.hazmat = true;
    return scenario(state, b, {
      label: 'Fuel tank fire', kind: 'dockFuel', fire: 0.45,
      text: `Fuel tank fire at ${b.name} — it burns hot, will spread and may explode; a fireboat can reach it`,
    });
  }

  if (b.zone === 'industrial' && (b.type === 'warehouse' || b.type === 'factory')) {
    if (rng.chance(0.3)) {
      // An accident, not a fire: somebody is badly hurt in the works.
      b.incidentLabel = 'Industrial accident';
      spawnPatient(state, b, rng.range(0.75, 1), 'Worker crushed by machinery at');
      addEvent(state, `Industrial accident at ${b.name} — a worker is trapped under a load`, 'warn');
      return b;
    }
    const quay = b.waterfront;
    b.hazmat = true;
    return scenario(state, b, {
      label: quay ? 'Dockside fuel fire' : 'Chemical fire', kind: quay ? 'dockFuel' : 'chemical', fire: 0.35,
      text: quay
        ? `Fuel store alight at ${b.name} on the waterfront — it burns hot and spreads; a fireboat can reach it`
        : `Chemical fire at ${b.name} — toxic smoke, it will spread fast and may explode`,
    });
  }

  b.reward = price(state, 'structure');
  b.incidentType = 'structure';
  b.incidentLabel = b.zone === 'commercial' ? 'Shop fire' : null;
  ignite(state, b, 'call');
  return b;
}

function blockFire(state, count) {
  // A fire in a shopping street takes the whole terrace with it.
  const first = (state.rng.chance(0.6) ? pickZone(state, 'commercial', ['shop']) : null) ?? pick(state);
  if (!first) return null;
  const rect = buildingRect(first);
  const neighbours = state.buildings.filter((b) => (
    b !== first
    && b.state === 'ok'
    && b.type !== 'station'
    && rectsTouch(rect, buildingRect(b), 4 * TILE)
  ));
  const picks = [first, ...state.rng.shuffle(neighbours).slice(0, count - 1)];
  const each = price(state, 'block', picks.length);
  const street = first.zone === 'commercial';
  for (const b of picks) {
    b.reward = each;
    b.incidentType = 'block';
    b.incidentLabel = street ? 'Shopping-street fire' : 'Block fire';
  }
  for (const b of picks) ignite(state, b, 'call');
  addEvent(
    state,
    street
      ? `Shopping-street fire — ${picks.length} shops alight around ${first.name}`
      : `Block fire — ${picks.length} buildings around ${first.name}`,
    'fire',
  );
  return picks[0];
}

function rescueJob(state) {
  const building = pick(state, ['office', 'hotel', 'apartment', 'shop', 'warehouse', 'tower', 'mall', 'factory']);
  if (!building) return null;
  const n = state.rng.int(1, 2);
  building.trapped = n;
  building.incidentType = 'rescue';
  const lift = building.type === 'office' || building.type === 'hotel' || building.type === 'tower';
  building.reward = price(state, lift ? 'lift' : 'rescue');
  const text = {
    office: `Lift failure — ${n} stuck between floors at ${building.name}`,
    tower: `Lift failure — ${n} stuck high up in ${building.name}`,
    mall: `Escalator accident — a shopper is trapped at ${building.name}`,
    factory: `Worker caught in a machine at ${building.name}`,
    hotel: `Lift failure — ${n} guests stuck at ${building.name}`,
    apartment: `Resident collapsed behind a locked door — ${building.name}`,
    shop: `Shelving has collapsed on a customer — ${building.name}`,
    warehouse: `Worker pinned under a fallen load — ${building.name}`,
  }[building.type];
  building.incidentLabel = {
    office: 'Lift rescue', tower: 'Lift rescue', hotel: 'Lift rescue', apartment: 'Locked-in resident', shop: 'Collapse rescue', warehouse: 'Industrial rescue',
    mall: 'Escalator rescue', factory: 'Industrial rescue',
  }[building.type];
  addEvent(state, text ?? `Person reported trapped — ${building.name}`, 'warn');
  return building;
}

function industrialFire(state) {
  // A works or a quay warehouse if one is in reach, else whatever is big.
  const works = pickZone(state, 'industrial', ['warehouse', 'factory', 'tankfarm']);
  if (works) {
    works.hazmat = true;
    works.reward = price(state, works.waterfront ? 'dockFuel' : 'industrial');
    works.incidentType = 'big';
    works.incidentLabel = works.waterfront ? 'Waterfront fuel depot fire' : 'Industrial fire';
    works.big = true;
    ignite(state, works, 'call');
    works.fire = 0.55;
    addEvent(
      state,
      works.waterfront
        ? `MAJOR INCIDENT — fuel depot burning at ${works.name} on the waterfront`
        : `MAJOR INCIDENT — industrial fire at ${works.name}; chemicals stored on site`,
      'big',
    );
    return works;
  }
  const building = pick(state, ['warehouse', 'office', 'hotel']);
  if (!building) return null;
  building.reward = price(state, 'industrial');
  building.incidentType = 'big';
  building.big = true;
  ignite(state, building, 'call');
  building.fire = 0.55;
  addEvent(state, `MAJOR INCIDENT — industrial fire at ${building.name}`, 'big');
  return building;
}

/** A tall office or hotel in a business district, with people on every floor. */
function towerFire(state) {
  const tower = pickZone(state, 'company', ['tower']) ?? pickZone(state, 'company', ['office', 'hotel', 'mall']);
  if (!tower || tower.floors < 5) return bigBlockFire(state);
  const n = state.rng.int(4, 8);
  tower.trapped = n;
  tower.reward = price(state, 'tower');
  tower.incidentType = 'big';
  tower.incidentLabel = 'High-rise fire';
  tower.big = true;
  ignite(state, tower, 'call');
  tower.fire = 0.4;
  addEvent(state, `MAJOR INCIDENT — high-rise fire at ${tower.name}: ${n} people trapped above the fire`, 'big');
  return tower;
}

function bigBlockFire(state) {
  const first = pick(state);
  if (!first) return null;
  const rect = buildingRect(first);
  const neighbours = state.buildings.filter((b) => (
    b !== first
    && b.state === 'ok'
    && b.type !== 'station'
    && rectsTouch(rect, buildingRect(b), 5 * TILE)
  ));
  const picks = [first, ...state.rng.shuffle(neighbours).slice(0, 3)];
  const each = price(state, 'bigBlock', picks.length);
  for (const b of picks) {
    b.reward = each;
    b.incidentType = 'big';
    b.big = true;
  }
  for (const b of picks) ignite(state, b, 'call');
  addEvent(state, `MAJOR INCIDENT — ${picks.length} buildings alight around ${first.name}`, 'big');
  return picks[0];
}

function forestFire(state) {
  const all = state.city.forestTiles;
  if (!all || all.length === 0) return null;
  const near = all.filter((t) => inCoverage(state, t.x, t.y, 1.4));
  const tile = state.rng.pick(near.length ? near : all);
  const wildfire = startWildfire(
    state,
    (tile.x + 0.5) * TILE,
    (tile.y + 0.5) * TILE,
    price(state, 'forest'),
  );
  return wildfire;
}

function medicalCall(state) {
  if (state.patients.filter((p) => !p.treated).length >= 5) return null;
  const building = pick(state, ['house', 'villa', 'apartment', 'office', 'tower', 'hotel', 'shop', 'mall', 'school', 'pharmacy']);
  if (!building) return null;
  const reason = {
    housing: 'Resident collapsed at home — suspected cardiac arrest at',
    company: 'Worker collapsed at the office —',
    commercial: 'Shopper fainted outside',
  }[building.zone] ?? null;
  return spawnPatient(state, building, state.rng.range(0.3, 1), reason);
}

const roadAllowed = (state) => (x, y) => inCoverage(state, x, y);

// ------------------------------------------------------------------ scenes ---

const weightedScene = (rng, options) => {
  const total = options.reduce((sum, o) => sum + o.scene.weight, 0);
  let roll = rng.range(0, total);
  for (const o of options) {
    roll -= o.scene.weight;
    if (roll <= 0) return o;
  }
  return options[0];
};

/** Play one scene on a building: fire, people trapped, people hurt, chemicals, a blast. */
function runBuildingScene(state, scene, b) {
  const rng = state.rng;
  const where = placeNear(state, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE);
  const n = scene.trapped ? rng.int(scene.trapped[0], scene.trapped[1]) : 0;
  b.reward = scene.reward ?? 0;
  b.incidentLabel = scene.label;
  b.incidentType = scene.big ? 'big' : scene.fire != null ? 'structure' : n > 0 ? 'rescue' : null;
  if (scene.hazmat) b.hazmat = true;
  if (scene.big) b.big = true;
  if (scene.fire != null) {
    ignite(state, b, 'call'); // (this also works out who got out and who did not)
    b.fire = Math.max(b.fire, scene.fire);
  }
  // The scene says how many are cut off, whatever the evacuation worked out.
  if (n > 0) b.trapped = Math.max(b.trapped ?? 0, n);
  addEvent(state, scene.text({ b, n, where }), scene.big ? 'big' : scene.fire != null ? 'fire' : 'warn');
  for (const [lo, hi, reason] of scene.hurt ?? []) spawnPatient(state, b, rng.range(lo, hi), reason);
  if (scene.blast) state.onExplosion?.(b);
  return b;
}

function runForestScene(state, scene) {
  const all = state.city.forestTiles;
  if (!all || all.length === 0) return null;
  const near = all.filter((t) => inCoverage(state, t.x, t.y, 1.4));
  if (near.length === 0) return null;
  const tile = state.rng.pick(near);
  const where = placeNear(state, (tile.x + 0.5) * TILE, (tile.y + 0.5) * TILE);
  const text = scene.text({ where });
  const first = startWildfire(state, (tile.x + 0.5) * TILE, (tile.y + 0.5) * TILE, scene.reward, { name: scene.label, text });
  if (scene.id === 'arson-woods') {
    // Set in two places at once, a few tiles apart.
    const other = state.rng.pick(near.filter((t) => Math.hypot(t.x - tile.x, t.y - tile.y) < 14)) ?? tile;
    startWildfire(state, (other.x + 0.5) * TILE, (other.y + 0.5) * TILE, 0, { name: scene.label, text: `A second fire has started nearby in ${where}` });
  }
  return first;
}

function runSiteScene(state, scene) {
  if (scene.site === 'forest') return runForestScene(state, scene);
  if (scene.site === 'road') {
    return trafficAccident(state, roadAllowed(state), {
      name: scene.label, hurt: scene.hurt, big: scene.big, reward: scene.reward, quickFuse: scene.quickFuse, text: scene.text,
    });
  }
  if (scene.site === 'water') return drowningCall(state, (x, y) => inCoverage(state, x, y), { what: scene.what });
  return null;
}

/**
 * Draw a scene (a major one if `big`): one that can happen to something within
 * reach of a station you own. Null if nothing fits, and the caller falls back to
 * the ordinary calls.
 */
function spawnScene(state, big) {
  const pool = state.buildings.filter((b) => (
    b.state === 'ok' && b.type !== 'station' && b.type !== 'hospital' && inCoverage(state, b.x + b.w / 2, b.y + b.h / 2)
  ));
  const options = [];
  for (const scene of SCENES) {
    if (Boolean(scene.big) !== big) continue;
    if (scene.site) options.push({ scene });
    else {
      const matches = pool.filter((b) => sceneFits(scene, b));
      if (matches.length) options.push({ scene, matches });
    }
  }
  for (let tries = 0; tries < 4 && options.length > 0; tries++) {
    const pickOne = weightedScene(state.rng, options);
    const made = pickOne.matches
      ? runBuildingScene(state, pickOne.scene, state.rng.pick(pickOne.matches))
      : runSiteScene(state, pickOne.scene);
    if (made) return made;
    options.splice(options.indexOf(pickOne), 1);
  }
  return null;
}

/** Play one named scene (for the tests and the dev tools): on `building`, or on one that fits. */
export function playScene(state, id, building = null) {
  const scene = SCENES.find((sc) => sc.id === id);
  if (!scene) return null;
  if (scene.site) return runSiteScene(state, scene);
  const target = building ?? state.rng.pick(state.buildings.filter((b) => b.state === 'ok' && sceneFits(scene, b)));
  return target ? runBuildingScene(state, scene, target) : null;
}

function spawnSmall(state) {
  if (state.rng.chance(CONFIG.incidents.sceneCall)) {
    const made = spawnScene(state, false);
    if (made) return made;
  }
  if (state.rng.chance(CONFIG.incidents.drownCall)) {
    const made = drowningCall(state, (x, y) => inCoverage(state, x, y));
    if (made) return made;
  }
  if (state.rng.chance(CONFIG.incidents.crashCall)) {
    return trafficAccident(state, roadAllowed(state));
  }
  if (state.rng.chance(CONFIG.incidents.medicalCall)) return medicalCall(state);
  const kind = state.rng.pick(SMALL());
  if (kind === 'rescue') return rescueJob(state);
  if (kind === 'block') return blockFire(state, 2);
  return structureFire(state);
}

function spawnBig(state) {
  if (state.rng.chance(CONFIG.incidents.sceneBigCall)) {
    const made = spawnScene(state, true);
    if (made) return made;
  }
  const kind = state.rng.pick(BIG);
  if (kind === 'industrial') return industrialFire(state);
  if (kind === 'forest') return forestFire(state);
  if (kind === 'tower') return towerFire(state);
  if (kind === 'pileup') return pileUp(state, (x, y) => inCoverage(state, x, y, 1.2));
  return bigBlockFire(state);
}

export function bigIncidentActive(state) {
  if (state.wildfires.some((w) => w.intensity > 0)) return true;
  if (state.blockades.some((b) => b.big)) return true;
  return state.buildings.some((b) => b.big && (b.state === 'burning' || b.state === 'out'));
}

export function updateIncidents(state, dt) {
  if (state.incidentsEnabled === false) return;
  const cfg = CONFIG.incidents;
  const phase = cyclePhase(state);

  // The cycle turned over: back to the quiet start. Whatever is still burning
  // stays, but nothing new comes for a breather and the build-up starts again.
  if (state.cycleIndex === undefined) state.cycleIndex = phase.index;
  if (phase.index !== state.cycleIndex) {
    state.cycleIndex = phase.index;
    state.nextCallAt = cfg.breather;
    state.nextBigAt = state.rng.range(cfg.bigFirst[0], cfg.bigFirst[1]);
    addEvent(state, 'Quiet spell — the district settles after a busy stretch', 'info');
  }

  const open = openIncidents(state);

  state.nextCallAt -= dt;
  if (state.nextCallAt <= 0) {
    const [lo, hi] = cfg.callEvery;
    const pace = 1 + (cfg.callScale - 1) * phase.level; // calls come faster as the cycle builds
    state.nextCallAt = state.rng.range(lo, hi) * pace * (bigIncidentActive(state) ? 1.35 : 1);
    if (open < openLimit(state)) spawnSmall(state);
  }

  if (phase.t < cfg.bigAfter) return;

  state.nextBigAt -= dt;
  if (state.nextBigAt > 0) return;
  // A major incident only starts when the district is nearly clear.
  if (open > 1 || bigIncidentActive(state)) {
    state.nextBigAt = 15;
    return;
  }
  const [lo, hi] = cfg.bigEvery;
  state.nextBigAt = state.rng.range(lo, hi);
  spawnBig(state);
}
