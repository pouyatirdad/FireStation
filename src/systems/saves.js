// Saving and loading, safely.
//
// A save slot holds an *envelope*: `{ format, kind, savedAt, shift, campaign? }`.
// The shift is `serialize(state)` (version 17); the campaign is a career's
// persistent data. Rules this module keeps:
//
//   - an old Quick Response save (a bare shift, version 16) still loads, and is
//     copied to `<key>.bak` before anything overwrites it;
//   - a save from a newer game (higher format) is never read down or overwritten;
//   - a save that cannot be parsed is copied to `<key>.corrupt`, never deleted;
//   - missing or damaged fields get safe defaults instead of failing the load.
//
// Storage is passed in (the browser's localStorage, or a stub in the tests).

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { CAMPAIGN_VERSION, createCampaign } from './campaign.js';
import { emptyTotals } from './careerStats.js';
import { createFinance } from './finance.js';
import { createObjectives } from './objectives.js';
import { restorePresets } from './presets.js';
import { restoreScenarios } from '../data/scenarios.js';
import { SKILLS } from '../data/personnel.js';

export const ENVELOPE_FORMAT = 2;
export const SHIFT_VERSION = 17;
export const OLDEST_SHIFT = 16;

export const KEYS = {
  quick: 'firestation.save.v16', // kept: Quick Response saves written by earlier versions live here
  career: 'firestation.career.v1',
  challenge: 'firestation.challenge.v1',
  results: 'firestation.results.v1',
  scenarios: 'firestation.scenarios.v1',
  presets: 'firestation.presets.v1',
};

// --------------------------------------------------------------- migration ---

/** One step per version: each takes a shift of version n and returns n + 1. */
const STEPS = {
  16: (d) => ({
    ...d,
    version: 17,
    mode: 'quick', // everything before 17 was Quick Response
    presets: null, report: null, support: null, evac: null, disaster: null, scenario: null, rules: {},
  }),
};

/** Bring a shift save up to the current version. `{ ok, data, from }` or `{ ok: false, error }`. */
export function migrateShift(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Not a save' };
  let d = { ...input };
  const from = Number(d.version);
  if (!Number.isFinite(from)) return { ok: false, error: 'The save has no version' };
  if (from > SHIFT_VERSION) return { ok: false, error: 'newer', newer: true };
  if (from < OLDEST_SHIFT) return { ok: false, error: `Saves older than version ${OLDEST_SHIFT} cannot be migrated` };
  while (d.version < SHIFT_VERSION) {
    const step = STEPS[d.version];
    if (!step) return { ok: false, error: `No migration from version ${d.version}` };
    d = step(d);
  }
  return { ok: true, data: d, from };
}

// -------------------------------------------------------------- validation ---

const arr = (v) => (Array.isArray(v) ? v : []);
const fin = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Fill safe defaults into a shift. Hard failures (not an object, no fleet) are reported. */
export function normalizeShift(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return { ok: false, errors: ['The save is empty'], data: null };
  const out = { ...d };
  out.seed = fin(d.seed, CONFIG.city.seed);
  out.time = Math.max(0, fin(d.time, 0));
  out.clock = fin(d.clock, CONFIG.clockStart);
  out.credits = fin(d.credits, CONFIG.economy.start);
  out.rating = clamp(fin(d.rating, CONFIG.rating.start), 0, 100);
  out.stats = d.stats && typeof d.stats === 'object' ? d.stats : {};
  for (const k of ['buildings', 'engines', 'crews', 'patients', 'blockades', 'victims', 'wildfires', 'events', 'cut', 'ownedStations']) {
    if (!Array.isArray(d[k])) {
      if (d[k] != null) errors.push(`${k} was damaged and has been reset`);
      out[k] = [];
    }
  }
  out.engines = out.engines.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && CONFIG.vehicles[e.type]);
  if (out.engines.length === 0) return { ok: false, errors: ['The save has no vehicles'], data: null };
  out.crews = arr(out.crews).filter((c) => c && typeof c === 'object' && typeof c.engineId === 'string');
  out.contracts = d.contracts && typeof d.contracts === 'object' ? d.contracts : undefined;
  return { ok: true, errors, data: out };
}

export function normalizeCampaign(c) {
  if (!c || typeof c !== 'object') return null;
  if (Number(c.version) > CAMPAIGN_VERSION) return { newer: true };
  const base = createCampaign({ name: c.name, scenario: c.scenario in { harbor: 1, riverside: 1, lean: 1 } ? c.scenario : 'harbor', seed: fin(c.seed, null) });
  const out = {
    ...base,
    id: typeof c.id === 'string' ? c.id : base.id,
    created: fin(c.created, base.created),
    level: Math.round(clamp(fin(c.level, 1), 1, CONFIG.career.levels.length)),
    reputation: clamp(fin(c.reputation, base.reputation), 0, 100),
    shifts: Math.max(0, Math.round(fin(c.shifts, 0))),
    totals: { ...emptyTotals(), ...(c.totals ?? {}) },
    nextPersonId: Math.max(1, Math.round(fin(c.nextPersonId, 1))),
    rngCounter: Math.max(0, Math.round(fin(c.rngCounter, 0))),
    candidatesUntil: 0,
    candidates: [],
    stations: c.stations && typeof c.stations === 'object' ? c.stations : {},
    fleet: arr(c.fleet).filter((f) => f && CONFIG.vehicles[f.type]).map((f) => ({ type: f.type, station: fin(f.station, 0) })),
    ownedStations: Array.isArray(c.ownedStations) ? c.ownedStations.map(Boolean) : null,
    balance: fin(c.balance, base.balance),
    finance: { ...createFinance(), ...(c.finance ?? {}) },
    objectives: { ...createObjectives(), ...(c.objectives ?? {}) },
    history: { months: arr(c.history?.months), shifts: arr(c.history?.shifts) },
    presets: restorePresets(c.presets),
    unlocked: arr(c.unlocked),
  };
  if (out.fleet.length === 0) out.fleet = base.fleet;
  out.objectives.completed = out.objectives.completed && typeof out.objectives.completed === 'object' ? out.objectives.completed : {};
  out.objectives.daily = { ids: [], base: {}, issuedShift: -1, ...(out.objectives.daily ?? {}) };

  // People: keep every record that has an id; repair what is missing.
  out.personnel = arr(c.personnel).filter((p) => p && typeof p.id === 'string').map((p) => {
    const skills = {};
    const skillXp = {};
    for (const s of SKILLS) {
      skills[s] = Math.round(clamp(fin(p.skills?.[s], 1), 1, CONFIG.personnel.maxSkill));
      skillXp[s] = Math.max(0, fin(p.skillXp?.[s], 0));
    }
    return {
      id: p.id,
      name: String(p.name ?? 'Firefighter').slice(0, 40),
      rank: CONFIG.personnel.ranks.some((r) => r.id === p.rank) ? p.rank : 'recruit',
      level: Math.round(clamp(fin(p.level, 1), 1, 10)),
      xp: Math.max(0, fin(p.xp, 0)),
      skills, skillXp,
      certs: arr(p.certs).filter((x) => typeof x === 'string'),
      fatigue: clamp(fin(p.fatigue, 0), 0, 1),
      injuredUntil: Math.max(0, fin(p.injuredUntil, 0)),
      status: ['active', 'injured', 'training'].includes(p.status) ? p.status : 'active',
      station: fin(p.station, null),
      vehicleId: null, // seats are rebuilt when the shift is built
      training: p.status === 'training' && p.training && CONFIG.training.courses[p.training.course] ? { ...p.training } : null,
      stats: { shifts: 0, incidents: 0, rescues: 0, treatments: 0, knockdowns: 0, injuries: 0, hoursOnDuty: 0, trainings: 0, ...(p.stats ?? {}) },
    };
  });
  for (const p of out.personnel) if (p.status === 'training' && !p.training) p.status = 'active';
  return out;
}

// ------------------------------------------------------------------ slots ---

const parse = (raw) => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

/**
 * Read a slot. Returns `{ status, ... }`:
 *   none       nothing saved
 *   ok         `{ kind, shift, campaign }` ready for loadState
 *   migrated   as ok, but an older save that was upgraded (`from`)
 *   newer      written by a newer version of the game; left alone
 *   corrupt    unreadable; kept under `<key>.corrupt`
 */
export function readSlot(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: 'error', error: 'Storage is blocked' };
  }
  if (raw == null) return { status: 'none' };

  const p = parse(raw);
  if (!p.ok || p.value == null || typeof p.value !== 'object') {
    keepCopy(storage, `${key}.corrupt`, raw);
    return { status: 'corrupt', error: 'The save could not be read; a copy was kept' };
  }
  let value = p.value;
  let legacy = false;
  if (value.format == null) {
    // A bare shift written before envelopes existed.
    legacy = true;
    value = { format: 1, kind: 'quick', shift: value };
  }
  if (value.format > ENVELOPE_FORMAT) return { status: 'newer', error: 'This save was made by a newer version of the game' };

  const migrated = migrateShift(value.shift);
  if (!migrated.ok) {
    if (migrated.newer) return { status: 'newer', error: 'This save was made by a newer version of the game' };
    keepCopy(storage, `${key}.corrupt`, raw);
    return { status: 'corrupt', error: migrated.error };
  }
  const n = normalizeShift(migrated.data);
  if (!n.ok) {
    keepCopy(storage, `${key}.corrupt`, raw);
    return { status: 'corrupt', error: n.errors[0] };
  }

  let campaign = null;
  if (value.kind === 'career') {
    campaign = normalizeCampaign(value.campaign);
    if (!campaign) {
      keepCopy(storage, `${key}.corrupt`, raw);
      return { status: 'corrupt', error: 'The career data is missing' };
    }
    if (campaign.newer) return { status: 'newer', error: 'This career was made by a newer version of the game' };
  }
  return {
    status: legacy || migrated.from < SHIFT_VERSION ? 'migrated' : 'ok',
    kind: value.kind ?? 'quick',
    shift: n.data,
    campaign,
    from: migrated.from,
    warnings: n.errors,
    savedAt: value.savedAt ?? null,
  };
}

function keepCopy(storage, key, raw) {
  try {
    if (storage.getItem(key) == null) storage.setItem(key, raw);
  } catch { /* nothing more can be done */ }
}

/**
 * Write a slot. Refuses to overwrite a save from a newer game, and keeps a
 * copy of an old-format save the first time it is replaced.
 */
export function writeSlot(storage, key, { kind, shift, campaign = null }) {
  try {
    const existing = storage.getItem(key);
    if (existing != null) {
      const p = parse(existing);
      if (p.ok && p.value && typeof p.value === 'object') {
        if ((p.value.format ?? 1) > ENVELOPE_FORMAT || Number(p.value.version) > SHIFT_VERSION) {
          return { ok: false, reason: 'newer', error: 'A newer save is stored here; it was not overwritten' };
        }
        if (p.value.format == null) keepCopy(storage, `${key}.bak`, existing);
      }
    }
    const envelope = { format: ENVELOPE_FORMAT, kind, savedAt: Date.now(), shift, ...(campaign ? { campaign } : {}) };
    storage.setItem(key, JSON.stringify(envelope));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'storage', error: 'Could not save — the browser blocked storage' };
  }
}

export function hasSlot(storage, key) {
  try {
    return storage.getItem(key) != null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------- challenges and scenarios ---

export function loadResults(storage) {
  try {
    const p = parse(storage.getItem(KEYS.results) ?? 'null');
    return p.ok && p.value && typeof p.value === 'object' ? p.value : {};
  } catch {
    return {};
  }
}

/** Keep the best score per challenge. Returns `{ best, isBest }`. */
export function recordResult(storage, id, result) {
  const all = loadResults(storage);
  const prev = all[id];
  const isBest = result.status === 'won' && (!prev || result.score > prev.score);
  all[id] = {
    plays: (prev?.plays ?? 0) + 1,
    wins: (prev?.wins ?? 0) + (result.status === 'won' ? 1 : 0),
    score: isBest ? result.score : prev?.score ?? 0,
    last: result.score,
  };
  try {
    storage.setItem(KEYS.results, JSON.stringify(all));
  } catch { /* score keeping is best-effort */ }
  return { best: all[id], isBest };
}

export function loadScenarioLibrary(storage) {
  try {
    const p = parse(storage.getItem(KEYS.scenarios) ?? 'null');
    return p.ok ? restoreScenarios(p.value) : [];
  } catch {
    return [];
  }
}

export function storeScenarioLibrary(storage, list) {
  try {
    storage.setItem(KEYS.scenarios, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
