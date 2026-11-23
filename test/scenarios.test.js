import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startShift, update, commandBuyVehicle, commandLoan, serialize, loadState, commandDispatchAll,
} from '../src/systems/game.js';
import { createScenarioGame, createCareer } from '../src/systems/modes.js';
import {
  CHALLENGES, deleteScenarioFrom, findChallenge, newScenarioTemplate, restoreScenarios, saveScenarioTo,
  validateScenario,
} from '../src/data/scenarios.js';
import { scenarioProgress, scenarioScore } from '../src/systems/challenges.js';
import { hydrantInReach } from '../src/systems/units.js';
import { CONFIG, TILE } from '../src/core/config.js';

const play = (def) => {
  const state = createScenarioGame(def);
  startShift(state);
  return state;
};

test('the eight built-in challenges are valid and cover the roadmap list', () => {
  assert.equal(CHALLENGES.length, 8);
  assert.equal(new Set(CHALLENGES.map((c) => c.id)).size, 8);
  for (const c of CHALLENGES) {
    const v = validateScenario(c);
    assert.equal(v.ok, true, `${c.id}: ${v.errors.join('; ')}`);
    assert.ok(c.text.length > 20);
  }
  const names = CHALLENGES.map((c) => c.name);
  for (const n of ['One Engine Only', 'No Water Supply', 'Night Emergency', 'Highway Disaster', 'Forest Under Siege', 'Budget Crisis', 'Mass Casualty', 'Industrial Emergency']) {
    assert.ok(names.includes(n), n);
  }
});

test('every challenge sets up its own conditions: fleet, money, time, weather, rules', () => {
  for (const def of CHALLENGES) {
    const state = play(def);
    assert.equal(state.mode, 'challenge');
    assert.equal(state.engines.length, def.start.fleet.length, def.id);
    assert.deepEqual(state.engines.map((e) => e.type).sort(), def.start.fleet.map((f) => f.type).sort(), def.id);
    assert.equal(state.credits, def.start.credits);
    assert.equal(Math.round(state.clock), def.start.clock);
    assert.equal(state.incidentsEnabled, Boolean(def.rules.random));
    assert.equal(Boolean(state.rules.noHydrants), Boolean(def.rules.noHydrants));
    assert.ok(state.crew.length > 0 || def.start.fleet.every((f) => CONFIG.vehicles[f.type].crew === 0));
    assert.ok(state.engines.every((e) => e.hotkey), 'every vehicle has a key');
  }
  const night = play(findChallenge('night'));
  assert.equal(Math.round(night.clock / 60), 22);
  const siege = play(findChallenge('forest-siege'));
  assert.equal(siege.weather.kind, 'heat');
  assert.ok(Math.abs(siege.wind.speed - 0.9) < 1e-9);
  assert.equal(siege.rules.windLock, true);
});

test('the rules bite: no hydrants, no loans, no purchases', () => {
  const water = play(findChallenge('no-water'));
  const engine = water.engines[0];
  const h = water.city.hydrants[0];
  engine.x = (h.x + 0.5) * TILE;
  engine.y = (h.y + 0.5) * TILE;
  assert.equal(hydrantInReach(water, engine), null, 'the mains are dead');

  const quick = play(findChallenge('one-engine'));
  const q = quick.engines[0];
  q.x = (h.x + 0.5) * TILE;
  q.y = (h.y + 0.5) * TILE;
  assert.ok(hydrantInReach(quick, q), 'hydrants work elsewhere');

  const budget = play(findChallenge('budget-crisis'));
  assert.equal(commandLoan(budget), false);
  assert.equal(budget.loan, 0);

  const custom = { ...newScenarioTemplate(), rules: { noBuy: true, random: false, randomRate: 1 } };
  const v = validateScenario(custom);
  const locked = play(v.scenario);
  locked.credits = 99999;
  assert.equal(commandBuyVehicle(locked, 'engine'), null);
});

test('scripted incidents start at their times, in the same places every replay', () => {
  const def = findChallenge('no-water');
  const a = play(def);
  const b = play(def);
  assert.equal(a.buildings.some((x) => x.state === 'burning'), false, 'nothing before the script');
  for (const s of [a, b]) for (let i = 0; i < 60 * 12; i++) update(s, 1 / 60);
  const fireA = a.buildings.find((x) => x.state === 'burning');
  const fireB = b.buildings.find((x) => x.state === 'burning');
  assert.ok(fireA && fireB);
  assert.equal(fireA.id, fireB.id, 'the same building on a replay');
  assert.equal(fireA.type, 'warehouse');
  assert.equal(scenarioProgress(a).started, 1);
  for (const s of [a]) for (let i = 0; i < 60 * 150; i++) update(s, 1 / 60);
  assert.equal(scenarioProgress(a).started, 2);
});

test('a custom scenario is played, won when everything is resolved, and scored', () => {
  const t = newScenarioTemplate();
  t.name = 'Small test';
  t.start.fleet = [{ type: 'engine', station: 0 }, { type: 'engine', station: 0 }, { type: 'ambulance', station: 0 }];
  t.incidents = [{ at: 3, kind: 'building-fire', location: { kind: 'type', type: 'house' }, intensity: 0.15, trapped: 0, injured: 1 }];
  t.timeLimit = 900;
  const v = validateScenario(t);
  assert.equal(v.ok, true, v.errors.join('; '));
  const state = play(v.scenario);
  let dispatched = false;
  for (let i = 0; i < 60 * 800 && !state.scenario.result; i++) {
    update(state, 1 / 60);
    if (!dispatched && state.buildings.some((b) => b.state === 'burning')) {
      dispatched = true;
      commandDispatchAll(state);
    }
    if (dispatched && i % 120 === 0) commandDispatchAll(state);
  }
  const result = state.scenario.result;
  assert.ok(result, 'the scenario finished');
  assert.equal(result.status, 'won', result.reasons.join('; '));
  assert.ok(result.score > 800);
  assert.equal(state.over, true);
  assert.equal(scenarioProgress(state).result.status, 'won');
});

test('failure and time-limit conditions end a challenge', () => {
  const one = play(findChallenge('one-engine'));
  for (let i = 0; i < 60; i++) update(one, 1 / 60);
  one.stats.casualties = 7;
  for (let i = 0; i < 60; i++) update(one, 1 / 60);
  assert.equal(one.scenario.result.status, 'lost');
  assert.match(one.scenario.result.reasons[0], /died/);
  assert.equal(one.over, true);

  const survive = play(findChallenge('one-engine'));
  survive.incidentsEnabled = false;
  survive.time = 599.9;
  survive.stats.casualties = 2;
  for (let i = 0; i < 60; i++) update(survive, 1 / 60);
  assert.equal(survive.scenario.result.status, 'won');

  const bad = play(findChallenge('night'));
  bad.incidentsEnabled = false;
  bad.time = 599.9;
  for (let i = 0; i < 60; i++) update(bad, 1 / 60);
  assert.equal(bad.scenario.result.status, 'lost', 'surviving is not enough: it needs four fires out');
  assert.match(bad.scenario.result.reasons.join(' '), /fires put out/);

  const money = play(findChallenge('budget-crisis'));
  money.incidentsEnabled = false;
  money.credits = -4000;
  for (let i = 0; i < 60; i++) update(money, 1 / 60);
  assert.equal(money.scenario.result.status, 'lost');

  const siege = play(findChallenge('forest-siege'));
  siege.stats.lost = 7;
  for (let i = 0; i < 60; i++) update(siege, 1 / 60);
  assert.equal(siege.scenario.result.status, 'lost');
});

test('the score rewards saving and punishes losses and a lost game', () => {
  const state = play(findChallenge('one-engine'));
  const base = scenarioScore(state, true);
  state.stats.saved = 5;
  const better = scenarioScore(state, true);
  assert.ok(better > base);
  state.stats.casualties = 2;
  assert.ok(scenarioScore(state, true) < better);
  assert.ok(scenarioScore(state, false) < scenarioScore(state, true));
  assert.ok(scenarioScore(state, false) >= 0);
});

test('a scenario in progress saves and loads, in its own mode', () => {
  const state = play(findChallenge('no-water'));
  for (let i = 0; i < 60 * 15; i++) update(state, 1 / 60);
  const data = JSON.parse(JSON.stringify(serialize(state)));
  const loaded = loadState(data);
  assert.equal(loaded.mode, 'challenge');
  assert.equal(loaded.scenario.def.id, 'no-water');
  assert.equal(loaded.rules.noHydrants, true);
  assert.equal(scenarioProgress(loaded).started, 1);
  assert.equal(loaded.engines.length, state.engines.length);
  for (let i = 0; i < 60 * 5; i++) update(loaded, 1 / 60);
  assert.ok(loaded.time > state.time);
  assert.equal(loaded.campaign, null, 'a challenge has no career');

  // A career shift is unaffected by playing challenges.
  const career = createCareer({ name: 'Safe' });
  assert.equal(career.mode, 'career');
  assert.equal(career.rules.noHydrants ?? false, false);
});

// ------------------------------------------------------------- validation ---

test('scenario validation refuses every kind of bad configuration', () => {
  const ok = () => JSON.parse(JSON.stringify(newScenarioTemplate()));
  const refused = (mutate, text) => {
    const t = ok();
    mutate(t);
    const v = validateScenario(t, { buildings: [{ id: 'b1' }] });
    assert.equal(v.ok, false, text);
    assert.ok(v.errors.some((e) => e.toLowerCase().includes(text.toLowerCase())), `${text}: got ${v.errors.join('; ')}`);
  };
  assert.equal(validateScenario(ok()).ok, true);
  assert.equal(validateScenario(null).ok, false);
  refused((t) => { t.name = '  '; }, 'name');
  refused((t) => { t.name = 'x'.repeat(41); }, 'too long');
  refused((t) => { t.start.fleet = []; }, 'at least one vehicle');
  refused((t) => { t.start.fleet = [{ type: 'ufo', station: 0 }]; }, 'Unknown vehicle');
  refused((t) => { t.start.fleet = [{ type: 'fireboat', station: 2 }]; }, 'Boats');
  refused((t) => { t.start.fleet = Array.from({ length: 17 }, () => ({ type: 'engine', station: 0 })); }, 'at most 16');
  refused((t) => { t.start.weather = 'meteors'; }, 'weather');
  refused((t) => { t.start.windSpeed = 4; }, 'wind strength');
  refused((t) => { t.start.windDir = 400; }, 'wind direction');
  refused((t) => { t.start.credits = -5; }, 'credits');
  refused((t) => { t.start.clock = 2000; }, 'start time');
  refused((t) => { t.timeLimit = 5; }, 'time limit');
  refused((t) => { t.incidents[0].kind = 'alien'; }, 'unknown type');
  refused((t) => { t.incidents[0].intensity = 3; }, 'intensity');
  refused((t) => { t.incidents[0].trapped = 99; }, 'trapped');
  refused((t) => { t.incidents[0].trapped = 1.5; }, 'trapped');
  refused((t) => { t.incidents[0].injured = -1; }, 'injured');
  refused((t) => { t.incidents[0].at = 700; }, 'after the time limit');
  refused((t) => { t.incidents[0].location = { kind: 'type', type: 'castle' }; }, 'building type');
  refused((t) => { t.incidents[0].location = { kind: 'building', buildingId: 'nope' }; }, 'does not exist');
  refused((t) => { t.incidents[0].location = { kind: 'moon' }; }, 'location kind');
  refused((t) => { t.incidents[0] = { ...t.incidents[0], kind: 'scene', scene: 'zzz' }; }, 'unknown scene');
  refused((t) => { t.incidents[0] = { ...t.incidents[0], kind: 'disaster', disaster: 'zzz' }; }, 'unknown disaster');
  refused((t) => { t.incidents = []; }, 'add an incident');
  refused((t) => { t.success = {}; }, 'success condition');
  refused((t) => { t.success = { surviveTime: true }; t.timeLimit = null; }, 'time limit');
  refused((t) => { t.incidents = Array.from({ length: 21 }, () => ({ at: 1, kind: 'crash', location: { kind: 'auto' }, intensity: 0.3, trapped: 0, injured: 0 })); }, 'at most 20');
  // Random calls alone are a valid scenario if the player can survive the clock.
  const survival = ok();
  survival.incidents = [];
  survival.rules.random = true;
  survival.success = { surviveTime: true, maxCasualties: 2 };
  assert.equal(validateScenario(survival).ok, true);
  // A building location is accepted when the building exists.
  const located = ok();
  located.incidents[0].location = { kind: 'building', buildingId: 'b1' };
  assert.equal(validateScenario(located, { buildings: [{ id: 'b1' }] }).ok, true);
});

test('custom scenarios can be saved, edited, listed and deleted without touching the built-ins', () => {
  let list = [];
  const a = saveScenarioTo(list, { ...newScenarioTemplate(), name: 'Alpha' });
  assert.equal(a.ok, true);
  list = a.list;
  assert.equal(list.length, 1);
  assert.ok(list[0].id.startsWith('custom-'));
  assert.equal(list[0].builtin, false);

  const dup = saveScenarioTo(list, { ...newScenarioTemplate(), name: 'alpha' });
  assert.equal(dup.ok, false);
  assert.equal(dup.list.length, 1, 'a refused save changes nothing');

  const edited = saveScenarioTo(list, { ...list[0], name: 'Alpha 2', timeLimit: 300 });
  assert.equal(edited.ok, true);
  assert.equal(edited.list.length, 1);
  assert.equal(edited.list[0].name, 'Alpha 2');
  assert.equal(edited.list[0].timeLimit, 300);

  const bad = saveScenarioTo(edited.list, { ...list[0], timeLimit: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.list[0].timeLimit, 300);

  const b = saveScenarioTo(edited.list, { ...newScenarioTemplate(), name: 'Beta' });
  assert.equal(b.list.length, 2);
  assert.equal(deleteScenarioFrom(b.list, b.list[0].id).length, 1);
  assert.equal(CHALLENGES.length, 8, 'built-ins untouched');
  assert.equal(restoreScenarios(JSON.parse(JSON.stringify(b.list))).length, 2);
  assert.equal(restoreScenarios('garbage').length, 0);

  // A loaded custom scenario plays.
  const state = play(b.list[1]);
  assert.equal(state.mode, 'challenge');
  assert.equal(state.scenario.def.name, 'Beta');
});
