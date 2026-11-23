// A deterministic Quick Response run used as a regression guard ("parity"): the same seeds, the same
// scripted player, the same clock. The numbers it returns were recorded on 0.17.1 and are kept in
// test/fixtures/parity-quick.json; test/parity.test.js fails when a change moves them where no change was
// intended. Not part of the game: it is only imported by the tests and by developers.
//
//   node tools/parity-run.mjs            print the numbers
//   node tools/parity-run.mjs --write    rewrite test/fixtures/parity-quick.json (only when a change is intended)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => pathToFileURL(path.join(root, 'src', p)).href;

const { createGame, startShift, update, commandBuyVehicle, commandDispatchAll } = await import(src('systems/game.js'));
const { Rng } = await import(src('core/math.js'));
const { drowningCall } = await import(src('systems/water.js'));

/** Cases: [city seed, call seed, seconds, vehicles bought at the start, seconds at which someone falls in the water]. */
export const CASES = [
  [7, 101, 600, ['engine', 'ambulance', 'ladder']],
  [7, 202, 600, ['engine', 'engine', 'ambulance', 'ambulance', 'rescue']],
  [11, 303, 480, ['engine', 'ambulance', 'tanker', 'medcar']],
  [7, 404, 600, ['engine', 'rescue', 'ambulance', 'ambulance'], [20, 150, 300]],
];

export function runCase([seed, callSeed, seconds, fleet, drownAt = []]) {
  const s = createGame(seed);
  startShift(s);
  s.rng = new Rng(callSeed);
  s.credits = 30000;
  for (const type of fleet) commandBuyVehicle(s, type);
  for (let t = 0; t < seconds * 60; t++) {
    update(s, 1 / 60);
    if (drownAt.includes(Math.floor(t / 60)) && t % 60 === 0) drowningCall(s, () => true);
    if (t % 120 === 0) commandDispatchAll(s);
  }
  const by = {};
  for (const [k, v] of Object.entries(s.ledger.by ?? {})) by[k] = Math.round(v);
  return {
    key: `${seed}/${callSeed}/${seconds}`,
    stats: { ...s.stats },
    credits: Math.round(s.credits),
    rating: Math.round(s.rating),
    ledger: by,
    events: s.eventSeq,
    engines: s.engines.length,
    burning: s.buildings.filter((b) => b.state === 'burning').length,
    patients: s.patients.length,
    victims: s.victims.length,
    wildfires: s.wildfires.length,
  };
}

export const runAll = () => CASES.map(runCase);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runAll();
  if (process.argv.includes('--write')) {
    const file = path.join(root, 'test', 'fixtures', 'parity-quick.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${file}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
