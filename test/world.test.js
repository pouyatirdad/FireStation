import test from 'node:test';
import assert from 'node:assert/strict';

import { createCity, CITY_W, CITY_H, V_ROADS, H_ROADS } from '../src/data/city.js';
import { createGame, startShift, update } from '../src/systems/game.js';
import { coverageRadius } from '../src/systems/incidents.js';
import { createAudio, eventSound } from '../src/systems/audio.js';
import { daylight } from '../src/render/render.js';
import { CONFIG } from '../src/core/config.js';

const city = createCity(7);

test('the map is ten times the area of the 520x384 city it grew from', () => {
  const ratio = (CITY_W * CITY_H) / (520 * 384);
  assert.ok(ratio >= 9.5 && ratio < 11, `area ratio ${ratio.toFixed(2)}`);
  assert.equal(city.w, CITY_W);
  assert.equal(city.h, CITY_H);
  assert.equal(V_ROADS.length, 55);
  assert.equal(H_ROADS.length, 48);
});

test('the big city has the buildings, hydrants, forests and pharmacies to fill it', () => {
  assert.ok(city.buildings.length >= 1000, `${city.buildings.length} buildings`);
  assert.ok(city.hydrants.length >= 400, `${city.hydrants.length} hydrants`);
  assert.ok(city.forestTiles.length >= 8000, `${city.forestTiles.length} forest tiles`);
  assert.ok(city.forestAreas.length >= 8, `${city.forestAreas.length} forest blocks`);
  assert.ok(city.pharmacies.length >= 40, `${city.pharmacies.length} pharmacies`);
  assert.ok(city.pharmacies.every((b) => b.type === 'pharmacy'));
  assert.ok(city.districts.length >= 12);
});

test('Station 1 is where it always was, with a pharmacy a short drive away', () => {
  assert.equal(city.station.x, 50);
  assert.equal(city.station.y, 44);
  const near = city.pharmacies.filter(
    (b) => Math.hypot(b.x - city.station.x, b.y - city.station.y) < 40,
  );
  assert.ok(near.length >= 1, 'no pharmacy within 40 tiles of the station');
});

test('the same seed builds the same city', () => {
  const again = createCity(7);
  assert.equal(again.buildings.length, city.buildings.length);
  assert.equal(again.buildings[500].name, city.buildings[500].name);
});

test('early calls come from near the station and the covered area grows', () => {
  const state = createGame(7);
  startShift(state);
  const start = coverageRadius(state);
  state.time = CONFIG.incidents.cycle - 100;
  assert.ok(coverageRadius(state) > start + 100);

  state.time = 0;
  state.nextCallAt = 0.1;
  state.nextBigAt = 99999;
  const st = state.city.station;
  const seen = [];
  for (let i = 0; i < 4000 && seen.length < 12; i++) {
    update(state, 1 / 30);
    for (const b of state.buildings) {
      if (b.state === 'burning' && !seen.includes(b.id)) seen.push(b.id);
    }
    // Keep the clock early so the radius stays small.
    state.time = Math.min(state.time, 60);
  }
  assert.ok(seen.length > 0, 'no calls arrived');
  for (const id of seen) {
    const b = state.buildings.find((x) => x.id === id);
    const d = Math.hypot(b.x - st.x, b.y - st.y);
    // Fires may spread a little from the original call; allow the reach of a block.
    assert.ok(d <= coverageRadius(state) + 40, `${b.name} is ${d.toFixed(0)} tiles away`);
  }
});

test('events map to sounds: alarms, klaxons, chimes and the collapse boom', () => {
  assert.equal(eventSound({ tone: 'big', text: 'MAJOR INCIDENT' }), 'klaxon');
  assert.equal(eventSound({ tone: 'fire', text: 'Structure fire — Bell’s Bakery' }), 'alarm');
  assert.equal(eventSound({ tone: 'fire', text: 'Fire spread — Maple Court' }), 'warn');
  assert.equal(eventSound({ tone: 'bad', text: 'Building lost — Maple Court' }), 'boom');
  assert.equal(eventSound({ tone: 'bad', text: '2 people trapped in X' }), 'bad');
  assert.equal(eventSound({ tone: 'good', text: 'Incident closed — $600' }), 'cash');
  assert.equal(eventSound({ tone: 'good', text: 'Engine 1: supply line connected' }), 'clunk');
  assert.equal(eventSound({ tone: 'good', text: 'All clear at X' }), 'chime');
  assert.equal(eventSound({ tone: 'warn', text: 'Injured person near X — ambulance needed' }), 'medic');
  assert.equal(eventSound({ tone: 'warn', text: 'Engine 1 water low' }), 'warn');
  assert.equal(eventSound({ tone: 'info', text: 'Shift saved' }), null);
  assert.equal(eventSound(null), null);
});

test('audio is inert without a browser (no AudioContext) and never throws', () => {
  const audio = createAudio();
  assert.equal(audio.supported, false);
  assert.equal(audio.unlock(), false);
  const state = createGame(7);
  audio.update(state, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
  audio.play('alarm');
});

test('night falls after dusk and lifts at dawn', () => {
  assert.equal(daylight(7 * 60), 0);
  assert.equal(daylight(12 * 60), 0);
  assert.equal(daylight(19.5 * 60), 0.5);
  assert.equal(daylight(23 * 60), 1);
  assert.equal(daylight(3 * 60), 1);
  assert.equal(daylight(6 * 60), 0.5);
  assert.equal(daylight((24 + 12) * 60), 0, 'the clock keeps counting past midnight');
  assert.ok(CONFIG.clockStart === 7 * 60);
});
