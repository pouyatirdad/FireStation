import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, selectUnit, selectBuilding, commandDispatch,
} from '../src/systems/game.js';
import { ignite } from '../src/systems/fire.js';
import { nearestPassable } from '../src/systems/grid.js';
import { startWildfire } from '../src/systems/wildfire.js';
import {
  coverageRadius, cyclePhase, openIncidents, openLimit, updateIncidents,
} from '../src/systems/incidents.js';
import { spawnPatient } from '../src/systems/medical.js';
import { CONFIG } from '../src/core/config.js';

function quietGame() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  return state;
}

/** Buildings nearest the station, so a route always exists. */
function nearBuildings(state, count = 1) {
  const st = state.city.station;
  return state.buildings
    .filter((b) => b.type !== 'station' && b.type !== 'hospital')
    .sort((a, b) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(b.x - st.x, b.y - st.y))
    .slice(0, count);
}

// ------------------------------------------------------------ the D key ---

test('D sends the selected engine to a building where someone is trapped but nothing burns', () => {
  const state = quietGame();
  const [building] = nearBuildings(state);
  building.trapped = 2;
  selectUnit(state, state.engines[0].id);

  assert.equal(commandDispatch(state), true);
  assert.equal(state.engines[0].targetId, building.id);
  assert.ok(state.engines[0].path.length > 0, 'the engine did not set off');
});

test('D works from a selected firefighter too', () => {
  const state = quietGame();
  const [building] = nearBuildings(state);
  building.trapped = 1;
  selectUnit(state, state.crew[0].id);

  assert.equal(commandDispatch(state), true);
  assert.equal(state.engines[0].targetId, building.id);
});


// A forest tile a street reaches: the middle one of those within eight tiles of a road.
function forestTileByRoad(state) {
  const near = state.city.forestTiles.filter((t) => nearestPassable(state.nav, 'drive', t.x, t.y, 8));
  return near[Math.floor(near.length / 2)];
}

test('D sends the selected engine to a forest fire when no building is alight', () => {
  const state = quietGame();
  const tile = forestTileByRoad(state);
  startWildfire(state, (tile.x + 0.5) * 32, (tile.y + 0.5) * 32, 2200);
  selectUnit(state, state.engines[0].id);

  assert.equal(commandDispatch(state), true);
  const engine = state.engines[0];
  assert.ok(engine.path.length > 0 || engine.wildfireId, 'the engine did not respond');
});

test('D with a building selected goes to that building, not the most urgent fire', () => {
  const state = quietGame();
  const [first, second] = nearBuildings(state, 2);
  ignite(state, first, 'test');
  ignite(state, second, 'test');
  first.fire = 0.9; // the most urgent
  second.fire = 0.2;
  selectBuilding(state, second.id);

  assert.equal(commandDispatch(state), true);
  assert.equal(state.engines[0].targetId, second.id);
});

test('D still says the district is quiet when there is nothing to do', () => {
  const state = quietGame();
  selectUnit(state, state.engines[0].id);
  assert.equal(commandDispatch(state), false);
  assert.match(state.events[0].text, /quiet/);
});

test('an engine that arrives at a trapped-person call sends its crew out', () => {
  const state = quietGame();
  const [building] = nearBuildings(state);
  building.trapped = 1;
  selectUnit(state, state.engines[0].id);
  commandDispatch(state);

  for (let i = 0; i < 30 * 90; i++) update(state, 1 / 30);

  const crewOut = state.crew.some((c) => !c.riding);
  assert.equal(crewOut || building.trapped === 0, true, 'nobody got out to help');
});

// ----------------------------------------------- the incident build-up ---

test('the build-up resets: the radius and the cap return to their start every cycle', () => {
  const state = quietGame();
  const { cycle } = CONFIG.incidents;

  state.time = 5;
  const startRadius = coverageRadius(state);
  const startLimit = openLimit(state);

  state.time = cycle - 5;
  assert.ok(coverageRadius(state) > startRadius + 100, 'the radius did not grow through the cycle');
  assert.ok(openLimit(state) > startLimit, 'the cap did not grow through the cycle');

  state.time = cycle + 5;
  assert.equal(cyclePhase(state).index, 1);
  assert.ok(Math.abs(coverageRadius(state) - startRadius) < 2, 'the radius did not reset');
  assert.equal(openLimit(state), startLimit);

  // However long the shift runs, it never exceeds the peak of a cycle.
  state.time = cycle * 40 + cycle - 1;
  const peak = CONFIG.incidents.radius.start + cycle * CONFIG.incidents.radius.growPerSecond;
  assert.ok(coverageRadius(state) <= peak);
  assert.ok(openLimit(state) <= CONFIG.incidents.maxOpen[1]);
});

test('when the cycle turns over there is a breather before the next call', () => {
  const state = createGame(7);
  startShift(state);
  const { cycle, breather } = CONFIG.incidents;
  state.time = cycle - 0.01;
  state.nextCallAt = 5;
  updateIncidents(state, 0.001); // records the cycle we are in
  state.time = cycle + 0.01;
  updateIncidents(state, 0.001);

  assert.ok(state.nextCallAt > breather - 1, `next call in ${state.nextCallAt}s`);
  assert.equal(state.buildings.some((b) => b.state === 'burning'), false);
});

test('no new call arrives while too many incidents are already open', () => {
  const state = createGame(7);
  startShift(state);
  state.time = 10;
  const limit = openLimit(state);

  // Fill the board with injured people up to the limit.
  const [building] = nearBuildings(state);
  for (let i = 0; i < limit; i++) spawnPatient(state, building, 0.2);
  assert.ok(openIncidents(state) >= limit);

  const patients = state.patients.length;
  const burning = () => state.buildings.filter((b) => b.state === 'burning').length;
  for (let n = 0; n < 8; n++) {
    state.nextCallAt = 0;
    updateIncidents(state, 0.001);
  }
  assert.equal(burning(), 0, 'a fire was started over the cap');
  assert.equal(state.patients.length, patients, 'a patient was added over the cap');
  assert.equal(state.wildfires.length, 0);
});

test('only a few incidents are ever open at once over a long shift with nobody responding', () => {
  const state = createGame(7);
  startShift(state);
  let worst = 0;
  // Two cycles of an unattended city (steps of 0.5 s keep it quick).
  for (let t = 0; t < CONFIG.incidents.cycle * 2; t += 0.5) {
    updateIncidents(state, 0.5);
    state.time += 0.5;
    worst = Math.max(worst, openIncidents(state));
  }
  // A major incident or a crash can add a few at once, but nothing like a flood.
  assert.ok(worst <= CONFIG.incidents.maxOpen[1] + 5, `${worst} incidents open at once`);
});
