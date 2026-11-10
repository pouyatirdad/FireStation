import test from 'node:test';
import assert from 'node:assert/strict';

import { createCity, CITY_W, CITY_H } from '../src/data/city.js';
import { buildNav, findPath, passable, tileOf, standTileForRect, nearestPassable } from '../src/systems/grid.js';
import { TILE } from '../src/core/config.js';

const seed = 7;
const city = createCity(seed);
const nav = buildNav(city);
const spawnTile = tileOf(city.spawn.x, city.spawn.y);

test('the city has a station, buildings and hydrants', () => {
  assert.ok(city.buildings.length >= 100, `only ${city.buildings.length} buildings`);
  assert.equal(city.station.id, 'station');
  assert.ok(city.hydrants.length >= 20, `only ${city.hydrants.length} hydrants`);
  assert.ok(city.trees.length > 100);
});

test('every building sits inside the city and off the roads', () => {
  for (const b of city.buildings) {
    assert.ok(b.x >= 0 && b.y >= 0, `${b.name} starts outside the map`);
    assert.ok(b.x + b.w <= CITY_W && b.y + b.h <= CITY_H, `${b.name} runs off the map`);
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        assert.equal(city.road[y * CITY_W + x], 0, `${b.name} is built on the road at ${x},${y}`);
      }
    }
  }
});

test('buildings do not overlap each other', () => {
  for (let i = 0; i < city.buildings.length; i++) {
    for (let j = i + 1; j < city.buildings.length; j++) {
      const a = city.buildings[i];
      const b = city.buildings[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${a.name} overlaps ${b.name}`);
    }
  }
});

test('hydrants stand on walkable ground beside a street', () => {
  for (const h of city.hydrants) {
    assert.ok(passable(nav, 'walk', h.x, h.y), `hydrant ${h.x},${h.y} is inside something`);
    const touchesRoad =
      passable(nav, 'drive', h.x + 1, h.y) ||
      passable(nav, 'drive', h.x - 1, h.y) ||
      passable(nav, 'drive', h.x, h.y + 1) ||
      passable(nav, 'drive', h.x, h.y - 1);
    assert.ok(touchesRoad, `hydrant ${h.x},${h.y} is not beside a street`);
  }
});

test('the engine starts on the apron and can reach the street', () => {
  assert.ok(passable(nav, 'drive', spawnTile.x, spawnTile.y), 'spawn is not drivable');
  const roadTile = { x: spawnTile.x, y: 60 };
  const path = findPath(nav, 'drive', spawnTile, roadTile);
  assert.ok(path && path.length > 0, 'no way out of the station');
  for (const t of path) assert.ok(passable(nav, 'drive', t.x, t.y), 'path leaves the road');
});

test('the engine can reach every hydrant', () => {
  for (const h of city.hydrants) {
    const target = nearestPassable(nav, 'drive', h.x, h.y, 4);
    assert.ok(target, `no street near hydrant ${h.x},${h.y}`);
    const path = findPath(nav, 'drive', spawnTile, target);
    assert.ok(path, `hydrant ${h.x},${h.y} is unreachable by road`);
  }
});

test('a crew can walk from the station to every building', () => {
  for (const b of city.buildings) {
    const rect = { x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE };
    const stand = standTileForRect(nav, rect, city.spawn.x, city.spawn.y);
    assert.ok(stand, `no place to stand beside ${b.name}`);
    const path = findPath(nav, 'walk', spawnTile, stand);
    assert.ok(path, `crew cannot walk to ${b.name}`);
  }
});

test('the road network is one connected piece', () => {
  const total = city.road.reduce((sum, v) => sum + v, 0);
  const seen = new Uint8Array(CITY_W * CITY_H);
  const queue = [[spawnTile.x, 60]];
  seen[60 * CITY_W + spawnTile.x] = 1;
  let reached = 0;
  while (queue.length) {
    const [x, y] = queue.pop();
    reached++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= CITY_W || ny >= CITY_H) continue;
      const i = ny * CITY_W + nx;
      if (seen[i] || !city.road[i]) continue;
      seen[i] = 1;
      queue.push([nx, ny]);
    }
  }
  assert.equal(reached, total, `${total - reached} road tiles are cut off`);
});
