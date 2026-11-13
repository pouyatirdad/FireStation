import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, commandBuyVehicle, serialize, loadState } from '../src/systems/game.js';
import { hourlyCharges, speedBonus, valueFactor, earn, spend } from '../src/systems/economy.js';
import { ignite, updateFire } from '../src/systems/fire.js';
import { CONFIG } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  return state;
}

test('there is no subsidy or upkeep: a fleet costs nothing to run', () => {
  const state = shift();
  state.credits = 50000;
  commandBuyVehicle(state, 'ladder');
  commandBuyVehicle(state, 'ambulance');
  const credits = state.credits;
  for (let t = 0; t < CONFIG.economy.hourEvery + 1; t++) update(state, 1);
  assert.equal(state.ledger.hours, 1);
  assert.equal(hourlyCharges(state).total, 0);
  assert.equal(state.credits, credits, 'credits moved with no loan or insurance');
  assert.ok(!state.events.some((e) => /Hourly/.test(e.text)), 'a charges line with nothing to charge');
});

test('loan interest and insurance are charged every hour and logged', () => {
  const state = shift();
  state.loan = 5000;
  state.insured = true;
  const credits = state.credits;
  const c = hourlyCharges(state);
  assert.equal(c.total, c.premium + c.interest);
  for (let t = 0; t < CONFIG.economy.hourEvery + 1; t++) update(state, 1);
  assert.equal(state.credits, credits - c.total);
  assert.ok(state.events.some((e) => /Hourly charges/.test(e.text)), 'no charges line in the log');
});

test('the ledger tracks what was earned and spent', () => {
  const state = shift();
  earn(state, 500, 'incident');
  spend(state, 200, 'loss');
  assert.equal(state.ledger.earned, 500);
  assert.equal(state.ledger.spent, 200);
  assert.equal(state.ledger.by.incident, 500);
  assert.equal(state.ledger.by.loss, -200);
});

test('putting a fire out quickly earns a speed bonus on the reward', () => {
  const state = shift();
  const building = state.buildings.find((b) => b.id !== 'station');
  ignite(state, building, 'test');
  state.time = building.ignitedAt + 10;
  assert.equal(speedBonus(state, building), CONFIG.economy.speedBonus.max);
  state.time = building.ignitedAt + CONFIG.economy.speedBonus.slow + 30;
  assert.equal(speedBonus(state, building), 0);
  state.time = building.ignitedAt + (CONFIG.economy.speedBonus.fast + CONFIG.economy.speedBonus.slow) / 2;
  const mid = speedBonus(state, building);
  assert.ok(mid > 0 && mid < CONFIG.economy.speedBonus.max);
});

test('losing a building costs money, scaled by what it was worth', () => {
  const state = shift();
  const hotel = state.buildings.find((b) => b.type === 'hotel');
  const house = state.buildings.find((b) => b.type === 'house');
  assert.ok(valueFactor(hotel) > valueFactor(house));

  const credits = state.credits;
  hotel.occupants = 0; // no one inside, so only the building is lost
  hotel.integrity = 0.01;
  ignite(state, hotel, 'test');
  hotel.fire = 1;
  for (let i = 0; i < 30 && hotel.state === 'burning'; i++) updateFire(state, 1 / 30);
  assert.equal(hotel.state, 'rubble');
  assert.equal(state.credits, credits - Math.round(CONFIG.economy.lossPenalty * valueFactor(hotel)));
});

test('the ledger survives a save', () => {
  const state = shift();
  earn(state, 1234, 'incident');
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.equal(loaded.ledger.earned, 1234);
});
