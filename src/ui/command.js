// The command screens: everything the roadmap adds to Headquarters and to the
// incident card — dispatch presets and ETAs, personnel and training, stations
// and upgrades, the career dashboard, the shift report, finance, challenges and
// the scenario editor. Plain DOM strings like hud.js; the simulation is only
// touched through the command functions in modes.js and game.js.

import { CONFIG, TILE } from '../core/config.js';
import { SKILL_EFFECT, SKILL_LABEL, SKILLS, overall, rankLabel, salaryOf } from '../data/personnel.js';
import {
  CHALLENGES, DISASTER_KINDS, INCIDENT_KINDS, LOCATION_TYPES, deleteScenarioFrom, findChallenge,
  newScenarioTemplate, saveScenarioTo,
} from '../data/scenarios.js';
import { WEATHER } from '../systems/weather.js';
import { SCENES } from '../systems/scenes.js';
import {
  INCIDENT_KINDS as PRESET_KINDS, PRESET_ROLES, availableVehicles, diverTotal, nearestStations, planPreset, recommendedPresets, slotLabel,
} from '../systems/presets.js';
import { currentTarget, formatEta, incidentEtas } from '../systems/eta.js';
import { incidentIntel } from '../systems/intel.js';
import { allAgencies } from '../systems/agencies.js';
import { evacuationAdvice } from '../systems/evacuation.js';
import { buildReport, formatDuration } from '../systems/report.js';
import { isCareer } from '../systems/modifiers.js';
import { levelProgress, readiness, shiftBlock } from '../systems/campaign.js';
import { listObjectives } from '../systems/objectives.js';
import { courseOf, payrollPerHour, people, rosterSummary, trainees, trainingBlock, trainingSlots } from '../systems/personnel.js';
import {
  UPGRADE_KEYS, budgetSummary, compareStations, coverage, levelInfo, stationLevel, upgradeBlock, upgradeCost,
} from '../systems/stations.js';
import { financialReport } from '../systems/finance.js';
import { stationCapacity } from '../systems/units.js';
import { KEYS, hasSlot, loadResults, loadScenarioLibrary, recordResult, storeScenarioLibrary } from '../systems/saves.js';
import {
  commandAgency, commandAssign, commandBudget, commandCancelDispatch, commandDeletePreset, commandDismiss,
  commandEmergencyFunding, commandEvacuate, commandHire, commandPreset, commandRedirect, commandSavePreset,
  commandStationBudget, commandTrain, commandUnassign, commandUpgrade,
} from '../systems/modes.js';
import { addEvent } from '../systems/events.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
const bar = (frac, cls = '') => `<div class="bar ${cls}"><i style="width:${pct(frac)}"></i></div>`;
const vehicleLabel = (type) => slotLabel(type);
const unitsText = (units) => Object.entries(units).map(([t, n]) => `${n}× ${vehicleLabel(t)}`).join(', ');
const btn = (label, action, attrs = '', cls = 'btn btn--small') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const section = (title, body, note = '') => `<div class="budget"><p class="menu__eyebrow">${title}</p>${note ? `<p class="station__note">${note}</p>` : ''}${body}</div>`;

// --------------------------------------------------------------- UI state ---

const ui = {
  people: { q: '', status: 'all' },
  preset: null, // the preset being edited
  presetError: '',
  scenario: null, // the scenario being edited
  scenarioErrors: [],
  library: [],
  results: {},
  storage: null,
  budgetCategory: 'personnel',
  notice: '',
};

/** Give the UI its storage (custom scenarios and challenge results live there). */
export function init(storage) {
  ui.storage = storage;
  try {
    ui.library = loadScenarioLibrary(storage);
    ui.results = loadResults(storage);
  } catch {
    ui.library = [];
    ui.results = {};
  }
}

export function noteResult(id, result) {
  if (!ui.storage) return null;
  const out = recordResult(ui.storage, id, result);
  ui.results = loadResults(ui.storage);
  return out;
}

export function tabsFor(state) {
  const tabs = [['fleet', 'Fleet'], ['dispatch', 'Dispatch']];
  if (isCareer(state)) tabs.push(['people', 'People'], ['stations', 'Stations'], ['career', 'Career']);
  tabs.push(['finance', 'Finance'], ['contracts', 'Contracts'], ['report', 'Report']);
  if (!isCareer(state)) tabs.push(['play', 'Play']);
  return tabs;
}

/** True while someone is typing in or choosing from a form field: do not rebuild the panel under them. */
export function isEditing(root) {
  const a = document.activeElement;
  return Boolean(a && root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
}

// -------------------------------------------------------- selected incident ---

/** The selected thing as an incident `{ kind, id }`, or null if it is not one. */
export function selectedIncident(state) {
  const s = state.selected;
  if (!s) return null;
  if (s.kind === 'building') {
    const b = state.buildings.find((x) => x.id === s.id);
    if (!b) return null;
    const live = b.state === 'burning' || (b.trapped ?? 0) > 0 || (b.leak ?? 0) > 0 || b.collapse;
    return live ? { kind: 'building', id: b.id } : null;
  }
  if (['wildfire', 'patient', 'victim', 'blockade'].includes(s.kind)) return { kind: s.kind, id: s.id };
  return null;
}

const AGENCY_SHORT = { police: 'Police', ems: 'EMS', civil: 'Civil', utility: 'Utility', coastguard: 'Coast guard' };
const TARGET_LABEL = { building: 'incident', wildfire: 'forest fire', patient: 'patient', victim: 'swimmer', blockade: 'wreck' };

const pill = (text, tone = '') => `<span class="pill" data-tone="${tone}">${esc(text)}</span>`;
const levelTone = (n) => (n >= 4 ? 'bad' : n >= 3 ? 'warn' : n >= 2 ? '' : 'good');

/** What changes the incident extras: ETAs to 5 s, readiness, hazard and collapse state. */
export function incidentSignature(state) {
  const inc = selectedIncident(state);
  if (!inc) return '';
  const etas = incidentEtas(state, inc.kind, inc.id).map((e) => `${e.engine.id}${Math.round(e.seconds / 5)}`).join(',');
  const agencies = allAgencies(state).map((a) => (a.ready ? 1 : 0)).join('');
  const b = inc.kind === 'building' ? state.buildings.find((x) => x.id === inc.id) : null;
  const extra = b ? `${Math.round((b.leak ?? 0) * 10)}${b.collapse ? Math.round((b.trapped ?? 0)) : ''}${b.utilityCut ? 'u' : ''}${b.evacuated ? 'e' : ''}` : '';
  return `${etas}|${agencies}|${extra}|${state.presets.length}|${state.evac.zones.length}`;
}

/** Intelligence, ETAs and the dispatch buttons, appended to the selected incident's card. */
export function incidentExtras(state) {
  const inc = selectedIncident(state);
  if (!inc) return '';
  const intel = incidentIntel(state, inc.kind, inc.id);
  if (!intel) return '';

  const explosion = intel.explosion.level === 'none' ? 'None' : `${intel.explosion.level[0].toUpperCase()}${intel.explosion.level.slice(1)}${intel.explosion.why ? ` — ${intel.explosion.why}` : ''}`;
  const env = intel.environment;
  const etas = incidentEtas(state, inc.kind, inc.id);
  const etaHtml = etas.length
    ? etas.map((e) => `<div class="intel__row"><span>${esc(e.engine.name)}</span><b>ETA ${formatEta(e.seconds)}</b>${btn('Call off', 'call-off', `data-engine="${e.engine.id}"`)}</div>`).join('')
    : '<div class="intel__row"><span>Nobody is on the way</span></div>';

  const recs = recommendedPresets(state, inc).slice(0, 2).map((p) => {
    const plan = planPreset(state, p, inc);
    const label = plan.assignments.length + plan.already.length;
    return btn(`${esc(p.name)} · ${label}/${Object.values(p.units).reduce((a, b) => a + b, 0)}`, 'preset-send', `data-id="${p.id}" title="${esc(unitsText(p.units))}${plan.warnings.length ? ' — ' + esc(plan.warnings.join('; ')) : ''}"`, 'btn btn--small btn--primary');
  }).join('');

  const agencies = allAgencies(state).map((a) => btn(`${esc(AGENCY_SHORT[a.agency])} ${money(a.cost)}`, 'agency-call',
    `data-agency="${a.agency}"${a.ready ? '' : ' disabled'} title="${esc(a.ready ? a.text : a.reason)}"`)).join('');

  const evac = (inc.kind === 'wildfire' || (inc.kind === 'building' && (intel.explosion.level !== 'none' || intel.secondary.some((s) => s.includes('Toxic')))))
    ? btn('Evacuate area', 'evacuate', 'title="Empty the buildings round it and close the streets"') : '';

  return `<div class="intel">
    <p class="menu__eyebrow">Intel</p>
    <div class="intel__row"><span>Severity</span>${pill(intel.severity.label, levelTone(intel.severity.level))}<span>Danger</span><b>${esc(intel.danger)}</b></div>
    <div class="intel__row"><span>Explosion risk</span><b>${esc(explosion)}</b></div>
    <div class="intel__row"><span>People</span><b>${esc(intel.trapped.text)}</b></div>
    ${intel.secondary.length ? `<ul class="intel__list">${intel.secondary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    <div class="intel__row"><span>Needs</span><b>${esc(intel.equipment.join(' · '))}</b></div>
    <div class="intel__row"><span>Scene</span><b>${esc(env.daylight)}, ${esc(env.wind)}, ${esc(env.traffic)}${env.weather && env.weather !== 'Clear' ? `, ${esc(env.weather.toLowerCase())}` : ''}</b></div>
    <p class="menu__eyebrow">Responders</p>${etaHtml}
    <p class="menu__eyebrow">Dispatch</p>
    <div class="intel__buttons">${recs || '<span class="station__note">No preset fits — make one in Headquarters › Dispatch.</span>'}${evac}</div>
    <p class="menu__eyebrow">Support</p>
    <div class="intel__buttons">${agencies}</div>
  </div>`;
}

// ------------------------------------------------------------ dispatch tab ---

const GROUND_TYPES = () => Object.keys(CONFIG.vehicles).filter((t) => !CONFIG.vehicles[t].boat);

function presetEditor(state) {
  const d = ui.preset;
  const inputs = [...Object.keys(PRESET_ROLES), ...Object.keys(CONFIG.vehicles)].map((t) => `<label class="field field--num"><span>${esc(vehicleLabel(t))}</span><input type="number" min="0" max="8" value="${d.units[t] ?? 0}" data-preset-unit="${t}"></label>`).join('');
  return `<div class="editor">
    <label class="field"><span>Name</span><input type="text" id="pr-name" maxlength="32" value="${esc(d.name)}"></label>
    <label class="field"><span>For</span><select id="pr-incident">${Object.entries(PRESET_KINDS).map(([k, l]) => `<option value="${k}"${d.incident === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <div class="field-grid">${inputs}</div>
    ${ui.presetError ? `<p class="form-error">${esc(ui.presetError)}</p>` : ''}
    <div class="finance__buttons">${btn('Save preset', 'preset-save', '', 'btn btn--small btn--primary')}${btn('Cancel', 'preset-cancel')}</div>
  </div>`;
}

export function dispatchTab(state) {
  const inc = selectedIncident(state);
  const incLabel = inc ? `the selected ${TARGET_LABEL[inc.kind]}` : null;

  const presets = state.presets.map((p) => {
    const plan = inc ? planPreset(state, p, inc) : null;
    const summary = plan
      ? `${plan.assignments.length + plan.already.length} of ${Object.values(p.units).reduce((a, b) => a + b, 0)} available${plan.warnings.length ? ' — ' + esc(plan.warnings[0]) : ''}`
      : '';
    return `<div class="preset"><div class="preset__text"><b>${esc(p.name)}</b><span>${esc(PRESET_KINDS[p.incident] ?? '')} · ${esc(unitsText(p.units))}</span>${summary ? `<em>${summary}</em>` : ''}</div>
      <div class="preset__buttons">${btn('Send', 'preset-send', `data-id="${p.id}"${inc ? '' : ' disabled title="Select an incident on the map first"'}`, 'btn btn--small btn--primary')}${btn('Edit', 'preset-edit', `data-id="${p.id}"`)}${btn('Delete', 'preset-delete', `data-id="${p.id}"`)}</div></div>`;
  }).join('');

  const avail = availableVehicles(state);
  const totals = {};
  for (const e of state.engines) totals[e.type] = (totals[e.type] ?? 0) + 1;
  const divers = diverTotal(state);
  if (divers > 0) totals.diver = divers;
  const fleet = Object.entries(totals).map(([t, n]) => `<span class="pill">${esc(vehicleLabel(t))} ${avail[t] ?? 0}/${n}</span>`).join(' ');

  let stations = '';
  if (inc) {
    const here = incidentPointOf(state, inc);
    if (here) {
      stations = nearestStations(state, here.x, here.y).map((s) => `<div class="intel__row"><span>${esc(s.name)}</span><b>${s.distance.toFixed(0)} tiles</b><span>${s.available}/${s.vehicles} free</span></div>`).join('');
    }
  }

  const active = state.engines.filter((e) => currentTarget(e) && e.path.length > 0).map((e) => {
    const t = currentTarget(e);
    return `<div class="intel__row"><span>${esc(e.name)}</span><b>${esc(t.kind)}</b>${btn('Call off', 'call-off', `data-engine="${e.id}"`)}${inc && !(t.kind === inc.kind && t.id === inc.id) ? btn('Send to selected', 'redirect', `data-engine="${e.id}"`) : ''}</div>`;
  }).join('');

  const evac = state.evac.zones.map((z) => `<div class="intel__row"><span>${esc(z.label)}</span><b>${z.total - z.queue.length}/${z.total} buildings</b><span>${z.evacuated} people${z.shelter ? ` → ${esc(z.shelter.name)}` : ''}</span></div>`).join('');
  const advice = evacuationAdvice(state).map((a) => `<div class="intel__row"><span>${esc(a.label)} is dangerous</span>${btn('Evacuate', 'evacuate-at', `data-kind="${a.kind}" data-id="${a.id}"`)}</div>`).join('');

  const agencies = allAgencies(state).map((a) => `<div class="preset"><div class="preset__text"><b>${esc(a.label)}</b><span>${esc(a.text)}</span><em>${money(a.cost)} · arrives in ${a.delay} s${a.reason ? ' · ' + esc(a.reason) : ''}</em></div>
    <div class="preset__buttons">${btn('Call', 'agency-call', `data-agency="${a.agency}"${a.ready && inc ? '' : ' disabled'}`, 'btn btn--small btn--primary')}</div></div>`).join('');

  return `<p class="station__note">${incLabel ? `Orders go to ${incLabel}.` : 'Select an incident on the map, then send a preset or call support from here (or from its card).'}</p>` +
    section('Presets', presets + (ui.preset ? presetEditor(state) : `<div class="finance__buttons">${btn('New preset', 'preset-new')}</div>`)) +
    section('Fleet available', fleet || '<p class="budget__total">No vehicles.</p>') +
    (stations ? section('Nearest stations', stations) : '') +
    section('Active dispatches', active || '<p class="budget__total">Nobody is on the way anywhere.</p>') +
    section('Evacuation', (evac || '<p class="budget__total">No evacuation running.</p>') + advice) +
    section('Support agencies', agencies);
}

function incidentPointOf(state, inc) {
  if (inc.kind === 'building') {
    const b = state.buildings.find((x) => x.id === inc.id);
    return b ? { x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE } : null;
  }
  const list = { wildfire: state.wildfires, patient: state.patients, victim: state.victims, blockade: state.blockades }[inc.kind];
  const e = list?.find((v) => v.id === inc.id);
  return e ? { x: e.x, y: e.y } : null;
}

// -------------------------------------------------------------- people tab ---

const STATUS_LABEL = { active: 'On duty', injured: 'Injured', training: 'Training', candidate: 'Candidate' };

function skillBars(person) {
  return SKILLS.map((s) => `<span class="skill" title="${esc(SKILL_LABEL[s])} ${person.skills[s]} — ${esc(SKILL_EFFECT[s])}"><b>${esc(SKILL_LABEL[s][0])}</b><i style="width:${person.skills[s] * 10}%"></i><em>${person.skills[s]}</em></span>`).join('');
}

export function peopleTab(state) {
  const sum = rosterSummary(state);
  const f = ui.people;
  const q = f.q.trim().toLowerCase();
  const list = people(state)
    .filter((p) => (!q || p.name.toLowerCase().includes(q) || rankLabel(p.rank).toLowerCase().includes(q)))
    .filter((p) => (f.status === 'all' ? true : f.status === 'reserve' ? !p.vehicleId && p.status === 'active' : p.status === f.status))
    .sort((a, b) => overall(b) - overall(a));

  const seats = state.engines.filter((e) => (e.spec.crew ?? 0) > e.crewIds.length);
  const rows = list.map((p) => {
    const vehicle = p.vehicleId ? state.engines.find((e) => e.id === p.vehicleId) : null;
    const where = vehicle ? vehicle.name : p.status === 'training' ? `${esc(courseOf(p.training.course)?.label ?? 'Training')} · ${Math.max(0, Math.ceil(p.training.until - state.time))} s` : p.status === 'injured' ? `back in ${Math.max(0, Math.ceil(p.injuredUntil - state.time))} s` : 'Reserve';
    const assign = p.status === 'active' && !vehicle && seats.length
      ? `<select id="assign-${p.id}">${seats.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>${btn('Assign', 'person-assign', `data-id="${p.id}"`)}` : '';
    const open = Object.keys(CONFIG.training.courses).filter((id) => !trainingBlock(state, p, id));
    const closed = p.status === 'active' && open.length === 0 ? `<em class="budget__total">${esc(trainingBlock(state, p, 'firefighting') ?? 'No course available')}</em>` : '';
    const courses = closed || (p.status === 'active' ? `<select id="train-${p.id}">${Object.entries(CONFIG.training.courses).map(([id, c]) => {
      const why = trainingBlock(state, p, id);
      return `<option value="${id}"${why ? ' disabled' : ''}>${esc(c.label)} ${money(c.cost)}${why ? ' — ' + esc(why) : ''}</option>`;
    }).join('')}</select>${btn('Train', 'person-train', `data-id="${p.id}"`)}` : '');
    return `<div class="person" data-status="${p.status}">
      <div class="person__head"><b>${esc(p.name)}</b><span>${esc(rankLabel(p.rank))} · level ${p.level} · ${esc(STATUS_LABEL[p.status] ?? p.status)}${p.certs.length ? ' · ' + esc(p.certs.join(', ')) : ''}</span><span>${esc(where)}</span></div>
      <div class="person__skills">${skillBars(p)}<span class="skill skill--fatigue" title="Fatigue — tired crews work slower"><b>F</b><i style="width:${Math.round(p.fatigue * 100)}%"></i><em>${Math.round(p.fatigue * 100)}%</em></span></div>
      <div class="person__buttons">${assign}${courses}${vehicle ? btn('Unassign', 'person-unassign', `data-id="${p.id}"`) : ''}${btn('Dismiss', 'person-dismiss', `data-id="${p.id}"`)}</div>
    </div>`;
  }).join('');

  const candidates = (state.campaign.candidates ?? []).map((c) => {
    const best = Math.max(...(state.campaign.candidates.map(overall)));
    return `<div class="person${overall(c) === best ? ' person--best' : ''}"><div class="person__head"><b>${esc(c.name)}</b><span>skills total ${overall(c)}${overall(c) === best ? ' · best of the list' : ''}</span><span>${money(c.askingFee)} fee · ${money(salaryOf(c))}/h</span></div>
      <div class="person__skills">${skillBars(c)}</div><div class="person__buttons">${btn('Hire', 'candidate-hire', `data-id="${c.id}"${state.credits < c.askingFee ? ' disabled' : ''}`, 'btn btn--small btn--primary')}</div></div>`;
  }).join('');

  const slots = state.city.stations.map((st, i) => ({ st, i })).filter(({ st, i }) => !st.sea && state.ownedStations[i])
    .map(({ st, i }) => `${esc(st.name)} ${trainees(state, i).length}/${trainingSlots(state, i)}`).join(' · ');

  return `<div class="station__balance">${sum.total} people<span>${sum.onVehicles} on vehicles · ${sum.reserve} in reserve · ${sum.injured} injured · ${sum.training} training · ${sum.exhausted} exhausted · payroll ${money(payrollPerHour(state))}/h</span></div>` +
    `<p class="station__note">Skills change what a crew actually does: firefighting (water on fire), rescue, medical, driving (vehicle speed) and technical (cutting gear). Tired people work slower; resting in quarters recovers. Training slots: ${slots}.</p>` +
    `<div class="filters"><input type="search" id="people-q" placeholder="Search name or rank" value="${esc(f.q)}" data-filter="people-q">
      <select id="people-status" data-filter="people-status">${[['all', 'Everyone'], ['active', 'On duty'], ['reserve', 'Reserve'], ['injured', 'Injured'], ['training', 'Training']].map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>` +
    section(`Roster (${list.length})`, rows || '<p class="budget__total">Nobody matches.</p>') +
    section('Recruitment', candidates || '<p class="budget__total">No candidates right now.</p>', 'Compare skills and fees. A hire joins a vehicle that is short of crew, or the reserve.');
}

// ------------------------------------------------------------ stations tab ---

export function stationsTab(state) {
  const cov = coverage(state);
  const stations = state.city.stations.map((st, i) => ({ st, i })).filter(({ st, i }) => !st.sea && state.ownedStations[i]).map(({ st, i }) => {
    const rec = state.campaign.stations[i];
    const used = state.engines.filter((e) => !e.spec.boat && state.city.bays[e.bayIndex]?.station === i).length;
    const ups = UPGRADE_KEYS.map((key) => {
      const def = CONFIG.upgrades[key];
      const level = rec?.upgrades?.[key] ?? 0;
      const block = upgradeBlock(state, i, key);
      const pips = Array.from({ length: def.max }, (_, n) => `<i class="${n < level ? 'on' : ''}"></i>`).join('');
      return `<div class="upgrade"><div><b>${esc(def.label)}</b> <span class="pips">${pips}</span><span>${esc(def.text)}</span></div>${
        level >= def.max ? '<em>Complete</em>' : btn(`Upgrade ${money(upgradeCost(key, level + 1))}`, 'upgrade', `data-station="${i}" data-key="${key}"${block ? ` disabled title="${esc(block)}"` : ''}`, 'btn btn--small btn--primary')}</div>`;
    }).join('');
    return `<div class="station-card"><header><b>${esc(st.name)}</b><span>level ${stationLevel(state, i)} · ${used}/${stationCapacity(state, i)} bays · ${(state.campaign.personnel).filter((p) => p.station === i && p.vehicleId).length} crew</span></header>${ups}
      ${rec?.budget > 0 ? `<div class="intel__row"><span>Spent this month</span><b data-tone="${(rec.spentMonth ?? 0) > rec.budget ? 'bad' : ''}">${money(rec.spentMonth ?? 0)} of ${money(rec.budget)}</b>${bar((rec.spentMonth ?? 0) / rec.budget, (rec.spentMonth ?? 0) > rec.budget ? 'bar--fire' : '')}</div>` : `<div class="intel__row"><span>Spent this month</span><b>${money(rec?.spentMonth ?? 0)}</b><span>no limit</span></div>`}
      <label class="field field--inline"><span>Monthly budget (0 = no limit)</span><input type="number" min="0" step="100" id="stbudget-${i}" value="${rec?.budget ?? 0}"><button type="button" class="btn btn--small" data-action="station-budget" data-station="${i}">Set</button></label></div>`;
  }).join('');

  const rows = compareStations(state).map((r) => `<tr><td>${esc(r.name)}</td><td>${r.level}</td><td>${r.vehicles}</td><td>${r.staff}</td><td>${r.resolved}/${r.incidents}</td><td>${formatDuration(r.avgResponse)}</td><td>${money(r.cost)}</td></tr>`).join('');
  const under = cov.underserved.length
    ? cov.underserved.slice(0, 6).map((d) => `<div class="intel__row"><span>${esc(d.district)}</span><b>${Math.round(d.seconds)} s from ${esc(d.station)}</b></div>`).join('')
    : '<p class="budget__total">Every district is within reach.</p>';

  const alloc = budgetSummary(state);
  const funding = financialReport(state).funding;
  const allocNote = `Budgets allocated: ${money(alloc.allocated)} of about ${money(funding)} in monthly funding${alloc.allocated > funding ? ' — you have promised more than the city pays' : ''}. A station over its budget still pays its upkeep but cannot buy vehicles, upgrades or training until next month.`;
  return `<p class="station__note">Department level ${state.campaign.level} lets you run ${levelInfo(state.campaign).stations === 99 ? 'any number of' : levelInfo(state.campaign).stations} station${levelInfo(state.campaign).stations === 1 ? '' : 's'} and upgrade to level ${levelInfo(state.campaign).upgradeCap}. Open new stations in the Fleet tab.</p>` +
    section('Station budgets', '<p class="budget__total">' + allocNote + '</p>') +
    stations +
    section(`Coverage — ${pct(cov.share)} of the city's buildings are within a minute and a quarter`, under, 'Districts a vehicle needs longer than that to reach:') +
    section('Station comparison', `<table class="cmd-table"><thead><tr><th>Station</th><th>Lvl</th><th>Veh</th><th>Crew</th><th>Done</th><th>Resp.</th><th>Upkeep</th></tr></thead><tbody>${rows}</tbody></table>`);
}

// ------------------------------------------------------------- career tab ---

const GROUP_LABEL = { main: 'Main objectives', secondary: 'Secondary objectives', daily: 'Daily objectives (this shift)', long: 'Long-term objectives' };

export function careerTab(state) {
  const c = state.campaign;
  const lp = levelProgress(c);
  const summary = state.shiftSummary;
  const objectives = Object.keys(GROUP_LABEL).map((g) => {
    const rows = listObjectives(state).filter((o) => o.group === g).map((o) => `<div class="objective${o.done ? ' is-done' : ''}"><div><b>${esc(o.label)}</b><span>${o.done ? 'Complete' : `${Math.min(o.value, o.target).toLocaleString('en-US')} / ${o.target.toLocaleString('en-US')}`} · ${money(o.reward.credits)} · reputation +${o.reward.rep}</span></div>${bar(o.fraction)}</div>`).join('');
    return section(GROUP_LABEL[g], rows);
  }).join('');
  const left = Math.max(0, CONFIG.career.shiftLength - state.time);
  const history = c.history.shifts.slice(-8).reverse().map((h) => `<div class="intel__row"><span>Shift ${h.n}</span><b class="grade grade--${h.grade}">${h.grade}</b><span>${h.resolved} resolved · ${h.rescued} rescued · ${h.net >= 0 ? '+' : '−'}${money(Math.abs(h.net))}</span></div>`).join('');

  const next = lp.next
    ? `Next: ${esc(lp.next.name)} — reputation ${Math.round(c.reputation)}/${lp.next.rep}, shifts ${c.shifts}/${lp.next.shifts}`
    : 'The highest level.';

  const shiftBox = summary
    ? `<p class="station__note">Shift ${summary.shiftNumber} is filed. ${summary.leveled ? `<b>Promoted to ${esc(summary.leveled.name)}.</b>` : ''}</p>${reportHtml(state, summary.report)}<div class="finance__buttons">${btn('Start the next shift', 'next-shift', '', 'btn btn--primary')}</div>`
    : `<p class="station__note">${state.shiftDue ? '<b>The shift is over.</b> ' : `${formatDuration(left)} left in this shift. `}File the report when you are ready: it pays the performance bonus, moves your reputation and gives everyone experience.</p><div class="finance__buttons">${btn('End shift and file the report', 'end-shift', shiftBlock(state) ? `disabled title="${esc(shiftBlock(state))}"` : '', 'btn btn--primary')}${btn('Save', 'save-game')}</div>`;

  return `<div class="station__balance">${esc(c.name)}<span>${esc(lp.current.name)} · reputation ${Math.round(c.reputation)}/100 · shift ${c.shifts + 1} · readiness ${pct(readiness(state))}</span></div>` +
    bar(c.reputation / 100, 'bar--health') + `<p class="station__note">${next}</p>` + shiftBox +
    section('Unlocked', `<p class="budget__total">${CONFIG.career.levels.filter((l) => l.id <= c.level).flatMap((l) => l.vehicles).map(vehicleLabel).join(', ')}</p>`, 'Vehicle types you may buy at your level.') +
    objectives + section('Recent shifts', history || '<p class="budget__total">No shifts finished yet.</p>');
}

// ------------------------------------------------------------- report tab ---

export function reportHtml(state, given = null) {
  const r = given ?? buildReport(state);
  const row = (a, b) => `<div class="budget__row"><span>${a}</span><b>${b}</b></div>`;
  const parts = Object.entries(r.rating.parts).map(([k, v]) => `<div class="intel__row"><span>${esc(k)}</span>${bar(v)}<b>${Math.round(v * 100)}</b></div>`).join('');
  const vehicles = r.vehicles.slice(0, 8).map((v) => `<tr><td>${esc(v.name)}</td><td>${v.incidents}</td><td>${v.resolved}</td><td>${formatDuration(v.avgResponse)}</td></tr>`).join('');
  const stations = r.stations.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.incidents}</td><td>${s.resolved}</td><td>${formatDuration(s.avgResponse)}</td></tr>`).join('');
  const recent = r.recent.slice(0, 6).map((d) => `<div class="intel__row"><span>${esc(d.label)}</span><b data-tone="${d.outcome === 'resolved' ? 'good' : 'bad'}">${d.outcome}</b><span>${formatDuration(d.response)}</span></div>`).join('');
  const by = Object.entries(r.money.by).sort((a, b) => b[1] - a[1]).map(([k, v]) => row(esc(k), `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`)).join('');
  return `<div class="report">
    <div class="report__grade"><b class="grade grade--${r.rating.grade}">${r.rating.grade}</b><span>Score ${r.rating.score}/100 · ${formatDuration(r.duration)} on shift</span></div>
    ${section('Incidents', row('Total', r.incidents.total) + row('Resolved', r.incidents.resolved) + row('Failed', r.incidents.failed) + row('Still open', r.incidents.open) + row('Average response', formatDuration(r.response.average)) + row('Fastest / slowest', `${formatDuration(r.response.best)} / ${formatDuration(r.response.worst)}`))}
    ${section('People and property', row('Rescued', r.people.rescued) + row('Injured civilians', r.people.injuries) + row('Fatalities', r.people.fatalities) + row('Firefighters hurt', r.people.firefighterInjuries) + row('Buildings saved', r.buildings.saved) + row('Buildings destroyed', r.buildings.destroyed))}
    ${section('Money', row('Income', money(r.money.income)) + row('Expenses', money(r.money.expenses)) + row('Net result', `${r.money.net >= 0 ? '+' : '−'}${money(Math.abs(r.money.net))}`) + by)}
    ${section('What the grade weighed', parts, 'Resolution, response time, safety, property and finances — never speed alone.')}
    ${vehicles ? section('Vehicles', `<table class="cmd-table"><thead><tr><th>Vehicle</th><th>Incidents</th><th>Resolved</th><th>Avg response</th></tr></thead><tbody>${vehicles}</tbody></table>`) : ''}
    ${stations ? section('Stations', `<table class="cmd-table"><thead><tr><th>Station</th><th>Incidents</th><th>Resolved</th><th>Avg response</th></tr></thead><tbody>${stations}</tbody></table>`) : ''}
    ${recent ? section('Latest incidents', recent) : ''}
  </div>`;
}

export function reportTab(state) {
  return `<p class="station__note">The report for this shift so far. ${isCareer(state) ? 'Filing it from the Career tab closes the shift.' : 'Press Restart for a new shift.'}</p>${reportHtml(state)}`;
}

// ------------------------------------------------------------- finance tab ---

/** Career finance, appended to the ordinary finance tab. */
export function careerFinanceHtml(state) {
  if (!isCareer(state)) return '';
  const f = financialReport(state);
  const m = f.monthToDate;
  const status = f.status;
  const tone = { ok: 'good', low: 'warn', critical: 'bad', bankrupt: 'bad' }[status.level];
  const cats = Object.keys({ ...m.expense, personnel: 0, operations: 0, capital: 0, losses: 0, finance: 0 });
  const spent = cats.map((c) => {
    const limit = f.budget[c];
    const v = m.expense[c] ?? 0;
    return `<div class="intel__row"><span>${esc(c)}</span><b>${money(v)}${limit ? ` of ${money(limit)}` : ''}</b>${limit ? bar(v / limit, v > limit ? 'bar--fire' : '') : ''}</div>`;
  }).join('');
  const income = Object.entries(m.income).map(([k, v]) => `<div class="intel__row"><span>${esc(k)}</span><b>+${money(v)}</b></div>`).join('');
  const history = f.history.slice().reverse().map((h) => `<div class="intel__row"><span>Month ${h.month}</span><b>${h.net >= 0 ? '+' : '−'}${money(Math.abs(h.net))}</b><span>in ${money(h.income)} · out ${money(h.expenses)}</span></div>`).join('');
  return section('Department finances', `
      <div class="intel__row"><span>Status</span>${pill(status.level, tone)}<span>${Number.isFinite(status.hoursLeft) ? `${status.hoursLeft.toFixed(1)} game hours of money at the current spending` : 'no running costs'}</span></div>
      <div class="intel__row"><span>Payroll</span><b>${money(f.payroll)}/h</b><span>upkeep ${money(f.maintenance)}/h · loan and insurance ${money(f.loanCharges.total)}/h</span></div>
      <div class="intel__row"><span>Government funding</span><b>${money(f.funding)} each month</b><span>grows with reputation</span></div>
      ${btn('Ask for emergency funding', 'emergency-funding', f.emergencyBlock ? `disabled title="${esc(f.emergencyBlock)}"` : '')}`) +
    section(`Month ${f.month} so far — ${pct(f.monthProgress)} through`, income + spent + `<label class="field field--inline"><span>Budget for</span><select id="budget-cat">${['personnel', 'operations', 'capital', 'losses', 'finance'].map((c) => `<option value="${c}"${ui.budgetCategory === c ? ' selected' : ''}>${c}</option>`).join('')}</select><input type="number" min="0" step="100" id="budget-amount" placeholder="per month (0 clears)">${btn('Set', 'budget-set')}</label>`, 'Set a monthly limit per category: going over it raises a warning.') +
    (history ? section('Monthly summaries', history) : '');
}

// --------------------------------------------------------------- play tab ---

function challengeRows(state) {
  return CHALLENGES.map((c) => {
    const r = ui.results[c.id];
    return `<div class="preset"><div class="preset__text"><b>${esc(c.name)}</b><span>${esc(c.text)}</span><em>${r ? `Best ${r.score} · won ${r.wins} of ${r.plays}` : 'Not played yet'}${c.timeLimit ? ` · ${Math.round(c.timeLimit / 60)} min` : ''}</em></div>
      <div class="preset__buttons">${btn(r ? 'Replay' : 'Play', 'challenge-play', `data-id="${c.id}"`, 'btn btn--small btn--primary')}${btn('Copy to editor', 'scenario-copy', `data-id="${c.id}"`)}</div></div>`;
  }).join('');
}

function libraryRows() {
  if (ui.library.length === 0) return '<p class="budget__total">No custom scenarios yet.</p>';
  return ui.library.map((s) => `<div class="preset"><div class="preset__text"><b>${esc(s.name)}</b><span>${esc(s.text || `${s.incidents.length} scripted incident${s.incidents.length === 1 ? '' : 's'}`)}</span></div>
    <div class="preset__buttons">${btn('Play', 'scenario-play', `data-id="${s.id}"`, 'btn btn--small btn--primary')}${btn('Edit', 'scenario-edit', `data-id="${s.id}"`)}${btn('Delete', 'scenario-delete', `data-id="${s.id}"`)}</div></div>`).join('');
}

const field = (label, path, value, type = 'number', extra = '') => `<label class="field"><span>${label}</span><input type="${type === 'text' ? 'text' : 'number'}" data-path="${path}" data-type="${type}" value="${value == null ? '' : esc(value)}" ${extra}></label>`;
const check = (label, path, on) => `<label class="field field--check"><input type="checkbox" data-path="${path}" data-type="bool"${on ? ' checked' : ''}><span>${label}</span></label>`;
const select = (path, options, value, type = 'text') => `<select data-path="${path}" data-type="${type}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(value) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

function scenarioEditor() {
  const d = ui.scenario;
  const sceneOptions = SCENES.map((s) => [s.id, s.label]);
  const counts = {};
  for (const f of d.start.fleet) counts[f.type] = (counts[f.type] ?? 0) + 1;
  const fleet = GROUND_TYPES().map((t) => `<label class="field field--num"><span>${esc(vehicleLabel(t))}</span><input type="number" min="0" max="16" value="${counts[t] ?? 0}" data-fleet="${t}"></label>`).join('');
  const incidents = d.incidents.map((it, i) => {
    const loc = it.location ?? { kind: 'auto' };
    return `<div class="editor__incident"><div class="field-grid">
      <label class="field"><span>Type</span>${select(`incidents.${i}.kind`, Object.entries(INCIDENT_KINDS), it.kind)}</label>
      ${field('Starts at (s)', `incidents.${i}.at`, it.at)}
      <label class="field"><span>Where</span>${select(`incidents.${i}.location.kind`, [['auto', 'Automatic'], ['type', 'A kind of building'], ['building', 'A building id']], loc.kind)}</label>
      ${loc.kind === 'type' ? `<label class="field"><span>Building</span>${select(`incidents.${i}.location.type`, LOCATION_TYPES.map((t) => [t, t]), loc.type ?? 'house')}</label>` : ''}
      ${loc.kind === 'building' ? field('Building id', `incidents.${i}.location.buildingId`, loc.buildingId ?? '', 'text') : ''}
      ${it.kind === 'scene' ? `<label class="field"><span>Scene</span>${select(`incidents.${i}.scene`, sceneOptions, it.scene)}</label>` : ''}
      ${it.kind === 'disaster' ? `<label class="field"><span>Disaster</span>${select(`incidents.${i}.disaster`, DISASTER_KINDS.map((k) => [k, k]), it.disaster)}</label>` : ''}
      ${field('Fire intensity (0.05–1)', `incidents.${i}.intensity`, it.intensity, 'number', 'step="0.05" min="0.05" max="1"')}
      ${field('Trapped', `incidents.${i}.trapped`, it.trapped, 'int', 'min="0" max="12"')}
      ${field('Injured', `incidents.${i}.injured`, it.injured, 'int', 'min="0" max="10"')}
    </div>${btn('Remove', 'scenario-remove-incident', `data-index="${i}"`)}</div>`;
  }).join('');
  return `<div class="editor">
    ${field('Name', 'name', d.name, 'text', 'maxlength="40"')}
    ${field('Description', 'text', d.text, 'text', 'maxlength="200"')}
    ${section('Start', `<div class="field-grid">
      <label class="field"><span>Start time</span>${select('start.clock', Array.from({ length: 24 }, (_, h) => [h * 60, `${String(h).padStart(2, '0')}:00`]), d.start.clock - (d.start.clock % 60), 'num')}</label>
      ${field('Credits', 'start.credits', d.start.credits, 'num', 'min="0" step="100"')}
      <label class="field"><span>Weather</span>${select('start.weather', Object.entries(WEATHER).map(([k, w]) => [k, w.label]), d.start.weather ?? 'clear')}</label>
      ${field('Wind strength (0–1)', 'start.windSpeed', d.start.windSpeed, 'num?', 'step="0.05" min="0" max="1"')}
      ${field('Wind direction (°)', 'start.windDir', d.start.windDir, 'num?', 'min="0" max="359"')}
      ${field('Time limit (s)', 'timeLimit', d.timeLimit, 'num?', 'min="60" max="3600" step="30"')}
    </div>`)}
    ${section('Vehicles', `<div class="field-grid">${fleet}</div>`, 'Boats need the dock and are left out. At most 16 vehicles.')}
    ${section('Restrictions', check('Hydrants are dead', 'rules.noHydrants', d.rules.noHydrants) + check('No loans', 'rules.noLoan', d.rules.noLoan) + check('No purchases', 'rules.noBuy', d.rules.noBuy) + check('Random calls as well', 'rules.random', d.rules.random))}
    ${section('Incidents', incidents + btn('Add an incident', 'scenario-add-incident'))}
    ${section('To win', check('Resolve every incident', 'success.resolveAll', d.success.resolveAll) + check('Survive until the time limit', 'success.surviveTime', d.success.surviveTime) + `<div class="field-grid">${field('At most this many deaths', 'success.maxCasualties', d.success.maxCasualties, 'num?')}${field('At least this many fires out', 'success.minSaved', d.success.minSaved, 'num?')}${field('At least this much money', 'success.minCredits', d.success.minCredits, 'num?')}</div>`)}
    ${section('To lose', `<div class="field-grid">${field('More than this many deaths', 'failure.maxCasualties', d.failure.maxCasualties, 'num?')}${field('More than this many buildings lost', 'failure.maxLost', d.failure.maxLost, 'num?')}${field('Less than this much money', 'failure.minCredits', d.failure.minCredits, 'num?')}</div>`)}
    ${ui.scenarioErrors.length ? `<ul class="form-error">${ui.scenarioErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    <div class="finance__buttons">${btn('Save scenario', 'scenario-save', '', 'btn btn--small btn--primary')}${btn('Cancel', 'scenario-cancel')}</div>
  </div>`;
}

export function playTab(state) {
  return `<p class="station__note">Challenges and custom scenarios are scored runs on their own save slot: they never touch your Quick Response or career saves. Starting one replaces the shift you are playing now (it is saved first).</p>` +
    (ui.storage && hasSlot(ui.storage, KEYS.challenge) ? section('Unfinished run', `<div class="finance__buttons">${btn('Continue the saved challenge', 'challenge-continue', '', 'btn btn--small btn--primary')}</div>`) : '') +
    section('Challenges', challengeRows(state)) +
    section('Your scenarios', libraryRows() + (ui.scenario ? '' : `<div class="finance__buttons">${btn('New scenario', 'scenario-new')}</div>`)) +
    (ui.scenario ? section(ui.scenario.id ? 'Edit scenario' : 'New scenario', scenarioEditor()) : '');
}

// -------------------------------------------------------------- the router ---

export function renderTab(id, state) {
  switch (id) {
    case 'dispatch': return dispatchTab(state);
    case 'people': return isCareer(state) ? peopleTab(state) : '';
    case 'stations': return isCareer(state) ? stationsTab(state) : '';
    case 'career': return isCareer(state) ? careerTab(state) : '';
    case 'report': return reportTab(state);
    case 'play': return playTab(state);
    default: return null; // fleet, finance and contracts are hud.js's
  }
}

const q = (id) => document.getElementById(id);

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[keys[i]];
  }
  o[keys.at(-1)] = value;
}

/** A form field changed: the filters, or a field of the scenario being edited. */
export function onChange(ev, api) {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.filter === 'people-q') ui.people.q = t.value;
  else if (t.dataset.filter === 'people-status') ui.people.status = t.value;
  else if (t.id === 'budget-cat') ui.budgetCategory = t.value;
  else if (t.dataset.fleet && ui.scenario) {
    const type = t.dataset.fleet;
    const n = Math.max(0, Math.min(16, Math.floor(Number(t.value) || 0)));
    ui.scenario.start.fleet = [...ui.scenario.start.fleet.filter((f) => f.type !== type), ...Array.from({ length: n }, () => ({ type, station: 0 }))];
  } else if (t.dataset.path && ui.scenario) {
    const type = t.dataset.type;
    let v = t.value;
    if (type === 'bool') v = t.checked;
    else if (type === 'num' || type === 'int') v = v === '' ? 0 : Number(v);
    else if (type === 'num?') v = v === '' ? null : Number(v);
    else if (type === 'hour') v = Number(v);
    if (type === 'int') v = Math.floor(v);
    setPath(ui.scenario, t.dataset.path, v);
  } else {
    return;
  }
  api.refresh();
}

function targetOr(state, say) {
  const inc = selectedIncident(state);
  if (!inc && say) addEvent(state, 'Select an incident on the map first', 'warn');
  return inc;
}

/** The actions of the command screens. Returns true if the action was one of ours. */
export function handle(action, data, state, api) {
  switch (action) {
    case 'preset-send': {
      const inc = targetOr(state, true);
      if (inc) commandPreset(state, data.id, inc);
      return true;
    }
    case 'preset-new': ui.preset = { id: null, name: '', incident: 'fire', units: { engine: 1 } }; ui.presetError = ''; return true;
    case 'preset-edit': {
      const p = state.presets.find((x) => x.id === data.id);
      if (p) ui.preset = { ...p, units: { ...p.units } };
      ui.presetError = '';
      return true;
    }
    case 'preset-cancel': ui.preset = null; ui.presetError = ''; return true;
    case 'preset-delete': commandDeletePreset(state, data.id); if (ui.preset?.id === data.id) ui.preset = null; return true;
    case 'preset-save': {
      const units = {};
      document.querySelectorAll('[data-preset-unit]').forEach((el) => { const n = Math.floor(Number(el.value) || 0); if (n > 0) units[el.dataset.presetUnit] = n; });
      const input = { name: q('pr-name')?.value ?? '', incident: q('pr-incident')?.value ?? 'any', units };
      const r = commandSavePreset(state, input, ui.preset?.id ?? null);
      if (r.ok) { ui.preset = null; ui.presetError = ''; } else { ui.presetError = r.error; ui.preset = { ...ui.preset, ...input }; }
      api.persistPresets?.();
      return true;
    }
    case 'call-off': commandCancelDispatch(state, data.engine); return true;
    case 'redirect': { const inc = targetOr(state, true); if (inc) commandRedirect(state, data.engine, inc); return true; }
    case 'agency-call': { const inc = targetOr(state, true); if (inc) commandAgency(state, data.agency, inc); return true; }
    case 'evacuate': { const inc = targetOr(state, true); if (inc) commandEvacuate(state, inc.kind, inc.id); return true; }
    case 'evacuate-at': commandEvacuate(state, data.kind, data.id); return true;

    case 'candidate-hire': commandHire(state, data.id); return true;
    case 'person-dismiss': commandDismiss(state, data.id); return true;
    case 'person-unassign': commandUnassign(state, data.id); return true;
    case 'person-assign': { const sel = q(`assign-${data.id}`); if (sel) commandAssign(state, data.id, sel.value); return true; }
    case 'person-train': { const sel = q(`train-${data.id}`); if (sel) commandTrain(state, data.id, sel.value); return true; }
    case 'upgrade': commandUpgrade(state, Number(data.station), data.key); return true;
    case 'station-budget': { const el = q(`stbudget-${data.station}`); if (el) commandStationBudget(state, Number(data.station), el.value); return true; }
    case 'budget-set': {
      const cat = q('budget-cat')?.value ?? 'personnel';
      ui.budgetCategory = cat;
      commandBudget(state, cat, q('budget-amount')?.value ?? 0);
      return true;
    }
    case 'emergency-funding': commandEmergencyFunding(state); return true;
    case 'end-shift': api.endShift(); return true;
    case 'next-shift': api.nextShift(); return true;

    case 'challenge-continue': api.continueChallenge(); return true;
    case 'challenge-play': { const def = findChallenge(data.id); if (def) api.playScenario(def); return true; }
    case 'scenario-play': { const def = ui.library.find((s) => s.id === data.id); if (def) api.playScenario(def); return true; }
    case 'scenario-new': ui.scenario = newScenarioTemplate(); ui.scenarioErrors = []; return true;
    case 'scenario-edit': { const s = ui.library.find((x) => x.id === data.id); if (s) ui.scenario = JSON.parse(JSON.stringify(s)); ui.scenarioErrors = []; return true; }
    case 'scenario-copy': {
      const c = findChallenge(data.id);
      if (c) { ui.scenario = { ...JSON.parse(JSON.stringify(c)), id: null, builtin: false, name: `${c.name} (copy)` }; ui.scenarioErrors = []; }
      return true;
    }
    case 'scenario-cancel': ui.scenario = null; ui.scenarioErrors = []; return true;
    case 'scenario-delete': {
      ui.library = deleteScenarioFrom(ui.library, data.id);
      if (ui.storage) storeScenarioLibrary(ui.storage, ui.library);
      if (ui.scenario?.id === data.id) ui.scenario = null;
      return true;
    }
    case 'scenario-add-incident':
      if (ui.scenario.incidents.length < 20) ui.scenario.incidents.push({ at: 30, kind: 'building-fire', location: { kind: 'auto' }, intensity: 0.3, trapped: 0, injured: 0 });
      return true;
    case 'scenario-remove-incident': ui.scenario.incidents.splice(Number(data.index), 1); return true;
    case 'scenario-save': {
      const r = saveScenarioTo(ui.library, ui.scenario, api.city?.());
      if (!r.ok) { ui.scenarioErrors = r.errors; return true; }
      ui.library = r.list;
      if (ui.storage) storeScenarioLibrary(ui.storage, ui.library);
      ui.scenario = null;
      ui.scenarioErrors = [];
      return true;
    }
    default: return false;
  }
}

