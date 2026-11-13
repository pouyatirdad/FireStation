import test from 'node:test';
import assert from 'node:assert/strict';

import { createCity } from '../src/data/city.js';
import { pointAt, trainsAt } from '../src/data/transit.js';

const city = createCity(7);
const lines = city.transit.lines;

test('there is a railway and two tram lines', () => {
  assert.ok(lines.some((l) => l.kind === 'rail'), 'no railway');
  assert.equal(lines.filter((l) => l.kind === 'tram').length, 2);
  const rail = lines.find((l) => l.kind === 'rail');
  assert.ok(rail.stops.length >= 2);
  assert.ok(rail.stops.every((s) => city.buildings.some((b) => b.id === s.building && b.type === 'railstation')), 'a rail stop is not at a railway station');
  for (const m of lines.filter((l) => l.kind === 'tram')) {
    assert.ok(m.stops.length >= 2);
    assert.ok(m.stops.every((s) => city.buildings.some((b) => b.id === s.building && b.type === 'tramstop')), 'a tram stop is not at a tram stop building');
  }
});

test('every line runs along streets', () => {
  for (const line of lines) {
    for (const p of line.pts) assert.equal(city.road[p.y * city.w + p.x], 1, `${line.name} leaves the street at ${p.x},${p.y}`);
    // Only straight runs between corners.
    for (let i = 1; i < line.pts.length; i++) assert.ok(line.pts[i].x === line.pts[i - 1].x || line.pts[i].y === line.pts[i - 1].y);
  }
});

test('trains run along the line, and are somewhere else a moment later', () => {
  for (const line of lines) {
    const a = trainsAt(line, 5);
    const b = trainsAt(line, 15);
    assert.equal(a.length, line.trains);
    assert.ok(line.trains >= 2);
    for (const train of a) {
      assert.equal(train.cars.length, line.cars);
      for (const car of train.cars) {
        assert.ok(car.x >= 0 && car.x < city.w && car.y >= 0 && car.y < city.h, 'a train off the map');
      }
    }
    assert.notEqual(`${a[0].cars[0].x},${a[0].cars[0].y}`, `${b[0].cars[0].x},${b[0].cars[0].y}`, `${line.name} is not moving`);
    // At the end of its run it turns round and comes back.
    const lap = (2 * line.length) / line.speed;
    const start = trainsAt(line, 0)[0].cars[0];
    const again = trainsAt(line, lap)[0].cars[0];
    assert.ok(Math.hypot(start.x - again.x, start.y - again.y) < 0.01, `${line.name} does not come back`);
  }
  const rail = lines.find((l) => l.kind === 'rail');
  const end = pointAt(rail, rail.length);
  assert.ok(Math.abs(end.x - (rail.pts[rail.pts.length - 1].x + 1)) < 1e-9);
});

test('streets with a tram are wider, and nothing is left standing on the new road', () => {
  const trams = lines.filter((l) => l.kind === 'tram');
  assert.ok(city.wide.length >= 4, 'no wide streets');
  let road = 0;
  let total = 0;
  for (const r of city.wide) {
    const w = r.x1 - r.x0 + 1;
    const h = r.y1 - r.y0 + 1;
    assert.ok(Math.min(w, h) === 4, `a boulevard ${Math.min(w, h)} tiles wide`);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        total++;
        if (city.road[y * city.w + x]) road++;
        assert.ok(!city.blocked[y * city.w + x] || !city.road[y * city.w + x], 'road under a building');
      }
    }
  }
  assert.ok(road / total > 0.9, `only ${Math.round((100 * road) / total)}% of the wide strips is road`);
  for (const h of city.hydrants) assert.ok(!city.road[h.y * city.w + h.x], 'a hydrant in the road');
  for (const t of city.trees) {
    const tx = Math.floor(t.x / 32);
    const ty = Math.floor(t.y / 32);
    if (!city.wide.some((r) => tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1)) continue;
    assert.ok(!city.road[ty * city.w + tx], 'a tree in the middle of a tram street');
  }
  assert.ok(trams.length === 2);
});
