import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, startShift, update, commandBuyVehicle } from '../src/systems/game.js';
import { createCareer } from '../src/systems/modes.js';
import * as command from '../src/ui/command.js';
import { drawCommandOverlays } from '../src/render/overlays.js';
import { ignite } from '../src/systems/fire.js';
import { collapseBuilding } from '../src/systems/collapse.js';
import { startLeak } from '../src/systems/hazmat.js';
import { startEvacuation } from '../src/systems/evacuation.js';
import { callAgency } from '../src/systems/agencies.js';
import { startWildfire } from '../src/systems/wildfire.js';
import { applyPreset } from '../src/systems/presets.js';
import { buyUpgrade } from '../src/systems/stations.js';
import { eventSound } from '../src/systems/audio.js';
import { TILE } from '../src/core/config.js';

const memory = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

function quick() {
  const state = createGame(7);
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 99999;
  return state;
}

function career() {
  const state = createCareer({ name: 'UI' });
  startShift(state);
  state.incidentsEnabled = false;
  state.credits = 99999;
  return state;
}

const near = (state, type = 'house') => {
  const st = state.city.station;
  return state.buildings.find((b) => b.type === type && b.state === 'ok' && Math.hypot(b.x - st.x, b.y - st.y) > 14 && Math.hypot(b.x - st.x, b.y - st.y) < 50);
};

/** A canvas context that accepts every call, so the overlay code can run under Node. */
const fakeCtx = () => new Proxy({}, {
  get: (target, prop) => (prop in target ? target[prop] : () => ({ width: 10 })),
  set: (target, prop, value) => { target[prop] = value; return true; },
});

const clean = (html, where) => {
  assert.ok(typeof html === 'string' && html.length > 20, `${where}: empty`);
  assert.equal(/undefined|NaN|\[object/.test(html), false, `${where}: has ${html.match(/.{20}(undefined|NaN|\[object).{20}/)?.[0]}`);
};

test('every Headquarters tab renders clean HTML in each mode', () => {
  command.init(memory());
  const q = quick();
  assert.deepEqual(command.tabsFor(q).map(([id]) => id), ['fleet', 'dispatch', 'finance', 'contracts', 'report', 'play']);
  for (const id of ['dispatch', 'report', 'play']) clean(command.renderTab(id, q), `quick ${id}`);
  assert.equal(command.renderTab('people', q), '', 'career tabs are empty in Quick Response');
  assert.equal(command.renderTab('fleet', q), null, 'fleet is the hud');
  assert.equal(command.careerFinanceHtml(q), '');

  const c = career();
  assert.deepEqual(command.tabsFor(c).map(([id]) => id), ['fleet', 'dispatch', 'people', 'stations', 'career', 'finance', 'contracts', 'report']);
  for (const id of ['dispatch', 'people', 'stations', 'career', 'report']) clean(command.renderTab(id, c), `career ${id}`);
  clean(command.careerFinanceHtml(c), 'career finance');
  assert.match(command.renderTab('career', c), /End shift and file the report/);
  assert.match(command.renderTab('people', c), /Recruitment/);
  assert.match(command.renderTab('stations', c), /Garage expansion/);
});

test('the tabs react to the game: a running fire and a bought upgrade', () => {
  const c = career();
  const b = near(c);
  ignite(c, b, 'test');
  c.selected = { kind: 'building', id: b.id };
  const dispatchTab = command.renderTab('dispatch', c);
  assert.match(dispatchTab, /the selected incident/);
  assert.match(dispatchTab, /Building fire/);
  assert.match(command.renderTab('people', c), /On duty/);

  assert.equal(buyUpgrade(c, 0, 'storage'), true);
  assert.match(command.renderTab('stations', c), /Complete|pips/);
});

test('the incident card shows intel, ETAs, presets, support and evacuation where they make sense', () => {
  const q = quick();
  commandBuyVehicle(q, 'engine');
  commandBuyVehicle(q, 'ambulance');
  const b = near(q, 'warehouse') ?? near(q);
  b.hazmat = true;
  ignite(q, b, 'test');
  b.trapped = 2;
  q.selected = { kind: 'building', id: b.id };
  const before = command.incidentExtras(q);
  clean(before, 'extras');
  assert.match(before, /Intel/);
  assert.match(before, /2 trapped inside/);
  assert.match(before, /Nobody is on the way/);
  assert.match(before, /Evacuate area/);
  assert.match(before, /Hazmat incident/);
  for (const name of ['Police', 'EMS', 'Civil', 'Utility', 'Coast guard']) assert.match(before, new RegExp(name));

  const sig = command.incidentSignature(q);
  applyPreset(q, q.presets.find((p) => p.incident === 'hazmat').id, { kind: 'building', id: b.id });
  assert.notEqual(command.incidentSignature(q), sig, 'the card refreshes when units are sent');
  assert.match(command.incidentExtras(q), /ETA/);

  // A quiet building has nothing to add; a unit selected has no extras either.
  q.selected = { kind: 'building', id: near(q, 'shop').id };
  assert.equal(command.incidentExtras(q), '');
  assert.equal(command.selectedIncident(q), null);
  q.selected = null;
  assert.equal(command.incidentSignature(q), '');
});

test('collapse, leak, wildfire and patient cards also carry intel', () => {
  const q = quick();
  const b = near(q);
  collapseBuilding(q, b, 3);
  q.selected = { kind: 'building', id: b.id };
  assert.match(command.incidentExtras(q), /Secondary collapse/);
  const wf = startWildfire(q, 100 * TILE, 100 * TILE, 1000);
  q.selected = { kind: 'wildfire', id: wf.id };
  assert.match(command.incidentExtras(q), /Evacuate area/);
  assert.match(command.incidentExtras(q), /Air support/);
});

test('the map overlays draw every kind of command marker without error', () => {
  const c = career();
  const [a, b, w] = [near(c, 'house'), near(c, 'apartment') ?? near(c, 'shop'), near(c, 'warehouse') ?? near(c, 'factory') ?? near(c, 'office')];
  collapseBuilding(c, a, 3);
  startLeak(c, w, 1);
  update(c, 1 / 60);
  startEvacuation(c, { x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE, radius: 6 * TILE, label: 'here' });
  callAgency(c, 'police', { kind: 'building', id: b.id });
  callAgency(c, 'utility', { kind: 'building', id: w.id });
  b.utilityCut = true;
  c.campaign.level = 3;
  for (const key of ['garage', 'tower', 'comms', 'storage']) buyUpgrade(c, 0, key);
  ignite(c, b, 'test');
  const engine = c.engines[0];
  c.selected = { kind: 'building', id: b.id };
  applyPreset(c, c.presets[0].id, { kind: 'building', id: b.id });
  assert.ok(engine.path.length > 0);
  update(c, 1 / 60);
  assert.equal(c.hazards.length, 1);
  assert.doesNotThrow(() => drawCommandOverlays(fakeCtx(), c, 1.5, 1));
  c.selected = { kind: 'unit', id: engine.id };
  assert.doesNotThrow(() => drawCommandOverlays(fakeCtx(), c, 1.5, 0.3));
  c.selected = null;
  assert.doesNotThrow(() => drawCommandOverlays(fakeCtx(), quick(), 0, 1));
});

test('new events map to radio and promotion sounds without disturbing the old ones', () => {
  assert.equal(eventSound({ tone: 'good', text: 'Building fire: 3 units dispatched' }), 'radio');
  assert.equal(eventSound({ tone: 'good', text: 'Police on scene — streets closed round the incident' }), 'radio');
  assert.equal(eventSound({ tone: 'info', text: 'Police called — arriving in 25 s ($450)' }), 'radio');
  assert.equal(eventSound({ tone: 'big', text: 'PROMOTION — City Department!' }), 'chime');
  assert.equal(eventSound({ tone: 'big', text: 'SECONDARY COLLAPSE at X' }), 'rumble');
  assert.equal(eventSound({ tone: 'big', text: 'EXPLOSION at X!' }), 'boom');
  assert.equal(eventSound({ tone: 'big', text: 'MAJOR INCIDENT' }), 'klaxon');
  assert.equal(eventSound({ tone: 'good', text: 'Incident closed — $600' }), 'cash');
  assert.equal(eventSound({ tone: 'info', text: 'Shift saved' }), null);
});

test('overlays are culled to the view and the collapse cloud plays only in its first seconds', () => {
  const c = career();
  const b = near(c);
  collapseBuilding(c, b, 3);
  ignite(c, near(c, 'apartment') ?? near(c, 'shop'), 'test');
  let calls = 0;
  const counting = () => new Proxy({}, {
    get: (target, prop) => (prop in target ? target[prop] : () => { calls += 1; return { width: 10 }; }),
    set: (target, prop, value) => { target[prop] = value; return true; },
  });
  const here = { x0: b.x - 10, y0: b.y - 10, x1: b.x + 20, y1: b.y + 20 };
  const away = { x0: 0, y0: 380, x1: 5, y1: 383 };
  drawCommandOverlays(counting(), c, c.time, 1, here);
  const visible = calls;
  calls = 0;
  drawCommandOverlays(counting(), c, c.time, 1, away);
  assert.ok(visible > 20, `drew ${visible}`);
  assert.ok(calls < visible / 3, `off-screen work ${calls} vs ${visible}`);

  // The big dust cloud (arcs) is drawn at the start and replaced by a few drifting puffs later.
  const t0 = b.collapse.at;
  const arcs = (age) => {
    let n = 0;
    const ctx = new Proxy({}, { get: (t, p) => (p === 'arc' ? () => { n += 1; } : p in t ? t[p] : () => ({ width: 10 })), set: (t, p, v) => { t[p] = v; return true; } });
    drawCommandOverlays(ctx, c, t0 + age, 1, here);
    return n;
  };
  assert.ok(arcs(1) > arcs(10), 'more dust at first than later');
  assert.ok(arcs(10) >= 3, 'some drifting dust while people are buried');
  b.collapse = null;
  b.trapped = 0;
  assert.ok(arcs(10) < 3 + 3, 'no rubble puffs once the rescue is over');
});
