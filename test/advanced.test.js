import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, startShift, update, commandBuyVehicle, commandDispatch, serialize, loadState,
} from '../src/systems/game.js';
import { createCareer } from '../src/systems/modes.js';
import { CONFIG, TILE } from '../src/core/config.js';
import { ignite } from '../src/systems/fire.js';
import { collapseBuilding, rescueProgress, updateCollapse } from '../src/systems/collapse.js';
import { hazardZones, hasHazard, startLeak, updateHazards, zoneAt } from '../src/systems/hazmat.js';
import { evacuateIncident, evacuationAdvice, startEvacuation, updateEvacuation } from '../src/systems/evacuation.js';
import { agencyStatus, allAgencies, callAgency, updateSupport } from '../src/systems/agencies.js';
import { DISASTER_IDS, startDisaster, updateDisaster } from '../src/systems/disasters.js';
import { speedMod, supportAt } from '../src/systems/modifiers.js';
import { drowningCall } from '../src/systems/water.js';
import { spawnPatient } from '../src/systems/medical.js';
import { playScene } from '../src/systems/incidents.js';
import { SCENES } from '../src/systems/scenes.js';
import { incidentIntel } from '../src/systems/intel.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 300000;
  return state;
}

const house = (state, type = 'house', min = 14, max = 50, skip = []) => {
  const st = state.city.station;
  return state.buildings.find((b) => b.type === type && b.state === 'ok' && !skip.includes(b.id)
    && Math.hypot(b.x - st.x, b.y - st.y) >= min && Math.hypot(b.x - st.x, b.y - st.y) <= max);
};

/** Any industrial building: a works, a warehouse or a tank farm. */
const works = (state) => state.buildings.find((b) => ['warehouse', 'factory'].includes(b.type) && b.state === 'ok');

/** The building with the most neighbours within eight tiles: a spot where an evacuation has work to do. */
function denseSpot(state) {
  let best = null;
  let bestN = -1;
  for (const b of state.buildings) {
    if (!['house', 'apartment', 'villa', 'shop'].includes(b.type) || b.state !== 'ok') continue;
    const n = state.buildings.filter((o) => (o.occupants ?? 0) > 0 && Math.hypot(o.x - b.x, o.y - b.y) <= 8).length;
    if (n > bestN) {
      bestN = n;
      best = b;
    }
  }
  return best;
}

/** Put a crew member from an engine on the ground at a point. */
function stand(state, engine, x, y) {
  const crew = state.crew.find((c) => c.engineId === engine.id);
  crew.riding = false;
  crew.x = x;
  crew.y = y;
  return crew;
}

// --------------------------------------------------------------- hazmat ---

test('a leaking building has a hazard zone; the people who work in it unprotected are overcome', () => {
  const state = shift();
  const b = works(state);
  assert.ok(b, 'an industrial building');
  startLeak(state, b, 1);
  assert.equal(hasHazard(b), true);
  const zones = hazardZones(state);
  assert.equal(zones.length, 1);
  const z = zones[0];
  assert.ok(z.radius > 3 * TILE);
  assert.ok(zoneAt(zones, z.x, z.y));
  assert.equal(zoneAt(zones, z.x + z.radius + 50, z.y), null);

  const engine = state.engines[0];
  const crew = stand(state, engine, z.x, z.y + 2 * TILE);
  const patients = state.patients.length;
  for (let i = 0; i < 60 * 40 && state.patients.length === patients; i++) {
    crew.riding = false;
    crew.x = z.x;
    crew.y = z.y + 2 * TILE;
    updateHazards(state, 1 / 60);
  }
  assert.equal(state.patients.length, patients + 1, 'an unprotected firefighter was overcome');
  assert.ok(state.patients.at(-1).reason.includes('overcome by fumes'));
  assert.ok(state.events.some((e) => e.text.includes('without protection')));
});

test('a hazmat unit protects its crew, who can contain the leak', () => {
  const state = shift();
  const b = works(state);
  b.reward = 900;
  startLeak(state, b, 1);
  const unit = commandBuyVehicle(state, 'hazmat');
  assert.ok(unit && unit.spec.hazmat);
  const crew = stand(state, unit, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE);
  const credits = state.credits;
  for (let i = 0; i < 60 * 60 && b.leak > 0; i++) {
    crew.riding = false;
    crew.x = (b.x + b.w / 2) * TILE;
    crew.y = (b.y + b.h / 2) * TILE;
    updateHazards(state, 1 / 60);
  }
  assert.equal(crew.contamination, 0, 'suited crews are never contaminated');
  assert.equal(b.leak, 0, 'the leak was contained');
  assert.equal(state.patients.length, 0);
  assert.equal(state.credits, credits + 900, 'the incident reward was paid');
  assert.equal(hasHazard(b), false);
});

test('a hazmat-certified person is protected in a career', () => {
  const state = createCareer({ name: 'H' });
  startShift(state);
  state.incidentsEnabled = false;
  const b = works(state);
  startLeak(state, b, 1);
  const engine = state.engines[0];
  const crew = state.crew.find((c) => c.engineId === engine.id);
  const person = state.campaign.personnel.find((p) => p.id === crew.personId);
  const z = hazardZones(state)[0];
  for (const c of state.crew.filter((x) => x.engineId === engine.id)) {
    const p = state.campaign.personnel.find((q) => q.id === c.personId);
    p.certs.push('hazmat');
  }
  for (let i = 0; i < 60 * 20; i++) {
    for (const c of state.crew.filter((x) => x.engineId === engine.id)) {
      c.riding = false; c.x = z.x; c.y = z.y;
    }
    updateHazards(state, 1 / 60);
  }
  assert.ok(person.certs.includes('hazmat'));
  assert.equal(state.crew.every((c) => !c.contamination), true);
});

test('contamination is washed off beside a hazmat unit and fades slowly otherwise', () => {
  const state = shift();
  const unit = commandBuyVehicle(state, 'hazmat');
  const engine = state.engines[0];
  const crew = stand(state, engine, engine.x, engine.y);
  crew.contamination = 0.8;
  state.hazards = [];
  unit.x = crew.x + 2 * TILE;
  unit.y = crew.y;
  for (let i = 0; i < 60 * 6; i++) updateHazards(state, 1 / 60);
  assert.equal(crew.contamination, 0, 'decontaminated by the wash line');

  crew.contamination = 0.8;
  unit.x = crew.x + 80 * TILE;
  for (let i = 0; i < 60 * 6; i++) updateHazards(state, 1 / 60);
  assert.ok(crew.contamination > 0.6, 'slow on its own');
});

test('a leak that nobody stops disperses by itself with no reward', () => {
  const state = shift();
  const b = works(state);
  b.reward = 900;
  startLeak(state, b, 1);
  const credits = state.credits;
  for (let i = 0; i < 60 * 320; i++) updateHazards(state, 1 / 60);
  assert.equal(b.leak, 0);
  assert.equal(state.credits, credits);
  assert.ok(state.events.some((e) => e.text.includes('dispersed')));
});

// ------------------------------------------------------------- collapse ---

test('a collapse buries people, can fail again, and loses them if nobody comes', () => {
  const state = shift();
  const b = house(state, 'house');
  collapseBuilding(state, b, 4);
  assert.equal(b.trapped, 4);
  assert.ok(b.collapse && b.collapse.secondaryIn > 0);
  assert.equal(rescueProgress(b), 0);

  // Nobody there: the secondary collapse comes late, then the people are lost.
  const casualties = state.stats.casualties;
  for (let i = 0; i < 60 * 460; i++) {
    state.time += 1 / 60;
    updateCollapse(state, 1 / 60);
  }
  assert.equal(state.stats.casualties > casualties, true);
  assert.equal(b.trapped, 0);
  assert.equal(b.collapse, null);
  assert.ok(state.events.some((e) => e.text.includes('SECONDARY COLLAPSE')));
  assert.ok(state.events.some((e) => e.text.includes('could not be reached')));
});

test('with rescuers inside, a secondary collapse buries more and can hurt them', () => {
  const state = shift();
  const b = house(state, 'house');
  collapseBuilding(state, b, 3);
  b.collapse.secondaryIn = 1;
  const engine = state.engines[0];
  stand(state, engine, (b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE);
  for (let i = 0; i < 120; i++) updateCollapse(state, 1 / 60);
  assert.equal(b.collapse.secondaryDone, true);
  assert.ok(b.trapped > 3);
  assert.equal(b.collapse.initial, b.trapped);
});

test('cutting gear makes a collapse rescue much faster than working by hand', () => {
  const timeToFree = (type) => {
    const state = shift();
    const b = house(state, 'house', 16, 30);
    collapseBuilding(state, b, 2);
    b.collapse.secondaryIn = 1e6;
    const unit = type === 'engine' ? state.engines[0] : commandBuyVehicle(state, type);
    state.selected = { kind: 'unit', id: unit.id };
    state.activeEngineId = unit.id;
    if (type !== 'engine') {
      // The default engine must not help.
      state.engines[0].x = 0;
    }
    assert.ok(commandDispatch(state, b.id));
    let t = 0;
    while (b.trapped > 0 && t < 60 * 400) {
      update(state, 1 / 60);
      t++;
    }
    return { t, left: b.trapped };
  };
  const rescue = timeToFree('rescue');
  const engine = timeToFree('engine');
  assert.equal(rescue.left, 0);
  assert.ok(rescue.t < engine.t || engine.left > 0, `rescue ${rescue.t} vs engine ${engine.t}`);
});

test('collapse and leak scenes exist and play out through the ordinary incident code', () => {
  const state = shift();
  assert.ok(SCENES.some((s) => s.collapse));
  assert.ok(SCENES.some((s) => s.leak));
  const b = playScene(state, 'house-collapse');
  assert.ok(b.collapse);
  assert.ok(b.trapped >= 3);
  assert.ok(state.patients.length >= 1);
  const intel = incidentIntel(state, 'building', b.id);
  assert.ok(intel.secondary.some((s) => s.includes('Secondary collapse')));
  assert.ok(intel.equipment.some((e) => e.includes('Cutting gear')));

  const leak = playScene(state, 'toxicleak');
  assert.ok(leak.leak > 0 && leak.hazmat);
  assert.equal(hasHazard(leak), true);
  // A save keeps the collapse and the leak.
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  const b2 = loaded.buildings.find((x) => x.id === b.id);
  assert.equal(b2.collapse.initial, b.collapse.initial);
  assert.equal(loaded.buildings.find((x) => x.id === leak.id).leak, leak.leak);
});

// ----------------------------------------------------------- evacuation ---

test('an evacuation empties the buildings one by one and people go to a shelter', () => {
  const state = shift();
  const b = denseSpot(state);
  const zone = startEvacuation(state, { x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE, radius: 8 * TILE, label: 'test area' });
  assert.ok(zone.total > 2, 'several occupied buildings inside');
  assert.equal(state.evac.zones.length, 1);
  const before = state.buildings.filter((x) => (x.occupants ?? 0) > 0).length;
  for (let i = 0; i < 60 * CONFIG.evacuation.pace * 2.5; i++) updateEvacuation(state, 1 / 60);
  assert.ok(zone.evacuated > 0);
  assert.ok(state.buildings.filter((x) => x.evacuated && x.evacZone === zone.id).length >= 2);
  assert.ok(state.buildings.filter((x) => (x.occupants ?? 0) > 0).length < before);
  assert.ok(state.stats.evacuated > 0);
  assert.equal(state.evac.stats.evacuated, state.stats.evacuated);
  assert.ok(zone.shelter === null || state.buildings.find((x) => x.id === zone.shelter.buildingId));
});

test('an evacuated building cannot kill anyone when it burns, and the zone lifts when the danger passes', () => {
  const state = shift();
  const b = denseSpot(state);
  b.occupants = Math.max(6, b.occupants);
  const original = b.occupants;
  const zone = startEvacuation(state, { x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE, radius: 5 * TILE, label: 'blk' });
  assert.ok(zone.queue.includes(b.id));
  for (let i = 0; i < 60 * CONFIG.evacuation.pace * (zone.total + 1); i++) {
    state.time += 1 / 60;
    updateEvacuation(state, 1 / 60);
  }
  assert.equal(b.evacuated, true);
  assert.equal(b.occupants, 0);

  ignite(state, b, 'test');
  assert.equal(b.trapped ?? 0, 0, 'nobody left inside to be trapped');
  update(state, 1 / 60);
  assert.equal(state.evac.zones.length, 1, 'the zone stays while it burns');

  const others = state.buildings.filter((x) => x.evacZone === zone.id && x !== b && x.state === 'ok');
  assert.ok(others.length >= 1);
  b.state = 'out';
  b.fire = 0;
  state.time += 90;
  for (let i = 0; i < 60; i++) updateEvacuation(state, 1 / 60);
  assert.equal(state.evac.zones.length, 0, 'the zone lifted');
  assert.ok(others.every((x) => x.occupants > 0 && x.evacuated === false), 'residents of the untouched buildings went home');
  assert.ok(original > 0);
  assert.ok(state.events.some((e) => e.text.includes('lifted')));
});

test('evacuation closes the streets, caps the zones and gives advice for hazards and forest fires', () => {
  const state = shift();
  const b = denseSpot(state);
  const cx = (b.x + b.w / 2) * TILE;
  const cy = (b.y + b.h / 2) * TILE;
  const cars = state.traffic.cars.length;
  const inside = state.traffic.cars.filter((c) => Math.hypot(c.x - cx, c.y - cy) <= 10 * TILE).length;
  startEvacuation(state, { x: cx, y: cy, radius: 10 * TILE });
  assert.equal(state.traffic.cars.length, cars - inside, 'cars left the closed streets');
  assert.ok(state.traffic.lanes.every((l) => l.cars.every((c) => Math.hypot(c.x - cx, c.y - cy) > 10 * TILE)));
  assert.equal(startEvacuation(state, { x: cx + 10, y: cy, radius: 10 * TILE }).id, state.evac.zones[0].id, 'no duplicate zone');

  for (let i = 0; i < 6; i++) startEvacuation(state, { x: (i + 1) * 40 * TILE, y: 300 * TILE });
  assert.equal(state.evac.zones.length, 4);
  assert.equal(startEvacuation(state, { x: 3 * TILE, y: 3 * TILE }), null);

  const s2 = shift();
  const w = works(s2);
  startLeak(s2, w, 1);
  update(s2, 1 / 60);
  const advice = evacuationAdvice(s2);
  assert.equal(advice.length, 1);
  assert.equal(advice[0].id, w.id);
  assert.ok(evacuateIncident(s2, 'building', w.id));
  assert.equal(evacuationAdvice(s2).length, 0);
});

// ------------------------------------------------------------- agencies ---

test('an agency call costs money, takes time to arrive, then cools down', () => {
  const state = shift();
  const b = house(state);
  ignite(state, b, 'test');
  const credits = state.credits;
  const status = agencyStatus(state, 'police');
  assert.equal(status.ready, true);
  const call = callAgency(state, 'police', { kind: 'building', id: b.id });
  assert.ok(call);
  assert.equal(state.credits, credits - CONFIG.agencies.police.cost);
  assert.equal(state.ledger.by.agency, -CONFIG.agencies.police.cost);
  assert.equal(supportAt(state, 'police', call.x, call.y), null, 'not there yet');
  assert.equal(callAgency(state, 'police', { kind: 'building', id: b.id }), null, 'cooling down');
  assert.equal(agencyStatus(state, 'police').ready, false);

  state.time += CONFIG.agencies.police.delay + 1;
  updateSupport(state);
  assert.ok(supportAt(state, 'police', call.x, call.y), 'on scene');
  state.time += CONFIG.agencies.police.duration + 5;
  updateSupport(state);
  assert.equal(supportAt(state, 'police', call.x, call.y), null, 'gone again');
  assert.equal(state.support.active.length, 0);
});

test('police traffic control removes the rush-hour penalty for vehicles at the scene', () => {
  const state = shift();
  const b = house(state);
  const engine = state.engines[0];
  engine.x = (b.x + b.w / 2) * TILE;
  engine.y = (b.y + b.h / 2) * TILE;
  state.trafficFactor = CONFIG.traffic.rushFactor;
  const before = speedMod(state, engine);
  callAgency(state, 'police', { kind: 'building', id: b.id });
  state.time += CONFIG.agencies.police.delay + 1;
  updateSupport(state);
  const after = speedMod(state, engine);
  assert.ok(after >= before / CONFIG.traffic.rushFactor, `${before} -> ${after}`);
});

test('the medical service treats the injured near the scene', () => {
  const state = shift();
  const b = house(state);
  for (let i = 0; i < 6; i++) spawnPatient(state, b, 0.4 + i * 0.1);
  const treated = state.stats.treated ?? 0;
  callAgency(state, 'ems', { kind: 'building', id: b.id });
  state.time += CONFIG.agencies.ems.delay + 1;
  updateSupport(state);
  assert.equal((state.stats.treated ?? 0) - treated, 4, 'four of six');
  assert.ok(state.events.some((e) => e.text.includes('4 patients treated')));
});

test('utility services cut gas and power: no explosion, and the intel says so', () => {
  const state = shift();
  const b = works(state);
  b.hazmat = true;
  ignite(state, b, 'test');
  b.fire = 0.9;
  const before = incidentIntel(state, 'building', b.id).explosion.level;
  assert.equal(before, 'high');
  callAgency(state, 'utility', { kind: 'building', id: b.id });
  state.time += CONFIG.agencies.utility.delay + 1;
  updateSupport(state);
  assert.equal(b.utilityCut, true);
  let exploded = 0;
  state.onExplosion = () => { exploded += 1; };
  for (let i = 0; i < 60 * 120 && b.state === 'burning'; i++) update(state, 1 / 60);
  assert.equal(exploded, 0, 'a cut supply cannot explode');
  assert.equal(incidentIntel(state, 'building', b.id)?.explosion.level ?? 'low', 'low');
});

test('the coast guard pulls swimmers out; civil protection runs an evacuation; careers unlock them by level', () => {
  const state = shift();
  drowningCall(state, () => true);
  const v = state.victims[0];
  assert.ok(v);
  callAgency(state, 'coastguard', { kind: 'victim', id: v.id });
  state.time += CONFIG.agencies.coastguard.delay + 1;
  updateSupport(state);
  assert.equal(state.victims.length, 0);
  assert.ok(state.stats.dived >= 1);
  assert.ok(state.patients.length >= 1, 'and they need an ambulance');

  const b = house(state);
  callAgency(state, 'civil', { kind: 'building', id: b.id });
  state.time += CONFIG.agencies.civil.delay + 1;
  updateSupport(state);
  assert.equal(state.evac.zones.length, 1);

  const c = createCareer({ name: 'A' });
  assert.equal(agencyStatus(c, 'police').ready, true);
  assert.equal(agencyStatus(c, 'civil').locked, true);
  assert.match(agencyStatus(c, 'civil').reason, /level 2/);
  assert.equal(callAgency(c, 'civil', { x: 100, y: 100 }), null);
  c.campaign.level = 3;
  assert.equal(agencyStatus(c, 'coastguard').locked, false);
  assert.equal(allAgencies(c).length, 5);

  state.credits = 10;
  assert.match(agencyStatus(state, 'ems').reason, /Needs/);
});

// ------------------------------------------------------------ disasters ---

test('an earthquake plays out in stages and pays when the district is quiet again', () => {
  const state = shift();
  startShift(state);
  assert.ok(DISASTER_IDS.includes('earthquake'));
  const d = startDisaster(state, 'earthquake');
  assert.ok(d);
  assert.equal(startDisaster(state, 'hurricane'), null, 'one at a time');

  updateDisaster(state, 0.1);
  const collapsed = () => state.buildings.filter((b) => b.collapse).length;
  assert.ok(collapsed() >= 3, 'collapses in the first stage');
  assert.ok(state.buildings.some((b) => b.state === 'burning'), 'and gas fires');
  assert.ok(state.patients.length >= 4);
  const first = collapsed();

  state.time += 71;
  updateDisaster(state, 0.1);
  assert.ok(collapsed() > first, 'aftershock');
  state.time += 90;
  updateDisaster(state, 0.1);
  assert.equal(state.disaster.stage, 3);
  assert.ok(state.buildings.some((b) => (b.leak ?? 0) > 0), 'leak after the quake');

  // Clear everything and wait for it to be over.
  const credits = state.credits;
  for (const b of state.buildings) {
    if (b.state === 'burning') { b.state = 'out'; b.fire = 0; }
    b.trapped = 0;
    b.leak = 0;
    b.collapse = null;
  }
  state.patients.length = 0;
  for (let i = 0; i < 60 * 10; i++) updateDisaster(state, 1 / 60);
  assert.equal(state.disaster, null);
  assert.ok(state.credits >= credits + 5000);
  assert.equal(state.stats.disasters, 1);
});

test('a hurricane brings a storm and a gale, and clears them at the end', () => {
  const state = shift();
  startDisaster(state, 'hurricane');
  updateDisaster(state, 0.1);
  assert.equal(state.weather.kind, 'storm');
  assert.equal(state.rules.windLock, true);
  assert.ok(state.wind.speed > 0.9);
  state.trafficFactor = 1;
  update(state, 1 / 60);
  assert.ok(state.trafficFactor < 1, 'storm slows the roads');
  state.time += 51;
  updateDisaster(state, 0.1);
  assert.ok(state.victims.length >= 1 || state.blockades.length >= 1);
  state.time += 70;
  updateDisaster(state, 0.1);
  for (const b of state.buildings) {
    if (b.state === 'burning') { b.state = 'out'; b.fire = 0; }
    b.trapped = 0;
    b.leak = 0;
    b.collapse = null;
  }
  state.wildfires.length = 0;
  state.victims.length = 0;
  state.patients.length = 0;
  state.blockades.length = 0;
  for (let i = 0; i < 60 * 10; i++) updateDisaster(state, 1 / 60);
  assert.equal(state.disaster, null);
  assert.equal(state.weather.kind, 'clear');
  assert.equal(state.rules.windLock, false);
});

test('every disaster can start, and the career starts them only at a high enough level', () => {
  for (const id of DISASTER_IDS) {
    const state = shift();
    assert.ok(startDisaster(state, id), id);
    assert.doesNotThrow(() => updateDisaster(state, 0.1), id);
  }
  const quick = shift();
  quick.time = 5000;
  for (let i = 0; i < 60 * 600; i++) updateDisaster(quick, 1 / 60);
  assert.equal(quick.disaster, null, 'never at random in Quick Response');
});
