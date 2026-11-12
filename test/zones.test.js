import test from 'node:test';
import assert from 'node:assert/strict';

import { createCity, V_ROADS, H_ROADS, SEA_Y, riverCentre } from '../src/data/city.js';
import { buildNav, passable } from '../src/systems/grid.js';
import { createGame, startShift } from '../src/systems/game.js';
import { updateIncidents } from '../src/systems/incidents.js';
import { updateFire } from '../src/systems/fire.js';

const city = createCity(7);

test('streets are not evenly spaced, but the anchors stay put', () => {
  const gaps = (lines) => new Set(lines.slice(1).map((v, i) => v - lines[i]));
  assert.ok(gaps(V_ROADS).size >= 5, 'avenues are all the same distance apart');
  assert.ok(gaps(H_ROADS).size >= 4, 'streets are all the same distance apart');
  // The original quarter, Station 2's block, the river banks and the quay.
  assert.deepEqual(V_ROADS.slice(0, 3), [12, 42, 72]);
  assert.deepEqual(H_ROADS.slice(0, 3), [12, 36, 60]);
  assert.equal(V_ROADS[11], 342);
  assert.equal(V_ROADS[12], 372);
  assert.equal(H_ROADS[14], SEA_Y - 2);
  for (let i = 1; i < V_ROADS.length; i++) assert.ok(V_ROADS[i] - V_ROADS[i - 1] >= 22);
  for (let i = 1; i < H_ROADS.length; i++) assert.ok(H_ROADS[i] - H_ROADS[i - 1] >= 20);
});

test('some blocks are merged into bigger ones, with the street between them taken out', () => {
  const merged = city.blocks.filter((b) => b.merged);
  assert.ok(merged.length >= 4, 'no merged blocks: ' + merged.length);
  const spans = city.roadRuns.v.some((r) => r.spans.length > 1) || city.roadRuns.h.some((r) => r.spans.length > 1);
  assert.ok(spans, 'no street was broken up');
});

test('every street that is left can still be driven from Station 1', () => {
  const nav = buildNav(city);
  const bay = city.bays[0];
  const start = { x: Math.floor(bay.x / 32), y: Math.floor(bay.y / 32) };
  const seen = new Uint8Array(city.w * city.h);
  const queue = [start.y * city.w + start.x];
  seen[queue[0]] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % city.w;
    const y = Math.floor(i / city.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!passable(nav, 'drive', nx, ny) || seen[ny * city.w + nx]) continue;
      seen[ny * city.w + nx] = 1;
      queue.push(ny * city.w + nx);
    }
  }
  let roads = 0;
  let reached = 0;
  for (let i = 0; i < city.w * city.h; i++) {
    if (nav.drive[i] !== 1) continue;
    roads++;
    if (seen[i]) reached++;
  }
  assert.ok(reached / roads > 0.995, `only ${reached} of ${roads} road tiles can be reached`);
  // Every station's apron (the dock's is the quay; its berths are on the water).
  for (const st of city.stations) {
    const a = st.apron;
    assert.equal(seen[Math.floor((a.y0 + a.y1) / 2) * city.w + Math.floor((a.x0 + a.x1) / 2)], 1, st.name + ' is cut off');
  }
});

test('the city has housing, business, shopping and industrial districts', () => {
  const zones = {};
  for (const b of city.buildings) zones[b.zone] = (zones[b.zone] ?? 0) + 1;
  for (const z of ['housing', 'company', 'commercial', 'industrial']) assert.ok(zones[z] >= 60, `${z}: ${zones[z]}`);
  // Each district has its own kinds of building.
  const types = (zone) => new Set(city.buildings.filter((b) => b.zone === zone).map((b) => b.type));
  assert.ok(types('housing').has('house'));
  assert.ok(!types('company').has('house') && !types('company').has('warehouse'));
  assert.ok(types('industrial').has('warehouse') && !types('industrial').has('house'));
  assert.ok(!types('housing').has('warehouse'));
});

test('industry sits by the water: the quay in the south and the river banks', () => {
  const industrial = city.buildings.filter((b) => b.zone === 'industrial');
  const byWater = industrial.filter((b) => {
    const cy = b.y + b.h / 2;
    const cx = b.x + b.w / 2;
    return SEA_Y - cy < 80 || Math.abs(cx - riverCentre(cy)) < 50;
  });
  assert.ok(byWater.length / industrial.length > 0.97, `${byWater.length} of ${industrial.length} industrial buildings are by water`);
  assert.ok(industrial.some((b) => b.waterfront), 'no industrial building is on the waterfront');
  // And the housing is not.
  const housing = city.buildings.filter((b) => b.zone === 'housing');
  assert.ok(housing.filter((b) => b.waterfront).length / housing.length < 0.15);
});

test('blocks differ in size and buildings differ in size', () => {
  const sizes = new Set(city.buildings.filter((b) => b.type === 'house').map((b) => b.w + 'x' + b.h));
  assert.ok(sizes.size >= 6, 'house sizes: ' + [...sizes]);
  const blockSizes = new Set(city.blocks.map((b) => (b.x1 - b.x0) + 'x' + (b.y1 - b.y0)));
  assert.ok(blockSizes.size >= 15, 'block sizes: ' + blockSizes.size);
});

// ----------------------------------------------------- district events ---

/** Run the incident generator over and over and see which stories come up. */
function stories({ big = false, runs = 500, seed = 7 } = {}) {
  const state = createGame(seed);
  startShift(state);
  state.ownedStations = [true, true, true];
  state.time = 880; // late in the cycle: a wide coverage radius
  state.cycleIndex = Math.floor(state.time / 900);
  const labels = new Map();
  const events = new Set();
  for (let i = 0; i < runs; i++) {
    state.nextCallAt = 0;
    state.nextBigAt = big ? 0 : 1e9;
    for (const b of state.buildings) {
      b.state = 'ok'; b.fire = 0; b.trapped = 0; b.incidentLabel = null; b.big = false; b.hazmat = false;
    }
    state.patients = [];
    state.blockades = [];
    state.victims = [];
    state.wildfires = [];
    updateIncidents(state, 0.01);
    for (const b of state.buildings) {
      if (b.incidentLabel) labels.set(b.incidentLabel, (labels.get(b.incidentLabel) ?? 0) + 1);
    }
    for (const e of state.events.slice(0, 6)) events.add(e.text);
  }
  return { labels, events, state };
}

test('calls differ by district: kitchen fires in the housing, trapped staff in the offices, chemicals in industry', () => {
  const { labels } = stories();
  for (const wanted of ['Kitchen fire', 'Apartment block fire', 'Office fire', 'Chemical fire', 'Lift rescue']) {
    assert.ok(labels.has(wanted), `never saw "${wanted}": ${[...labels.keys()]}`);
  }
  assert.ok(labels.size >= 8, 'too few kinds of call: ' + [...labels.keys()]);
});

test('major incidents come from the industrial estates and the business towers', () => {
  const { labels } = stories({ big: true, runs: 300 });
  assert.ok([...labels.keys()].some((k) => /fuel depot|Industrial fire/.test(k)), 'no industrial major incident: ' + [...labels.keys()]);
  assert.ok(labels.has('High-rise fire'), 'no high-rise fire: ' + [...labels.keys()]);
});

test('a chemical fire spreads further than an ordinary one', () => {
  const state = createGame(7);
  startShift(state);
  const warehouse = state.buildings.find((b) => b.type === 'warehouse');
  assert.equal(warehouse.zone, 'industrial');
  const spreadFrom = (hazmat) => {
    let n = 0;
    for (let trial = 0; trial < 30; trial++) {
      for (const b of state.buildings) {
        b.state = 'ok'; b.fire = 0; b.dryTime = 0; b.spreadTimer = 3;
      }
      warehouse.hazmat = hazmat;
      warehouse.exploded = true; // no blast: just the spread
      warehouse.state = 'burning';
      warehouse.integrity = warehouse.maxIntegrity = 1e9;
      for (let i = 0; i < 30 * 25; i++) {
        warehouse.fire = 0.9;
        state.streams.length = 0;
        updateFire(state, 1 / 30);
      }
      n += state.buildings.filter((b) => b !== warehouse && b.state === 'burning').length;
    }
    return n;
  };
  const plain = spreadFrom(false);
  const chemical = spreadFrom(true);
  assert.ok(chemical > plain, `chemical ${chemical} vs plain ${plain}`);
});
