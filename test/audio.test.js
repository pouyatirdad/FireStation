import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift } from '../src/systems/game.js';
import { callAgency } from '../src/systems/agencies.js';
import { AGENCY_VOICE, SOUND_CATEGORIES, createAudio, eventSound } from '../src/systems/audio.js';
import { TILE } from '../src/core/config.js';

/** A recording stand-in for the Web Audio API, enough to run the synthesis code under Node. */
function installFakeAudio() {
  const log = { oscillators: [], targets: [] };
  const param = (owner, name) => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime(v) { log.targets.push([owner, name, v]); },
  });
  const node = (kind) => {
    const n = { kind, type: 'sine', connect: (next) => next, start() {}, stop() {}, loop: false };
    for (const p of ['frequency', 'gain', 'Q', 'pan', 'threshold', 'ratio']) n[p] = param(n, p);
    if (kind === 'osc') log.oscillators.push(n);
    return n;
  };
  class FakeContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.state = 'running';
      this.destination = {};
    }
    createGain() { return node('gain'); }
    createOscillator() { return node('osc'); }
    createBiquadFilter() { return node('filter'); }
    createBufferSource() { return node('source'); }
    createDynamicsCompressor() { return node('comp'); }
    createStereoPanner() { return node('pan'); }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    resume() {}
  }
  globalThis.window = { AudioContext: FakeContext };
  return log;
}

const removeFakeAudio = () => { delete globalThis.window; };

test('radio, collapse, hazard and evacuation events each get a sound of their own', () => {
  assert.equal(eventSound({ tone: 'good', text: 'Building fire: 3 units dispatched' }), 'radio');
  assert.equal(eventSound({ tone: 'big', text: 'Part of X has collapsed — 4 people buried' }), 'rumble');
  assert.equal(eventSound({ tone: 'big', text: 'SECONDARY COLLAPSE at X' }), 'rumble');
  assert.equal(eventSound({ tone: 'big', text: 'EARTHQUAKE — buildings are down' }), 'rumble');
  assert.equal(eventSound({ tone: 'bad', text: 'A firefighter from Engine 1 was overcome by fumes' }), 'bad');
  assert.equal(eventSound({ tone: 'warn', text: 'Engine 1\'s crew are working in a hazard zone without protection!' }), 'hazard');
  assert.equal(eventSound({ tone: 'info', text: 'Evacuation of the area: 5 buildings to clear' }), 'evac');
  assert.equal(eventSound({ tone: 'big', text: 'MAJOR INCIDENT — fire' }), 'klaxon');
  assert.equal(eventSound({ tone: 'big', text: 'EXPLOSION at X!' }), 'boom');
});

test('every agency has its own siren voice', () => {
  const agencies = Object.keys(AGENCY_VOICE);
  assert.deepEqual(agencies.sort(), ['civil', 'coastguard', 'ems', 'police', 'utility']);
  // The patterns differ: sample each over a few seconds and compare the shapes.
  const shapes = agencies.map((a) => {
    const v = AGENCY_VOICE[a];
    const freqs = Array.from({ length: 40 }, (_, i) => Math.round(v.freq(i * 0.2)));
    return `${v.type}:${freqs.join(',')}`;
  });
  assert.equal(new Set(shapes).size, agencies.length, 'no two agencies sound the same');
  for (const a of agencies) for (let t = 0; t < 10; t += 0.1) assert.ok(AGENCY_VOICE[a].freq(t) > 80 && AGENCY_VOICE[a].freq(t) < 2000);
});

test('sounds are rate-limited: one sound never repeats at once and a busy night is capped', () => {
  installFakeAudio();
  try {
    const audio = createAudio();
    assert.equal(audio.unlock(), true);
    assert.equal(audio.play('radio'), true);
    assert.equal(audio.play('radio'), false, 'the same sound has a cooldown');
    const names = ['alarm', 'warn', 'medic', 'bad', 'crash', 'chime', 'cash', 'select', 'clunk', 'click'];
    const played = names.filter((n) => audio.play(n)).length;
    assert.ok(played + 1 <= 6, `${played + 1} one-shots in one burst`);
    // Big events still get through a crowded moment.
    assert.equal(audio.play('klaxon'), true);
    assert.equal(audio.play('nonsense'), false);
  } finally {
    removeFakeAudio();
  }
});

test('categories and mute switch sounds off, and the choice is kept', () => {
  installFakeAudio();
  try {
    const audio = createAudio();
    audio.unlock();
    assert.deepEqual(Object.keys(audio.settings().categories).sort(), [...SOUND_CATEGORIES].sort());
    assert.equal(audio.setCategory('radio', false), true);
    assert.equal(audio.setCategory('bogus', false), false);
    assert.equal(audio.play('radio'), false, 'radio is off');
    assert.equal(audio.play('alarm'), true, 'alerts still work');
    audio.setCategory('alerts', false);
    assert.equal(audio.play('warn'), false);
    audio.setCategory('alerts', true);
    audio.setVolume(5);
    assert.equal(audio.settings().volume, 1, 'volume is clamped');
    audio.setVolume(-1);
    assert.equal(audio.settings().volume, 0);
    audio.toggleMute();
    assert.equal(audio.play('chime'), false, 'muted');
    assert.equal(audio.settings().muted, true);
  } finally {
    removeFakeAudio();
  }
});

test('support agencies on scene drive their own voices, and a category can silence them', () => {
  const log = installFakeAudio();
  try {
    const audio = createAudio();
    audio.unlock();
    const state = createGame(7);
    startShift(state);
    state.credits = 99999;
    const b = state.buildings.find((x) => x.type === 'house' && x.state === 'ok');
    const cam = { x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE, zoom: 1 };
    const view = { width: 1000, height: 700 };
    callAgency(state, 'police', { kind: 'building', id: b.id });
    callAgency(state, 'coastguard', { x: cam.x, y: cam.y });
    state.time += 40;
    log.targets.length = 0;
    audio.update(state, cam, view);
    const voices = log.oscillators.filter((o) => ['square', 'sine'].includes(o.type));
    assert.ok(voices.some((o) => o.type === 'sine'), 'the coast guard foghorn is a sine');
    const loud = log.targets.filter(([, name, v]) => name === 'gain' && v > 0).length;
    assert.ok(loud > 0, 'something is audible');

    audio.setCategory('sirens', false);
    audio.setCategory('ambience', false);
    log.targets.length = 0;
    audio.update(state, cam, view);
    const stillLoud = log.targets.filter(([n, name, v]) => name === 'gain' && v > 0.04).length;
    assert.equal(stillLoud, 0, 'with sirens and ambience off nothing is left');
  } finally {
    removeFakeAudio();
  }
});

test('audio without a browser is inert, with settings that still answer', () => {
  removeFakeAudio();
  const audio = createAudio();
  assert.equal(audio.supported, false);
  assert.equal(audio.unlock(), false);
  assert.equal(audio.play('alarm'), false);
  assert.equal(audio.settings().volume >= 0, true);
  assert.doesNotThrow(() => audio.update(createGame(7), { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }));
});
