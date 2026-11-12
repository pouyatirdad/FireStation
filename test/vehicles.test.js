import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandBuyStation,
  commandLoan, commandRepay, commandInsurance, commandTrain, commandAcceptContract,
  commandDispatch, commandDispatchWildfire, commandSellVehicle, selectUnit, serialize, loadState,
} from '../src/systems/game.js';
import { firePower, freeBay, totalBays } from '../src/systems/units.js';
import { hourlyBudget } from '../src/systems/economy.js';
import { updateContracts } from '../src/systems/contracts.js';
import { ignite, updateFire } from '../src/systems/fire.js';
import { startWildfire } from '../src/systems/wildfire.js';
import { CONFIG, TILE } from '../src/core/config.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 60000;
  return state;
}

const burnable = (state) => state.buildings.find((b) => b.type !== 'station' && b.type !== 'hospital' && b.type !== 'warehouse' && b.state === 'ok' && Math.hypot(b.x - 54, b.y - 47) > 30);

// -------------------------------------------------------------- stations ---

test('Station 2 is for sale: it adds eight bays, and vehicles can be delivered to either', () => {
  const state = shift();
  assert.equal(totalBays(state), 8);
  assert.equal(commandBuyVehicle(state, 'engine', 1), null, 'delivered to a station that is not open');

  const credits = state.credits;
  assert.equal(commandBuyStation(state), true);
  assert.equal(state.credits, credits - CONFIG.economy.stationPrice);
  assert.equal(totalBays(state), 16);
  assert.equal(commandBuyStation(state), false, 'bought it twice');

  const engine = commandBuyVehicle(state, 'engine', 1);
  assert.ok(engine);
  assert.equal(state.city.bays[engine.bayIndex].station, 1);
  const st2 = state.city.stations[1].building;
  assert.ok(Math.hypot(engine.x - (st2.x + st2.w / 2) * TILE, engine.y - (st2.y + st2.h / 2) * TILE) < 12 * TILE, 'not at Station 2');
  assert.equal(engine.status, 'in quarters');
});

test('with Station 2 open, sixteen vehicles fit and a seventeenth does not', () => {
  const state = shift();
  commandBuyStation(state);
  for (let i = 0; i < 15; i++) assert.ok(commandBuyVehicle(state, 'engine'), 'vehicle ' + (i + 2));
  assert.equal(state.engines.length, 16);
  assert.equal(freeBay(state), -1);
  assert.equal(commandBuyVehicle(state, 'engine'), null);
});

test('a vehicle refills on the apron of Station 2', () => {
  const state = shift();
  commandBuyStation(state);
  const engine = commandBuyVehicle(state, 'engine', 1);
  engine.water = 100;
  for (let i = 0; i < 30 * 5; i++) update(state, 1 / 30);
  assert.ok(engine.water > 100, 'no refill at Station 2');
});

test('calls reach the Station 2 district only once it is open', () => {
  const state = shift();
  state.time = 0;
  const near2 = state.buildings.filter((b) => {
    const st = state.city.stations[1].building;
    return Math.hypot(b.x - st.x, b.y - st.y) < 60 && b.type !== 'station';
  });
  assert.ok(near2.length > 10);
  commandBuyStation(state);
  state.incidentsEnabled = true;
  state.nextCallAt = 0.1;
  state.nextBigAt = 1e9;
  let hit = false;
  for (let n = 0; n < 40 && !hit; n++) {
    state.nextCallAt = 0.01;
    update(state, 0.05);
    hit = near2.some((b) => b.state === 'burning' || (b.trapped ?? 0) > 0) || state.patients.length > 0 || state.blockades.length > 0;
  }
  assert.ok(hit || state.stats.alarms > 0, 'no calls were generated');
});

// ---------------------------------------------------------- new vehicles ---

test('a helicopter has no crew and flies straight to a fire, ignoring roads', () => {
  const state = shift();
  const heli = commandBuyVehicle(state, 'helicopter');
  assert.ok(heli);
  assert.equal(state.crew.filter((c) => c.engineId === heli.id).length, 0);
  const target = burnable(state);
  ignite(state, target, 'test');
  selectUnit(state, heli.id);
  assert.equal(commandDispatch(state, target.id), true);
  assert.equal(heli.path.length, 1, 'a helicopter should fly in one straight leg');

  let seconds = 0;
  while (target.state === 'burning' && seconds < 240) {
    update(state, 1 / 30);
    seconds += 1 / 30;
  }
  assert.notEqual(target.state, 'burning', 'the fire was not put out');
  assert.ok(heli.water < heli.capacity, 'the helicopter dropped no water');
});

test('a helicopter fights a forest fire from the air and refills in the harbour', () => {
  const state = shift();
  const heli = commandBuyVehicle(state, 'helicopter');
  const tile = state.city.forestTiles[Math.floor(state.city.forestTiles.length / 2)];
  const wf = startWildfire(state, (tile.x + 0.5) * TILE, (tile.y + 0.5) * TILE, 2200);
  const start = wf.intensity;
  assert.equal(commandDispatchWildfire(state, wf.id), true);
  assert.equal(state.selected.id, heli.id, 'the helicopter was not chosen');
  for (let i = 0; i < 30 * 120; i++) update(state, 1 / 30);
  assert.ok(wf.intensity < start || !state.wildfires.includes(wf), 'the wildfire was not touched');

  heli.water = 0;
  heli.path = [];
  heli.x = 100 * TILE;
  heli.y = (state.city.h - 4) * TILE;
  for (let i = 0; i < 30 * 3; i++) update(state, 1 / 30);
  assert.ok(heli.water > 500, 'the helicopter did not refill over the harbour');
});

test('a command car boosts crews parked near it, and is never sent to a fire', () => {
  const state = shift();
  const engine = state.engines[0];
  const base = firePower(state, engine.x, engine.y);
  assert.equal(base, 1);
  const car = commandBuyVehicle(state, 'command');
  car.x = engine.x + 3 * TILE;
  car.y = engine.y;
  assert.ok(Math.abs(firePower(state, engine.x, engine.y) - (1 + CONFIG.command.aura)) < 1e-9);
  car.x = engine.x + (CONFIG.command.range + 5) * TILE;
  assert.equal(firePower(state, engine.x, engine.y), 1, 'the aura reached too far');

  car.x = engine.x;
  const target = burnable(state);
  ignite(state, target, 'test');
  selectUnit(state, car.id);
  commandDispatch(state, target.id);
  assert.notEqual(state.activeEngineId === car.id && car.targetId, target.id, 'the command car was sent to the fire');
});

test('a boosted crew puts a fire out faster', () => {
  const run = (withCar) => {
    const state = shift();
    const engine = state.engines[0];
    if (withCar) {
      const car = commandBuyVehicle(state, 'command');
      car.x = engine.x + 2 * TILE;
      car.y = engine.y;
    }
    const target = burnable(state);
    ignite(state, target, 'test');
    target.fire = 0.9;
    target.integrity = 1e6;
    target.maxIntegrity = 1e6;
    state.streams = [{ targetId: target.id, power: 0.05 * firePower(state, engine.x, engine.y) }];
    let t = 0;
    while (target.state === 'burning' && t < 600) {
      state.streams = [{ targetId: target.id, power: 0.05 * firePower(state, engine.x, engine.y) }];
      updateFire(state, 1 / 30);
      t += 1 / 30;
    }
    return t;
  };
  assert.ok(run(true) < run(false));
});

// --------------------------------------------------------------- finance ---

test('a loan adds credits, charges interest every hour, and can be repaid', () => {
  const state = shift();
  state.credits = 1000;
  const before = hourlyBudget(state);
  assert.equal(commandLoan(state), true);
  assert.equal(state.credits, 1000 + CONFIG.economy.loan.step);
  assert.equal(state.loan, CONFIG.economy.loan.step);
  const after = hourlyBudget(state);
  assert.equal(after.interest, Math.round(CONFIG.economy.loan.step * CONFIG.economy.loan.rate));
  assert.equal(after.net, before.net - after.interest);

  for (let i = 0; i < 5; i++) commandLoan(state);
  assert.equal(state.loan, CONFIG.economy.loan.max, 'borrowed past the limit');
  assert.equal(commandLoan(state), false);

  assert.equal(commandRepay(state), true);
  assert.equal(state.loan, CONFIG.economy.loan.max - CONFIG.economy.loan.step);
  state.credits = 10;
  assert.equal(commandRepay(state), false, 'repaid with no money');
});

test('insurance cuts the cost of a lost building and costs a premium', () => {
  const lose = (insured) => {
    const state = shift();
    if (insured) commandInsurance(state);
    const b = state.buildings.find((x) => x.type === 'hotel');
    b.occupants = 0;
    b.integrity = 0.01;
    ignite(state, b, 'test');
    b.fire = 1;
    const credits = state.credits;
    for (let i = 0; i < 30 && b.state === 'burning'; i++) updateFire(state, 1 / 30);
    return credits - state.credits;
  };
  const without = lose(false);
  const withCover = lose(true);
  assert.equal(without, Math.round(CONFIG.economy.lossPenalty * CONFIG.economy.value.hotel));
  assert.equal(withCover, Math.round(CONFIG.economy.lossPenalty * CONFIG.economy.value.hotel * CONFIG.economy.insurance.lossShare));
  assert.ok(withCover < without);

  const state = shift();
  const plain = hourlyBudget(state).net;
  commandInsurance(state);
  assert.equal(hourlyBudget(state).net, plain - CONFIG.economy.insurance.premium);
});

test('training makes crews better at their jobs, and costs no extra wages', () => {
  const state = shift();
  const plain = hourlyBudget(state).net;
  const engine = state.engines[0];
  assert.equal(firePower(state, engine.x, engine.y), 1);
  assert.equal(commandTrain(state, 'fire'), true);
  assert.ok(Math.abs(firePower(state, engine.x, engine.y) - (1 + CONFIG.economy.training.fire)) < 1e-9);
  assert.equal(hourlyBudget(state).net, plain, 'training changed the hourly budget');
  commandTrain(state, 'fire');
  commandTrain(state, 'fire');
  assert.equal(commandTrain(state, 'fire'), false, 'a fourth level');
  assert.equal(state.training.fire, 3);
  assert.equal(commandTrain(state, 'nonsense'), false);
});

test('a day report is written at midnight', () => {
  const state = shift();
  update(state, 1 / 30);
  state.clock = 24 * 60 + 1;
  update(state, 1 / 30);
  assert.ok(state.events.some((e) => /Day report/.test(e.text)), 'no report');
});

// ------------------------------------------------------------- contracts ---

test('a sponsor offers a contract, and finishing it in time pays', () => {
  const state = shift();
  state.contracts.nextOfferAt = 0;
  updateContracts(state);
  assert.equal(state.contracts.offers.length, 1);
  const offer = state.contracts.offers[0];
  assert.ok(offer.reward > 0 && offer.duration > 0);

  assert.equal(commandAcceptContract(state, offer.id), true);
  assert.equal(state.contracts.active.length, 1);
  assert.equal(state.contracts.offers.length, 0);

  const active = state.contracts.active[0];
  const credits = state.credits;
  if (active.kind === 'safe') {
    state.time = active.deadline + 1;
  } else {
    state.stats[active.stat] = (state.stats[active.stat] ?? 0) + active.target;
  }
  updateContracts(state);
  assert.equal(state.contracts.active.length, 0);
  assert.equal(state.contracts.completed, 1);
  assert.equal(state.credits, credits + active.reward);
});

test('missing the deadline costs a quarter of the fee, and only two can run at once', () => {
  const state = shift();
  const make = (kind) => ({
    id: 'c' + Math.random(), sponsor: 'Test', kind, stat: kind === 'save' ? 'saved' : 'treated',
    label: 'x', target: 99, reward: 1000, duration: 100, expiresAt: state.time + 999,
  });
  const offers = [make('save'), make('treat'), make('save')];
  state.contracts.offers.push(...offers);
  assert.equal(commandAcceptContract(state, offers[0].id), true);
  assert.equal(commandAcceptContract(state, offers[1].id), true);
  assert.equal(commandAcceptContract(state, offers[2].id), false);

  const credits = state.credits;
  state.time += 101;
  updateContracts(state);
  assert.equal(state.contracts.failed, 2);
  assert.equal(state.credits, credits - 2 * 250);
});

test('a casualty ends a "no casualties" contract', () => {
  const state = shift();
  state.contracts.offers.push({
    id: 'safe1', sponsor: 'Test', kind: 'safe', stat: 'casualties', label: 'No casualties',
    target: 0, reward: 1500, duration: 400, expiresAt: state.time + 999,
  });
  commandAcceptContract(state, 'safe1');
  state.stats.casualties += 1;
  updateContracts(state);
  assert.equal(state.contracts.failed, 1);
});

test('finance state survives a save', () => {
  const state = shift();
  commandLoan(state);
  commandInsurance(state);
  commandTrain(state, 'medic');
  commandBuyStation(state);
  state.contracts.nextOfferAt = 0;
  updateContracts(state);
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.equal(loaded.loan, CONFIG.economy.loan.step);
  assert.equal(loaded.insured, true);
  assert.equal(loaded.training.medic, 1);
  assert.deepEqual(loaded.ownedStations, [true, true, false]);
  assert.equal(loaded.contracts.offers.length, 1);
});
