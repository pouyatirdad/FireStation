// Major disasters: multi-stage emergencies built from the incident primitives
// that already exist (collapses, leaks, fires, forest fires, people in the water,
// storms) rather than a simulation of their own. A disaster is a list of stages;
// each stage runs once, `at` seconds after the disaster begins. When every stage
// has run and the district is quiet again the response is paid.

import { addEvent } from './events.js';
import { earn, money } from './economy.js';
import { ignite } from './fire.js';
import { collapseBuilding } from './collapse.js';
import { startLeak } from './hazmat.js';
import { openIncidents, playScene, spawnIncidentKind } from './incidents.js';
import { spawnPatient } from './medical.js';
import { setWeather } from './weather.js';
import { drowningCall } from './water.js';

const eligible = (state, types = null) => state.buildings.filter((b) => (
  b.state === 'ok' && b.type !== 'station' && b.type !== 'hospital' && (!types || types.includes(b.type))
));

/** n random buildings of the given types, nearest to a station you own first (deterministic through state.rng). */
function pickBuildings(state, n, types = null) {
  const owned = state.city.stations.filter((st, i) => state.ownedStations[i] && !st.sea).map((st) => st.building);
  const pool = eligible(state, types).filter((b) => owned.some((s) => Math.hypot(b.x - s.x, b.y - s.y) <= 90));
  return state.rng.shuffle(pool.length ? pool : eligible(state, types)).slice(0, n);
}

function bury(state, b, reward = 900) {
  const n = state.rng.int(3, 6);
  b.reward = reward;
  b.incidentLabel = 'Earthquake collapse';
  collapseBuilding(state, b, n);
  spawnPatient(state, b, state.rng.range(0.5, 1), 'Earthquake casualty at');
  spawnPatient(state, b, state.rng.range(0.4, 0.9), 'Earthquake casualty at');
  addEvent(state, `${b.name} has collapsed — ${n} people buried`, 'big');
}

function gasFire(state, b) {
  b.reward = 700;
  b.incidentLabel = 'Gas fire after the quake';
  b.hazmat = true;
  ignite(state, b, 'call');
  b.fire = Math.max(b.fire, 0.3);
}

const lockWind = (state, speed) => {
  state.rules = state.rules ?? {};
  state.rules.windLock = true;
  if (state.wind) {
    state.wind.speed = speed;
    state.wind.targetSpeed = speed;
  }
};

const unlockWind = (state) => {
  if (state.rules) state.rules.windLock = false;
};

export const DISASTERS = {
  earthquake: {
    label: 'Major earthquake',
    reward: 5000,
    stages: [
      { at: 0, text: 'EARTHQUAKE — buildings are down across the district', run: (s) => {
        for (const b of pickBuildings(s, 3, ['house', 'apartment', 'shop', 'office'])) bury(s, b);
        for (const b of pickBuildings(s, 2, ['house', 'apartment', 'shop'])) gasFire(s, b);
      } },
      { at: 70, text: 'AFTERSHOCK — more buildings have gone and the damaged ones are moving', run: (s) => {
        for (const b of pickBuildings(s, 2, ['house', 'apartment', 'warehouse', 'shop'])) bury(s, b, 800);
        for (const b of s.buildings) if (b.collapse && !b.collapse.secondaryDone) b.collapse.secondaryIn = Math.min(b.collapse.secondaryIn, 25);
      } },
      { at: 150, text: 'Ruptured pipes and a leaking works — chemical fire and a gas cloud', run: (s) => {
        const [f] = pickBuildings(s, 1, ['factory', 'warehouse']);
        if (f) {
          f.reward = 1200;
          startLeak(s, f, 1);
          f.incidentLabel = 'Chemical leak after the quake';
        }
        for (const b of pickBuildings(s, 1, ['house', 'apartment'])) gasFire(s, b);
      } },
    ],
  },
  hurricane: {
    label: 'Hurricane',
    reward: 4500,
    stages: [
      { at: 0, text: 'HURRICANE — gale-force wind and torrential rain across the city', run: (s) => {
        setWeather(s, 'storm');
        lockWind(s, 0.95);
        for (const b of pickBuildings(s, 2, ['house', 'villa', 'shop'])) {
          b.reward = 600;
          b.incidentLabel = 'Storm fire';
          ignite(s, b, 'call');
        }
      } },
      { at: 50, text: 'The sea is surging — people swept into the water', run: (s) => {
        drowningCall(s, () => true);
        drowningCall(s, () => true);
        spawnIncidentKind(s, 'crash');
      } },
      { at: 120, text: 'Storm damage: a terrace on fire and the woods are burning where the wires came down', run: (s) => {
        spawnIncidentKind(s, 'bigBlock');
        spawnIncidentKind(s, 'forest');
      } },
    ],
    end: (s) => {
      unlockWind(s);
      setWeather(s, 'clear');
    },
  },
  airport: {
    label: 'Airport disaster',
    reward: 6000,
    stages: [
      { at: 0, text: 'AIRPORT DISASTER — an aircraft is down', run: (s) => {
        const hit = playScene(s, 'crash-landing') ?? spawnIncidentKind(s, 'industrial');
        if (!hit) spawnIncidentKind(s, 'bigBlock');
      } },
      { at: 60, text: 'Fuel is spreading to the apron', run: (s) => {
        playScene(s, 'hangarfuel') ?? playScene(s, 'baggage') ?? spawnIncidentKind(s, 'structure');
      } },
    ],
  },
  industrial: {
    label: 'Industrial explosion',
    reward: 5500,
    stages: [
      { at: 0, text: 'INDUSTRIAL EXPLOSION — a works has gone up', run: (s) => {
        playScene(s, 'dust') ?? spawnIncidentKind(s, 'industrial');
      } },
      { at: 45, text: 'A second plant is leaking toxic gas', run: (s) => {
        playScene(s, 'toxicleak') ?? playScene(s, 'ammonia') ?? spawnIncidentKind(s, 'structure');
      } },
      { at: 100, text: 'A fuel tank vent has ignited', run: (s) => {
        playScene(s, 'tankvent') ?? spawnIncidentKind(s, 'structure');
      } },
    ],
  },
  siege: {
    label: 'Forest under siege',
    reward: 5000,
    stages: [
      { at: 0, text: 'FOREST FIRES — three fires have started in the woods in a gale', run: (s) => {
        lockWind(s, 0.9);
        for (let i = 0; i < 3; i++) spawnIncidentKind(s, 'forest');
      } },
      { at: 100, text: 'The wind has thrown embers across the roads', run: (s) => {
        spawnIncidentKind(s, 'forest');
        spawnIncidentKind(s, 'structure');
      } },
    ],
    end: (s) => unlockWind(s),
  },
  blocks: {
    label: 'Multiple building fires',
    reward: 4000,
    stages: [
      { at: 0, text: 'MULTIPLE FIRES — blocks are alight in three districts', run: (s) => {
        for (let i = 0; i < 3; i++) spawnIncidentKind(s, 'bigBlock');
      } },
      { at: 80, text: 'The fires have spread', run: (s) => {
        spawnIncidentKind(s, 'block');
        spawnIncidentKind(s, 'tower');
      } },
    ],
  },
};

export const DISASTER_IDS = Object.keys(DISASTERS);

export function startDisaster(state, id) {
  const def = DISASTERS[id];
  if (!def || state.disaster) return null;
  state.disaster = { id, label: def.label, startedAt: state.time, stage: 0, quietFor: 0 };
  addEvent(state, `DISASTER — ${def.label}`, 'big');
  return state.disaster;
}

/** Run due stages; end the disaster and pay for the response when it is over. */
export function updateDisaster(state, dt) {
  const d = state.disaster;
  if (!d) {
    maybeStart(state, dt);
    return;
  }
  const def = DISASTERS[d.id];
  const age = state.time - d.startedAt;
  while (d.stage < def.stages.length && age >= def.stages[d.stage].at) {
    const stage = def.stages[d.stage];
    d.stage += 1;
    addEvent(state, stage.text, 'big');
    stage.run(state);
  }
  if (d.stage < def.stages.length) return;
  d.quietFor = openIncidents(state) <= 0 ? d.quietFor + dt : 0;
  if (d.quietFor >= 8) {
    def.end?.(state);
    earn(state, def.reward, 'incident');
    addEvent(state, `${def.label} response complete — ${money(def.reward)}`, 'good');
    state.stats.disasters = (state.stats.disasters ?? 0) + 1;
    state.disaster = null;
    state.nextDisasterAt = state.time + 900;
  }
}

/** In an advanced career a disaster can strike on its own, rarely and never while the city is busy. */
function maybeStart(state, dt) {
  if (state.mode !== 'career' || (state.campaign?.level ?? 1) < 4) return;
  if (state.time < (state.nextDisasterAt ?? 600) || state.incidentsEnabled === false) return;
  state.disasterAcc = (state.disasterAcc ?? 0) + dt;
  if (state.disasterAcc < 30) return;
  state.disasterAcc = 0;
  if (openIncidents(state) > 1 || !state.rng.chance(0.05)) return;
  startDisaster(state, state.rng.pick(DISASTER_IDS));
}

