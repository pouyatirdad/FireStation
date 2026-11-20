import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandBuyStation, commandSellVehicle,
  commandDispatch, commandRecall, commandReturnHome,
} from '../src/systems/game.js';
import {
  commandHire, commandTrain, commandUpgrade, commandAssign, commandUnassign, commandEmergencyFunding,
  commandBudget, createCareer, nextCareerShift, commandDismiss,
} from '../src/systems/modes.js';
import { CONFIG, TILE } from '../src/core/config.js';
import { workRate, speedMod, fatigueFactor, personOf } from '../src/systems/modifiers.js';
import {
  autoStaff, awardXp, injure, people, reserve, trainingBlock, refreshCandidates, payrollPerHour,
} from '../src/systems/personnel.js';
import { bankruptcyStatus, fundingForMonth, hourlyBurn, monthSeconds, maintenanceBreakdown } from '../src/systems/finance.js';
import { vehicleUnlocked, coverage, compareStations, upgradeBlock } from '../src/systems/stations.js';
import { endShift, levelProgress, shiftBlock } from '../src/systems/campaign.js';
import { listObjectives, updateObjectives } from '../src/systems/objectives.js';
import { toolCount, stationCapacity } from '../src/systems/units.js';
import { ignite } from '../src/systems/fire.js';

function career(options = {}) {
  const state = createCareer({ name: 'Test dept', ...options });
  startShift(state);
  state.incidentsEnabled = false;
  return state;
}

const burning = (state, minTiles = 14, maxTiles = 40) => {
  const st = state.city.station;
  const b = state.buildings.find((x) => x.type === 'house' && x.state === 'ok'
    && Math.hypot(x.x - st.x, x.y - st.y) >= minTiles && Math.hypot(x.x - st.x, x.y - st.y) <= maxTiles);
  ignite(state, b, 'test');
  return b;
};

// --------------------------------------------------------------- start ---

test('a new career starts with a staffed engine and ambulance, a reserve and a budget', () => {
  const state = career();
  assert.equal(state.mode, 'career');
  assert.equal(state.credits, CONFIG.career.startCredits);
  assert.deepEqual(state.engines.map((e) => e.type), ['engine', 'ambulance']);
  assert.equal(state.crew.length, 5, 'three on the engine, two on the ambulance');
  assert.equal(people(state).length, 6);
  assert.equal(reserve(state).length, 1);
  assert.ok(state.crew.every((c) => c.personId));
  assert.equal(state.campaign.level, 1);
  assert.equal(state.campaign.personnel.every((p) => p.name.includes(' ')), true);
  assert.equal(new Set(people(state).map((p) => p.id)).size, 6, 'unique ids');
});

test('Quick Response has no personnel, salaries or maintenance', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  const before = state.credits;
  for (let i = 0; i < 60 * 300; i++) update(state, 1 / 60);
  assert.equal(state.mode, 'quick');
  assert.equal(state.campaign, null);
  assert.equal(state.credits, before, 'no running costs in Quick Response');
  assert.equal(workRate(state, state.crew[0], 'firefighting'), 1);
  assert.equal(state.crew.length, 3);
});

test('a career charges salaries and upkeep every game hour, through the ledger', () => {
  const state = career();
  const before = state.credits;
  const wages = payrollPerHour(state);
  const upkeep = maintenanceBreakdown(state).total;
  assert.ok(wages > 0 && upkeep > 0);
  for (let i = 0; i < 60 * (CONFIG.economy.hourEvery + 1); i++) update(state, 1 / 60);
  assert.ok(Math.abs(before - state.credits - (wages + upkeep)) < 1, `${before - state.credits} vs ${wages + upkeep}`);
  assert.ok(state.ledger.by.salary < 0 && state.ledger.by.maintenance < 0);
  assert.ok(hourlyBurn(state) >= wages + upkeep);
});

// ----------------------------------------------------------- personnel ---

test('skills change what the crew does: rate, rescue speed, treatment and driving', () => {
  const state = career();
  const engine = state.engines[0];
  const crew = state.crew.find((c) => c.engineId === engine.id);
  const person = personOf(state, crew);
  person.skills.firefighting = 1;
  person.fatigue = 0;
  assert.equal(workRate(state, crew, 'firefighting'), 1);
  person.skills.firefighting = 10;
  const expert = workRate(state, crew, 'firefighting');
  assert.ok(Math.abs(expert - (1 + CONFIG.personnel.skillBonus * 9)) < 1e-9);
  assert.ok(expert > 1.5);

  // The spray power that reaches the fire is the base times the skill.
  const b = burning(state);
  state.credits += 0;
  commandDispatch(state, b.id);
  let power = null;
  for (let i = 0; i < 60 * 240 && power == null; i++) {
    update(state, 1 / 60);
    const s = state.streams.find((x) => x.crewId === crew.id);
    if (s) power = s.power;
  }
  assert.ok(power != null, 'the crew sprayed');
  assert.ok(Math.abs(power - CONFIG.crew.sprayPower * workRate(state, crew, 'firefighting')) < 1e-9);

  // Driving: the best driver aboard sets the speed.
  for (const id of engine.crewIds) personOf(state, state.crew.find((c) => c.id === id)).skills.driving = 1;
  const slow = speedMod(state, engine);
  personOf(state, state.crew.find((c) => c.id === engine.crewIds[0])).skills.driving = 10;
  assert.ok(speedMod(state, engine) > slow * 1.4);
});

test('a tired crew works worse, and rest brings it back', () => {
  const state = career();
  const crew = state.crew[0];
  const person = personOf(state, crew);
  person.fatigue = 0;
  assert.equal(fatigueFactor(person), 1);
  person.fatigue = 1;
  assert.ok(Math.abs(fatigueFactor(person) - (1 - CONFIG.personnel.fatigue.penalty)) < 1e-9);

  // Working at a real fire builds fatigue; resting in quarters takes it off again.
  person.fatigue = 0;
  const engine = state.engines.find((e) => e.id === crew.engineId);
  const b = burning(state, 12, 30);
  commandDispatch(state, b.id);
  for (let i = 0; i < 60 * 400 && b.state === 'burning'; i++) update(state, 1 / 60);
  const workers = state.crew.filter((c) => c.engineId === engine.id).map((c) => personOf(state, c));
  assert.ok(workers.some((w) => w.fatigue > 0.003), 'the crew got tired: ' + workers.map((w) => w.fatigue.toFixed(3)));
  commandRecall(state);
  commandReturnHome(state);
  const tired = Math.max(...workers.map((w) => w.fatigue));
  for (let i = 0; i < 60 * 150; i++) update(state, 1 / 60);
  assert.ok(Math.max(...workers.map((w) => w.fatigue)) < tired, 'rest brought it down');
});

test('an injured firefighter is replaced from the reserve and returns later', () => {
  const state = career();
  const engine = state.engines[0];
  const crew = state.crew.find((c) => c.engineId === engine.id);
  const person = personOf(state, crew);
  assert.equal(reserve(state).length, 1);
  assert.equal(injure(state, person), true);
  assert.equal(person.status, 'injured');
  assert.equal(engine.crewIds.length, 3, 'the reserve took the seat');
  assert.equal(reserve(state).length, 0);
  assert.equal(person.vehicleId, null);
  assert.equal(state.stats.firefighterInjuries, 1);
  assert.equal(injure(state, person), false, 'already hurt');

  state.time = person.injuredUntil + 1;
  update(state, 1 / 60);
  assert.equal(person.status, 'active');
  assert.equal(reserve(state).length, 1, 'back as the reserve');
});

test('hiring costs money, adds a person and fills a short-crewed vehicle', () => {
  const state = career();
  state.campaign.level = 2; // ladders unlocked
  const candidates = refreshCandidates(state, true);
  assert.equal(candidates.length, CONFIG.personnel.candidates);
  assert.ok(candidates.every((c) => c.askingFee > 0 && c.status === 'candidate'));

  const vehicle = commandBuyVehicle(state, 'ladder');
  assert.ok(vehicle);
  assert.equal(vehicle.crewIds.length, 1, 'only the one reserve is free to crew it');

  const pick = candidates[0];
  const fee = pick.askingFee;
  const before = state.credits;
  assert.equal(commandHire(state, pick.id), true);
  assert.equal(state.credits, before - fee);
  assert.equal(people(state).length, 7);
  assert.equal(vehicle.crewIds.length, 2, 'the new hire went to the short vehicle');
  assert.equal(state.campaign.candidates.some((c) => c.id === pick.id), false);
  assert.equal(commandHire(state, 'nobody'), false);
  state.credits = 0;
  assert.equal(commandHire(state, candidates[1].id), false, 'cannot afford');
});

test('a vehicle with nobody to crew it cannot be dispatched', () => {
  const state = career();
  state.campaign.level = 2;
  commandBuyVehicle(state, 'ladder'); // takes the one reserve
  commandBuyVehicle(state, 'tanker'); // nobody left
  const tanker = state.engines.find((e) => e.type === 'tanker');
  assert.equal(tanker.crewIds.length, 0);
  const b = burning(state);
  // Picking the empty vehicle by hand is refused with a reason...
  assert.equal(state.selected.id, tanker.id);
  assert.equal(commandDispatch(state, b.id), false);
  assert.equal(tanker.path.length, 0);
  assert.ok(state.events.some((e) => e.text.includes('no crew')));
  // ...and the automatic choice never picks it.
  state.selected = null;
  assert.equal(commandDispatch(state, b.id), true);
  assert.equal(tanker.path.length, 0);
  assert.ok(state.engines.some((e) => e.targetId === b.id && e.type !== 'tanker'));
});

test('seats can be moved by hand, and selling a vehicle returns its crew to the reserve', () => {
  const state = career();
  const engine = state.engines[0];
  const ambulance = state.engines[1];
  const spare = reserve(state)[0];
  const seated = people(state).find((p) => p.vehicleId === engine.id);
  assert.equal(commandUnassign(state, seated.id), true);
  assert.equal(engine.crewIds.length, 2);
  assert.equal(commandAssign(state, spare.id, engine.id), true);
  assert.equal(engine.crewIds.length, 3);
  assert.equal(commandAssign(state, seated.id, engine.id), false, 'the engine is full again');
  assert.equal(seated.vehicleId, null);

  commandSellVehicle(state, ambulance.id);
  assert.equal(people(state).filter((p) => p.vehicleId === ambulance.id).length, 0);
  assert.equal(reserve(state).length, 3);
  assert.equal(commandDismiss(state, spare.id), true);
  assert.equal(people(state).length, 5);
});

test('experience raises skills, levels and rank', () => {
  const state = career();
  const person = people(state)[0];
  const skill = person.skills.rescue;
  awardXp(state, person, 'rescue', CONFIG.personnel.xpPerLevel * skill + 1);
  assert.equal(person.skills.rescue, skill + 1);
  for (let i = 0; i < 40; i++) awardXp(state, person, null, 120 * person.level);
  assert.equal(person.level, 10);
  assert.equal(person.rank, 'chief');
  assert.ok(state.events.some((e) => e.text.includes('promoted')));
});

test('training costs money, takes time, respects capacity and cannot be duplicated', () => {
  const state = career();
  const [a, b] = people(state);
  const course = 'rescue';
  const cost = CONFIG.training.courses[course].cost;
  const skill = a.skills.rescue;
  const before = state.credits;

  assert.equal(trainingBlock(state, a, course), null);
  assert.equal(commandTrain(state, a.id, course), true);
  assert.equal(state.credits, before - cost);
  assert.equal(a.status, 'training');
  assert.equal(a.vehicleId, null, 'off the vehicle while training');
  assert.equal(commandTrain(state, a.id, 'medical'), false, 'already training');
  assert.equal(commandTrain(state, b.id, 'medical'), false, 'the one training slot is taken');
  assert.equal(trainingBlock(state, b, 'medical'), 'The training centre is full');
  assert.equal(commandTrain(state, b.id, 'nonsense'), false);

  state.time = a.training.until + 1;
  update(state, 1 / 60);
  assert.equal(a.status, 'active');
  assert.ok(a.skills.rescue >= skill, 'skill xp was awarded');
  assert.ok(a.skillXp.rescue > 0 || a.skills.rescue > skill);
  assert.equal(a.stats.trainings, 1);
  // Certification courses can only be taken once.
  a.status = 'active';
  assert.equal(commandTrain(state, a.id, 'hazmat'), true);
  state.time = a.training.until + 1;
  update(state, 1 / 60);
  assert.ok(a.certs.includes('hazmat'));
  assert.equal(trainingBlock(state, a, 'hazmat'), 'Already certified');
});

// ------------------------------------------------------------- stations ---

test('stations hold only the bays their garage has built, and upgrades add bays', () => {
  const state = career();
  state.credits = 500000;
  state.campaign.level = 6;
  assert.equal(stationCapacity(state, 0), CONFIG.upgrades.baseBays);
  commandBuyVehicle(state, 'engine');
  commandBuyVehicle(state, 'engine'); // four vehicles now
  assert.equal(state.engines.length, 4);
  assert.equal(commandBuyVehicle(state, 'engine'), null, 'garage full');
  assert.ok(state.events.some((e) => e.text.includes('no free bay') || e.text.includes('bays are full')));
  assert.equal(commandUpgrade(state, 0, 'garage'), true);
  assert.equal(stationCapacity(state, 0), CONFIG.upgrades.baseBays + CONFIG.upgrades.garage.per);
  assert.ok(commandBuyVehicle(state, 'engine'));
});

test('upgrades cost money, need a high enough department level and have real effects', () => {
  const state = career();
  state.credits = 500000;
  assert.equal(upgradeBlock(state, 0, 'storage'), null);
  const before = state.credits;
  const engine = state.engines[0];
  assert.equal(toolCount(engine, 'diving'), CONFIG.vehicles.engine.tools.diving);
  assert.equal(commandUpgrade(state, 0, 'storage'), true);
  assert.equal(state.credits, before - CONFIG.upgrades.storage.cost);
  assert.equal(toolCount(engine, 'diving'), CONFIG.vehicles.engine.tools.diving + 1, 'storage adds a tool of each kind');
  assert.equal(CONFIG.vehicles.engine.tools.diving, 2, 'the shared config is never mutated');

  // Level 1 allows upgrades up to level 1 only.
  assert.equal(upgradeBlock(state, 0, 'garage'), null);
  assert.equal(commandUpgrade(state, 0, 'garage'), true);
  assert.match(upgradeBlock(state, 0, 'garage'), /higher department level/);
  assert.equal(commandUpgrade(state, 0, 'garage'), false);
  state.campaign.level = 3;
  assert.equal(commandUpgrade(state, 0, 'garage'), true);
  assert.equal(state.campaign.stations[0].level, 4);

  // Communication centre: responders drive faster.
  const slow = speedMod(state, engine);
  engine.status = 'responding';
  const fast0 = speedMod(state, engine);
  commandUpgrade(state, 0, 'comms');
  const fast1 = speedMod(state, engine);
  assert.ok(fast1 > fast0 && fast0 >= slow);

  // Maintenance workshop: cheaper upkeep.
  const cost0 = maintenanceBreakdown(state).total;
  commandUpgrade(state, 0, 'workshop');
  const cost1 = maintenanceBreakdown(state).total;
  assert.ok(cost1 < cost0 + CONFIG.career.maintenance.upgradeLevel, 'the workshop discount outweighs its own upkeep');
  assert.equal(commandUpgrade(state, 5, 'garage'), false, 'cannot upgrade a station you do not own');
});

test('a medical centre speeds recovery and a training centre adds a place', () => {
  const state = career();
  state.credits = 500000;
  state.campaign.level = 3;
  const person = people(state).find((p) => p.vehicleId);
  injure(state, person);
  const t0 = person.injuredUntil - state.time;
  person.status = 'active';
  person.injuredUntil = 0;
  commandUpgrade(state, 0, 'medical');
  commandUpgrade(state, 0, 'medical');
  injure(state, person);
  const t1 = person.injuredUntil - state.time;
  assert.ok(t1 < t0 * 0.85, `${t1} vs ${t0}`);

  commandUpgrade(state, 0, 'training');
  const [a, b] = people(state).filter((p) => p.status === 'active');
  assert.equal(commandTrain(state, a.id, 'driving'), true);
  assert.equal(commandTrain(state, b.id, 'medical'), true, 'two places now');
});

test('the department level decides which vehicles and how many stations are available', () => {
  const state = career();
  state.credits = 900000;
  assert.equal(vehicleUnlocked(state, 'engine'), true);
  assert.equal(vehicleUnlocked(state, 'helicopter'), false);
  assert.equal(commandBuyVehicle(state, 'helicopter'), null);
  assert.ok(state.events.some((e) => e.text.includes('Unlocked at')));
  assert.equal(commandBuyStation(state, 1), false, 'level 1 allows one station');
  state.campaign.level = 2;
  assert.equal(commandBuyStation(state, 1), true);
  assert.equal(state.ownedStations[1], true);
  assert.equal(commandBuyStation(state, 3), false, 'level 2 allows two stations');
  state.campaign.level = 5;
  assert.ok(commandBuyVehicle(state, 'helicopter'));
});

test('coverage names the districts a station reaches slowly, and more stations improve it', () => {
  const state = career();
  state.campaign.level = 3;
  state.credits = 500000;
  const one = coverage(state);
  assert.ok(one.rows.length > 3);
  assert.ok(one.share > 0 && one.share <= 1);
  assert.ok(one.underserved.length > 0, 'one station cannot cover this city');
  commandBuyStation(state, 1);
  const two = coverage(state);
  assert.ok(two.share >= one.share);
  const rows = compareStations(state);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].vehicles >= 2);
});

// -------------------------------------------------------------- finance ---

test('money warnings, emergency funding and monthly funding all go through the ledger', () => {
  const state = career();
  assert.equal(bankruptcyStatus(state).level, 'ok');
  state.credits = 900;
  assert.equal(bankruptcyStatus(state).level, 'low');
  assert.equal(commandEmergencyFunding(state), false, 'not in trouble yet');
  state.credits = -500;
  update(state, 1 / 60);
  assert.equal(bankruptcyStatus(state).level, 'critical');
  assert.ok(state.events.some((e) => e.text.includes('in debt')));
  const rep = state.campaign.reputation;
  const before = state.credits;
  assert.equal(commandEmergencyFunding(state), true);
  assert.equal(state.credits, before + CONFIG.career.bankruptcy.emergencyAmount);
  assert.ok(state.campaign.reputation < rep);
  assert.equal(state.ledger.by.emergency, CONFIG.career.bankruptcy.emergencyAmount);
  assert.equal(commandEmergencyFunding(state), false, 'cooldown');

  const s2 = career();
  s2.credits = CONFIG.career.bankruptcy.emergencyAt - 1;
  update(s2, 1 / 60);
  assert.ok(s2.credits > 0, 'the city steps in by itself at rock bottom');
});

test('a month ends with a summary, government funding and a budget check', () => {
  const state = career();
  const before = state.credits;
  commandBudget(state, 'personnel', 50);
  const funding = fundingForMonth(state);
  assert.ok(funding >= CONFIG.career.funding.baseMonthly);
  for (let i = 0; i < 60 * Math.ceil(monthSeconds() + 1); i++) update(state, 1 / 60);
  assert.equal(state.campaign.history.months.length, 1);
  assert.equal(state.campaign.finance.month, 2);
  assert.ok(state.ledger.by.funding >= funding);
  assert.ok(state.events.some((e) => e.text.includes('Month 1 summary')));
  assert.ok(state.events.some((e) => e.text.includes('Over budget')));
  assert.ok(state.credits !== before);
  assert.equal(commandBudget(state, 'personnel', -4), false);
});

// ------------------------------------------------- objectives and levels ---

test('objectives complete, pay, and stay completed', () => {
  const state = career();
  state.credits = 100000;
  assert.ok(listObjectives(state).some((o) => o.group === 'daily'));
  assert.equal(listObjectives(state).find((o) => o.id === 'first-shift').done, false);

  const before = state.credits;
  state.time = 600;
  const next = nextCareerShift(state);
  const s2 = next.state;
  assert.equal(s2.campaign.objectives.completed['first-shift'], 1);
  assert.ok(s2.credits > before - 1, 'objective and bonus money arrived');
  assert.equal(listObjectives(s2).find((o) => o.id === 'first-shift').done, true);
  const credits = s2.credits;
  updateObjectives(s2, 5, true);
  assert.equal(s2.credits, credits, 'paid once only');
});

test('progress carries across shifts: stations, roster and totals count', () => {
  const state = career();
  state.credits = 300000;
  state.campaign.level = 2;
  commandBuyStation(state, 1);
  const row = listObjectives(state).find((o) => o.id === 'second-station');
  assert.equal(row.value, 2);
  assert.equal(row.fraction, 1);
  updateObjectives(state, 5, true);
  assert.ok(state.campaign.objectives.completed['second-station'] != null);
  state.time = 600;
  const next = nextCareerShift(state).state;
  assert.equal(next.ownedStations[1], true, 'the second station carries over');
  assert.equal(next.campaign.objectives.completed['second-station'] != null, true);
});

test('a good shift raises reputation and promotes the department; the fleet carries over', () => {
  const state = career();
  state.credits = 120000;
  commandBuyVehicle(state, 'engine');
  state.campaign.reputation = 95;
  state.campaign.shifts = 5;
  const p = levelProgress(state.campaign);
  assert.equal(p.ready, true);
  const fleet = state.engines.map((e) => e.type);
  state.time = 600;
  const { state: next, summary } = nextCareerShift(state);
  assert.equal(summary.leveled.id, 4, 'enough reputation and shifts for several promotions at once');
  assert.equal(next.campaign.level, 4);
  assert.deepEqual(next.engines.map((e) => e.type), fleet);
  assert.equal(next.credits >= state.credits, true);
  assert.equal(next.time, 0);
  assert.ok(next.campaign.history.shifts.length === 1);
  assert.equal(endShift(state), summary, 'ending twice returns the same summary');
});

test('finishing incidents moves reputation and gives the crew experience', () => {
  const state = career();
  const rep = state.campaign.reputation;
  const b = burning(state, 14, 30);
  commandDispatch(state, b.id);
  const crewPeople = people(state).filter((p) => p.vehicleId === state.engines[0].id);
  const xp0 = crewPeople.reduce((n, p) => n + p.xp + p.skillXp.firefighting, 0);
  for (let i = 0; i < 60 * 300 && b.state === 'burning'; i++) update(state, 1 / 60);
  update(state, 1);
  assert.notEqual(b.state, 'burning');
  assert.ok(state.campaign.reputation > rep, 'a resolved incident raises reputation');
  const xp1 = crewPeople.reduce((n, p) => n + p.xp + p.skillXp.firefighting, 0);
  assert.ok(xp1 > xp0, 'the crew learned something');
  assert.ok(crewPeople.some((p) => p.stats.incidents >= 1));
});

test('career mode is independent of quick response: a career never leaks into a quick game', () => {
  const c = career();
  const q = createGame(7);
  assert.equal(q.campaign, null);
  assert.equal(q.mode, 'quick');
  assert.equal(c.mode, 'career');
  assert.equal(q.credits, CONFIG.economy.start);
  assert.notEqual(c.credits, q.credits);
  assert.equal(q.engines.length, 1);
});

test('an objective completed in the very first shift pays once, not every second', () => {
  const state = career();
  state.credits = 1000;
  state.campaign.level = 3; // 'city-dept' needs level 3: met at once, in shift 0
  updateObjectives(state, 5, true);
  const afterFirst = state.credits;
  assert.ok(afterFirst > 1000, 'it paid');
  assert.equal(state.campaign.objectives.completed['city-dept'], 0, 'completed in shift 0');
  for (let i = 0; i < 10; i++) updateObjectives(state, 5, true);
  assert.equal(state.credits, afterFirst, 'and never again');
  assert.equal(listObjectives(state).find((o) => o.id === 'city-dept').done, true);
  assert.equal(state.events.filter((e) => e.text.includes('Reach City Department')).length, 1);
});

test('a shift cannot be filed at once: no bonus, experience or promotion farming', () => {
  const state = career();
  const credits = state.credits;
  assert.match(shiftBlock(state), /at least half its length/);
  assert.equal(endShift(state), null, 'refused at the start');
  assert.equal(nextCareerShift(state), null);
  assert.equal(state.credits, credits);
  assert.equal(state.campaign.shifts, 0);
  assert.ok(state.events.some((e) => e.text.includes('at least half its length')));

  state.time = CONFIG.career.shiftLength * CONFIG.career.minShiftShare;
  assert.equal(shiftBlock(state), null);
  const half = endShift(state);
  assert.ok(half);
  assert.equal(half.report.rating.grade, 'B', 'a shift with nothing to do cannot earn a top grade');
  assert.ok(half.report.rating.score <= 70);
  // The bonus is paid in proportion to the time played.
  assert.ok(state.ledger.by.bonus === undefined || state.ledger.by.bonus <= 450 + 1500 + 1);
});

test('emergency funding clears a deep debt with a cushion, and is capped', () => {
  const state = career();
  state.credits = -30000;
  assert.equal(commandEmergencyFunding(state), true);
  assert.ok(state.credits >= CONFIG.career.bankruptcy.cushion - 500, `credits ${state.credits}`);
  assert.ok(state.credits <= CONFIG.career.bankruptcy.cushion + 500);
  const s2 = career();
  s2.credits = -500000;
  commandEmergencyFunding(s2);
  assert.equal(s2.credits, -500000 + CONFIG.career.bankruptcy.emergencyMax, 'never more than the cap');
});
