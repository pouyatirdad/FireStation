// The shift report. An observer: each fraction of a second it looks at what is
// open on the map (burning or trapped buildings, forest fires, injured people,
// people in the water, wrecks), notes when each one began, when the first unit
// got there and how it ended, and keeps per-vehicle and per-station tallies.
// At the end of a shift `buildReport` turns all that, the money ledger and the
// running stats into the report screen and a grade (S, A, B, C or D).
//
// The simulation never reads this module back; it is the same kind of observer
// as the audio.

import { CONFIG, TILE } from '../core/config.js';
import { clamp } from '../core/math.js';
import { emit } from './hooks.js';

const SCAN_EVERY = 0.25;
const NEAR = 6 * TILE; // how close a road vehicle must be to count as on scene
const NEAR_AIR = 12 * TILE;
const MAX_DONE = 300;

export function createReport(state) {
  return {
    startedAt: state.time ?? 0,
    acc: 0,
    open: {},
    done: [],
    vehicles: {},
    stations: {},
    patientsSeen: 0,
    counts: {},
    lastCasualties: state.stats?.casualties ?? 0,
    base: {
      earned: state.ledger?.earned ?? 0,
      spent: state.ledger?.spent ?? 0,
      by: { ...(state.ledger?.by ?? {}) },
      stats: { ...(state.stats ?? {}) },
    },
  };
}

export function restoreReport(state, data) {
  const fresh = createReport(state);
  if (!data || typeof data !== 'object') return fresh;
  return {
    ...fresh,
    ...data,
    open: data.open && typeof data.open === 'object' ? data.open : {},
    done: Array.isArray(data.done) ? data.done : [],
    counts: data.counts ?? {},
    vehicles: data.vehicles ?? {},
    stations: data.stations ?? {},
    base: { ...fresh.base, ...(data.base ?? {}) },
  };
}

const centre = (b) => ({ x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE });

/** Everything currently open, keyed so the same incident keeps the same key. */
function openNow(state) {
  const now = new Map();
  for (const b of state.buildings) {
    const burning = b.state === 'burning';
    const leaking = (b.leak ?? 0) > 0 && b.state !== 'rubble';
    if (!burning && !leaking && !((b.trapped ?? 0) > 0 && b.state !== 'rubble')) continue;
    now.set(`b:${b.id}`, {
      kind: burning ? 'fire' : (b.trapped ?? 0) > 0 ? 'rescue' : 'hazmat',
      label: b.incidentLabel ?? (burning ? 'Structure fire' : leaking ? 'Hazmat leak' : 'Rescue'),
      ...centre(b), big: Boolean(b.big), ref: b,
    });
  }
  for (const w of state.wildfires ?? []) {
    now.set(`w:${w.id}`, { kind: 'wildfire', label: w.name ?? 'Forest fire', x: w.x, y: w.y, big: true, ref: w });
  }
  for (const p of state.patients ?? []) {
    if (p.treated) continue;
    now.set(`p:${p.id}`, { kind: 'patient', label: 'Injured person', x: p.x, y: p.y, big: false, ref: p });
  }
  for (const v of state.victims ?? []) {
    now.set(`v:${v.id}`, { kind: 'water', label: 'Person in the water', x: v.x, y: v.y, big: false, ref: v });
  }
  for (const w of state.blockades ?? []) {
    now.set(`x:${w.id}`, { kind: 'wreck', label: w.name ?? 'Road blocked', x: w.x, y: w.y, big: Boolean(w.big), ref: w });
  }
  return now;
}

function nearUnits(state, inc) {
  const found = [];
  for (const e of state.engines) {
    const away = e.status !== 'in quarters' || e.targetId || e.wildfireId || e.patientId || e.blockadeId || e.victimId;
    if (!away) continue;
    const limit = e.spec.flying || e.spec.boat ? NEAR_AIR : NEAR;
    if (Math.hypot(e.x - inc.x, e.y - inc.y) <= limit) found.push(e);
  }
  return found;
}

function stationOf(state, engine) {
  return state.city.bays[engine.bayIndex]?.station ?? 0;
}

function vehicleRow(report, engine) {
  return (report.vehicles[engine.id] = report.vehicles[engine.id] ?? {
    id: engine.id, name: engine.name, type: engine.type, responses: 0, responseSum: 0, incidents: 0, resolved: 0,
  });
}

function stationRow(state, report, index) {
  return (report.stations[index] = report.stations[index] ?? {
    index, name: state.city.stations[index]?.name ?? `Station ${index + 1}`, responses: 0, responseSum: 0, incidents: 0, resolved: 0,
  });
}

function close(state, report, key, inc, outcome) {
  delete report.open[key];
  const entry = {
    kind: inc.kind, label: inc.label, outcome, startedAt: inc.startedAt, endedAt: state.time,
    response: inc.arrivedAt != null ? inc.arrivedAt - inc.startedAt : null,
    vehicle: inc.vehicle ?? null, station: inc.station ?? null, big: inc.big,
  };
  report.counts = report.counts ?? {};
  report.counts[outcome] = (report.counts[outcome] ?? 0) + 1;
  report.counts[`${inc.kind}:${outcome}`] = (report.counts[`${inc.kind}:${outcome}`] ?? 0) + 1;
  report.done.push(entry);
  if (report.done.length > MAX_DONE) report.done.shift();
  for (const id of inc.engines ?? []) {
    const row = report.vehicles[id];
    if (!row) continue;
    row.incidents += 1;
    if (outcome === 'resolved') row.resolved += 1;
  }
  if (inc.station != null) {
    const row = report.stations[inc.station];
    if (row) {
      row.incidents += 1;
      if (outcome === 'resolved') row.resolved += 1;
    }
  }
  emit(state, 'incident:done', { incident: entry, outcome, people: inc.people ?? [], key });
}

/** Look at the map; record starts, arrivals and endings. Cheap enough to run every frame. */
export function observe(state, dt) {
  const report = state.report;
  if (!report) return;
  report.acc += dt;
  if (report.acc < SCAN_EVERY) return;
  report.acc = 0;

  const now = openNow(state);
  const casualtiesDelta = (state.stats.casualties ?? 0) - report.lastCasualties;
  report.lastCasualties = state.stats.casualties ?? 0;
  let deaths = Math.max(0, casualtiesDelta);

  // Endings first: whatever was open and is no longer.
  for (const [key, inc] of Object.entries(report.open)) {
    if (now.has(key)) continue;
    let outcome = 'resolved';
    if (key.startsWith('b:')) {
      const b = state.buildings.find((x) => `b:${x.id}` === key);
      if (b && b.state === 'rubble') outcome = 'failed';
    } else if (key.startsWith('p:') || key.startsWith('v:')) {
      if (deaths > 0) {
        outcome = 'failed';
        deaths -= 1;
      }
    }
    close(state, report, key, inc, outcome);
  }

  // Starts, and what is on scene.
  for (const [key, d] of now) {
    let inc = report.open[key];
    if (!inc) {
      inc = report.open[key] = {
        kind: d.kind, label: d.label, startedAt: state.time, arrivedAt: null, x: d.x, y: d.y,
        big: d.big, engines: [], people: [], vehicle: null, station: null,
      };
      if (d.kind === 'patient') report.patientsSeen += 1;
      emit(state, 'incident:start', { key, incident: inc });
    }
    inc.x = d.x;
    inc.y = d.y;
    const near = nearUnits(state, inc);
    for (const e of near) {
      if (!inc.engines.includes(e.id)) {
        inc.engines.push(e.id);
        vehicleRow(report, e);
      }
    }
    if (inc.arrivedAt == null && near.length > 0) {
      near.sort((a, b) => Math.hypot(a.x - inc.x, a.y - inc.y) - Math.hypot(b.x - inc.x, b.y - inc.y));
      const first = near[0];
      inc.arrivedAt = state.time;
      inc.vehicle = first.id;
      inc.station = stationOf(state, first);
      const time = inc.arrivedAt - inc.startedAt;
      const v = vehicleRow(report, first);
      v.responses += 1;
      v.responseSum += time;
      const s = stationRow(state, report, inc.station);
      s.responses += 1;
      s.responseSum += time;
    }
    for (const c of state.crew) {
      if (c.riding || !c.personId) continue;
      if (Math.hypot(c.x - inc.x, c.y - inc.y) <= 8 * TILE && !inc.people.includes(c.personId)) inc.people.push(c.personId);
    }
  }
}

// ------------------------------------------------------------------ rating ---

export const GRADES = [['S', 90], ['A', 78], ['B', 62], ['C', 45], ['D', 0]];
export const gradeOf = (score) => GRADES.find(([, min]) => score >= min)[0];

/**
 * A grade from several things, not response speed alone:
 * how many incidents were resolved, how fast the first unit arrived, whether
 * anyone died or was hurt, how much property was saved, and whether the
 * department made money.
 */
export function scoreShift(parts) {
  const w = { resolution: 0.25, response: 0.2, safety: 0.25, property: 0.15, finance: 0.15 };
  let score = 0;
  for (const [k, weight] of Object.entries(w)) score += weight * parts[k];
  return Math.round(score * 100);
}

export function buildReport(state) {
  const report = state.report ?? createReport(state);
  const stats = state.stats;
  const base = report.base.stats;
  const delta = (k) => Math.max(0, (stats[k] ?? 0) - (base[k] ?? 0));

  const done = report.done;
  const resolved = done.filter((d) => d.outcome === 'resolved').length;
  const failed = done.filter((d) => d.outcome === 'failed').length;
  const open = Object.keys(report.open).length;
  const responses = done.map((d) => d.response).filter((r) => r != null);
  for (const inc of Object.values(report.open)) if (inc.arrivedAt != null) responses.push(inc.arrivedAt - inc.startedAt);
  const avg = responses.length ? responses.reduce((a, b) => a + b, 0) / responses.length : null;

  const income = Math.max(0, (state.ledger?.earned ?? 0) - report.base.earned);
  const expenses = Math.max(0, (state.ledger?.spent ?? 0) - report.base.spent);
  const by = {};
  for (const [tag, amount] of Object.entries(state.ledger?.by ?? {})) {
    const change = amount - (report.base.by[tag] ?? 0);
    if (Math.abs(change) > 0.5) by[tag] = change;
  }

  const fatalities = delta('casualties');
  const injuries = report.patientsSeen;
  const firefighterInjuries = delta('firefighterInjuries');
  const destroyed = delta('lost');
  const saved = delta('saved');
  const rescued = delta('rescued');
  const net = income - expenses;

  const { targetResponse, slowResponse } = CONFIG.career.reputation;
  const parts = {
    resolution: resolved + failed + open === 0 ? 0.75 : resolved / (resolved + failed + open * 0.5),
    response: avg == null ? 0.7 : clamp(1 - (avg - targetResponse) / (slowResponse - targetResponse), 0, 1),
    safety: clamp(1 - fatalities * 0.25 - firefighterInjuries * 0.1 - injuries * 0.01, 0, 1),
    property: saved + destroyed === 0 ? 0.8 : saved / (saved + destroyed),
    finance: net >= 0 ? 1 : clamp(1 + net / 6000, 0, 1),
  };
  // A shift with nothing to do shows nothing about the department: it cannot earn a top grade.
  const quiet = resolved + failed + open === 0;
  const score = quiet ? Math.min(scoreShift(parts), 70) : scoreShift(parts);

  const vehicles = Object.values(report.vehicles).map((v) => ({
    ...v, avgResponse: v.responses ? v.responseSum / v.responses : null,
  })).sort((a, b) => b.resolved - a.resolved);
  const stations = Object.values(report.stations).map((s) => ({
    ...s, avgResponse: s.responses ? s.responseSum / s.responses : null,
  })).sort((a, b) => b.resolved - a.resolved);

  return {
    duration: (state.time ?? 0) - report.startedAt,
    incidents: { total: resolved + failed + open, resolved, failed, open },
    people: { rescued, injuries, fatalities, firefighterInjuries },
    buildings: { saved, destroyed },
    response: {
      average: avg,
      best: responses.length ? Math.min(...responses) : null,
      worst: responses.length ? Math.max(...responses) : null,
    },
    vehicles,
    stations,
    money: { income, expenses, net, by },
    rating: { grade: gradeOf(score), score, parts },
    recent: done.slice(-12).reverse(),
  };
}

export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
