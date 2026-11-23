// The persistence registry: each system saves and loads the part of a shift it owns.
//
//   registerPersistence({ key, save(state), load(state, data, ctx), order })
//
// `serialize` (game.js) asks every registered section for its part and merges them; `loadState` hands every
// section the whole saved shift in `order`. A system registers itself when its module is imported, so adding
// a field to a system means changing that system, not game.js.
//
//   key     the section's name, and the top-level key of the save its value is stored under
//   keys    (optional) when a section owns several top-level keys, `save` returns an object holding those keys
//   fields  (optional) the live state fields the section owns when they are not just `key` (state.crew for the
//           'crews' key); the coverage test checks every live field is owned by a section or listed in TRANSIENT_STATE
//   save    state -> JSON-safe value (or the object of `keys`)
//   load    (state, data, ctx) -> void. `data` is the WHOLE saved shift (so a section can read what it needs,
//           including keys written by an older version); `ctx.issues` collects what was repaired, `ctx.campaign`
//           is the career's campaign (or null)
//   order   load order, low first (fleet before the things that point at vehicles, and so on)
//
// Top-level fields of the live state that are not owned by any section are listed in TRANSIENT_STATE with
// the reason they are not saved; a test fails when the live state has a field that is neither.
//
// This module is a leaf: it imports nothing from the game.

/** The shift save format this build writes; `OLDEST_SHIFT` is the oldest it can still migrate. */
export const SHIFT_VERSION = 18;
export const OLDEST_SHIFT = 16;

/** Keys an older save carries that a section still reads itself, so they are not "unknown". */
export const LEGACY_KEYS = ['buildingExtras'];

const sections = new Map();

export function registerPersistence({ key, save, load, order = 50, keys = null, fields = null }) {
  if (typeof key !== 'string' || typeof save !== 'function' || typeof load !== 'function') {
    throw new Error('registerPersistence needs { key, save, load }');
  }
  sections.set(key, { key, save, load, order, keys: keys ?? [key], fields: fields ?? (keys ? [] : [key]) });
}

/** Every live state field some section owns. */
export const ownedStateFields = () => new Set(persistenceSections().flatMap((s) => s.fields));

export const persistenceSections = () => [...sections.values()].sort((a, b) => a.order - b.order);

/** Every top-level key of a save that some section owns. */
export const ownedKeys = () => new Set(persistenceSections().flatMap((s) => s.keys));

/** Ask every section for its part of the save. */
export function saveSections(state) {
  const out = {};
  for (const s of persistenceSections()) {
    const part = s.save(state);
    if (s.keys.length === 1 && s.keys[0] === s.key) out[s.key] = part;
    else Object.assign(out, part); // a section that owns several keys returns them as an object
  }
  return out;
}

/** Hand every section the saved shift. Returns the issues the sections reported. */
export function loadSections(state, data, ctx = {}) {
  const issues = ctx.issues ?? [];
  const full = { ...ctx, issues };
  for (const s of persistenceSections()) s.load(state, data, full);
  return issues;
}

/**
 * Top-level fields of the live state that are deliberately NOT saved, and why. (Fields that a section
 * owns are not listed here; fields of the entities have their own schemas.)
 */
export const TRANSIENT_STATE = {
  city: 'rebuilt from the seed',
  nav: 'rebuilt from the city, the blockades and the cuts',
  running: 'set by loadState',
  paused: 'set by loadState',
  over: 'a finished shift is not saved',
  speed: 'a view setting; the game loop owns it',
  rng: 'a loaded shift carries on with fresh luck derived from rngSeed and the clock',
  streams: 'per-frame list of water jets',
  hoses: 'per-frame list of hose lines',
  fx: 'particles',
  fleeing: 'decorative people running from a fire; the numbers that matter (escaped, rescued) are counted when they leave',
  hazards: 'recomputed every tick from the leaking buildings',
  cutCount: 'derived from the cut list',
  selected: 'the UI selection',
  ui: 'UI scratch space',
  units: 'derived: engines and crew',
  vehicleCount: 'derived from the engines\' numbers',
  nextCrew: 'derived from the crew numbers',
  activeEngineId: 'the UI selection',
  traffic: 'ambient cars, regenerated',
  trafficFactor: 'recomputed from the clock every tick',
  rushNow: 'recomputed from the clock every tick',
  onDestroyed: 'callback',
  onExplosion: 'callback',
  onBlockadeChange: 'callback',
  lastEvent: 'a pointer to the newest log entry',
  hooks: 'listeners registered by the running game',
  objAcc: 'a one-second accumulator for the objectives check',
  saveStatus: 'a label for the HUD',
  loadReport: 'what the last load repaired; recomputed by every load',
  shiftSummary: 'a finished career shift is filed, not saved as a shift in progress',
  onSave: 'callback',
};

// ---------------------------------------------------------------- id counters ---

/**
 * The next id for a kind of entity ("patient" -> "patient1", "patient2", ...). Counters live on the game
 * (`state.ids`), are saved with it, and never go back, so two games in one page do not share numbering and a
 * loaded game cannot hand out an id it already has.
 */
export function nextId(state, name) {
  const ids = (state.ids = state.ids ?? {});
  ids[name] = (ids[name] ?? 0) + 1;
  return `${name}${ids[name]}`;
}

const SUFFIX = /(\d+)$/;

/** After a load: the counters carry on from the saved ones, and from the highest id already in use. */
export function reserveIds(state, saved, lists) {
  const ids = {};
  if (saved && typeof saved === 'object') {
    for (const [k, v] of Object.entries(saved)) if (Number.isFinite(v) && v >= 0 && v < 1e9) ids[k] = Math.floor(v);
  }
  for (const [name, list] of Object.entries(lists)) {
    for (const item of list ?? []) {
      const m = typeof item?.id === 'string' && item.id.startsWith(name) ? SUFFIX.exec(item.id) : null;
      if (m) ids[name] = Math.max(ids[name] ?? 0, Number(m[1]));
    }
  }
  state.ids = ids;
  return ids;
}

/** A JSON-safe deep copy (null and undefined pass through). */
export const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
