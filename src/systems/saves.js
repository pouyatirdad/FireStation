// Saving and loading, safely.
//
// A save slot holds an *envelope*: `{ format, kind, savedAt, shift, campaign? }`.
// The shift is `serialize(state)` (version 18); the campaign is a career's
// persistent data (version 2). Rules this module keeps:
//
//   - an old Quick Response save (a bare shift, version 16) still loads, and is
//     copied to `<key>.bak` before anything overwrites it;
//   - a save from a newer game (higher format or version) is never read down or overwritten;
//   - a save that cannot be parsed is copied to `<key>.corrupt`, never deleted, and the newest
//     readable backup generation is offered instead;
//   - missing or damaged fields get safe defaults instead of failing the load (see schema.js);
//   - the last three saves of a slot are kept (`<key>.gen1` newest ... `.gen3`), at least
//     `BACKUP_EVERY_MS` apart; a write that fails (storage full, blocked, or not read back the way
//     it was written) leaves the live save as it was, and frees older backups before giving up.
//
// Storage is passed in (the browser's localStorage, or a stub in the tests).

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { CAMPAIGN_VERSION, createCampaign } from './campaign.js';
import { OLDEST_SHIFT as OLDEST, SHIFT_VERSION as CURRENT_SHIFT } from './persistence.js';
import { emptyTotals } from './careerStats.js';
import { createFinance } from './finance.js';
import { createObjectives } from './objectives.js';
import { restorePresets } from './presets.js';
import { restoreScenarios } from '../data/scenarios.js';
import { SKILLS } from '../data/personnel.js';

export const ENVELOPE_FORMAT = 2;
export const SHIFT_VERSION = CURRENT_SHIFT;
export const OLDEST_SHIFT = OLDEST;

/** How many earlier saves of a slot are kept, and how far apart (milliseconds) they are at least. */
export const GENERATIONS = 3;
export const BACKUP_EVERY_MS = 120000;
const GEN_SUFFIXES = Array.from({ length: GENERATIONS }, (_, i) => `.gen${i + 1}`);

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
  // 18 adds: id counters per game (`ids`; the loader also derives them from the ids in use), the fields the
  // entity schemas now keep (timers, crew routes and tasks, patient and victim state, building timers), and
  // buildings saved only when they changed. All of it is additive: a version 17 shift lists every building and
  // keeps its leak/collapse extras apart in `buildingExtras`, and the loaders still read that form.
  17: (d) => ({ ...d, version: 18, ids: d.ids && typeof d.ids === 'object' ? d.ids : {} }),
};

/** One step per campaign version: each takes a campaign of version n and returns n + 1. */
const CAMPAIGN_STEPS = {
  // 2 adds `meta` (where the campaign came from). Nothing else changes; people gain their new fields in the
  // release that uses them, through this same chain.
  1: (c) => ({ ...c, version: 2, meta: { migratedFrom: 1 } }),
};

/** Bring a campaign up to the current version. `{ ok, data, from }`, `{ newer: true }` or `{ ok: false }`. */
export function migrateCampaign(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Not a campaign' };
  const from = Number(input.version ?? 1);
  if (!Number.isFinite(from) || from < 1) return { ok: false, error: 'The campaign has no usable version' };
  if (from > CAMPAIGN_VERSION) return { ok: false, newer: true, error: 'newer' };
  let c = { ...input, version: from };
  while (c.version < CAMPAIGN_VERSION) {
    const step = CAMPAIGN_STEPS[c.version];
    if (!step) return { ok: false, error: `No migration from campaign version ${c.version}` };
    c = step(c);
  }
  return { ok: true, data: c, from };
}

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

export function normalizeCampaign(input) {
  const m = migrateCampaign(input);
  if (m.newer) return { newer: true };
  if (!m.ok) return null;
  const c = m.data;
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
    meta: c.meta && typeof c.meta === 'object' ? { ...c.meta } : { migratedFrom: null },
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
 * Look at the raw text of a save without touching storage. Returns `{ status, ... }`:
 *   ok         `{ kind, shift, campaign }` ready for loadState
 *   migrated   as ok, but an older save that was upgraded (`from`)
 *   newer      written by a newer version of the game; left alone
 *   corrupt    unreadable
 */
export function inspectRaw(raw) {
  const p = parse(raw);
  if (!p.ok || p.value == null || typeof p.value !== 'object') {
    return { status: 'corrupt', error: 'The save could not be read' };
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
    return { status: 'corrupt', error: migrated.error };
  }
  const n = normalizeShift(migrated.data);
  if (!n.ok) return { status: 'corrupt', error: n.errors[0] };
  // The envelope records how many vehicles and buildings it was written with; fewer means a write was cut short.
  const check = value.check;
  if (check && typeof check === 'object') {
    for (const k of ['engines', 'crews', 'patients']) {
      if (Number.isFinite(check[k]) && Array.isArray(migrated.data[k]) && migrated.data[k].length !== check[k]) {
        return { status: 'corrupt', error: `The save is incomplete (${k}: ${migrated.data[k].length} of ${check[k]})` };
      }
    }
  }

  let campaign = null;
  if (value.kind === 'career') {
    campaign = normalizeCampaign(value.campaign);
    if (!campaign) return { status: 'corrupt', error: 'The career data is missing' };
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

/**
 * Read a slot: `none` if nothing is saved, otherwise what `inspectRaw` says. An
 * unreadable save is copied to `<key>.corrupt` (never deleted).
 */
export function readSlot(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: 'error', error: 'Storage is blocked' };
  }
  if (raw == null) return { status: 'none' };
  const result = inspectRaw(raw);
  if (result.status === 'corrupt') {
    keepCopy(storage, `${key}.corrupt`, raw);
    // The live save is damaged (a write that was cut short, say): offer the newest backup that reads.
    for (const suffix of GEN_SUFFIXES) {
      let backup = null;
      try {
        backup = storage.getItem(key + suffix);
      } catch { continue; }
      if (backup == null) continue;
      const info = inspectRaw(backup);
      if (info.status === 'ok' || info.status === 'migrated') {
        return { ...info, recoveredFrom: key + suffix, damaged: result.error, warnings: [...(info.warnings ?? []), `The latest save was damaged (${result.error}); the previous one was loaded`] };
      }
    }
    result.error = `${result.error}; a copy was kept`;
  }
  return result;
}

// ------------------------------------------------------------ recovery ---

const BACKUP_SUFFIXES = {
  '.gen1': 'the previous save',
  '.gen2': 'the save before that',
  '.gen3': 'the oldest kept save',
  '.bak': 'the Quick Response save from before it was upgraded',
  '.prev': 'the career that was replaced by a new one',
  '.replaced': 'the save that was replaced by a restore',
  '.corrupt': 'a save that could not be read',
};

/**
 * The backups kept beside each slot (an old-format save, a replaced career, an unreadable
 * save), with whether each one could be loaded as it stands.
 */
export function listBackups(storage) {
  const out = [];
  for (const [slot, key] of Object.entries({ quick: KEYS.quick, career: KEYS.career, challenge: KEYS.challenge })) {
    for (const [suffix, about] of Object.entries(BACKUP_SUFFIXES)) {
      let raw = null;
      try {
        raw = storage.getItem(key + suffix);
      } catch {
        continue;
      }
      if (raw == null) continue;
      const info = inspectRaw(raw);
      out.push({
        key: key + suffix, target: key, slot, suffix: suffix.slice(1), about,
        loadable: info.status === 'ok' || info.status === 'migrated',
        status: info.status, kind: info.kind ?? slot, savedAt: info.savedAt ?? null, error: info.error ?? null,
      });
    }
  }
  return out;
}

/**
 * Put a backup back as the live save. The save it replaces is kept under `<slot>.replaced`
 * and the backup itself is left in place, so nothing is ever lost by restoring.
 */
export function restoreBackup(storage, backupKey) {
  try {
    const entry = listBackups(storage).find((b) => b.key === backupKey);
    if (!entry) return { ok: false, error: 'There is no such backup' };
    if (!entry.loadable) return { ok: false, error: 'That backup cannot be loaded' };
    const raw = storage.getItem(backupKey);
    const current = storage.getItem(entry.target);
    if (current != null && current !== raw) storage.setItem(`${entry.target}.replaced`, current);
    storage.setItem(entry.target, raw);
    return { ok: true, slot: entry.slot };
  } catch {
    return { ok: false, error: 'Could not restore — the browser blocked storage' };
  }
}

function keepCopy(storage, key, raw) {
  try {
    if (storage.getItem(key) == null) storage.setItem(key, raw);
  } catch { /* nothing more can be done */ }
}

const savedAtOf = (raw) => {
  const p = parse(raw);
  return p.ok && p.value && Number.isFinite(p.value.savedAt) ? p.value.savedAt : 0;
};

/** Keep `existing` (the save about to be replaced) as generation 1 when it is old enough; shift the others down. */
function rotate(storage, key, existing, now) {
  try {
    const g1 = storage.getItem(key + GEN_SUFFIXES[0]);
    const when = savedAtOf(existing) || now;
    if (g1 != null && when - savedAtOf(g1) < BACKUP_EVERY_MS) return false;
    for (let i = GENERATIONS - 1; i >= 1; i--) {
      const older = storage.getItem(key + GEN_SUFFIXES[i - 1]);
      if (older != null) storage.setItem(key + GEN_SUFFIXES[i], older);
    }
    storage.setItem(key + GEN_SUFFIXES[0], existing);
    return true;
  } catch {
    return false; // no room for a backup is no reason to refuse the save itself
  }
}

/** Backups that may be given up, oldest first, to make room for a live save. */
const EXPENDABLE = [...GEN_SUFFIXES].reverse().concat(['.replaced', '.prev', '.bak']);

/**
 * Write a slot. Refuses to overwrite a save from a newer game, keeps a copy of an old-format save the first
 * time it is replaced, keeps the last three saves, and never loses the live save to a failed write:
 *   - the new text is built before anything is touched;
 *   - if the browser refuses it (storage full), older backups are given up one at a time and the write is
 *     tried again, and if it still fails the live save is exactly what it was;
 *   - after the write the text is read back; if it is not what was written the previous save is put back.
 * Returns `{ ok, ... }`; on failure `reason` is 'newer', 'quota', 'storage' or 'verify'.
 */
export function writeSlot(storage, key, { kind, shift, campaign = null }, { now = Date.now() } = {}) {
  let existing = null;
  try {
    existing = storage.getItem(key);
    if (existing != null) {
      const p = parse(existing);
      if (p.ok && p.value && typeof p.value === 'object') {
        if ((p.value.format ?? 1) > ENVELOPE_FORMAT || Number(p.value.version) > SHIFT_VERSION
          || Number(p.value.shift?.version) > SHIFT_VERSION || Number(p.value.campaign?.version) > CAMPAIGN_VERSION) {
          return { ok: false, reason: 'newer', error: 'A newer save is stored here; it was not overwritten' };
        }
        if (p.value.format == null) keepCopy(storage, `${key}.bak`, existing);
      }
    }
  } catch {
    return { ok: false, reason: 'storage', error: 'Could not save — the browser blocked storage' };
  }

  let text;
  try {
    const check = { engines: shift.engines?.length ?? 0, crews: shift.crews?.length ?? 0, patients: shift.patients?.length ?? 0 };
    text = JSON.stringify({ format: ENVELOPE_FORMAT, kind, savedAt: now, check, shift, ...(campaign ? { campaign } : {}) });
  } catch {
    return { ok: false, reason: 'storage', error: 'Could not save — the shift could not be written out' };
  }

  if (existing != null) rotate(storage, key, existing, now);

  const freed = []; // [suffix, text] of the backups given up, so they can be put back if it was no use
  const attempt = () => {
    try {
      storage.setItem(key, text);
      return true;
    } catch {
      return false;
    }
  };
  let wrote = attempt();
  for (const suffix of EXPENDABLE) {
    if (wrote) break;
    try {
      const old = storage.getItem(key + suffix);
      if (old == null) continue;
      storage.removeItem(key + suffix);
      freed.push([suffix, old]);
    } catch { continue; }
    wrote = attempt();
  }
  if (!wrote) {
    // Giving the backups up did not help (the save is simply too big): put them back.
    for (const [suffix, old] of freed) {
      try {
        storage.setItem(key + suffix, old);
      } catch { /* best effort */ }
    }
    return { ok: false, reason: 'quota', error: 'Could not save — the browser has no room left; the previous save is unchanged' };
  }

  let back = null;
  try {
    back = storage.getItem(key);
  } catch { /* read-back is best-effort */ }
  if (back !== text) {
    try {
      if (existing != null) storage.setItem(key, existing);
    } catch { /* nothing more can be done */ }
    return { ok: false, reason: 'verify', error: 'Could not save — what was stored did not match; the previous save was put back' };
  }
  return { ok: true, bytes: text.length, ...(freed.length ? { freed: freed.map(([suffix]) => suffix.slice(1)) } : {}) };
}

/**
 * Copy whatever is in a slot to `<key><suffix>` (an older copy there is replaced). Used
 * before a save is overwritten by something that is not its own continuation.
 */
export function archiveSlot(storage, key, suffix = '.replaced') {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return false;
    storage.setItem(key + suffix, raw);
    return true;
  } catch {
    return false;
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
