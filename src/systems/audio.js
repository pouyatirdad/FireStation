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
    case 'big':
      if (/promotion/i.test(text)) return 'chime';
      if (/secondary collapse|earthquake|aftershock|has collapsed/i.test(text)) return 'rumble';
      return /explosion/i.test(text) ? 'boom' : 'klaxon';
    case 'fire':
      if (/traffic accident/i.test(text)) return 'crash';
      return /spread/i.test(text) ? 'warn' : 'alarm';
    case 'bad': return /building lost/i.test(text) ? 'boom' : 'bad';
    case 'good':
      if (/supply line connected/i.test(text)) return 'clunk';
      // Radio traffic: dispatch orders and support agencies reporting in.
      if (/dispatched|on scene —|response complete/i.test(text)) return 'radio';
      if (/\$/.test(text)) return 'cash';
      return 'chime';
    case 'warn':
      if (/overcome by fumes|without protection|hazard zone is forming/i.test(text)) return 'hazard';
      return /injured|ambulance/i.test(text) ? 'medic' : 'warn';
    case 'info':
      if (/evacuation of/i.test(text)) return 'evac';
      return /called —|called off|redirected/i.test(text) ? 'radio' : null;
    default: return null;
  }
}

/** What can be switched off separately: alerts (alarms, booms, warnings), radio, sirens, ambience, effects. */
export const SOUND_CATEGORIES = ['alerts', 'radio', 'sirens', 'ambience', 'effects'];
const DEFAULT_CATEGORIES = { alerts: true, radio: true, sirens: true, ambience: true, effects: true };

const SOUND_CATEGORY = {
  click: 'effects', select: 'effects', chime: 'effects', cash: 'effects', clunk: 'effects', kaching: 'effects',
  alarm: 'alerts', klaxon: 'alerts', bad: 'alerts', crash: 'alerts', boom: 'alerts', warn: 'alerts', medic: 'alerts',
  rumble: 'alerts', hazard: 'alerts', evac: 'alerts', radio: 'radio',
};

// Minimum gap between two plays of the same sound, and the sounds that may break the global limit.
const COOLDOWN = { radio: 700, alarm: 1500, klaxon: 2500, boom: 900, rumble: 2000, hazard: 1500, evac: 4000, crash: 800 };
const PRIORITY = new Set(['klaxon', 'boom', 'rumble']);
const LIMIT = { count: 6, windowMs: 2000 }; // at most this many one-shots in a window

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (raw) {
      return {
        muted: Boolean(raw.muted),
        volume: clamp(Number(raw.volume ?? 0.7), 0, 1),
        categories: { ...DEFAULT_CATEGORIES, ...(raw.categories && typeof raw.categories === 'object' ? raw.categories : {}) },
      };
    }
  } catch {
    // storage blocked: fall through to the defaults
  }
  return { muted: false, volume: 0.7, categories: { ...DEFAULT_CATEGORIES } };
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    // not worth surfacing
  }
}

const MAX_AGENCY_VOICES = 3;

/**
 * Each agency sounds different: a fast two-tone yelp for the police, a slow wail for the
 * medical service, a long alternating horn for civil protection, a low pulsing buzz for
 * the utilities and a foghorn for the coast guard.
 */
export const AGENCY_VOICE = {
  police: { type: 'square', freq: (t) => (Math.floor(t * 3) % 2 ? 960 : 720) },
  ems: { type: 'sawtooth', freq: (t) => 520 + 420 * (0.5 + 0.5 * Math.sin(t * 1.6)) },
  civil: { type: 'triangle', freq: (t) => (Math.floor(t / 1.4) % 2 ? 520 : 390) },
  utility: { type: 'square', freq: (t) => 210 + (Math.floor(t * 2) % 2) * 40, gate: (t) => (Math.floor(t * 2) % 2 ? 1 : 0.35) },
  coastguard: { type: 'sine', freq: () => 150, gate: (t) => (t % 3.5 < 1.2 ? 1 : 0) },
};

export function createAudio() {
  const prefs = loadPrefs();
  let ctx = null;
  let master = null;
  let noise = null;
  const loops = {};
  const sirens = [];
  const agencyVoices = [];
  const recent = [];
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

    // Support agencies have voices of their own, so police, EMS and the rest can be told apart.
    for (let i = 0; i < MAX_AGENCY_VOICES; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 600;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2600;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      osc.connect(filter).connect(gain);
      if (pan) gain.connect(pan).connect(master);
      else gain.connect(master);
      osc.start();
      agencyVoices.push({ osc, gain, pan, type: 'square' });
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
    crash: () => {
      burst(0.35, { filter: 'bandpass', from: 1800, to: 500, gain: 0.35, q: 1.5 });
      tone(180, 0.3, { type: 'square', gain: 0.1, slide: 70 });
      tone(1240, 0.18, { type: 'triangle', gain: 0.06, delay: 0.06, slide: 700 });
      tone(660, 0.5, { type: 'square', gain: 0.05, delay: 0.5 });
      tone(660, 0.5, { type: 'square', gain: 0.05, delay: 1.1 });
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
    // Radio traffic: the squelch click, a burst of voice-like chatter, then the tail click.
    radio: () => {
      burst(0.05, { filter: 'bandpass', from: 3000, gain: 0.12, q: 2 });
      let t = 0.09;
      const syllables = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < syllables; i++) {
        const dur = 0.07 + Math.random() * 0.07;
        burst(dur, { filter: 'bandpass', from: 700 + Math.random() * 1100, gain: 0.07, q: 3, delay: t });
        tone(110 + Math.random() * 70, dur, { type: 'sawtooth', gain: 0.018, delay: t });
        t += dur + 0.03 + Math.random() * 0.05;
      }
      tone(1500, 0.04, { type: 'square', gain: 0.035, delay: t + 0.02 });
    },
    // A building coming down, or the ground moving: a deep rumble with debris falling after it.
    rumble: () => {
      burst(2.2, { from: 240, to: 40, gain: 0.5 });
      tone(48, 1.8, { type: 'sine', gain: 0.4, slide: 30, attack: 0.05 });
      for (let k = 0; k < 4; k++) burst(0.25, { filter: 'bandpass', from: 900, to: 300, gain: 0.16, delay: 0.4 + k * 0.35, q: 1.2 });
    },
    // A hazard alarm: fast two-pitch chirps.
    hazard: () => {
      for (let r = 0; r < 4; r++) {
        tone(900, 0.07, { type: 'square', gain: 0.06, delay: r * 0.2 });
        tone(1350, 0.07, { type: 'square', gain: 0.06, delay: r * 0.2 + 0.09 });
      }
    },
    // An evacuation warning: three rising whoops.
    evac: () => {
      for (let i = 0; i < 3; i++) tone(400, 0.7, { type: 'sawtooth', gain: 0.1, slide: 760, delay: i * 0.8, attack: 0.08 });
    },
    clunk: () => {
      tone(150, 0.14, { type: 'triangle', gain: 0.2, slide: 80 });
      burst(0.1, { from: 700, gain: 0.1 });
    },
    kaching: () => SOUNDS.cash(),
  };

  function play(name, scale = 1) {
    if (!ctx || prefs.muted) return false;
    const fn = SOUNDS[name];
    if (!fn) return false;
    if (prefs.categories[SOUND_CATEGORY[name] ?? 'effects'] === false) return false;
    const now = performance.now();
    if (now - (lastPlayed[name] ?? -Infinity) < (COOLDOWN[name] ?? 120)) return false;
    // However busy the night, never more than a handful of one-shots at once.
    while (recent.length && now - recent[0] > LIMIT.windowMs) recent.shift();
    if (recent.length >= LIMIT.count && !PRIORITY.has(name)) return false;
    lastPlayed[name] = now;
    recent.push(now);
    fn(scale);
    return true;
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
      for (const v of agencyVoices) ramp(v.gain.gain, 0, 0.08);
      return;
    }
    const ambience = prefs.categories.ambience !== false;
    const sirenOn = prefs.categories.sirens !== false;

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
    const fireGain = ambience ? Math.min(1, fire) * 0.2 : 0;
    ramp(loops.fire.gain.gain, fireGain, 0.2);
    if (fireGain > 0.02 && Math.random() < fireGain * 0.5) {
      burst(0.05 + Math.random() * 0.06, {
        filter: 'highpass', from: 1500 + Math.random() * 3000, gain: fireGain * 0.9, q: 0.9,
      });
    }

    let water = 0;
    for (const s of state.streams) water += heard(s.sx, s.sy);
    ramp(loops.water.gain.gain, ambience ? Math.min(1, water * 0.6) * 0.14 : 0, 0.15);

    // A little less wind at night would be more honest, but the day length makes
    // that a faint effect; keep it constant and gentle.
    ramp(loops.wind.gain.gain, ambience ? 0.025 + 0.09 * (state.wind?.speed ?? 0.3) : 0, 0.5);
    ramp(loops.wind.filter.frequency, 260 + 520 * (state.wind?.speed ?? 0.3), 0.8);

    const moving = state.engines
      .filter((e) => e.path.length > 0)
      .map((e) => ({ e, d: Math.hypot(e.x - cam.x, e.y - cam.y) }))
      .sort((a, b) => a.d - b.d);

    ramp(loops.hum.gain.gain, ambience && moving.length ? heard(moving[0].e.x, moving[0].e.y) * 0.09 : 0, 0.25);
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
      ramp(siren.gain.gain, sirenOn ? level * 0.07 : 0, 0.15);
    });

    // Support agencies on their way or on scene, each with its own voice, nearest first.
    const calls = (state.support?.active ?? [])
      .filter((c) => t >= c.arriveAt - 6 && t <= c.until)
      .map((c) => ({ c, d: Math.hypot(c.x - cam.x, c.y - cam.y) }))
      .sort((a, b) => a.d - b.d);
    agencyVoices.forEach((voice, i) => {
      const entry = calls[i];
      if (!entry || !sirenOn) {
        ramp(voice.gain.gain, 0, 0.1);
        return;
      }
      const style = AGENCY_VOICE[entry.c.agency] ?? AGENCY_VOICE.police;
      if (voice.type !== style.type) {
        voice.osc.type = style.type;
        voice.type = style.type;
      }
      ramp(voice.osc.frequency, style.freq(t + i * 0.21), 0.015);
      if (voice.pan) ramp(voice.pan.pan, pan(entry.c.x), 0.1);
      const gate = style.gate ? style.gate(t) : 1;
      ramp(voice.gain.gain, heard(entry.c.x, entry.c.y) * 0.06 * gate, 0.06);
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
    /** The current settings, for the sound panel. */
    settings: () => ({ muted: prefs.muted, volume: prefs.volume, categories: { ...prefs.categories } }),
    setCategory(name, on) {
      if (!SOUND_CATEGORIES.includes(name)) return false;
      prefs.categories[name] = Boolean(on);
      savePrefs(prefs);
      return true;
    },
    setVolume(v) {
      prefs.volume = clamp(v, 0, 1);
      if (master && !prefs.muted) ramp(master.gain, prefs.volume, 0.05);
      savePrefs(prefs);
    },
  };
}
