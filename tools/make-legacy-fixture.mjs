// Produces a genuine historical save from an old checkout of the game, using THAT checkout's own code to play a
// short deterministic busy shift and to write the save exactly as that version's game wrote it.
//
//   node tools/make-legacy-fixture.mjs <checkout dir> <bare|quick|career|challenge> <out file>
//
//   bare       the 0.9 format: a bare shift (version 16) as `localStorage['firestation.save.v16']` held it
//   quick      the 0.17 envelope, kind "quick"        (writeSlot of that checkout, shift version 17)
//   career     the 0.17 envelope, kind "career"       (shift + campaign)
//   challenge  the 0.17 envelope, kind "challenge"    (shift with its scenario)
//
// Nothing here edits a save by hand: the text written to <out file> is what the old game put in storage.
// See test/fixtures/legacy/README.md for the commits used and the exact commands.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, kind, out] = process.argv.slice(2);
if (!dir || !kind || !out) {
  console.error('usage: node tools/make-legacy-fixture.mjs <checkout dir> <bare|quick|career|challenge> <out file>');
  process.exit(2);
}
const src = (p) => pathToFileURL(path.resolve(dir, 'src', p)).href;
const has = (p) => fs.existsSync(path.resolve(dir, 'src', p));

const game = await import(src('systems/game.js'));
const { Rng } = await import(src('core/math.js'));
const water = await import(src('systems/water.js'));
const { createGame, startShift, update, commandBuyVehicle, commandDispatchAll, serialize } = game;

let state;
if (kind === 'career') {
  const modes = await import(src('systems/modes.js'));
  state = modes.createCareer({ name: 'Legacy Fixture' });
} else if (kind === 'challenge') {
  const modes = await import(src('systems/modes.js'));
  const { findChallenge } = await import(src('data/scenarios.js'));
  state = modes.createScenarioGame(findChallenge('mass-casualty'));
} else {
  state = createGame(7);
}
startShift(state);
state.rng = new Rng(404);
state.credits = Math.max(state.credits, 30000);
for (const type of ['ambulance', 'ladder', 'rescue', 'tanker']) commandBuyVehicle(state, type);

// Play until something is going on everywhere that matters: a fire, a patient, a person in the water,
// a vehicle on the road, and (for a first save) someone already on a stretcher if that happens.
let busy = 0;
for (let t = 0; t < 60 * 420; t++) {
  update(state, 1 / 60);
  if (t === 60 * 25 || t === 60 * 90) water.drowningCall(state, () => true);
  if (t % 120 === 0) commandDispatchAll(state);
  if (t > 60 * 150 && t % 30 === 0) {
    const burning = state.buildings.some((b) => b.state === 'burning');
    const driving = state.engines.some((e) => e.path.length > 0);
    const aboard = state.engines.some((e) => (e.cargo?.length ?? 0) > 0);
    const hurt = state.patients.length > 0;
    busy = (burning ? 1 : 0) + (driving ? 1 : 0) + (hurt ? 1 : 0) + (aboard ? 2 : 0) + (state.victims.length > 0 ? 1 : 0);
    if (busy >= 4) break;
  }
}

let text;
if (kind === 'bare') {
  text = JSON.stringify(serialize(state)); // what 0.9's saveGame stored
} else {
  const saves = await import(src('systems/saves.js'));
  const modes = await import(src('systems/modes.js'));
  const data = kind === 'career' ? modes.careerSlotData(state) : kind === 'challenge' ? modes.scenarioSlotData(state)
    : { kind: 'quick', shift: serialize(state) };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const key = kind === 'career' ? saves.KEYS.career : kind === 'challenge' ? saves.KEYS.challenge : saves.KEYS.quick;
  const result = saves.writeSlot(storage, key, data);
  if (!result.ok) throw new Error(`the old game could not write its save: ${result.error}`);
  text = storage.getItem(key);
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, text);

const shift = JSON.parse(text);
const body = shift.shift ?? shift;
console.log(JSON.stringify({
  kind, bytes: text.length, shiftVersion: body.version, format: shift.format ?? null, time: Math.round(body.time),
  engines: body.engines.length, crews: body.crews.length, patients: body.patients.length, victims: body.victims.length,
  buildings: body.buildings.length, burning: body.buildings.filter((b) => b.state === 'burning').length,
  driving: body.engines.filter((e) => e.path?.length > 0).length, aboard: body.engines.reduce((n, e) => n + (e.cargo?.length ?? 0), 0),
  stats: body.stats, hasModules: { modes: has('systems/modes.js') }, busy,
}));
