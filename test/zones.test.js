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
  assert.equal(H_ROADS[14], 348);
  assert.equal(H_ROADS[H_ROADS.length - 1], SEA_Y - 2);
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

test('industry sits by the sea; the river banks are commercial', () => {
  const industrial = city.buildings.filter((b) => b.zone === 'industrial');
  assert.ok(industrial.length >= 40);
  const bySea = industrial.filter((b) => SEA_Y - (b.y + b.h / 2) < 90);
  // Most of it is on the waterfront belts; the rest is industrial parks out on the edge of town.
  assert.ok(bySea.length / industrial.length >= 0.4, 'not enough industry by the sea: ' + bySea.length + ' of ' + industrial.length);
  assert.ok(industrial.some((b) => b.waterfront), 'no industrial building is on the waterfront');
  // Along the river: shops, offices, hotels, towers.
  const river = city.buildings.filter((b) => {
    const cy = b.y + b.h / 2;
    return Math.abs(b.x + b.w / 2 - riverCentre(cy)) < 28 && cy < SEA_Y - 60;
  });
  const commercial = river.filter((b) => b.zone === 'commercial' || b.zone === 'company');
  assert.ok(river.length >= 40 && commercial.length / river.length > 0.8, `${commercial.length} of ${river.length} by the river are commercial`);
  // And the housing is not on the water.
  const housing = city.buildings.filter((b) => b.zone === 'housing');
  assert.ok(housing.filter((b) => b.waterfront).length / housing.length < 0.15);
});

test('housing west of the river is apartment blocks, east of it villas', () => {
  const side = (b) => (b.x + b.w / 2 < riverCentre(b.y + b.h / 2) ? 'west' : 'east');
  const west = city.buildings.filter((b) => b.zone === 'housing' && side(b) === 'west' && b.x + b.w / 2 > riverCentre(b.y + b.h / 2) - 170);
  // The villas are the original strip east of the river; further out is ordinary suburb.
  const east = city.buildings.filter((b) => b.zone === 'housing' && side(b) === 'east' && b.x + b.w / 2 < riverCentre(b.y + b.h / 2) + 165 && b.y < 360);
  const share = (list, type) => list.filter((b) => b.type === type).length / list.length;
  assert.ok(west.length >= 40 && share(west, 'apartment') > 0.6, 'west apartments: ' + share(west, 'apartment'));
  assert.ok(east.length >= 10 && share(east, 'villa') > 0.5, 'east villas: ' + share(east, 'villa'));
  assert.ok(city.buildings.filter((b) => b.type === 'villa').every((b) => side(b) === 'east'), 'a villa west of the river');
  // A villa is a big house with a garden.
  const villas = city.buildings.filter((b) => b.type === 'villa');
  assert.ok(villas.every((b) => b.w >= 6 && b.h >= 6 && b.floors >= 2));
});

test('the very large building types exist, each in its own district', () => {
  const of = (type) => city.buildings.filter((b) => b.type === type);
  // (The airports' control towers are towers too, but short and civic.)
  const towers = of('tower').filter((b) => !/Control Tower/.test(b.name));
  assert.ok(towers.length >= 10 && towers.every((b) => b.zone === 'company' && b.floors >= 12), 'towers');
  assert.ok(of('mall').length >= 2 && of('mall').every((b) => b.w >= 14 && b.h >= 10), 'malls');
  assert.ok(of('factory').length >= 5 && of('factory').every((b) => b.zone === 'industrial'), 'factories');
  const farms = of('tankfarm').filter((b) => !/Fuel Farm/.test(b.name)); // the airports keep fuel of their own
  assert.ok(farms.length >= 3 && farms.every((b) => b.zone === 'industrial' && b.waterfront && b.hazmat), 'tank farms by the sea');
  // Towers are the tallest things in the city.
  const tallest = Math.max(...city.buildings.map((b) => b.floors));
  assert.ok(tallest >= 20);
});

test('the map is about half small buildings, three in ten medium, one in eight large, one in twelve very large', () => {
  for (const seed of [7, 3, 11]) {
    const c = createCity(seed);
    const list = c.buildings.filter((b) => b.type !== 'station' && b.type !== 'hospital');
    const share = (cls) => list.filter((b) => b.sizeClass === cls).length / list.length;
    const near = (cls, want, tol = 0.025) => assert.ok(Math.abs(share(cls) - want) <= tol, `seed ${seed} ${cls}: ${(share(cls) * 100).toFixed(1)}%`);
    near('small', 0.5);
    near('medium', 0.3);
    near('large', 0.12);
    near('huge', 0.08);
    // The class really follows the size: a very large building is bigger than a small one.
    const mass = (b) => b.w * b.h * (0.7 + 0.15 * b.floors);
    const maxSmall = Math.max(...list.filter((b) => b.sizeClass === 'small').map(mass));
    const minHuge = Math.min(...list.filter((b) => b.sizeClass === 'huge').map(mass));
    assert.ok(maxSmall < 30 && minHuge >= 200);
  }
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
  // A works with a neighbour just inside a chemical fire's reach but outside an ordinary one's.
  const gap = (a, b) => Math.max(
    Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0),
    Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0),
  );
  const warehouse = state.buildings.find((b) => (b.type === 'warehouse' || b.type === 'factory')
    && state.buildings.some((o) => o !== b && o.type !== 'station' && gap(b, o) > 0 && gap(b, o) <= 2.6));
  assert.ok(warehouse, 'no works with a close neighbour');
  assert.equal(warehouse.zone, 'industrial');
  const spreadFrom = (hazmat) => {
    let n = 0;
    for (let trial = 0; trial < 120; trial++) {
      for (const b of state.buildings) {
        b.state = 'ok'; b.fire = 0; b.dryTime = 0; b.spreadTimer = 3;
      }
      warehouse.hazmat = hazmat;
      warehouse.exploded = true; // no blast: just the spread
      warehouse.state = 'burning';
      warehouse.integrity = warehouse.maxIntegrity = 1e9;
      for (let i = 0; i < 30 * 9; i++) {
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

test('curvy roads wind through some blocks, and no building sits on a road', () => {
  assert.ok(city.curves.length >= 10, 'curves: ' + city.curves.length);
  const onGrid = (x, y) => V_ROADS.some((v) => x >= v && x <= v + 1) || H_ROADS.some((h) => y >= h && y <= h + 1);
  let winding = 0;
  for (let y = 0; y < city.h; y++) {
    for (let x = 0; x < city.w; x++) if (city.road[y * city.w + x] && !onGrid(x, y)) winding++;
  }
  assert.ok(winding > 600, 'too little curvy road: ' + winding);
  // Each curve really bends: it is longer than the straight line between its ends.
  let bend = 0;
  for (const c of city.curves) {
    const first = c.pts[0];
    const last = c.pts[c.pts.length - 1];
    let length = 0;
    for (let i = 1; i < c.pts.length; i++) length += Math.hypot(c.pts[i].x - c.pts[i - 1].x, c.pts[i].y - c.pts[i - 1].y);
    const ratio = length / Math.hypot(last.x - first.x, last.y - first.y);
    assert.ok(ratio > 1.01, 'a curve that is a straight line: ' + ratio);
    bend += ratio;
  }
  assert.ok(bend / city.curves.length > 1.08, 'the curves hardly bend: ' + bend / city.curves.length);
  for (const b of city.buildings) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) assert.equal(city.road[y * city.w + x], 0, b.name + ' stands on a road');
    }
  }
});
