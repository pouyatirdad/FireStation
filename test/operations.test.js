import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle,
} from '../src/systems/game.js';
import { ignite } from '../src/systems/fire.js';
import { spawnPatient } from '../src/systems/medical.js';
import { startWildfire } from '../src/systems/wildfire.js';
import {
  applyPreset, availableVehicles, cancelDispatch, createPreset, defaultPresets, deletePreset,
  nearestStations, planPreset, recommendedPresets, redirectDispatch, updatePreset, validatePreset,
} from '../src/systems/presets.js';
import { engineEta, estimate, formatEta, incidentEtas } from '../src/systems/eta.js';
import { buildReport, gradeOf, scoreShift } from '../src/systems/report.js';
import { incidentIntel } from '../src/systems/intel.js';
import { addBlockade } from '../src/systems/blockades.js';
import { CONFIG, TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 200000;
  return state;
}

const buy = (state, type, n = 1) => {
  for (let i = 0; i < n; i++) assert.ok(commandBuyVehicle(state, type), type);
};

/** A house a fair way from the station. */
function farBuilding(state, minTiles = 18, maxTiles = 60, skip = []) {
  const st = state.city.station;
  return state.buildings.find((b) => ['house', 'shop', 'apartment', 'office'].includes(b.type) && b.state === 'ok' && !skip.includes(b.id)
    && Math.hypot(b.x - st.x, b.y - st.y) >= minTiles && Math.hypot(b.x - st.x, b.y - st.y) <= maxTiles);
}

// -------------------------------------------------------------- presets ---

test('the default presets are valid, and one of them is the building-fire response', () => {
  const presets = defaultPresets();
  for (const p of presets) assert.equal(validatePreset(p, []).ok, true, p.name);
  const fire = presets.find((p) => p.incident === 'fire');
  assert.deepEqual(fire.units, { engine: 2, ladder: 1, ambulance: 1, rescue: 1 });
});

test('presets can be created, edited and deleted, and bad ones are refused', () => {
  const state = shift();
  const n = state.presets.length;
  const made = createPreset(state, { name: 'Small fire', incident: 'fire', units: { engine: 1, ambulance: 1 } });
  assert.equal(made.ok, true);
  assert.equal(state.presets.length, n + 1);

  assert.equal(createPreset(state, { name: 'small fire', incident: 'fire', units: { engine: 1 } }).ok, false, 'duplicate name');
  assert.equal(createPreset(state, { name: '', units: { engine: 1 } }).ok, false, 'no name');
  assert.equal(createPreset(state, { name: 'X', units: {} }).ok, false, 'no vehicles');
  assert.equal(createPreset(state, { name: 'X', units: { spaceship: 1 } }).ok, false, 'unknown vehicle');
  assert.equal(createPreset(state, { name: 'X', units: { engine: 99 } }).ok, false, 'too many');
  assert.equal(createPreset(state, { name: 'X', units: { engine: 8, ladder: 8 } }).ok, false, 'too many in total');

  const id = made.preset.id;
  assert.equal(updatePreset(state, id, { name: 'Small fire+', incident: 'fire', units: { engine: 2 } }).ok, true);
  assert.equal(state.presets.find((p) => p.id === id).units.engine, 2);
  assert.equal(deletePreset(state, id), true);
  assert.equal(state.presets.length, n);
  assert.equal(deletePreset(state, id), false);
});

test('a preset sends the whole combination to a fire, and pressing it twice sends nothing more', () => {
  const state = shift();
  buy(state, 'engine', 2); // three engines
  buy(state, 'ladder');
  buy(state, 'ambulance');
  buy(state, 'rescue');
  const b = farBuilding(state);
  ignite(state, b, 'test');
  const preset = state.presets.find((p) => p.incident === 'fire');

  const first = applyPreset(state, preset.id, { kind: 'building', id: b.id });
  assert.equal(first.sent, 5);
  assert.equal(first.warnings.length, 0);
  // Four fire vehicles go to the building; the ambulance stands by near it.
  assert.equal(state.engines.filter((e) => e.targetId === b.id).length, 4);
  const amb = state.engines.find((e) => e.type === 'ambulance');
  assert.equal(amb.standbyFor.id, b.id);
  assert.ok(amb.path.length > 0, 'the ambulance is moving');

  const again = applyPreset(state, preset.id, { kind: 'building', id: b.id });
  assert.equal(again.sent, 0, 'no duplicate orders');
  assert.equal(again.already.length, 5);
  assert.equal(state.engines.filter((e) => e.targetId === b.id).length, 4);
});

test('a preset says what is missing instead of failing silently', () => {
  const state = shift(); // one engine only
  const b = farBuilding(state);
  ignite(state, b, 'test');
  const preset = state.presets.find((p) => p.incident === 'fire');
  const plan = planPreset(state, preset, { kind: 'building', id: b.id });
  assert.equal(plan.assignments.length, 1);
  assert.deepEqual(plan.missing, { engine: 1, ladder: 1, ambulance: 1, rescue: 1 });
  assert.ok(plan.warnings.some((w) => w.includes('No Ladder in the fleet')));
  const sent = applyPreset(state, preset.id, { kind: 'building', id: b.id });
  assert.equal(sent.sent, 1);
  assert.ok(state.events.some((e) => e.tone === 'warn' && e.text.startsWith('Dispatch:')));
});

test('a preset picks the vehicles that arrive soonest, and the nearest station is reported', () => {
  const state = shift();
  buy(state, 'engine', 2);
  // Move one engine right next to the fire: it should be the one chosen.
  const b = farBuilding(state);
  ignite(state, b, 'test');
  const near = state.engines[2];
  near.x = (b.x - 3) * TILE;
  near.y = (b.y + b.h / 2) * TILE;
  const plan = planPreset(state, { name: 't', units: { engine: 1 } }, { kind: 'building', id: b.id });
  assert.equal(plan.assignments[0].engine.id, near.id);
  assert.ok(plan.station && plan.station.name);
  assert.equal(nearestStations(state, b.x * TILE, b.y * TILE)[0].index, 0);
  assert.equal(availableVehicles(state).engine, 3);
});

test('a dispatch can be called off or redirected', () => {
  const state = shift();
  buy(state, 'engine');
  const a = farBuilding(state);
  const c = farBuilding(state, 18, 70, [a.id]);
  ignite(state, a, 'test');
  ignite(state, c, 'test');
  const preset = { name: 't', incident: 'fire', units: { engine: 1 } };
  state.presets.push({ ...preset, id: 'p-t' });
  applyPreset(state, 'p-t', { kind: 'building', id: a.id });
  const engine = state.engines.find((e) => e.targetId === a.id);
  assert.ok(engine);

  assert.equal(redirectDispatch(state, engine.id, { kind: 'building', id: c.id }), true);
  assert.equal(engine.targetId, c.id);
  assert.equal(cancelDispatch(state, engine.id), true);
  assert.equal(engine.targetId, null);
  assert.equal(cancelDispatch(state, engine.id), false, 'nothing left to cancel');
});

test('recommended presets follow the incident kind', () => {
  const state = shift();
  const wf = startWildfire(state, 100 * TILE, 100 * TILE, 1000);
  const rec = recommendedPresets(state, { kind: 'wildfire', id: wf.id });
  assert.ok(rec.length >= 1 && rec.every((p) => p.incident === 'wildfire' || p.incident === 'any'));
  const b = farBuilding(state);
  b.hazmat = true;
  ignite(state, b, 'test');
  assert.ok(recommendedPresets(state, { kind: 'building', id: b.id }).some((p) => p.incident === 'hazmat'));
});

// ------------------------------------------------------------------ eta ---

test('ETA is the length of the real route over the vehicle speed, and follows traffic', () => {
  const state = shift();
  const b = farBuilding(state, 30, 70);
  const engine = state.engines[0];
  const x = (b.x + b.w / 2) * TILE;
  const y = (b.y + b.h / 2) * TILE;
  state.trafficFactor = 1;
  const free = estimate(state, engine, x, y);
  assert.ok(free.reachable);
  const straight = Math.hypot(engine.x - x, engine.y - y);
  assert.ok(free.length >= straight * 0.95, 'a route is never shorter than the straight line');
  assert.ok(Math.abs(free.seconds - free.length / (engine.spec.speed * TILE)) < 0.01);

  state.trafficFactor = CONFIG.traffic.rushFactor;
  engine.etaCache = null;
  const rush = estimate(state, engine, x, y);
  assert.ok(rush.seconds > free.seconds * 1.2, 'rush hour lengthens the ETA');
  assert.equal(formatEta(75), '1:15');
  assert.equal(formatEta(Infinity), '—');
});

test('a vehicle on its way shows an ETA that shrinks, and the incident lists its responders', () => {
  const state = shift();
  buy(state, 'engine');
  const b = farBuilding(state, 25, 60);
  ignite(state, b, 'test');
  const preset = { id: 'p', name: 'p', incident: 'fire', units: { engine: 2 } };
  state.presets.push(preset);
  applyPreset(state, 'p', { kind: 'building', id: b.id });
  const [first] = incidentEtas(state, 'building', b.id);
  assert.ok(first && first.seconds > 5);
  assert.equal(incidentEtas(state, 'building', b.id).length, 2);
  for (let i = 0; i < 600; i++) update(state, 1 / 60);
  const later = engineEta(state, first.engine);
  assert.ok(later == null || later < first.seconds - 5, 'ETA fell as it drove');
});

test('a blocked road changes the route and the ETA is recomputed', () => {
  const state = shift();
  const b = farBuilding(state, 30, 70);
  const engine = state.engines[0];
  const x = (b.x + b.w / 2) * TILE;
  const y = (b.y + b.h / 2) * TILE;
  const before = estimate(state, engine, x, y);
  // Put a wreck on a street tile of the planned route, well along it.
  const mid = before.points[Math.floor(before.points.length / 2)];
  addBlockade(state, { tx: Math.floor(mid.x / TILE), ty: Math.floor(mid.y / TILE), tw: 2, th: 2 }, { name: 'test wreck', reward: 0 });
  const after = estimate(state, engine, x, y);
  assert.ok(after.reachable);
  assert.notEqual(after.length, before.length);
});

// --------------------------------------------------------------- report ---

test('the report tracks incidents from start to end, with response times', () => {
  const state = shift();
  const b = farBuilding(state, 15, 50);
  ignite(state, b, 'test');
  update(state, 0.3);
  assert.equal(Object.keys(state.report.open).length >= 1, true);
  const preset = { id: 'p', name: 'p', incident: 'fire', units: { engine: 1 } };
  state.presets.push(preset);
  applyPreset(state, 'p', { kind: 'building', id: b.id });
  for (let i = 0; i < 60 * 240 && b.state === 'burning'; i++) update(state, 1 / 60);
  update(state, 0.5);
  assert.notEqual(b.state, 'burning', 'the fire was dealt with');
  const report = buildReport(state);
  assert.equal(report.incidents.resolved, 1);
  assert.ok(report.response.average > 0, 'response time recorded');
  assert.equal(report.vehicles[0].name, state.engines[0].name);
  assert.equal(report.vehicles[0].resolved, 1);
  assert.equal(report.stations[0].resolved, 1);
  assert.ok(report.money.income > 0);
  assert.ok(['S', 'A', 'B', 'C', 'D'].includes(report.rating.grade));
});

test('a lost building and a death count as failed and pull the grade down', () => {
  const state = shift();
  const b = farBuilding(state);
  ignite(state, b, 'test');
  update(state, 0.3);
  const good = buildReport(state);
  b.state = 'rubble';
  state.stats.lost += 1;
  state.stats.casualties += 2;
  update(state, 0.3);
  const bad = buildReport(state);
  assert.equal(bad.incidents.failed, 1);
  assert.equal(bad.people.fatalities, 2);
  assert.equal(bad.buildings.destroyed, 1);
  assert.ok(bad.rating.score < good.rating.score);
});

test('the grade weighs several things, not only speed', () => {
  const perfect = { resolution: 1, response: 1, safety: 1, property: 1, finance: 1 };
  assert.equal(gradeOf(scoreShift(perfect)), 'S');
  // Fast but deadly.
  const fastDeadly = scoreShift({ ...perfect, safety: 0, property: 0.3 });
  // Slow but clean.
  const slowClean = scoreShift({ ...perfect, response: 0 });
  assert.ok(slowClean > fastDeadly);
  assert.equal(gradeOf(scoreShift({ resolution: 0, response: 0, safety: 0, property: 0, finance: 0 })), 'D');
  assert.equal(gradeOf(89), 'A');
  assert.equal(gradeOf(61), 'C');
});

// ---------------------------------------------------------------- intel ---

test('incident intelligence is derived from the incident and never contradicts itself', () => {
  const state = shift();
  const b = farBuilding(state);
  b.hazmat = true;
  b.trapped = 3;
  ignite(state, b, 'test');
  b.fire = 0.6;
  b.trapped = 3;
  const intel = incidentIntel(state, 'building', b.id);
  assert.equal(intel.trapped.count, 3);
  assert.ok(intel.trapped.text.includes('3'));
  assert.equal(intel.explosion.level, 'high', 'a hot chemical fire can explode');
  assert.ok(intel.secondary.some((s) => s.includes('Toxic smoke')));
  assert.ok(intel.equipment.some((e) => e.includes('Hazmat')));
  assert.ok(intel.equipment.some((e) => e.includes('Rescue')));
  assert.ok(['Severe', 'Extreme', 'High'].includes(intel.severity.label));
  assert.ok(intel.environment.wind && intel.environment.daylight && intel.environment.traffic);
  assert.ok(intel.recommended.includes('Hazmat incident'));

  // A utility cut lowers the explosion risk and the same card says why.
  b.utilityCut = true;
  const cut = incidentIntel(state, 'building', b.id);
  assert.equal(cut.explosion.level, 'low');
  assert.ok(cut.explosion.why.includes('cut'));

  // A quiet building has no fire, no explosion and nobody inside.
  const calm = farBuilding(state, 18, 90, [b.id]);
  const quiet = incidentIntel(state, 'building', calm.id);
  assert.equal(quiet.explosion.level, 'none');
  assert.equal(quiet.trapped.count, 0);
  assert.equal(incidentIntel(state, 'building', 'nonexistent'), null);
});

test('intel covers forest fires, patients, people in the water and wrecks', () => {
  const state = shift();
  const wf = startWildfire(state, 100 * TILE, 100 * TILE, 1000);
  assert.ok(incidentIntel(state, 'wildfire', wf.id).equipment.some((e) => e.includes('Air support')));
  const b = farBuilding(state);
  const p = spawnPatient(state, b, 0.9);
  const pi = incidentIntel(state, 'patient', p.id);
  assert.ok(pi.title.includes('Critical'));
  assert.ok(pi.secondary.some((s) => s.includes('hospital')));
  const w = addBlockade(state, { tx: 80, ty: 80, tw: 2, th: 2 }, { name: 'Wreck', reward: 0 });
  assert.ok(incidentIntel(state, 'blockade', w.id));
});
