import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update } from '../src/systems/game.js';
import { SCENES, SCENE_COUNT, sceneFits } from '../src/systems/scenes.js';
import { playScene } from '../src/systems/incidents.js';
import { activeFires } from '../src/systems/fire.js';

function shift() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  // Every station open and well into a cycle: calls reach the whole map.
  state.ownedStations.fill(true);
  state.time = 800;
  return state;
}

test('there are more than fifty incident scenes, each complete', () => {
  assert.ok(SCENE_COUNT >= 50, `${SCENE_COUNT} scenes`);
  assert.equal(new Set(SCENES.map((s) => s.id)).size, SCENES.length, 'duplicate scene ids');
  for (const s of SCENES) {
    assert.ok(s.label, `${s.id} has no label`);
    if (s.site === 'water') assert.ok(s.what, `${s.id} says nothing about what happened`);
    else assert.equal(typeof s.text, 'function', `${s.id} has no text`);
    assert.ok(s.weight > 0, `${s.id} has no weight`);
    if (!s.site) assert.ok(Array.isArray(s.types) && s.types.length > 0, `${s.id} fits nothing`);
  }
});

test('the scenes cover homes, shops, offices, malls, industry, the airport, the railway, the metro, the woods, roads and water', () => {
  const types = new Set(SCENES.flatMap((s) => s.types ?? []));
  for (const t of ['house', 'apartment', 'shop', 'office', 'hotel', 'tower', 'mall', 'school', 'warehouse', 'factory', 'tankfarm', 'terminal', 'hangar', 'railstation', 'metro']) {
    assert.ok(types.has(t), `no scene for ${t}`);
  }
  const sites = new Set(SCENES.map((s) => s.site));
  for (const site of ['forest', 'road', 'water']) assert.ok(sites.has(site), `no ${site} scene`);
  assert.ok(SCENES.some((s) => s.big), 'no major scenes');
});

for (const scene of SCENES.filter((s) => !s.site)) {
  test(`scene "${scene.id}" plays out on a ${scene.types.join('/')}`, () => {
    const state = shift();
    const fits = state.buildings.filter((b) => sceneFits(scene, b));
    assert.ok(fits.length > 0, `no building in the city fits ${scene.id}`);
    const b = fits[Math.floor(fits.length / 2)];
    const patients = state.patients.length;
    const events = state.events.length;
    const made = playScene(state, scene.id, b);
    assert.equal(made, b);
    assert.equal(b.incidentLabel, scene.label);
    assert.ok(state.events.length > events, 'the dispatcher said nothing');
    if (scene.fire != null) assert.equal(b.state, 'burning', 'not alight');
    if (scene.trapped) assert.ok(b.trapped >= scene.trapped[0], `only ${b.trapped} trapped`);
    if (scene.hazmat) assert.equal(b.hazmat, true);
    if (scene.big) assert.equal(b.big, true);
    if (scene.hurt?.length) assert.ok(state.patients.length >= patients + 1, 'nobody was hurt');
    // The scene is a real incident: the game carries on with it.
    for (let i = 0; i < 90; i++) update(state, 1 / 30);
    if (scene.fire != null) assert.ok(activeFires(state).length >= 1 || b.state !== 'ok');
  });
}

test('forest, road and water scenes start their incidents', () => {
  for (const [id, check] of [
    ['campfire', (s) => s.wildfires.length >= 1],
    ['lightning', (s) => s.wildfires.length >= 1],
    ['arson-woods', (s) => s.wildfires.length >= 2],
    ['cigarette', (s) => s.wildfires.length >= 1],
    ['bus', (s) => s.blockades.length >= 1 && s.patients.length >= 4],
    ['tanker', (s) => s.blockades.some((b) => b.big)],
    ['truckfire', (s) => s.blockades.length >= 1],
    ['kayak', (s) => s.victims.length >= 1],
    ['carwater', (s) => s.victims.length >= 1],
  ]) {
    const state = shift();
    state.time = 1700; // a wide radius
    let made = null;
    for (let tries = 0; tries < 6 && !made; tries++) made = playScene(state, id);
    assert.ok(made, `scene ${id} found nowhere to happen`);
    assert.ok(check(state), `scene ${id} did not start what it should`);
  }
});

test('the incident generator draws on the scenes', () => {
  const state = createGame(7);
  startShift(state);
  state.ownedStations.fill(true);
  const labels = new Set();
  // Run a long, busy shift's worth of calls and see which stories come up.
  state.incidentsEnabled = true;
  for (let t = 0; t < 4000; t++) {
    update(state, 1);
    for (const b of state.buildings) {
      if (b.incidentLabel) labels.add(b.incidentLabel);
      if (b.state === 'burning' && t % 20 === 0) b.state = 'out'; // keep the map from filling with fires
    }
    if (labels.size >= 12) break;
  }
  assert.ok(labels.size >= 6, `only ${labels.size} different stories: ${[...labels].join(', ')}`);
});
