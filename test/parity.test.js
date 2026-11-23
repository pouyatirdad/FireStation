// The Quick Response regression guard. The fixture was recorded on 0.17.1 before any 0.18 change
// (tools/parity-run.mjs). With the 0.18 hospital rules switched off, the same seeds and the same scripted
// player must give exactly the same shift; with them on, only the medical side may move.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CONFIG } from '../src/core/config.js';
import { runAll } from '../tools/parity-run.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/parity-quick.json', import.meta.url), 'utf8'));
const RULE = CONFIG.medical.hospital;
const DEFAULT = { ...RULE };

test.afterEach(() => Object.assign(RULE, DEFAULT));

test('Quick Response with the 0.17 hospital rules reproduces the recorded 0.17.1 shifts exactly', () => {
  Object.assign(RULE, { anyIntact: false, byRoute: false, avoidBurning: false });
  const got = runAll();
  assert.equal(got.length, fixture.length);
  got.forEach((run, i) => assert.deepEqual(run, fixture[i], `case ${run.key} moved`));
});

test('with the new hospital rules on, fire, calls and fleet are unchanged and only the medical side may differ', () => {
  const got = runAll();
  got.forEach((run, i) => {
    const base = fixture[i];
    assert.equal(run.key, base.key);
    assert.equal(run.engines, base.engines);
    for (const k of ['alarms', 'saved', 'lost', 'rescued', 'escaped']) {
      assert.equal(run.stats[k], base.stats[k], `${run.key}: ${k}`);
    }
    // the same number of people were hurt in the fires; who made it to a hospital may differ a little
    assert.ok(Math.abs((run.stats.treated ?? 0) - (base.stats.treated ?? 0)) <= 4, `${run.key}: treated`);
    assert.ok((run.stats.transported ?? 0) >= (base.stats.transported ?? 0) - 1, `${run.key}: transported`);
    assert.ok(run.stats.casualties <= base.stats.casualties + 1, `${run.key}: casualties`);
  });
});
