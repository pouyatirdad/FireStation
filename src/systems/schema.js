// Declarative save schemas for the entities of a shift.
//
// A schema lists EVERY field an entity can have and says what happens to it in a save:
//
//   saved       written to the save, read back with a type check, bounds and a default
//   derived     rebuilt from the city seed or the vehicle spec when a shift is loaded (a test checks that it
//               has not changed since the shift started, so it really is derived)
//   transient   deliberately not saved, with the reason written next to it (caches, per-frame flags,
//               cosmetic accumulators, values recomputed every tick)
//
// A test (test/schema.test.js) plays busy games and fails if a live entity has a field that no schema
// declares, so a new field cannot silently miss the save: it has to be declared here, as one of the three.
//
// How damaged data is handled (`loadFields`):
//   - a saved field of the wrong type, not finite, or out of bounds is repaired (clamped, or replaced by its
//     default) and reported in `issues`; the entity itself is kept;
//   - a field that is missing takes its default silently (that is what an older save looks like);
//   - a field the schema does not know is NOT discarded: it is kept in `extra`, written back by `saveFields`,
//     and reported once as an unknown field (a save from a slightly newer build keeps its extras, and a typo
//     in a hand-edited save is visible instead of vanishing).
//
// This module is a leaf: it imports nothing from the game.

const MAX_STR = 120;

// --------------------------------------------------------------- field kinds ---

const saved = (kind, def, extra = {}) => ({ persist: 'saved', kind, def, ...extra });

/** A finite number, clamped to [min, max]. */
export const num = (def = 0, min = -Infinity, max = Infinity) => saved('number', def, { min, max });
/** A whole number, clamped to [min, max]. */
export const int = (def = 0, min = -Infinity, max = Infinity) => saved('int', def, { min, max });
export const bool = (def = false) => saved('bool', def);
/** A string. Over `max` it is cut, unless `cut` is false, when a too-long value is treated as damaged. */
export const str = (def = '', max = MAX_STR, cut = true) => saved('string', def, { max, cut });
/** A string or null. */
export const optStr = (max = MAX_STR) => saved('optString', null, { max });
/** One of a fixed list. */
export const oneOf = (values, def) => saved('enum', def ?? values[0], { values });
/** A reference to another entity's id (a short string) or null. */
export const ref = () => saved('ref', null);
/** Anything JSON; `clean(value)` returns the repaired value or `undefined` if it cannot be repaired. */
export const json = (def, clean = null, out = null) => saved('json', def, { clean, out });

/** A field that is rebuilt on load (from the city seed, the vehicle spec or other saved fields). */
export const derived = (reason) => ({ persist: 'derived', reason });
/** A field that is deliberately not saved. */
export const transient = (reason) => ({ persist: 'transient', reason });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p) => p && typeof p === 'object' && isNum(p.x) && isNum(p.y);

/** An array of {x, y} points (a route); bad points are dropped, long routes are cut; saved to a tenth of a pixel. */
const route = (max = 4000) => json([], (v) => (Array.isArray(v)
  ? v.filter(isPoint).slice(0, max).map((p) => ({ x: p.x, y: p.y }))
  : undefined), (v) => v.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })));

const cleanKit = (v) => (Array.isArray(v)
  ? v.filter((c) => c && typeof c === 'object').slice(0, 64).map((c) => ({ ...c }))
  : undefined);

const cleanObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : undefined);

// ----------------------------------------------------------------- the seven ---

export const BUILDING_STATES = ['ok', 'burning', 'out', 'rubble'];

export const SCHEMAS = {};
const define = (name, fields) => { SCHEMAS[name] = { name, fields }; return SCHEMAS[name]; };

/**
 * A building. Only the dynamic fields are saved; everything about what a building *is* comes from the city
 * seed. A building whose saved fields are all as they were at the start of the shift is left out of the save
 * altogether (`serializeBuildings` in fire.js), which is most of the 1,100 buildings.
 */
define('building', {
  id: ref(),
  state: oneOf(BUILDING_STATES, 'ok'),
  fire: num(0, 0, 1),
  integrity: num((b) => b.maxIntegrity, 0, Infinity),
  trapped: int(0, 0, 10000),
  occupants: int(0, 0, 100000),
  evacuated: bool(false),
  reward: num(0, 0, 1e7),
  incidentType: optStr(),
  incidentLabel: optStr(),
  neglect: num(0, 0, 1e6),
  hazmat: bool(false),
  big: bool(false),
  leak: num(0, 0, 1e6),
  collapse: json(null, (v) => (v === null ? null : cleanObj(v))),
  utilityCut: bool(false),
  evacZone: optStr(),
  evacOccupants: saved('optInt', null, { min: 0, max: 100000 }),
  spreadTimer: num(0, -1e6, 1e6),
  dryTime: num(0, 0, 1e6),
  runaway: bool(false),
  ignitedAt: saved('optNumber', null),
  // what a building is: the city seed gives it back
  type: derived('city seed'),
  zone: derived('city seed'),
  waterfront: derived('city seed'),
  sizeClass: derived('city seed'),
  name: derived('city seed'),
  x: derived('city seed'),
  y: derived('city seed'),
  w: derived('city seed'),
  h: derived('city seed'),
  floors: derived('city seed'),
  elevation: derived('city seed'),
  roofColor: derived('city seed'),
  maxIntegrity: derived('city seed'),
  risk: derived('city seed'),
  details: derived('city seed'),
  stationIndex: derived('city seed'),
  base: derived('city seed'),
  smokeAcc: transient('cosmetic smoke-puff accumulator'),
  tookHold: transient('recomputed from `neglect` when a shift is loaded'),
});

define('engine', {
  id: ref(),
  type: str('engine', 32),
  number: int(1, 1, 9999),
  name: str('', 60),
  bayIndex: int(0, 0, 255),
  hotkey: str('', 2),
  x: num(0, -1e7, 1e7),
  y: num(0, -1e7, 1e7),
  angle: num(0, -1e4, 1e4),
  water: num((e) => e.capacity ?? 0, 0, 1e7),
  targetId: ref(),
  supply: json(null, (v) => (v === null ? null : cleanObj(v))),
  kits: num(0, 0, 999),
  cargo: json([], cleanKit),
  path: route(),
  goal: json(null, (v) => (v === null ? null : (v && Number.isInteger(v.x) && Number.isInteger(v.y) ? { x: v.x, y: v.y } : undefined))),
  arrived: bool(false),
  packTimer: num(0, 0, 10),
  wildfireId: ref(),
  blockadeId: ref(),
  victimId: ref(),
  patientId: ref(),
  hospitalId: ref(),
  standbyFor: json(null, (v) => (v === null ? null : (v && typeof v.id === 'string' && typeof v.kind === 'string' ? { kind: v.kind, id: v.id } : undefined))),
  mission: json(null, (v) => (v === null ? null : (v && isNum(v.x) && isNum(v.y) && (v.mode === 'attack' || v.mode === 'refill') ? { ...v } : undefined))),
  status: str('in quarters', 40, false),
  kitAcc: num(0, 0, 100),
  worked: bool(false),
  returnIn: saved('optNumber', null),
  hospitalRetry: saved('optNumber', null),
  emptyWarned: bool(false),
  fullNotified: bool(false),
  lowWarned: bool(false),
  noHospital: bool(false),
  dryHome: json(null, (v) => (v === null || typeof v === 'boolean' ? v : undefined)),
  refilling: transient('set every tick by the vehicle update from its supply'),
  pumping: transient('set every tick by the vehicle update from its crews'),
  etaCache: transient('a route cache; rebuilt on demand'),
  kind: derived('always "engine"'),
  spec: derived('the vehicle type\'s spec, copied from CONFIG.vehicles by type'),
  base: derived('the vehicle type\'s spec in CONFIG.vehicles'),
  capacity: derived('from the spec'),
  crewIds: derived('rebuilt from the crew list (each crew member names its engine)'),
});

define('crew', {
  id: ref(),
  number: int(1, 1, 99999),
  name: str('', 60),
  engineId: ref(),
  personId: ref(),
  x: num(0, -1e7, 1e7),
  y: num(0, -1e7, 1e7),
  angle: num(0, -1e4, 1e4),
  riding: bool(true),
  targetId: ref(),
  wildfireId: ref(),
  tool: saved('optString', null, { max: 24 }),
  fetch: saved('optString', null, { max: 24 }),
  fetchTimer: num(0, 0, 1e4),
  cut: json(null, (v) => (v === null ? null : cleanObj(v))),
  path: route(2000),
  rescueTimer: num(0, 0, 1e4),
  rescueId: ref(),
  patientId: ref(),
  treatTimer: num(0, 0, 1e4),
  victimId: ref(),
  idleFor: num(0, 0, 1e6),
  boarding: bool(false),
  think: num(0, -1e4, 1e4),
  warned: bool(false),
  warnedHazard: bool(false),
  contamination: num(0, 0, 1e4),
  status: str('aboard', 40, false),
  kind: derived('always "crew"'),
  medic: derived('from the vehicle spec'),
  spraying: transient('set every tick by the crew update from its target'),
});

define('patient', {
  id: ref(),
  x: num(0, -1e7, 1e7),
  y: num(0, -1e7, 1e7),
  buildingId: ref(),
  buildingName: str('somewhere', 80),
  severity: num(0.5, 0, 1),
  critical: bool(false),
  life: num(1, -1e6, 1e6),
  maxLife: num(1, 0, 1e6),
  treated: bool(false),
  treatTimer: num(0, 0, 1e4),
  claimedBy: ref(),
  medicId: ref(),
  leaveAt: num(0, 0, 1e9),
  reason: optStr(),
  kind: derived('always "patient"'),
  name: derived('a constant label'),
});

define('victim', {
  id: ref(),
  x: num(0, -1e7, 1e7),
  y: num(0, -1e7, 1e7),
  label: str('the water', 80),
  life: num(1, -1e6, 1e6),
  maxLife: num(1, 0, 1e6),
  rescueTimer: num(0, 0, 1e4),
  diverId: ref(),
  kind: derived('always "victim"'),
  name: derived('a constant label'),
});

define('blockade', {
  id: ref(),
  name: str('Blocked road', 80),
  place: str('', 80),
  tx: int(0, 0, 100000),
  ty: int(0, 0, 100000),
  tw: int(1, 1, 1000),
  th: int(1, 1, 1000),
  progress: num(0, 0, 1),
  big: bool(false),
  reward: num(0, 0, 1e7),
  fuelAt: saved('optNumber', null),
  fuelDone: bool(false),
  debris: bool(false),
  createdAt: num(0, -1e9, 1e9),
  kind: derived('always "blockade"'),
  x: derived('from the tile box (tx, tw)'),
  y: derived('from the tile box (ty, th)'),
  w: derived('from the tile box'),
  h: derived('from the tile box'),
  saved: derived('the tiles sealed by the wreck, found again by sealing the street when it is restored'),
});

define('wildfire', {
  id: ref(),
  name: str('Forest fire', 80),
  x: num(0, -1e7, 1e7),
  y: num(0, -1e7, 1e7),
  radius: num(80, 0, 1e6),
  maxRadius: num(576, 0, 1e6),
  intensity: num(0.55, 0, 1),
  reward: num(0, 0, 1e7),
  spreadTimer: num(5, -1e4, 1e4),
  big: bool(true),
  kind: derived('always "wildfire"'),
  smokeAcc: transient('cosmetic smoke-puff accumulator'),
});

// ------------------------------------------------------------------ helpers ---

/** The default of a field: a value, or a function of the entity it belongs to. */
const defaultOf = (field, entity) => {
  const d = typeof field.def === 'function' ? field.def(entity ?? {}) : field.def;
  return d && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : d;
};

const SHORT = 64;

/** Check one value against a field; returns the repaired value, or `undefined` if it cannot be used. */
function check(field, v, entity) {
  switch (field.kind) {
    case 'number': return isNum(v) ? Math.min(field.max, Math.max(field.min, v)) : undefined;
    case 'optNumber': return v === null ? null : isNum(v) ? v : undefined;
    case 'int': return isNum(v) ? Math.min(field.max, Math.max(field.min, Math.round(v))) : undefined;
    case 'optInt': return v === null ? null : isNum(v) ? Math.min(field.max, Math.max(field.min, Math.round(v))) : undefined;
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'string': return typeof v === 'string' && (field.cut || v.length <= field.max) ? v.slice(0, field.max) : undefined;
    case 'optString': return v === null ? null : typeof v === 'string' ? v.slice(0, field.max ?? MAX_STR) : undefined;
    case 'enum': return field.values.includes(v) ? v : undefined;
    case 'ref': return v === null ? null : typeof v === 'string' && v.length > 0 && v.length < SHORT ? v : undefined;
    case 'json': {
      if (field.clean) return field.clean(v, entity);
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    }
    default: return undefined;
  }
}

export const fieldNames = (schema, which = null) => Object.entries(schema.fields)
  .filter(([, f]) => which == null || f.persist === which).map(([k]) => k);

/** Every field the schema declares, in any category. */
export const declaredNames = (schema) => new Set(Object.keys(schema.fields));

/**
 * The saved form of an entity: its `saved` fields, plus any unknown fields it carries in `extra`.
 * With `compact`, fields equal to their default are left out (the loader puts the default back).
 */
export function saveFields(schema, entity, { compact = false } = {}) {
  const out = {};
  for (const [name, f] of Object.entries(schema.fields)) {
    if (f.persist !== 'saved') continue;
    let v = entity[name];
    if (v === undefined) v = defaultOf(f, entity);
    if (compact && JSON.stringify(v) === JSON.stringify(defaultOf(f, entity))) continue;
    if (f.kind === 'json' && v && typeof v === 'object') v = f.out ? f.out(v) : JSON.parse(JSON.stringify(v));
    out[name] = v;
  }
  if (entity.extra && typeof entity.extra === 'object') {
    for (const [k, v] of Object.entries(entity.extra)) if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * Read a saved entity. `target` supplies the values the defaults are computed from (for example a building's
 * `maxIntegrity`) and is NOT modified. Returns `{ values, extra, issues }`:
 *   values  every `saved` field, repaired or defaulted
 *   extra   fields the schema does not know (kept so they are written back)
 *   issues  strings describing what was repaired
 * A field that is absent keeps `target[name]` if the target has one and `keep` is set (compact saves), else its default.
 */
export function loadFields(schema, data, target = null, { keep = false, where = schema.name } = {}) {
  const values = {};
  const extra = {};
  const issues = [];
  const src = data && typeof data === 'object' ? data : {};
  for (const [name, f] of Object.entries(schema.fields)) {
    if (f.persist !== 'saved') continue;
    if (!(name in src) || src[name] === undefined) {
      values[name] = keep && target && name in target ? target[name] : defaultOf(f, target);
      continue;
    }
    const ok = check(f, src[name], target);
    if (ok === undefined) {
      issues.push(`${where}.${name} was damaged and has been reset`);
      values[name] = defaultOf(f, target);
    } else {
      if ((f.kind === 'number' || f.kind === 'int') && (src[name] < f.min || src[name] > f.max)) {
        issues.push(`${where}.${name} was out of range and has been limited`);
      }
      values[name] = ok;
    }
  }
  for (const k of Object.keys(src)) {
    if (!(k in schema.fields)) extra[k] = src[k];
  }
  if (Object.keys(extra).length > 0) issues.push(`${where} has unknown fields: ${Object.keys(extra).join(', ')} (kept)`);
  return { values, extra, issues };
}

/** Apply `loadFields` results onto an entity (and remember the extras). */
export function applyFields(entity, result) {
  Object.assign(entity, result.values);
  if (Object.keys(result.extra).length > 0) entity.extra = { ...(entity.extra ?? {}), ...result.extra };
  return entity;
}

/**
 * Drop entities that share an id (the first one wins) and entities with no usable id.
 * Returns `{ list, issues }`.
 */
export function uniqueById(list, where) {
  const seen = new Set();
  const out = [];
  const issues = [];
  for (const item of Array.isArray(list) ? list : []) {
    const id = item && typeof item === 'object' ? item.id : null;
    if (typeof id !== 'string' || id.length === 0 || id.length >= SHORT) {
      issues.push(`${where}: an entry with no usable id was dropped`);
      continue;
    }
    if (seen.has(id)) {
      issues.push(`${where}: duplicate id ${id} — the later entry was dropped`);
      continue;
    }
    seen.add(id);
    out.push(item);
  }
  return { list: out, issues };
}
