import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, commandDispatch, orderEngine } from '../src/systems/game.js';
import { ignite, updateFire, fireResistance, fireDifficulty } from '../src/systems/fire.js';
import { CONFIG } from '../src/core/config.js';

const step = (state, seconds, dt = 1 / 30) => {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) update(state, dt);
};

test('a fire grows, damages the building and is finally put out by water', () => {
  const state = createGame(11);
  state.running = true;
  const building = state.buildings.find((b) => b.type === 'warehouse');
  ignite(state, building, 'test');
  assert.equal(building.state, 'burning');

  for (let i = 0; i < 300; i++) updateFire(state, 1 / 30);
  assert.ok(building.fire > 0.2, `fire only reached ${building.fire.toFixed(2)}`);
  assert.ok(building.integrity < building.maxIntegrity, 'fire did no damage');

  // Three crew streams on it, for as long as it takes.
  let seconds = 0;
  while (building.state === 'burning' && seconds < 60) {
    state.streams = [
      { targetId: building.id, power: 0.035 },
      { targetId: building.id, power: 0.035 },
      { targetId: building.id, power: 0.035 },
    ];
    updateFire(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.equal(building.state, 'out');
  assert.equal(state.stats.saved, 1);
  assert.ok(state.rating >= 100);
});

test('an unattended building is lost, and the city rating drops with it', () => {
  const state = createGame(12);
  state.running = true;
  const building = state.buildings.find((b) => b.type === 'house');
  building.occupants = 0; // isolate the structural loss from casualties
  ignite(state, building, 'test');
  const ratingBefore = state.rating;

  for (let i = 0; i < 30 * 240 && building.state === 'burning'; i++) updateFire(state, 1 / 30);
  assert.equal(building.state, 'rubble');
  assert.equal(state.stats.lost, 1);
  assert.equal(state.rating, ratingBefore - CONFIG.rating.perLost);
  assert.ok(building.integrity <= 0);
});

test('fire spreads to a neighbouring building', () => {
  const state = createGame(13);
  state.running = true;
  // An office with a neighbour close enough to catch.
  const close = (a, b) => Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < (a.w + b.w) / 2 + 2 && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < (a.h + b.h) / 2 + 2;
  const source = state.buildings.find((b) => b.type === 'office' && state.buildings.some((o) => o !== b && o.type !== 'station' && close(b, o)));
  source.integrity = 100000; // hold the source open while the spread is tested
  source.fire = 0.95;
  ignite(state, source, 'test');
  source.integrity = 100000;

  let spread = false;
  for (let i = 0; i < 30 * 180 && !spread; i++) {
    updateFire(state, 1 / 30);
    spread = state.buildings.some((b) => b !== source && b.state === 'burning');
  }
  assert.ok(spread, 'fire never jumped to a neighbour');
});

test('the shift clock runs while the game is running', () => {
  const state = createGame(14);
  startShift(state);
  const before = state.clock;
  step(state, 10);
  assert.ok(state.clock > before);
  assert.equal(state.over, false);
});

test('dispatch sends the engine, deploys the crew and puts the fire out', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  const st = state.city.station;
  const target = state.buildings
    .filter((b) => b.type === 'house' && b.y > 20)
    .sort((a, b) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(b.x - st.x, b.y - st.y))[0];
  ignite(state, target, 'test');

  assert.equal(commandDispatch(state, target.id), true);
  let seconds = 0;
  while (target.state === 'burning' && seconds < 240) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }

  assert.equal(target.state, 'out', `fire still burning after ${seconds.toFixed(0)}s`);
  assert.ok(state.stats.saved >= 1);
  assert.ok(state.crew.some((c) => !c.riding), 'crew never left the engine');
  assert.ok(state.engines[0].water < state.engines[0].capacity, 'no water was used');
});

test('the engine never drives through a building and stops beside the target', () => {
  const state = createGame(7);
  startShift(state);
  const target = state.buildings.find((b) => b.type === 'shop');
  orderEngine(state, state.engines[0], (target.x + target.w / 2) * 32, (target.y + target.h / 2) * 32, target.id);

  for (let i = 0; i < 30 * 30; i++) {
    update(state, 1 / 30);
    const tileX = Math.floor(state.engines[0].x / 32);
    const tileY = Math.floor(state.engines[0].y / 32);
    const i = tileY * state.city.w + tileX;
    assert.ok(!state.city.blocked[i] && !state.city.water[i] && !state.city.woods[i], `engine drove into a building, the water or the woods at ${tileX},${tileY}`);
    if (state.engines[0].path.length === 0 && state.engines[0].arrived) break;
  }
  assert.equal(state.engines[0].arrived, true, 'engine never arrived');
});

// ----------------------------------------------------- how hard a fire is ---

function bySize(state, cls, types = null) {
  return state.buildings.find((b) => b.sizeClass === cls && b.state === 'ok' && (!types || types.includes(b.type)));
}

/** Seconds of water at a steady rate to put out a fire that starts at `fire`, after `dry` seconds of burning unfought. */
function timeToPutOut(building, { dry = 0, fire = 0.3, power = 0.25 } = {}) {
  const state = createGame(7);
  state.running = true;
  const b = state.buildings.find((x) => x.id === building.id);
  ignite(state, b, 'test');
  b.integrity = b.maxIntegrity = 1e9;
  b.fire = fire;
  for (let t = 0; t < dry; t += 1 / 30) {
    state.streams.length = 0;
    updateFire(state, 1 / 30);
  }
  let t = 0;
  while (b.state === 'burning' && t < 600) {
    state.streams = [{ targetId: b.id, power }];
    updateFire(state, 1 / 30);
    t += 1 / 30;
  }
  return b.state === 'burning' ? Infinity : t;
}

test('a small house is easy to put out and a big building is hard once the fire has taken hold', () => {
  const state = createGame(7);
  const house = bySize(state, 'small', ['house']);
  const tower = bySize(state, 'huge', ['tower', 'warehouse', 'factory', 'mall']);
  assert.ok(house && tower);
  house.fire = 0.9;
  tower.fire = 0.9;
  assert.ok(fireResistance(house) < 0.8, 'house: ' + fireResistance(house));
  assert.ok(fireResistance(tower) > 1.7, 'tower: ' + fireResistance(tower));
  assert.equal(fireDifficulty(house).label, 'Easy');
  assert.ok(['Hard', 'Very hard'].includes(fireDifficulty(tower).label));
  // And it takes much longer to put the big one out with the same water.
  const a = timeToPutOut(house, { fire: 0.6 });
  const b = timeToPutOut(tower, { fire: 0.6 });
  assert.ok(b > a * 2, `house ${a.toFixed(1)}s, big building ${b.toFixed(1)}s`);
});

test('a big building is still easy while the fire is early: a fast response keeps it easy', () => {
  const state = createGame(7);
  const big = bySize(state, 'huge', ['tower', 'warehouse', 'factory', 'mall']);
  big.state = 'burning';
  big.neglect = 0;
  big.fire = 0.15;
  const early = fireResistance(big);
  big.fire = 0.9;
  const late = fireResistance(big);
  assert.ok(early < 1.3, 'early ' + early);
  assert.ok(late > early * 1.5, `early ${early.toFixed(2)} late ${late.toFixed(2)}`);
  // Water inside half a minute is far quicker than after a long delay.
  const fast = timeToPutOut(big, { dry: 8, fire: 0.2 });
  const slow = timeToPutOut(big, { dry: 90, fire: 0.2 });
  assert.ok(fast * 2 < slow, `fast ${fast.toFixed(1)}s, slow ${slow.toFixed(1)}s`);
});

test('a fire nobody fights takes hold, and that does not ease quickly once water arrives', () => {
  const state = createGame(7);
  state.running = true;
  const b = bySize(state, 'medium', ['apartment', 'shop']);
  ignite(state, b, 'test');
  b.integrity = b.maxIntegrity = 1e9;
  const start = fireResistance(b);
  for (let i = 0; i < 30 * 40; i++) {
    state.streams.length = 0;
    updateFire(state, 1 / 30);
    b.fire = Math.max(b.fire, 0.3);
  }
  assert.ok(b.neglect > 0.4, 'neglect ' + b.neglect);
  assert.ok(fireResistance(b) > start * 1.4, 'resistance barely rose');
  // Ten seconds of water (the fire kept alight) only eases it a little.
  const taken = b.neglect;
  for (let i = 0; i < 30 * 10; i++) {
    state.streams = [{ targetId: b.id, power: 0.0001 }];
    updateFire(state, 1 / 30);
    b.fire = Math.max(b.fire, 0.3);
  }
  assert.ok(b.neglect > taken * 0.85, `neglect fell from ${taken.toFixed(2)} to ${b.neglect.toFixed(2)} too quickly`);
  assert.ok(state.events.some((e) => e.text.includes('taken hold')), 'no warning that it has taken hold');
});

test('a late fire is harder than an early one, for a small building too', () => {
  const state = createGame(7);
  const house = bySize(state, 'small', ['house']);
  const early = timeToPutOut(house, { dry: 5, fire: 0.3 });
  const late = timeToPutOut(house, { dry: 80, fire: 0.3 });
  assert.ok(late > early * 1.5, `early ${early.toFixed(1)}s late ${late.toFixed(1)}s`);
});
