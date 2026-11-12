// Sound, synthesised with Web Audio so the game stays one self-contained file
// with no audio assets. Nothing here touches the simulation: it reads the state
// each frame and plays what it finds.
//
//   loops     fire crackle, hose water, city wind, an engine hum and up to three
//             sirens (wail for fire apparatus, two-tone yelp for ambulances),
//             all attenuated by distance from the camera and panned by where
//             they are on screen
//   one-shots dispatch alarm, major-incident klaxon, chimes and cash, collapse
//             boom, warning blips, UI ticks, radio chirps
//
// Browsers only allow audio after a user gesture, so everything is created
// lazily by `unlock()`, which main.js calls on the first click or key press.

import { TILE } from '../core/config.js';
import { clamp } from '../core/math.js';

const STORE_KEY = 'firestation.audio.v1';
const MAX_SIRENS = 3;

/** Which one-shot an event in the dispatch log should trigger (pure, testable). */
export function eventSound(event) {
  if (!event) return null;
  const text = event.text ?? '';
  switch (event.tone) {
    case 'big': return 'klaxon';
    case 'fire': return /spread/i.test(text) ? 'warn' : 'alarm';
    case 'bad': return /building lost/i.test(text) ? 'boom' : 'bad';
    case 'good':
      if (/supply line connected/i.test(text)) return 'clunk';
      if (/\$/.test(text)) return 'cash';
      return 'chime';
    case 'warn': return /injured|ambulance/i.test(text) ? 'medic' : 'warn';
    default: return null;
  }
}

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (raw) return { muted: Boolean(raw.muted), volume: clamp(Number(raw.volume ?? 0.7), 0, 1) };
  } catch {
    // storage blocked: fall through to the defaults
  }
  return { muted: false, volume: 0.7 };
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    // not worth surfacing
  }
}

export function createAudio() {
  const prefs = loadPrefs();
  let ctx = null;
  let master = null;
  let noise = null;
  const loops = {};
  const sirens = [];
  let trackedState = null;
  let lastEventId = 0;
  let lastPlayed = {};

  const supported = typeof window !== 'undefined'
    && Boolean(window.AudioContext || window.webkitAudioContext);

  // ------------------------------------------------------------ building ---

  function makeNoise() {
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = (white * 0.6 + brown * 6) * 0.7;
    }
    return buffer;
  }

  function noiseLoop(filterType, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    return { gain, filter };
  }

  function build() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = prefs.muted ? 0 : prefs.volume;
    master.connect(compressor).connect(ctx.destination);
    noise = makeNoise();

    loops.fire = noiseLoop('bandpass', 1100, 0.6);
    loops.water = noiseLoop('bandpass', 4200, 0.5);
    loops.wind = noiseLoop('lowpass', 380, 0.4);

    // Engine hum: a low saw through a lowpass.
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 52;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 180;
    const humGain = ctx.createGain();
    humGain.gain.value = 0;
    hum.connect(humFilter).connect(humGain).connect(master);
    hum.start();
    loops.hum = { gain: humGain, osc: hum };

    for (let i = 0; i < MAX_SIRENS; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 700;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2200;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      osc.connect(filter).connect(gain);
      if (pan) gain.connect(pan).connect(master);
      else gain.connect(master);
      osc.start();
      sirens.push({ osc, gain, pan });
    }
  }

  function unlock() {
    if (!supported) return false;
    if (!ctx) {
      try {
        build();
      } catch {
        ctx = null;
        return false;
      }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  // ----------------------------------------------------------- one-shots ---

  function tone(freq, dur, { type = 'sine', gain = 0.2, delay = 0, slide = null, attack = 0.005 } = {}) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function burst(dur, { filter = 'lowpass', from = 1200, to = null, gain = 0.3, delay = 0, q = 0.7 } = {}) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loopStart = Math.random();
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  const SOUNDS = {
    click: () => tone(1800, 0.03, { type: 'square', gain: 0.04 }),
    select: () => {
      tone(760, 0.06, { type: 'triangle', gain: 0.08 });
      tone(1140, 0.08, { type: 'triangle', gain: 0.07, delay: 0.05 });
    },
    // Station tones: a rising three-note page, twice.
    alarm: () => {
      for (let r = 0; r < 2; r++) {
        tone(740, 0.16, { type: 'square', gain: 0.07, delay: r * 0.62 });
        tone(988, 0.16, { type: 'square', gain: 0.07, delay: r * 0.62 + 0.2 });
        tone(1318, 0.26, { type: 'square', gain: 0.07, delay: r * 0.62 + 0.4 });
      }
    },
    klaxon: () => {
      for (let i = 0; i < 3; i++) {
        tone(330, 0.5, { type: 'sawtooth', gain: 0.16, delay: i * 0.6, slide: 560, attack: 0.04 });
      }
      burst(0.5, { filter: 'bandpass', from: 900, to: 300, gain: 0.08 });
    },
    chime: () => {
      tone(659, 0.28, { gain: 0.11 });
      tone(784, 0.28, { gain: 0.11, delay: 0.09 });
      tone(988, 0.42, { gain: 0.11, delay: 0.18 });
    },
    cash: () => {
      tone(1318, 0.12, { type: 'triangle', gain: 0.1 });
      tone(1976, 0.4, { type: 'triangle', gain: 0.1, delay: 0.09 });
    },
    bad: () => {
      tone(220, 0.55, { type: 'triangle', gain: 0.16, slide: 110 });
      burst(0.25, { from: 500, to: 120, gain: 0.12 });
    },
    boom: () => {
      burst(1.4, { from: 900, to: 50, gain: 0.55 });
      tone(78, 0.9, { type: 'sine', gain: 0.5, slide: 28, attack: 0.01 });
    },
    warn: () => {
      tone(620, 0.09, { type: 'triangle', gain: 0.1 });
      tone(620, 0.09, { type: 'triangle', gain: 0.1, delay: 0.16 });
    },
    medic: () => {
      tone(740, 0.22, { gain: 0.11 });
      tone(554, 0.34, { gain: 0.11, delay: 0.24 });
    },
    radio: () => {
      burst(0.08, { filter: 'bandpass', from: 2400, gain: 0.1, q: 2 });
      tone(1500, 0.06, { type: 'square', gain: 0.04, delay: 0.09 });
      tone(1100, 0.08, { type: 'square', gain: 0.04, delay: 0.18 });
    },
    clunk: () => {
      tone(150, 0.14, { type: 'triangle', gain: 0.2, slide: 80 });
      burst(0.1, { from: 700, gain: 0.1 });
    },
    kaching: () => SOUNDS.cash(),
  };

  function play(name, scale = 1) {
    if (!ctx || prefs.muted) return;
    const fn = SOUNDS[name];
    if (!fn) return;
    const now = performance.now();
    if (now - (lastPlayed[name] ?? 0) < 120) return;
    lastPlayed[name] = now;
    fn(scale);
  }

  // -------------------------------------------------------------- frame ---

  const ramp = (param, value, tc = 0.12) => param.setTargetAtTime(value, ctx.currentTime, tc);

  function update(state, cam, view) {
    if (!ctx) return;

    if (trackedState !== state) {
      trackedState = state;
      lastEventId = state.events[0]?.id ?? 0;
      lastPlayed = {};
    }

    // One-shots for new log entries, oldest first, at most three a frame.
    const fresh = [];
    for (const event of state.events) {
      if (event.id <= lastEventId) break;
      fresh.unshift(event);
    }
    if (fresh.length > 0) {
      lastEventId = fresh[fresh.length - 1].id;
      for (const event of fresh.slice(-3)) play(eventSound(event));
    }

    const live = state.running && !state.paused && !state.over && !prefs.muted;
    if (!live) {
      for (const key of ['fire', 'water', 'wind', 'hum']) ramp(loops[key].gain.gain, 0, 0.08);
      for (const s of sirens) ramp(s.gain.gain, 0, 0.08);
      return;
    }

    // Everything is heard within about a screen and a half of the camera.
    const reach = (Math.hypot(view.width, view.height) / cam.zoom) * 0.75;
    const heard = (x, y) => clamp(1 - Math.hypot(x - cam.x, y - cam.y) / reach, 0, 1) ** 1.6;
    const pan = (x) => clamp((x - cam.x) / (view.width / cam.zoom / 2), -1, 1) * 0.8;

    let fire = 0;
    for (const b of state.buildings) {
      if (b.state !== 'burning') continue;
      fire += heard((b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE) * b.fire;
    }
    for (const wf of state.wildfires ?? []) fire += heard(wf.x, wf.y) * wf.intensity * 1.4;
    const fireGain = Math.min(1, fire) * 0.2;
    ramp(loops.fire.gain.gain, fireGain, 0.2);
    if (fireGain > 0.02 && Math.random() < fireGain * 0.5) {
      burst(0.05 + Math.random() * 0.06, {
        filter: 'highpass', from: 1500 + Math.random() * 3000, gain: fireGain * 0.9, q: 0.9,
      });
    }

    let water = 0;
    for (const s of state.streams) water += heard(s.sx, s.sy);
    ramp(loops.water.gain.gain, Math.min(1, water * 0.6) * 0.14, 0.15);

    // A little less wind at night would be more honest, but the day length makes
    // that a faint effect; keep it constant and gentle.
    ramp(loops.wind.gain.gain, 0.05, 0.5);

    const moving = state.engines
      .filter((e) => e.path.length > 0)
      .map((e) => ({ e, d: Math.hypot(e.x - cam.x, e.y - cam.y) }))
      .sort((a, b) => a.d - b.d);

    ramp(loops.hum.gain.gain, moving.length ? heard(moving[0].e.x, moving[0].e.y) * 0.09 : 0, 0.25);
    if (moving.length) {
      ramp(loops.hum.osc.frequency, 46 + moving[0].e.spec.speed * 2.6, 0.3);
    }

    const t = state.time;
    sirens.forEach((siren, i) => {
      const entry = moving[i];
      const level = entry ? heard(entry.e.x, entry.e.y) : 0;
      const medical = Boolean(entry?.e.spec?.medical);
      if (entry) {
        const phase = t + i * 0.37;
        const freq = medical
          ? (Math.floor(phase / 0.42) % 2 === 0 ? 660 : 880)
          : 600 + 520 * (0.5 + 0.5 * Math.sin(phase * 2.2));
        ramp(siren.osc.frequency, freq, medical ? 0.012 : 0.05);
        if (siren.pan) ramp(siren.pan.pan, pan(entry.e.x), 0.1);
      }
      ramp(siren.gain.gain, level * 0.07, 0.15);
    });
  }

  // --------------------------------------------------------------- api ---

  return {
    supported,
    unlock,
    update,
    play,
    isMuted: () => prefs.muted,
    volume: () => prefs.volume,
    toggleMute() {
      prefs.muted = !prefs.muted;
      if (master) ramp(master.gain, prefs.muted ? 0 : prefs.volume, 0.05);
      savePrefs(prefs);
      return prefs.muted;
    },
    setVolume(v) {
      prefs.volume = clamp(v, 0, 1);
      if (master && !prefs.muted) ramp(master.gain, prefs.volume, 0.05);
      savePrefs(prefs);
    },
  };
}
