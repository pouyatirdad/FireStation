import test from 'node:test';
import assert from 'node:assert/strict';

import { createCity, CITY_W, CITY_H } from '../src/data/city.js';
import { createGame, startShift, update, commandBuyStation, commandBuyVehicle, serialize, loadState } from '../src/systems/game.js';
import { buildNav, findPath, nearestPassable, passable } from '../src/systems/grid.js';
import { CONFIG, TILE } from '../src/core/config.js';

const city = createCity(7);

test('the map keeps its 520x384 size', () => {
  assert.equal(CITY_W, 520);
  assert.equal(CITY_H, 384);
  assert.equal(city.road.length, CITY_W * CITY_H);
});

test('there is one airport, with a runway, a terminal, hangars and a control tower', () => {
  assert.equal(city.airfields.length, 1);
  for (const f of city.airfields) {
    const r = f.runway;
    assert.ok(r.x1 - r.x0 >= 60, `${f.name} has a short runway`);
    assert.ok(f.x1 < CITY_W && f.y1 < CITY_H);
    for (let x = r.x0; x <= r.x1; x += 9) assert.equal(city.road[r.y0 * city.w + x], 1, 'runway is not paved');
    const by = (id) => city.buildings.find((b) => b.id === id);
    assert.equal(by(f.terminal).type, 'terminal');
    assert.equal(by(f.tower).type, 'tower');
    assert.ok(f.hangars.length >= 1 && f.hangars.every((id) => by(id).type === 'hangar'));
  }
});

test('the runways are part of the road network, so engines can drive onto the airfield', () => {
  const nav = buildNav(city);
  const bay = city.bays[0];
  const start = { x: Math.floor(bay.x / TILE), y: Math.floor(bay.y / TILE) };
  for (const f of city.airfields) {
    const goal = nearestPassable(nav, 'drive', f.runway.x0 + 20, f.runway.y0 + 1, 3);
    assert.ok(goal, 'no way onto the runway');
    const path = findPath(nav, 'drive', start, goal);
    assert.ok(path && path.length > 0, `${f.name} cannot be reached from Station 1`);
  }
});

test('the metro and the railway have stations in the business districts', () => {
  const of = (type) => city.buildings.filter((b) => b.type === type);
  assert.ok(of('metro').length >= 10, `${of('metro').length} metro entrances`);
  assert.ok(of('railstation').length >= 2, `${of('railstation').length} railway stations`);
  assert.ok(of('metro').every((b) => b.zone === 'company'));
  assert.ok(of('mall').length >= 3, `${of('mall').length} malls`);
});

test('regional fire stations are spread over the map, each with a base hospital', () => {
  const stations = city.stations;
  assert.ok(stations.length >= 9, `${stations.length} stations`);
  const land = stations.filter((st) => !st.sea);
  // Far apart: no two of the regional stations are closer than 40 tiles.
  const regional = stations.slice(3);
  for (let i = 0; i < regional.length; i++) {
    for (let j = i + 1; j < regional.length; j++) {
      const a = regional[i].building;
      const b = regional[j].building;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 40, `${regional[i].name} and ${regional[j].name} are close together`);
    }
  }
  assert.equal(city.hospitals.length, land.length);
  assert.ok(regional.some((st) => st.kind === 'airport'), 'no airport fire station');
  for (const st of stations) {
    assert.equal(st.building.stationIndex, stations.indexOf(st));
    assert.equal(st.bays.length, 16, st.name);
    // The apron is open ground and touches a street.
    const a = st.apron;
    if (st.sea) continue;
    let touchesRoad = false;
    for (let x = a.x0; x <= a.x1 && !touchesRoad; x++) if (city.road[(a.y1 + 1) * city.w + x]) touchesRoad = true;
    assert.ok(touchesRoad, `${st.name}'s apron does not meet a street`);
  }
});

test('a regional station can be bought, and vehicles are delivered to it', () => {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 100000;
  assert.equal(state.ownedStations.length, state.city.stations.length);
  assert.equal(commandBuyVehicle(state, 'engine', 3), null, 'a vehicle went to a station that is not open');
  const before = state.credits;
  assert.equal(commandBuyStation(state, 3), true);
  assert.equal(before - state.credits, CONFIG.economy.regionStationPrice);
  assert.equal(state.ownedStations[3], true);
  assert.equal(commandBuyStation(state, 3), false, 'bought twice');
  const engine = commandBuyVehicle(state, 'engine', 3);
  assert.ok(engine, 'no engine for the new station');
  assert.equal(state.city.bays[engine.bayIndex].station, 3);
  // The airport station costs more.
  const airport = state.city.stations.findIndex((st) => st.kind === 'airport');
  const credits = state.credits;
  assert.equal(commandBuyStation(state, airport), true);
  assert.equal(credits - state.credits, CONFIG.economy.airportStationPrice);
  const loaded = loadState(JSON.parse(JSON.stringify(serialize(state))));
  assert.equal(loaded.ownedStations[3], true);
  assert.equal(loaded.ownedStations[airport], true);
});

test('a call comes from the district of every station you own', () => {
  const state = createGame(7);
  startShift(state);
  state.time = 500;
  // Open a station far from Station 1 and the radius around it counts.
  const home = state.city.station;
  const far = state.city.stations.reduce((best, st, i) => (st.kind === 'region' && (best < 0 || Math.hypot(st.building.x - home.x, st.building.y - home.y) > Math.hypot(state.city.stations[best].building.x - home.x, state.city.stations[best].building.y - home.y)) ? i : best), -1);
  assert.ok(far > 0);
  state.ownedStations[far] = true;
  const st = state.city.stations[far].building;
  const seen = new Set();
  state.incidentsEnabled = true;
  for (let t = 0; t < 6000 && seen.size < 1; t++) {
    update(state, 1);
    for (const b of state.buildings) {
      if ((b.state === 'burning' || b.trapped > 0) && Math.hypot(b.x - st.x, b.y - st.y) < 150) seen.add(b.id);
    }
    state.time = 500 + (t % 300);
  }
  assert.ok(seen.size >= 1, 'no call ever came from the far district');
});

test('long drives are planned along the streets and stay quick', () => {
  const nav = buildNav(city);
  const from = { x: 52, y: 55 };
  for (const to of [{ x: 480, y: 40 }, { x: 330, y: 320 }, { x: 30, y: 330 }]) {
    const goal = nearestPassable(nav, 'drive', to.x, to.y, 8);
    assert.ok(goal, `nothing to drive to near ${to.x},${to.y}`);
    const t0 = Date.now();
    const path = findPath(nav, 'drive', from, goal);
    const took = Date.now() - t0;
    assert.ok(path && path.length > 0, `no route to ${to.x},${to.y}`);
    assert.ok(took < 1500, `the route to ${to.x},${to.y} took ${took} ms`);
    for (const t of path) assert.ok(passable(nav, 'drive', t.x, t.y), 'the route leaves the open ground');
    // Along streets it is no more than a little over the Manhattan distance.
    assert.ok(path.length < (Math.abs(goal.x - from.x) + Math.abs(goal.y - from.y)) * 1.35, 'the route is a long way round');
  }
});
