import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startShift, update, commandBuyVehicle, commandSellVehicle, commandBuyStation,
} from '../src/systems/game.js';
import {
  commandBudget, commandHire, commandStationBudget, commandTrain, commandUpgrade, createCareer,
} from '../src/systems/modes.js';
import { CONFIG } from '../src/core/config.js';
import { budgetSummary, stationBudgetBlock } from '../src/systems/stations.js';
import { monthSeconds } from '../src/systems/finance.js';
import { people, refreshCandidates } from '../src/systems/personnel.js';

function career() {
  const state = createCareer({ name: 'Budget' });
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 200000;
  state.campaign.level = 3;
  return state;
}

const spentMonth = (state, i = 0) => state.campaign.stations[i]?.spentMonth ?? 0;

test('a station with a budget refuses purchases that would pass it, with a clear reason', () => {
  const state = career();
  assert.equal(commandStationBudget(state, 0, 1500), true);
  assert.ok(state.events.some((e) => e.text.includes('monthly budget set to $1,500')));
  const credits = state.credits;

  // A $1,000 engine fits; the next would pass $1,500.
  assert.ok(commandBuyVehicle(state, 'engine'));
  assert.equal(spentMonth(state), 1000);
  assert.equal(commandBuyVehicle(state, 'engine'), null);
  assert.equal(state.credits, credits - 1000, 'nothing was charged for the refused purchase');
  assert.ok(state.events.some((e) => e.tone === 'warn' && e.text.includes('Over Station 1') && e.text.includes('$2,000 of $1,500')));
  assert.equal(state.engines.filter((e) => e.type === 'engine').length, 2);

  // Upgrades and training obey the same budget; money alone does not override it.
  assert.equal(commandUpgrade(state, 0, 'storage'), false);
  assert.match(stationBudgetBlock(state, 0, 3400), /Over Station 1/);
  const person = people(state).find((p) => p.status === 'active');
  assert.equal(commandTrain(state, person.id, 'firefighting'), false, '$700 more would make $1,700');
  assert.ok(state.events.some((e) => e.text.includes('$1,700 of $1,500')));
  commandStationBudget(state, 0, 2000);
  assert.equal(commandTrain(state, person.id, 'firefighting'), true, 'fits once the budget is raised');
  assert.equal(spentMonth(state), 1700);
});

test('raising the budget or removing it lets purchases through again', () => {
  const state = career();
  assert.equal(commandUpgrade(state, 0, 'garage'), true); // room for more than four vehicles
  commandStationBudget(state, 0, 4600);
  assert.ok(commandBuyVehicle(state, 'engine'));
  assert.equal(commandBuyVehicle(state, 'engine'), null);
  commandStationBudget(state, 0, 9000);
  assert.ok(commandBuyVehicle(state, 'engine'));
  commandStationBudget(state, 0, 0);
  assert.ok(commandBuyVehicle(state, 'ambulance'));
  assert.equal(stationBudgetBlock(state, 0, 1e9), null, 'no limit means no block');
  assert.equal(commandStationBudget(state, 0, -5), false);
  assert.equal(commandStationBudget(state, 0, 1e9), false);
  assert.equal(commandStationBudget(state, 0, 'lots'), false);
  assert.equal(commandStationBudget(state, 4, 100), false, 'not an owned station');
});

test('selling a vehicle gives back what the station spent, never below zero', () => {
  const state = career();
  commandStationBudget(state, 0, 5000);
  const engine = commandBuyVehicle(state, 'engine');
  assert.equal(spentMonth(state), 1000);
  const refund = commandSellVehicle(state, engine.id);
  assert.equal(refund, 600);
  assert.equal(spentMonth(state), 400);
  state.campaign.stations[0].spentMonth = 100;
  const again = commandBuyVehicle(state, 'ambulance');
  assert.ok(again);
  assert.equal(spentMonth(state), 1500);
  state.campaign.stations[0].spentMonth = 0;
  commandSellVehicle(state, again.id);
  assert.equal(spentMonth(state), 0, 'never negative');
});

test('upkeep is tracked against the budget, always paid, and warns once as it is passed', () => {
  const state = career();
  commandStationBudget(state, 0, 100);
  const seen = new Set();
  for (let i = 0; i < 60 * (CONFIG.economy.hourEvery * 3 + 1); i++) {
    update(state, 1 / 60);
    for (const e of state.events) if (e.text.includes('over its monthly budget')) seen.add(e.id);
  }
  assert.ok(spentMonth(state) > 100, 'upkeep counted');
  assert.ok(state.ledger.by.maintenance < -100, 'and it was paid even over budget');
  assert.equal(seen.size, 1, 'one warning, not one per hour');
});

test('a station nearing its budget gets an early warning', () => {
  const state = career();
  commandStationBudget(state, 0, 1200);
  commandBuyVehicle(state, 'engine'); // $1,000 of $1,200
  assert.ok(state.events.some((e) => /used 83% of its monthly budget/.test(e.text)));
});

test('the month ends: budgets reset and the station can spend again', () => {
  const state = career();
  commandStationBudget(state, 0, 1500);
  commandBuyVehicle(state, 'engine');
  assert.equal(commandBuyVehicle(state, 'engine'), null);
  for (let i = 0; i < 60 * Math.ceil(monthSeconds() + 2); i++) update(state, 1 / 60);
  assert.ok(spentMonth(state) < 1000, 'reset at the month end (plus a little upkeep since)');
  assert.ok(commandBuyVehicle(state, 'engine'));
});

test('station spending stays consistent with the ledger', () => {
  const state = career();
  state.campaign.level = 5;
  commandBuyStation(state, 1);
  commandStationBudget(state, 0, 90000);
  commandStationBudget(state, 1, 90000);
  commandBuyVehicle(state, 'engine', 0);
  commandBuyVehicle(state, 'ladder', 1);
  commandUpgrade(state, 0, 'storage');
  commandUpgrade(state, 1, 'comms');
  const person = people(state)[0];
  commandTrain(state, person.id, 'driving');
  const sold = commandBuyVehicle(state, 'engine', 0);
  commandSellVehicle(state, sold.id);
  for (let i = 0; i < 60 * (CONFIG.economy.hourEvery * 2 + 1); i++) update(state, 1 / 60);

  // Everything the stations report spending was a real expense in the ledger (the ledger also
  // holds the station purchase itself and other things, so it can only be larger).
  const stationTotal = budgetSummary(state).rows.reduce((n, r) => n + r.spent, 0);
  const by = state.ledger.by;
  const ledgerTotal = -((by.vehicle ?? 0) + (by.upgrade ?? 0) + (by.training ?? 0) + (by.maintenance ?? 0));
  assert.ok(stationTotal > 0);
  assert.ok(Math.abs(stationTotal - ledgerTotal) < 1, `stations ${stationTotal} vs ledger ${ledgerTotal}`);
  // And the books balance: credits are what we started with plus everything earned minus everything spent.
  assert.ok(Math.abs(state.credits - (200000 + state.ledger.earned - state.ledger.spent)) < 1);
});

test('the allocation summary counts budgets against monthly funding', () => {
  const state = career();
  state.campaign.level = 3;
  commandStationBudget(state, 0, 4000);
  const s = budgetSummary(state);
  assert.equal(s.allocated, 4000);
  assert.equal(s.rows[0].budget, 4000);
  assert.equal(commandBudget(state, 'personnel', 100), true);
});

test('candidates are topped up over time and hiring cannot re-roll the list', () => {
  const state = career();
  const first = refreshCandidates(state, true).map((c) => c.id);
  assert.equal(first.length, CONFIG.personnel.candidates);
  assert.ok(commandHire(state, first[0]));
  assert.equal(state.campaign.candidates.length, CONFIG.personnel.candidates - 1);
  update(state, 1 / 60);
  assert.equal(state.campaign.candidates.length, CONFIG.personnel.candidates, 'one new face fills the gap');
  const kept = state.campaign.candidates.map((c) => c.id);
  assert.deepEqual(first.slice(1).every((id) => kept.includes(id)), true, 'the others are still there');
  state.time += CONFIG.personnel.candidateLife + 1;
  update(state, 1 / 60);
  assert.equal(state.campaign.candidates.some((c) => first.includes(c.id)), false, 'the list turns over when it expires');
});
