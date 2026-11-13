// All DOM: the top bar, the selection card, the dispatch log, the unit roster
// and the overlay screens. The renderer never touches an element.

import { CONFIG } from '../core/config.js';
import { formatClock } from '../core/math.js';
import {
  freeBay, hydrantInReach, ownsStation, toolCount, toolsFree, totalBays, totalBerths, vehicleTools,
} from '../systems/units.js';
import { contractProgress } from '../systems/contracts.js';
import { fireDifficulty } from '../systems/fire.js';
import { windLabel } from '../systems/wind.js';

const $ = (id) => document.getElementById(id);

const TYPE_LABEL = {
  house: 'House',
  apartment: 'Apartment block',
  shop: 'Shop',
  office: 'Office',
  hotel: 'Hotel',
  warehouse: 'Warehouse',
  villa: 'Villa',
  tower: 'Office tower',
  mall: 'Shopping centre',
  factory: 'Factory',
  school: 'School',
  tankfarm: 'Fuel tank farm',
  pharmacy: 'Pharmacy',
  hospital: 'Hospital',
  station: 'Fire station',
};

const STATUS_TONE = {
  pumping: 'fire',
  spraying: 'fire',
  rescuing: 'good',
  responding: 'warn',
  moving: 'warn',
  returning: 'warn',
  refilling: 'good',
  restocking: 'good',
  treating: 'good',
  clearing: 'good',
  swimming: 'good',
  transporting: 'warn',
  blocked: 'bad',
  'no kits': 'bad',
  cutting: 'good',
  fetching: 'warn',
  'suiting up': 'warn',
  'in quarters': 'good',
  'no water': 'bad',
  'no hydrant': 'bad',
  'hose too short': 'bad',
  'beyond hose reach': 'bad',
  'at hose limit': 'bad',
  'out of hose': 'bad',
};

const SHORT_STATUS = {
  'in quarters': 'In quarters',
  responding: 'Responding',
  'on scene': 'On scene',
  pumping: 'Pumping',
  refilling: 'Refilling',
  'packing up': 'Packing up',
  'standing by': 'Standing by',
  aboard: 'Aboard',
  moving: 'Moving',
  spraying: 'Spraying',
  rescuing: 'Rescuing',
  returning: 'Returning',
  deployed: 'Deployed',
  'at hose limit': 'Hose limit',
  'hose too short': 'Hose short',
  'beyond hose reach': 'Too far',
  'out of hose': 'Out of hose',
  'no water': 'No water',
  'no hydrant': 'No hydrant',
  restocking: 'Restocking',
  treating: 'Treating',
  clearing: 'Clearing',
  swimming: 'Swimming',
  transporting: 'To hospital',
  blocked: 'Blocked',
  'no kits': 'No kits',
  cutting: 'Cutting',
  fetching: 'Fetching tool',
  'suiting up': 'Suiting up',
};

const TOOL_NOTE = {
  hose: 'Fights fire within hose reach of the vehicle.',
  chainsaw: 'Right-click in the forest to cut a track from the nearest road; vehicles can drive it.',
  diving: 'Swims out to people in the water near the vehicle.',
  cutter: 'Clears wrecks and debris much faster.',
  medkit: 'Treats injured people near the ambulance.',
};

const toolLabel = (tool) => (tool === 'medkit' ? 'Medical bag' : CONFIG.tools[tool]?.label ?? 'Nothing');

/** Buttons for the tools a vehicle carries; `crew` marks the one held. */
function toolButtons(state, engine, crew = null) {
  const tools = vehicleTools(engine);
  if (tools.length === 0) return '';
  return '<div class="sel__tools">' + tools.map((tool) => {
    const total = toolCount(engine, tool);
    const free = toolsFree(state, engine, tool);
    const held = crew && !crew.riding && (crew.tool === tool || crew.fetch === tool);
    const count = total === Infinity ? '' : ' <span class="sel__count">' + free + '/' + total + '</span>';
    const disabled = !held && free <= 0 ? ' disabled' : '';
    return '<button type="button" class="btn btn--tool' + (held ? ' is-active' : '') + '" data-action="equip" data-tool="' + tool + '"' + disabled +
      ' title="' + esc(TOOL_NOTE[tool] ?? '') + '">' + esc(CONFIG.tools[tool].label) + count + '<kbd>' + CONFIG.tools[tool].key + '</kbd></button>';
  }).join('') + '</div>';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const pct = (v, max) => `${max > 0 ? Math.round(Math.max(0, Math.min(1, v / max)) * 100) : 0}%`;
const money = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const title = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

let lastSelectionKey = '';
let lastLogId = -1;
let lastHudAt = 0;
let toastSeen = 0;
let overShown = false;
let handlers = {};

export function mount(state, callbacks) {
  handlers = callbacks;
  buildSpeeds(state);
  buildRoster(state);

  currentState = state;
  document.addEventListener('click', (ev) => {
    const incident = ev.target.closest('[data-incident]');
    if (incident) {
      ev.preventDefault();
      handlers.onIncident?.(incident.dataset.incident, incident.dataset.id);
      return;
    }
    const button = ev.target.closest('[data-action]');
    if (button) {
      ev.preventDefault();
      if (localAction(button)) return;
      handlers.onAction?.(button.dataset.action, button.dataset);
      return;
    }
    const unit = ev.target.closest('[data-unit]');
    if (unit) {
      ev.preventDefault();
      handlers.onUnit?.(unit.dataset.unit);
    }
  });

  document.addEventListener('dblclick', (ev) => {
    const unit = ev.target.closest('[data-unit]');
    if (unit) handlers.onUnitCenter?.(unit.dataset.unit);
  });

  // The unit list starts tucked away so the whole map is visible.
  setUnitsCollapsed(true);

  $('btn-pause').addEventListener('click', () => handlers.onPause?.());
  $('btn-help').addEventListener('click', () => handlers.onHelp?.());
  $('btn-help-close').addEventListener('click', () => handlers.onHelpClose?.());
  $('btn-station').addEventListener('click', () => handlers.onStation?.());
  $('btn-station-close').addEventListener('click', () => handlers.onStationClose?.());
  $('btn-start').addEventListener('click', () => handlers.onStart?.());
  $('btn-continue').addEventListener('click', () => handlers.onContinue?.());
  $('btn-restart').addEventListener('click', () => handlers.onRestart?.());
  $('btn-sound').addEventListener('click', () => handlers.onSound?.());

  toastSeen = state.events[0]?.id ?? 0;
}

function buildSpeeds(state) {
  const box = $('speeds');
  box.innerHTML = '';
  for (const speed of CONFIG.speeds) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.speed = String(speed);
    button.textContent = `${speed}×`;
    button.addEventListener('click', () => handlers.onSpeed?.(speed));
    box.append(button);
  }
}

let currentState = null;
let unitFilter = 'all';
let unitsCollapsed = true; // the unit list starts hidden; the Units button (or U) opens it
const collapsedGroups = new Set();
let rosterKey = '';

const GROUPS = [
  ['fire', 'Fire'],
  ['medical', 'Medical'],
  ['air', 'Air'],
  ['water', 'Water rescue'],
];

/** Which group of the unit list a vehicle belongs to. */
export function categoryOf(engine) {
  const spec = engine.spec;
  if (spec.medical) return 'medical';
  if (spec.flying) return 'air';
  if (spec.boat || spec.diver) return 'water';
  return 'fire';
}

function localAction(button) {
  const action = button.dataset.action;
  if (action === 'units-filter') {
    unitFilter = button.dataset.filter ?? 'all';
    rosterKey = '';
    if (currentState) renderRoster(currentState);
    return true;
  }
  if (action === 'units-collapse') {
    setUnitsCollapsed(!unitsCollapsed);
    if (!unitsCollapsed) setIncidentsOpen(false); // on a phone the two lists share the screen
    return true;
  }
  if (action === 'incidents-toggle') {
    setIncidentsOpen(!incidentsOpen);
    if (incidentsOpen) setUnitsCollapsed(true);
    return true;
  }
  if (action === 'group-toggle') {
    const group = button.dataset.group;
    if (collapsedGroups.has(group)) collapsedGroups.delete(group);
    else collapsedGroups.add(group);
    rosterKey = '';
    if (currentState) renderRoster(currentState);
    return true;
  }
  return false;
}

function setUnitsCollapsed(collapsed) {
  unitsCollapsed = collapsed;
  $('dock-left').hidden = collapsed;
  const tab = $('units-open');
  tab.classList.toggle('is-open', !collapsed);
  tab.setAttribute('aria-expanded', String(!collapsed));
  $('stage').classList.toggle('units-collapsed', collapsed);
}

/** Show or hide the unit list. */
export function toggleUnits() {
  setUnitsCollapsed(!unitsCollapsed);
}

// On a phone the incident list is a popover too, opened from its own button.
let incidentsOpen = false;

function setIncidentsOpen(open) {
  incidentsOpen = open;
  const tab = $('incidents-open');
  tab.classList.toggle('is-open', open);
  tab.setAttribute('aria-expanded', String(open));
  $('stage').classList.toggle('incidents-open', open);
}

/** Fold both lists away, so a small screen shows the map. */
export function closePanels() {
  setIncidentsOpen(false);
  if (!unitsCollapsed) setUnitsCollapsed(true);
}

const unitKey = (engine) => (engine.hotkey ? engine.hotkey.toUpperCase() : '');

function renderRoster(state) {
  const box = $('roster-units');
  const sig = [
    unitFilter, unitsCollapsed, [...collapsedGroups].join(','),
    state.engines.map((e) => e.id + e.name + (e.hotkey ?? '')).join(','),
  ].join('|');
  if (sig === rosterKey) return;
  rosterKey = sig;

  $('units-count').textContent = String(state.engines.length);
  for (const chip of $('units-filters').children) {
    chip.classList.toggle('is-active', chip.dataset.filter === unitFilter);
  }

  let html = '';
  for (const [group, label] of GROUPS) {
    if (unitFilter !== 'all' && unitFilter !== group) continue;
    const members = state.engines
      .map((engine, index) => ({ engine, index }))
      .filter(({ engine }) => categoryOf(engine) === group);
    if (members.length === 0) continue;
    const folded = collapsedGroups.has(group);
    html += '<section class="ugroup" data-group="' + group + '">' +
      '<button type="button" class="ugroup__head" data-action="group-toggle" data-group="' + group + '" aria-expanded="' + (!folded) + '">' +
      '<span class="ugroup__chev">' + (folded ? '▸' : '▾') + '</span><b>' + label + '</b><span class="ugroup__count">' + members.length + '</span></button>';
    if (!folded) {
      html += '<div class="ugroup__list">' + members.map(({ engine, index }) =>
        '<button type="button" class="unit" data-cat="' + group + '" data-unit="' + engine.id + '" title="Click to select · double-click to find">' +
        '<span class="unit__key">' + unitKey(engine) + '</span><span class="unit__dot"></span>' +
        '<span class="unit__text"><span class="unit__name">' + esc(engine.name) + '</span><span class="unit__status">—</span></span>' +
        '<span class="unit__bar"><i></i></span></button>').join('') + '</div>';
    }
    html += '</section>';
  }
  box.innerHTML = html || '<p class="units__empty">No units in this group.</p>';
}

function buildRoster(state) {
  rosterKey = '';
  renderRoster(state);
}

export function reset(state) {
  lastSelectionKey = '';
  lastLogId = -1;
  overShown = false;
  toastSeen = state.events[0]?.id ?? 0;
  $('screen-over').hidden = true;
  $('screen-station').hidden = true;
  $('toasts').innerHTML = '';
  $('selection').hidden = true;
  $('log-list').innerHTML = '';
  buildRoster(state);
  update(state, true);
}

export function update(state, force = false) {
  const now = performance.now();
  if (!force && now - lastHudAt < 90) return;
  lastHudAt = now;

  const buildingFires = state.buildings.filter((b) => b.state === 'burning').length;
  const wildfires = state.wildfires?.length ?? 0;
  const wrecks = state.blockades.length;
  const fires = buildingFires + wildfires;
  const trapped = state.buildings.reduce((sum, b) => sum + (b.trapped ?? 0), 0);

  $('stat-clock').textContent = formatClock(state.clock);
  $('stat-credits').textContent = money(state.credits);
  $('stat-credits').dataset.debt = state.credits < 0 ? '1' : '';
  $('stat-injured').textContent = String(state.patients.filter((q) => !q.treated).length);
  $('stat-wind').textContent = windLabel(state.wind);
  $('wind-arrow').style.transform = `rotate(${state.wind.dir}rad)`;
  $('stat-wind').title = 'Wind speed and the compass point it blows from. Fire spreads faster downwind.';
  $('stat-fires').textContent = String(fires);
  $('stat-trapped').textContent = String(trapped);
  $('stat-rescued').textContent = String(state.stats.rescued);
  $('stat-saved').textContent = String(state.stats.saved);
  $('stat-lost').textContent = String(state.stats.lost);
  $('stat-rating').textContent = String(Math.round(state.rating));
  $('rating-fill').style.width = `${Math.max(0, Math.min(100, state.rating))}%`;

  const pauseButton = $('btn-pause');
  pauseButton.textContent = state.paused ? 'Resume' : 'Pause';
  pauseButton.disabled = !state.running || state.over;

  for (const button of $('speeds').children) {
    button.classList.toggle('is-active', Number(button.dataset.speed) === state.speed);
  }

  const banner = $('banner');
  if (fires > 0 || wrecks > 0) {
    banner.hidden = false;
    const parts = [];
    if (wrecks > 0) parts.push(`${wrecks} road${wrecks === 1 ? '' : 's'} blocked`);
    if (buildingFires > 0) parts.push(`${buildingFires} structure fire${buildingFires === 1 ? '' : 's'}`);
    if (wildfires > 0) parts.push(`${wildfires} forest fire${wildfires === 1 ? '' : 's'}`);
    const people = trapped > 0 ? ` · ${trapped} trapped` : '';
    $('banner-text').textContent = parts.join(' · ') + people;
  } else {
    banner.hidden = true;
  }

  updateRoster(state);
  updateIncidents(state);
  const mini = state.ui.minimap;
  if (mini) $('stage').style.setProperty('--mini-h', Math.round(mini.h) + 'px');
  updateSelection(state);
  updateLog(state);
  updateToasts(state);
  updateTooltip(state);
  updateGameOver(state);
  if (!$('screen-station').hidden) updateStation(state);
}

function unitLevel(engine) {
  if (engine.spec.medical) return engine.kits / (engine.spec.kits || 1);
  if (engine.capacity > 0 && engine.capacity < 50000) return engine.water / engine.capacity;
  return null;
}

function updateRoster(state) {
  currentState = state;
  renderRoster(state);
  const box = $('roster-units');
  for (const button of box.querySelectorAll('.unit')) {
    const engine = state.engines.find((e) => e.id === button.dataset.unit);
    if (!engine) continue;
    const selected = state.selected?.id === engine.id
      || (state.selected?.kind === 'unit' && state.units.find((u) => u.id === state.selected.id)?.engineId === engine.id);
    button.classList.toggle('is-active', state.activeEngineId === engine.id || selected);
    button.querySelector('.unit__dot').dataset.tone = engineTone(engine);
    button.querySelector('.unit__status').textContent = SHORT_STATUS[engine.status] ?? title(engine.status);
    const level = unitLevel(engine);
    const bar = button.querySelector('.unit__bar');
    bar.hidden = level == null;
    if (level != null) {
      bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, level)) * 100) + '%';
      bar.dataset.low = level < 0.2 ? '1' : '';
    }
  }
}

function engineTone(engine) {
  if (engine.pumping) return 'fire';
  if (engine.status === 'responding' || engine.status === 'transporting') return 'warn';
  if (engine.status === 'blocked') return 'bad';
  if (engine.refilling || engine.status === 'treating' || engine.status === 'rescuing' || engine.status === 'clearing') return 'good';
  return '';
}

// ---- incidents: every call that needs someone, most urgent first ---------------
let incidentKey = '';

function collectIncidents(state) {
  const list = [];
  const claimed = (pred) => state.engines.some(pred);
  for (const v of state.victims ?? []) {
    list.push({
      kind: 'victim', id: v.id, tone: 'water', urgency: 1000 - v.life,
      title: 'Person in the water', meta: Math.ceil(v.life) + ' s · ' + (v.label ?? ''),
      handled: Boolean(v.diverId) || claimed((e) => e.victimId === v.id),
    });
  }
  for (const b of state.buildings) {
    if (b.state === 'burning') {
      list.push({
        kind: 'building', id: b.id, tone: 'fire', urgency: 600 + b.fire * 100 + (b.trapped ?? 0) * 40 + (b.dryTime ?? 0) / 4,
        title: b.name, meta: (b.incidentLabel ? b.incidentLabel + ' · ' : '') + Math.round(b.fire * 100) + '% burning · ' + fireDifficulty(b).label + ((b.trapped ?? 0) > 0 ? ' · ' + b.trapped + ' trapped' : '') + (b.runaway ? ' · out of control' : ''),
        handled: claimed((e) => e.targetId === b.id) || state.streams.some((st) => st.targetId === b.id),
      });
    } else if ((b.trapped ?? 0) > 0 && b.state !== 'rubble') {
      list.push({
        kind: 'building', id: b.id, tone: 'bad', urgency: 700,
        title: b.name, meta: (b.incidentLabel ? b.incidentLabel + ' · ' : '') + b.trapped + ' trapped inside', handled: claimed((e) => e.targetId === b.id),
      });
    }
  }
  for (const w of state.wildfires ?? []) {
    list.push({
      kind: 'wildfire', id: w.id, tone: 'fire', urgency: 650 + w.intensity * 100,
      title: 'Forest fire', meta: Math.round(w.intensity * 100) + '% · ' + Math.round(w.radius / 32) + ' tiles across',
      handled: claimed((e) => e.wildfireId === w.id) || state.streams.some((st) => st.wildfireId === w.id),
    });
  }
  for (const q of state.patients) {
    if (q.treated) continue;
    list.push({
      kind: 'patient', id: q.id, tone: 'medic', urgency: 500 - q.life + (q.critical ? 80 : 0),
      title: q.critical ? 'Critically injured' : 'Injured person', meta: Math.ceil(q.life) + ' s · ' + q.buildingName,
      handled: Boolean(q.claimedBy),
    });
  }
  for (const wreck of state.blockades) {
    list.push({
      kind: 'blockade', id: wreck.id, tone: 'warn', urgency: 300 + (wreck.big ? 50 : 0),
      title: wreck.name, meta: Math.round(wreck.progress * 100) + '% cleared',
      handled: claimed((e) => e.blockadeId === wreck.id),
    });
  }
  list.sort((a, b) => b.urgency - a.urgency);
  return list;
}

function updateIncidents(state) {
  const list = collectIncidents(state);
  const shown = list.slice(0, 40);
  const sig = shown.map((i) => [i.kind, i.id, i.meta, i.handled].join(':')).join('|') + list.length;
  $('incident-count').textContent = String(list.length);
  $('incident-count').dataset.on = list.length > 0 ? '1' : '';
  $('incidents-open-count').textContent = String(list.length);
  $('incidents-open-count').dataset.on = list.length > 0 ? '1' : '';
  if (sig === incidentKey) return;
  incidentKey = sig;
  $('incident-list').innerHTML = shown.length
    ? shown.map((i) =>
      '<li><button type="button" class="incident" data-tone="' + i.tone + '" data-incident="' + i.kind + '" data-id="' + i.id + '">' +
      '<span class="incident__dot"></span><span class="incident__text"><b>' + esc(i.title) + '</b><span>' + esc(i.meta) + '</span></span>' +
      '<span class="incident__tag" data-handled="' + (i.handled ? '1' : '') + '">' + (i.handled ? 'En route' : 'Open') + '</span></button></li>').join('') +
      (list.length > shown.length ? '<li class="incident__more">+' + (list.length - shown.length) + ' more</li>' : '')
    : '<li class="incident__none">All quiet. No incidents.</li>';
}

function selectionSignature(state, entity) {
  if (state.selected.kind === 'victim') {
    return [entity.id, Math.ceil(entity.life / 5), Math.round(entity.rescueTimer)].join(':');
  }
  if (state.selected.kind === 'blockade') {
    return [entity.id, Math.round(entity.progress * 50)].join(':');
  }
  if (state.selected.kind === 'patient') {
    return [entity.id, entity.treated, Math.ceil(entity.life / 5), Math.round(entity.treatTimer)].join(':');
  }
  if (state.selected.kind === 'unit') {
    const supply = entity.kind === 'engine'
      ? (entity.supply ? 'S' : hydrantInReach(state, entity) ? 'R' : 'T')
      : '';
    const vehicle = entity.kind === 'engine' ? entity : state.engines.find((e) => e.id === entity.engineId);
    const lockers = vehicle ? vehicleTools(vehicle).map((t) => toolsFree(state, vehicle, t)).join(',') : '';
    const tools = entity.kind === 'engine' ? lockers : [entity.tool, entity.fetch, entity.cut?.done ?? '', lockers].join(',');
    return [
      entity.id, entity.status, Math.round(entity.water / 80), entity.riding,
      entity.kind === 'crew' ? entity.targetId : '', supply, entity.kits ?? '', entity.cargo?.length ?? '', tools,
      entity.kind === 'engine' ? (entity.hotkey ?? '') + (state.ui.rebinding === entity.id ? '*' : '') : '',
    ].join(':');
  }
  return [
    entity.id, entity.state, Math.round(entity.fire * 20),
    Math.round(entity.integrity / 3), entity.trapped ?? 0,
  ].join(':');
}

function updateSelection(state) {
  const panel = $('selection');
  const selected = state.selected;
  let entity = null;
  if (selected?.kind === 'unit') entity = state.units.find((u) => u.id === selected.id);
  else if (selected?.kind === 'wildfire') entity = (state.wildfires ?? []).find((w) => w.id === selected.id);
  else if (selected?.kind === 'patient') entity = state.patients.find((q) => q.id === selected.id);
  else if (selected?.kind === 'blockade') entity = state.blockades.find((q) => q.id === selected.id);
  else if (selected?.kind === 'victim') entity = state.victims.find((q) => q.id === selected.id);
  else entity = state.buildings.find((b) => b.id === selected?.id);

  if (!entity) {
    panel.hidden = true;
    lastSelectionKey = '';
    return;
  }

  const key = selected.kind === 'wildfire'
    ? `wf:${entity.id}:${Math.round(entity.intensity * 20)}:${Math.round(entity.radius / 16)}`
    : selectionSignature(state, entity);
  if (key === lastSelectionKey) return;
  lastSelectionKey = key;
  panel.hidden = false;
  panel.innerHTML = selected.kind === 'wildfire'
    ? wildfireCard(state, entity)
    : selected.kind === 'victim'
      ? victimCard(state, entity)
      : selected.kind === 'blockade'
      ? blockadeCard(state, entity)
      : selected.kind === 'patient'
      ? patientCard(state, entity)
      : selected.kind === 'unit'
      ? (entity.kind === 'engine' ? engineCard(state, entity) : crewCard(state, entity))
      : buildingCard(state, entity);
  if (selected.kind === 'unit' && entity.kind === 'engine') panel.insertAdjacentHTML('beforeend', shortcutRow(state, entity));
}

/** The unit's selection key, with a button to change it. */
function shortcutRow(state, engine) {
  const waiting = state.ui.rebinding === engine.id;
  return '<div class="sel__shortcut"><span>Shortcut</span>' +
    '<button type="button" class="btn btn--small' + (waiting ? ' is-active' : '') + '" data-action="rebind-key" title="Click, then press the key you want for this unit (a digit or Q W S I J L N O Y). Backspace clears it.">' +
    (waiting ? 'Press a key…' : (engine.hotkey ? '<kbd>' + esc(engine.hotkey.toUpperCase()) + '</kbd> change' : 'Set a key')) + '</button></div>';
}

function wildfireCard(state, wildfire) {
  const reward = wildfire.reward ?? 0;
  return `
    <div class="sel__kind">Major incident · Forest fire</div>
    <h2 class="sel__name">North Woods fire</h2>
    <div class="sel__status" data-tone="fire"><i></i>Burning</div>
    <div class="bar__label"><span>Intensity</span><span>${Math.round(wildfire.intensity * 100)}%</span></div>
    <div class="bar bar--fire"><i style="width:${pct(wildfire.intensity, 1)}"></i></div>
    <div class="bar__label"><span>Burned area</span><span>${Math.round(wildfire.radius / 32)} tiles</span></div>
    <p class="sel__meta">Crews have to reach the tree line on foot.<br>Incident reward $${reward.toLocaleString('en-US')}.</p>
    <div class="sel__actions">
      <button type="button" class="btn" data-action="dispatch">Dispatch<kbd>D</kbd></button>
      <button type="button" class="btn" data-action="center">Locate<kbd>C</kbd></button>
    </div>`;
}

function victimCard(state, victim) {
  const frac = Math.max(0, Math.min(1, victim.life / victim.maxLife));
  const divers = state.engines.some((e) => e.spec.diver || toolCount(e, 'diving') > 0);
  return `
    <div class="sel__kind">Water rescue</div>
    <h2 class="sel__name">Person in the water</h2>
    <div class="sel__status" data-tone="bad"><i></i>Drowning</div>
    <div class="bar__label"><span>Time left</span><span>${Math.ceil(victim.life)} s</span></div>
    <div class="bar bar--health"><i style="width:${Math.round(frac * 100)}%"></i></div>
    <p class="sel__meta">Near ${esc(victim.label ?? 'the water')}.<br>${divers
      ? 'Firefighters put on the diving gear from an engine or rescue unit parked on the bank, or go over the side of a rescue boat. Once out they need an ambulance.'
      : 'Nobody has diving gear — engines and rescue units carry it, or buy a rescue boat in Headquarters (B).'}</p>
    <div class="sel__actions">
      <button type="button" class="btn" data-action="dispatch">Send divers<kbd>D</kbd></button>
      <button type="button" class="btn" data-action="center">Locate<kbd>C</kbd></button>
    </div>`;
}

function blockadeCard(state, wreck) {
  const free = state.engines.some((e) => !e.spec.medical);
  const fuse = wreck.fuelAt != null && !wreck.fuelDone ? Math.max(0, Math.ceil(wreck.fuelAt - state.time)) : null;
  return `
    <div class="sel__kind">${wreck.big ? 'Major incident · ' : ''}${wreck.debris ? 'Debris' : 'Wreck'}</div>
    <h2 class="sel__name">${esc(wreck.name)}</h2>
    <div class="sel__status" data-tone="warn"><i></i>Road blocked</div>
    <div class="bar__label"><span>Cleared</span><span>${Math.round(wreck.progress * 100)}%</span></div>
    <div class="bar"><i style="width:${Math.round(wreck.progress * 100)}%"></i></div>
    ${fuse != null ? `<div class="sel__alert">Fuel leaking — may ignite a building in ${fuse} s</div>` : ''}
    <p class="sel__meta">Vehicles cannot drive through it; engines route round. A deployed crew within reach clears it (rescue units twice as fast).<br>Reward $${(wreck.reward ?? 0).toLocaleString('en-US')}${fuse != null ? ' + a quick-clearance bonus' : ''}.</p>
    <div class="sel__actions">
      ${free ? '<button type="button" class="btn" data-action="dispatch">Send a crew<kbd>D</kbd></button>' : ''}
      <button type="button" class="btn" data-action="center">Locate<kbd>C</kbd></button>
    </div>`;
}

function patientCard(state, patient) {
  const frac = Math.max(0, Math.min(1, patient.life / patient.maxLife));
  const free = state.engines.filter((e) => e.spec.medical && e.kits > 0).length;
  return `
    <div class="sel__kind">Medical emergency</div>
    <h2 class="sel__name">${patient.critical ? 'Critically injured' : 'Injured person'}</h2>
    <div class="sel__status" data-tone="${patient.treated ? 'good' : 'bad'}"><i></i>${patient.treated ? 'Stabilised' : 'Needs an ambulance'}</div>
    ${patient.treated ? '' : `
      <div class="bar__label"><span>Time left</span><span>${Math.ceil(patient.life)} s</span></div>
      <div class="bar bar--health"><i style="width:${Math.round(frac * 100)}%"></i></div>`}
    <p class="sel__meta">Hurt near ${esc(patient.buildingName)}.<br>${
      free > 0
        ? `A paramedic crew walks out from the ambulance and uses one kit.${patient.critical ? ' Critical: once stabilised they go to a hospital.' : ''}`
        : 'No ambulance with kits — buy one at the station (B).'
    }</p>
    <div class="sel__actions">
      <button type="button" class="btn" data-action="dispatch">Send ambulance<kbd>D</kbd></button>
      <button type="button" class="btn" data-action="center">Locate<kbd>C</kbd></button>
    </div>`;
}

function statusChip(status) {
  const tone = STATUS_TONE[status] ?? '';
  return `<div class="sel__status" data-tone="${tone}"><i></i>${esc(SHORT_STATUS[status] ?? title(status))}</div>`;
}

function ambulanceCard(state, engine) {
  const crew = state.crew.filter((c) => c.engineId === engine.id);
  const aboard = crew.filter((c) => c.riding).length;
  const kits = engine.spec.kits;
  return `
    <div class="sel__kind">${esc(engine.spec.label)} · paramedics</div>
    <h2 class="sel__name">${esc(engine.name)}</h2>
    ${statusChip(engine.status)}
    <div class="bar__label"><span>Medical kits</span><span>${Math.floor(engine.kits)} / ${kits}</span></div>
    <div class="bar"><i style="width:${pct(engine.kits, kits)}"></i></div>
    <div class="bar__label"><span>Stretchers</span><span>${engine.cargo?.length ?? 0} / ${engine.spec.carry}</span></div>
    <div class="bar"><i style="width:${pct(engine.cargo?.length ?? 0, engine.spec.carry)}"></i></div>
    <p class="sel__meta">${aboard} aboard · ${crew.length - aboard} out<br>Paramedics walk up to ${engine.spec.medRange} tiles from the vehicle. Restock on the station apron (free, slow) or beside a pharmacy ($${CONFIG.economy.kitPrice} a kit, fast). Critical patients ride to a hospital for $${CONFIG.medical.transportFee} each.</p>
    <div class="sel__actions">
      <button type="button" class="btn" data-action="dispatch">Nearest patient<kbd>D</kbd></button>
      <button type="button" class="btn" data-action="pharmacy">Pharmacy<kbd>P</kbd></button>
      <button type="button" class="btn" data-action="hospital">Hospital<kbd>K</kbd></button>
      <button type="button" class="btn" data-action="recall">Recall<kbd>R</kbd></button>
      <button type="button" class="btn" data-action="home">Station<kbd>H</kbd></button>
    </div>`;
}

function specialCard(state, engine) {
  const flying = Boolean(engine.spec.flying);
  const diver = Boolean(engine.spec.diver);
  const boat = Boolean(engine.spec.boat);
  const crew = state.crew.filter((c) => c.engineId === engine.id);
  const water = flying || (boat && !diver)
    ? '<div class="bar__label"><span>Water</span><span>' + Math.round(engine.water) + ' / ' + engine.capacity + ' L</span></div><div class="bar"><i style="width:' + pct(engine.water, engine.capacity) + '"></i></div>'
    : '';
  const note = engine.spec.plane
    ? 'Circles its target dropping water, and skims the sea to refill when it runs low. Very fast; it needs something burning to circle. Right-click a fire to send it.'
    : flying
      ? 'Flies straight to the target over roads, wrecks and traffic and drops water from ' + engine.spec.turretRange + ' tiles, forest fires included. Refills at a station apron or by dipping in the river or the harbour.'
      : diver
        ? (boat ? 'Sails to the casualty and puts divers over the side.' : 'Drives to the bank nearest the casualty; divers swim out up to ' + engine.spec.diveRange + ' tiles.') + ' Right-click someone in the water to send it.'
        : boat
          ? 'Pumps river or sea water without limit from ' + engine.spec.turretRange + ' tiles out, but only works fires near the water. Right-click a fire to send it.'
          : '';
  return '<div class="sel__kind">' + esc(engine.spec.label) + '</div><h2 class="sel__name">' + esc(engine.name) + '</h2>' + statusChip(engine.status) + water +
    '<p class="sel__meta">' + crew.length + ' crew<br>' + note + '</p>' +
    '<div class="sel__actions">' + '<button type="button" class="btn" data-action="dispatch">Dispatch<kbd>D</kbd></button>' +
    (diver ? '<button type="button" class="btn" data-action="deploy">Dive<kbd>E</kbd></button><button type="button" class="btn" data-action="recall">Recall<kbd>R</kbd></button>' : '') +
    '<button type="button" class="btn" data-action="home">Base<kbd>H</kbd></button></div>';
}

function engineCard(state, engine) {
  if (engine.spec.medical) return ambulanceCard(state, engine);
  if (engine.spec.flying || engine.spec.boat || engine.spec.diver) return specialCard(state, engine);
  const crew = state.crew.filter((c) => c.engineId === engine.id);
  const aboard = crew.filter((c) => c.riding).length;
  const deployed = crew.length - aboard;
  const waterPct = pct(engine.water, engine.capacity);
  const hydrant = hydrantInReach(state, engine);
  const pumpless = Boolean(engine.spec.hydrantOnly);
  const supply = engine.supply
    ? '<div class="supply is-on">Hydrant supply connected</div>'
    : hydrant
      ? '<div class="supply is-ready">Hydrant in reach — press G</div>'
      : '<div class="supply">' + (pumpless ? 'No water until it is at a hydrant' : 'Tank supply only') + '</div>';
  return `
    <div class="sel__kind">${esc(engine.spec.label)} company</div>
    <h2 class="sel__name">${esc(engine.name)}</h2>
    ${statusChip(engine.status)}
    ${pumpless ? '' : `<div class="bar__label"><span>Water</span><span>${Math.round(engine.water)} / ${engine.capacity} L</span></div>
    <div class="bar"><i style="width:${waterPct}"></i></div>`}
    ${supply}
    <p class="sel__meta">${aboard} aboard · ${deployed} deployed<br>${pumpless
      ? 'No pump or tank: it parks at the hydrant nearest the fire, connects, and the crew run a hose up to ' + engine.spec.hoseRange + ' tiles.'
      : 'Hose reaches ' + engine.spec.hoseRange + ' tiles; the deck gun ' + engine.spec.turretRange + '.'}</p>
    <div class="sel__label">Equipment — a crew member takes it from the lockers</div>
    ${toolButtons(state, engine)}
    <div class="sel__actions">
      <button type="button" class="btn" data-action="dispatch">Dispatch<kbd>D</kbd></button>
      <button type="button" class="btn" data-action="deploy">Deploy<kbd>E</kbd></button>
      <button type="button" class="btn" data-action="recall">Recall<kbd>R</kbd></button>
      <button type="button" class="btn" data-action="home">Station<kbd>H</kbd></button>
      <button type="button" class="btn" data-action="hydrant">${engine.supply ? 'Detach hydrant' : 'Connect hydrant'}<kbd>G</kbd></button>
    </div>`;
}

function crewCard(state, crew) {
  const target = state.buildings.find((b) => b.id === crew.targetId);
  const engine = state.engines.find((e) => e.id === crew.engineId);
  const distance = engine ? Math.round(Math.hypot(crew.x - engine.x, crew.y - engine.y) / 32) : 0;
  const tool = crew.riding ? null : crew.fetch ?? crew.tool;
  const job = crew.cut
    ? `Cutting a track: ${crew.cut.done * 2} tiles felled, ${Math.max(Math.abs(crew.cut.tx - crew.cut.hx), Math.abs(crew.cut.ty - crew.cut.hy))} to go.`
    : crew.medic ? (crew.patientId ? 'Treating a patient.' : 'No patient assigned.')
      : tool === 'hose' ? (target ? `Working ${esc(target.name)}.` : 'No fire assigned.')
        : esc(TOOL_NOTE[tool] ?? '');
  return `
    <div class="sel__kind">${crew.medic ? 'Paramedic' : tool === 'diving' ? 'Firefighter · diver' : 'Firefighter'}</div>
    <h2 class="sel__name">${esc(crew.name)}</h2>
    ${statusChip(crew.status)}
    <p class="sel__meta">
      ${crew.riding ? `Riding in ${esc(engine?.name ?? 'the engine')}.` : `On foot · ${distance} tiles from ${esc(engine?.name ?? 'the engine')} · ${esc(toolLabel(tool))}${crew.fetch ? ' (fetching)' : ''}.`}<br>
      ${job}
    </p>
    ${!crew.medic && engine ? toolButtons(state, engine, crew) : ''}
    <div class="sel__actions">
      <button type="button" class="btn" data-action="recall">Recall</button>
      <button type="button" class="btn" data-action="select-engine">Engine</button>
      <button type="button" class="btn" data-action="center">Locate</button>
    </div>`;
}

const SIZE_LABEL = { small: 'Small building', medium: 'Medium building', large: 'Large building', huge: 'Very large building' };

const ZONE_LABEL = {
  housing: 'Housing',
  company: 'Business district',
  commercial: 'Shopping street',
  industrial: 'Industrial',
  civic: 'Civic',
};

/** How hard this fire is to fight, and why: size, how far it has taken hold. */
function difficultyRow(b) {
  const d = fireDifficulty(b);
  const why = [];
  if ((b.neglect ?? 0) >= 0.5) why.push('it has taken hold');
  else if ((b.neglect ?? 0) >= 0.2) why.push('it is taking hold — get water on it');
  if (b.sizeClass === 'huge' || b.sizeClass === 'large') why.push(b.fire < 0.3 && (b.neglect ?? 0) < 0.2 ? 'big, but still early: act now' : 'a big building');
  if (b.sizeClass === 'small') why.push('small building');
  return `<div class="sel__status sel__difficulty" data-tone="${d.tone}"><i></i>Fire fight: ${d.label}${why.length ? ' — ' + why.join(', ') : ''}</div>`;
}

function buildingCard(state, building) {
  const type = TYPE_LABEL[building.type] ?? 'Building';
  const burning = building.state === 'burning';
  const trapped = building.trapped ?? 0;
  const firePct = pct(building.fire, 1);
  const healthPct = pct(building.integrity, building.maxIntegrity);
  const healthValue = Math.round((building.integrity / building.maxIntegrity) * 100);
  const tone = burning ? 'fire' : building.state === 'rubble' ? 'bad' : building.state === 'out' ? 'good' : '';
  const status = burning ? 'Burning' : building.state === 'out' ? 'Knocked down' : building.state === 'rubble' ? 'Lost' : 'No fire';

  const district = ZONE_LABEL[building.zone] ?? null;
  const story = building.incidentLabel && building.state !== 'rubble'
    ? `<div class="sel__alert sel__alert--story">${esc(building.incidentLabel)}${building.hazmat ? ' — chemicals, spreads fast' : ''}</div>`
    : '';
  return `
    <div class="sel__kind">${district ? esc(district) + ' · ' : 'Structure · '}${esc(type)}${building.waterfront ? ' · waterfront' : ''}</div>
    <h2 class="sel__name">${esc(building.name)}</h2>
    <div class="sel__status" data-tone="${tone}"><i></i>${status}</div>
    ${story}
    ${trapped > 0 ? `<div class="sel__alert">${trapped} trapped inside</div>` : ''}
    ${burning ? `
      <div class="bar__label"><span>Fire</span><span>${Math.round(building.fire * 100)}%</span></div>
      <div class="bar bar--fire"><i style="width:${firePct}"></i></div>` : ''}
    ${building.state !== 'rubble' ? `
      <div class="bar__label"><span>Structure</span><span>${healthValue}%</span></div>
      <div class="bar bar--health"><i style="width:${healthPct}"></i></div>` : ''}
    ${burning ? difficultyRow(building) : ''}
    <p class="sel__meta">${esc(type)} · ${building.floors} floor${building.floors === 1 ? '' : 's'} · ${SIZE_LABEL[building.sizeClass] ?? ''}${trapped > 0 ? '<br>A crew at the building will bring them out.' : ''}</p>
    <div class="sel__actions">
      ${burning ? '<button type="button" class="btn" data-action="dispatch">Dispatch<kbd>D</kbd></button>' : ''}
      <button type="button" class="btn" data-action="center">Locate<kbd>C</kbd></button>
      <button type="button" class="btn" data-action="select-engine">Engine</button>
    </div>`;
}

function updateLog(state) {
  const newest = state.events[0]?.id ?? -1;
  if (newest === lastLogId) return;
  lastLogId = newest;
  $('log-list').innerHTML = state.events
    .slice(0, 14)
    .map((event) => {
      const clock = formatClock(CONFIG.clockStart + event.t * CONFIG.clockRate);
      return `<li data-tone="${event.tone}"><time>${clock}</time><span>${esc(event.text)}</span></li>`;
    })
    .join('');
}

function updateToasts(state) {
  if (toastSeen === 0) {
    toastSeen = state.events[0]?.id ?? 0;
    return;
  }
  const fresh = [];
  for (const event of state.events) {
    if (event.id <= toastSeen) break;
    fresh.unshift(event);
  }
  if (fresh.length === 0) return;
  toastSeen = fresh[fresh.length - 1].id;

  const box = $('toasts');
  for (const event of fresh.slice(-2)) {
    if (event.tone !== 'fire' && event.tone !== 'bad' && event.tone !== 'big') continue;
    const toast = document.createElement('div');
    toast.className = `toast${event.tone === 'bad' ? ' toast--bad' : ''}${event.tone === 'big' ? ' toast--big' : ''}`;
    toast.innerHTML = `<span class="toast__dot"></span><span>${esc(event.text)}</span>`;
    box.append(toast);
    if (box.children.length > 4) box.firstElementChild.remove();
    setTimeout(() => toast.remove(), 5400);
  }
}

function updateTooltip(state) {
  const tip = $('tooltip');
  const hover = state.ui.hover;
  if (!hover || !state.ui.pointer) {
    tip.hidden = true;
    return;
  }
  const entity = hover.kind === 'unit'
    ? state.units.find((u) => u.id === hover.id)
    : hover.kind === 'wildfire'
      ? (state.wildfires ?? []).find((w) => w.id === hover.id)
      : hover.kind === 'patient'
        ? state.patients.find((q) => q.id === hover.id)
        : hover.kind === 'blockade'
          ? state.blockades.find((q) => q.id === hover.id)
          : hover.kind === 'victim'
            ? state.victims.find((q) => q.id === hover.id)
            : state.buildings.find((b) => b.id === hover.id);
  if (!entity) {
    tip.hidden = true;
    return;
  }
  let detail;
  if (hover.kind === 'victim') {
    detail = `In the water · ${Math.ceil(entity.life)} s left`;
  } else if (hover.kind === 'blockade') {
    detail = `Road blocked · ${Math.round(entity.progress * 100)}% cleared`;
  } else if (hover.kind === 'patient') {
    detail = entity.treated ? 'Stabilised' : `Needs an ambulance · ${Math.ceil(entity.life)} s`;
  } else if (hover.kind === 'wildfire') {
    detail = `Forest fire · $${entity.reward ?? 0} · ${Math.round(entity.intensity * 100)}%`;
  } else if (hover.kind === 'unit') {
    detail = entity.kind !== 'engine'
      ? SHORT_STATUS[entity.status] ?? entity.status
      : entity.spec.medical
        ? `${SHORT_STATUS[entity.status] ?? entity.status} · ${Math.floor(entity.kits)} kits`
        : !(entity.capacity > 0) || entity.capacity >= 50000
          ? SHORT_STATUS[entity.status] ?? entity.status
          : `${SHORT_STATUS[entity.status] ?? entity.status} · ${Math.round(entity.water / entity.capacity * 100)}% water`;
  } else if (entity.state === 'burning') {
    detail = `Burning · ${Math.round(entity.integrity / entity.maxIntegrity * 100)}% standing`;
    if ((entity.trapped ?? 0) > 0) detail += ` · ${entity.trapped} trapped`;
  } else {
    detail = entity.state === 'rubble' ? 'Lost' : entity.state === 'out' ? 'Knocked down' : 'No fire';
    if ((entity.trapped ?? 0) > 0) detail += ` · ${entity.trapped} trapped`;
  }
  tip.innerHTML = `<b>${esc(entity.name)}</b><span>${esc(detail)}</span>`;
  tip.hidden = false;
  tip.style.left = `${state.ui.pointer.x + 16}px`;
  tip.style.top = `${state.ui.pointer.y + 18}px`;
}

function updateGameOver(state) {
  if (!state.over || overShown) return;
  overShown = true;
  $('over-stats').innerHTML = `
    <div><b>${state.stats.saved}</b><span>Saved</span></div>
    <div><b>${state.stats.lost}</b><span>Lost</span></div>
    <div><b>${state.stats.rescued}</b><span>Rescued</span></div>
    <div><b>${state.stats.casualties}</b><span>Casualties</span></div>
    <div><b>${state.stats.treated ?? 0}</b><span>Treated</span></div>`;
  $('screen-over').hidden = false;
}

// ---------------------------------------------------------------- station ---

let stationTab = 'fleet';
let buyStation = 0;
let lastStationHtml = '';

export function setStationTab(tab) {
  stationTab = tab;
  lastStationHtml = '';
}

export function setBuyStation(index) {
  buyStation = index;
  lastStationHtml = '';
}

/** The station new vehicles are delivered to (0 or 1), as chosen in the panel. */
export const getBuyStation = () => buyStation;

const TABS = [
  ['fleet', 'Fleet'],
  ['finance', 'Finance'],
  ['contracts', 'Contracts'],
];

const vehicleBlurb = (spec) => {
  if (spec.plane) return 'no crew · ' + spec.capacity.toLocaleString('en-US') + ' L · circles the fire, skims the sea to refill';
  if (spec.diver) return spec.crew + ' divers · swim ' + spec.diveRange + ' tiles' + (spec.boat ? ' · sails to the casualty' : ' · drives to the bank');
  if (spec.boat) return 'no crew · pumps water without limit · reaches ' + spec.turretRange + ' tiles from the water';
  if (spec.medical) return spec.crew + ' paramedics · ' + spec.kits + ' kits · ' + spec.carry + ' stretchers';
  if (spec.flying) return 'no crew · ' + spec.capacity.toLocaleString('en-US') + ' L · flies over roads · dips in the harbour';
  if (spec.hydrantOnly) return spec.crew + ' crew · no pump or tank · hooks to a hydrant · hose ' + spec.hoseRange + ' · chainsaw, cutter, diving gear';
  return spec.crew + ' crew · ' + spec.capacity.toLocaleString('en-US') + ' L · hose ' + spec.hoseRange;
};

function fleetTab(state) {
  const bays = totalBays(state);
  const landCount = state.engines.filter((e) => !e.spec.boat).length;
  const maxed = freeBay(state, null, false) < 0;
  const dockOpen = ownsStation(state, 2);
  const stationName = (engine) => state.city.stations[state.city.bays[engine.bayIndex]?.station ?? 0]?.name ?? 'Station 1';

  const engines = state.engines.map((engine, index) => {
    const crew = state.crew.filter((c) => c.engineId === engine.id);
    const aboard = crew.filter((c) => c.riding).length;
    const refund = Math.round(engine.spec.cost * engine.spec.refund);
    const load = engine.spec.medical
      ? Math.floor(engine.kits) + '/' + engine.spec.kits + ' kits'
      : engine.capacity > 0
        ? Math.round((engine.water / engine.capacity) * 100) + '% water'
        : 'no tank';
    return '<div class="station__engine">' +
      '<span class="station__num">' + (engine.hotkey ? esc(engine.hotkey.toUpperCase()) : '–') + '</span>' +
      '<div class="station__text"><b>' + esc(engine.name) + '</b>' +
      '<span>' + esc(SHORT_STATUS[engine.status] ?? engine.status) + ' · ' + load + ' · ' + aboard + '/' + crew.length + ' aboard · ' + esc(stationName(engine)) + '</span></div>' +
      '<button type="button" class="station__sell" data-action="sell-vehicle" data-engine="' + engine.id + '">Sell $' + refund.toLocaleString('en-US') + '</button>' +
      '</div>';
  }).join('');

  const landStations = state.city.stations.map((st, i) => ({ st, i })).filter(({ st }) => !st.sea);
  const ownedLand = landStations.filter(({ i }) => ownsStation(state, i));
  const price = (st, i) => (i === 1 ? CONFIG.economy.stationPrice : st.kind === 'airport' ? CONFIG.economy.airportStationPrice : CONFIG.economy.regionStationPrice);
  const stationBox = (ownedLand.length > 1
    ? '<div class="station__chooser"><span>Deliver new vehicles to</span>' +
      ownedLand.map(({ st, i }) => '<button type="button" class="btn btn--small' + (buyStation === i ? ' is-active' : '') + '" data-action="deliver-to" data-station="' + i + '">' + esc(st.name) + '</button>').join('') +
      '</div>'
    : '') +
    '<div class="station__more">' +
    landStations.filter(({ i }) => i > 0 && !ownsStation(state, i)).map(({ st, i }) => {
      const cost = price(st, i);
      const blurb = i === 1 ? 'Sixteen more bays and a second helipad, deep in the city. Calls start coming from its district too.'
        : st.kind === 'airport' ? 'The airport fire station: sixteen bays beside the runway and its own medical centre. Calls start coming from the airfield and its district.'
          : 'A regional station with sixteen bays and a base hospital. Calls start coming from its district.';
      return '<div class="station__expand"><div><b>' + esc(st.name) + '</b><span>' + blurb + '</span></div>' +
        '<button type="button" class="btn btn--small btn--primary" data-action="buy-station" data-station="' + i + '"' + (state.credits < cost ? ' disabled' : '') + '>Open $' + cost.toLocaleString('en-US') + '</button></div>';
    }).join('') +
    '</div>';

  const dock = state.city.stations[2];
  const dockBox = dockOpen
    ? '<div class="station__chooser"><span>' + esc(dock.name) + ' · ' + state.engines.filter((e) => e.spec.boat).length + '/' + totalBerths(state) + ' berths</span></div>'
    : '<div class="station__expand"><div><b>' + esc(dock.name) + '</b><span>Sixteen berths on the harbour. Needed for fireboats and rescue boats, which can sail the river and the bay.</span></div>' +
      '<button type="button" class="btn btn--small btn--primary" data-action="buy-dock"' + (state.credits < CONFIG.economy.dockPrice ? ' disabled' : '') + '>Open $' + CONFIG.economy.dockPrice.toLocaleString('en-US') + '</button></div>';

  const buys = Object.entries(CONFIG.vehicles).map(([type, spec]) => {
    const noRoom = spec.boat ? !dockOpen || freeBay(state, 2, true) < 0 : maxed;
    const disabled = noRoom || state.credits < spec.cost;
    return '<button type="button" class="station__buybtn" data-action="buy-vehicle" data-type="' + type + '"' + (disabled ? ' disabled' : '') + '>' +
      '<span class="station__buyhead"><b>' + esc(spec.label) + '</b><i>$' + spec.cost.toLocaleString('en-US') + '</i></span>' +
      '<span>' + esc(vehicleBlurb(spec)) + '</span></button>';
  }).join('');

  return '<div class="station__balance">$' + state.credits.toLocaleString('en-US') + '<span>credits · ' + landCount + '/' + bays + ' bays</span></div>' +
    '<div class="station__list">' + engines + '</div>' +
    (maxed ? '<p class="station__full">Every bay you own is full' + (ownedLand.length > 1 ? '.' : ' — open another station for sixteen more bays.') + '</p>' : '') +
    stationBox + dockBox +
    '<div class="station__buys">' + buys + '</div>';
}

function financeTab(state) {
  const ledger = state.ledger;
  const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  const line = (label, value, tone) => '<div class="budget__row"' + (tone ? ' data-tone="' + tone + '"' : '') + '><span>' + label + '</span><b>' + value + '</b></div>';
  const loan = CONFIG.economy.loan;
  const owed = state.loan ?? 0;
  const ins = CONFIG.economy.insurance;
  const by = Object.entries(ledger.by ?? {}).sort((a, c) => c[1] - a[1]);
  const ledgerRows = by.length
    ? by.map(([tag, amount]) => line(esc(tag), (amount >= 0 ? '+' : '') + money(amount), amount >= 0 ? 'good' : 'bad')).join('')
    : '<p class="budget__total">Nothing yet this shift.</p>';

  return '<div class="station__balance">$' + state.credits.toLocaleString('en-US') + '<span>credits' + (owed ? ' · owe ' + money(owed) : '') + '</span></div>' +
    '<div class="budget"><p class="menu__eyebrow">Loan · ' + Math.round(loan.rate * 100) + '% interest an hour</p>' +
    line('Owed', money(owed) + ' of ' + money(loan.max)) +
    '<div class="finance__buttons"><button type="button" class="btn btn--small" data-action="take-loan">Borrow ' + money(loan.step) + '</button>' +
    '<button type="button" class="btn btn--small" data-action="repay-loan"' + (owed <= 0 || state.credits < Math.min(owed, loan.step) ? ' disabled' : '') + '>Repay ' + money(Math.min(owed || loan.step, loan.step)) + '</button></div></div>' +

    '<div class="budget"><p class="menu__eyebrow">Insurance</p>' +
    '<p class="budget__total">' + money(ins.premium) + ' an hour. Buildings you lose cost ' + Math.round(ins.lossShare * 100) + '% instead of 100%.</p>' +
    '<div class="finance__buttons"><button type="button" class="btn btn--small' + (state.insured ? ' is-active' : '') + '" data-action="toggle-insurance">' + (state.insured ? 'Insured — cancel' : 'Take out insurance') + '</button></div></div>' +

    '<div class="budget"><p class="menu__eyebrow">This shift · earned ' + money(ledger.earned) + ' · spent ' + money(ledger.spent) + '</p>' + ledgerRows + '</div>';
}

function contractsTab(state) {
  const c = state.contracts;
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const mins = (sec) => Math.max(0, Math.ceil(sec / 60)) + ' min';
  const active = c.active.map((a) => {
    const prog = contractProgress(state, a);
    const frac = prog.target > 0 ? Math.min(1, prog.done / prog.target) : 0;
    const label = a.kind === 'safe'
      ? Math.floor(prog.done) + ' / ' + prog.target + ' s clean'
      : prog.done + ' / ' + prog.target;
    return '<div class="contract is-active"><header><b>' + esc(a.sponsor) + '</b><span>' + money(a.reward) + '</span></header><p>' + esc(a.label) + '</p>' +
      '<div class="bar"><i style="width:' + Math.round(frac * 100) + '%"></i></div>' +
      '<span class="contract__meta">' + label + ' · ' + mins(a.deadline - state.time) + ' left · forfeit ' + money(a.reward * CONFIG.economy.contracts.failPenalty) + '</span></div>';
  }).join('');
  const offers = c.offers.map((o) =>
    '<div class="contract"><header><b>' + esc(o.sponsor) + '</b><span>' + money(o.reward) + '</span></header><p>' + esc(o.label) + '</p>' +
    '<span class="contract__meta">' + mins(o.duration) + ' to do it · offer ends in ' + mins(o.expiresAt - state.time) + '</span>' +
    '<button type="button" class="btn btn--small btn--primary" data-action="accept-contract" data-id="' + o.id + '"' + (c.active.length >= CONFIG.economy.contracts.maxActive ? ' disabled' : '') + '>Accept</button></div>').join('');
  return '<p class="station__note">Sponsors offer side jobs every few minutes. Accept up to two; finish in time and they pay, miss the deadline and you forfeit a quarter of the fee.</p>' +
    '<p class="menu__eyebrow">Running (' + c.active.length + '/' + CONFIG.economy.contracts.maxActive + ')</p>' + (active || '<p class="budget__total">None running.</p>') +
    '<p class="menu__eyebrow">Offers</p>' + (offers || '<p class="budget__total">No offers right now. The next one will turn up soon.</p>') +
    '<p class="budget__total">Completed ' + c.completed + ' · failed ' + c.failed + '</p>';
}

export function updateStation(state) {
  const tabs = '<div class="tabs" role="tablist">' + TABS.map(([id, label]) =>
    '<button type="button" role="tab" class="tab' + (stationTab === id ? ' is-active' : '') + '" data-action="station-tab" data-tab="' + id + '">' + label + '</button>').join('') + '</div>';
  const body = stationTab === 'finance' ? financeTab(state)
      : stationTab === 'contracts' ? contractsTab(state)
        : fleetTab(state);

  const footer = '<div class="station__save">' +
    '<button type="button" class="btn btn--small" data-action="save-game">Save<kbd>Ctrl+S</kbd></button>' +
    '<button type="button" class="btn btn--small" data-action="load-game">Load</button>' +
    '<button type="button" class="btn btn--small" data-action="new-shift">New shift</button></div>' +
    '<p class="station__saved">' + (state.saveStatus ? 'Saved at ' + state.saveStatus : 'Autosaves every 30 seconds') + '</p>' +
    '<p class="station__keys"><kbd>B</kbd> headquarters · <kbd>D</kbd> dispatch · <kbd>A</kbd> dispatch all · <kbd>Z</kbd> back all · <kbd>E</kbd> deploy · <kbd>R</kbd> pack up · <kbd>G</kbd> hydrant · <kbd>P</kbd> pharmacy · <kbd>K</kbd> hospital · <kbd>Tab</kbd> next incident · <kbd>M</kbd> sound · <kbd>F1</kbd> controls</p>';

  const html = '<p class="menu__eyebrow">Headquarters</p>' + tabs + body + footer;
  // Rebuilding the DOM under the pointer swallows clicks, so only touch it on a change.
  if (html === lastStationHtml) return;
  const box = $('station-body');
  const scroll = box.parentElement?.scrollTop ?? 0;
  box.innerHTML = html;
  if (box.parentElement) box.parentElement.scrollTop = scroll;
  lastStationHtml = html;
}

/** Reflect the sound toggle on its button. */
export function setSoundState(muted) {
  const button = $('btn-sound');
  button.classList.toggle('is-off', muted);
  button.firstChild.textContent = muted ? 'Sound off' : 'Sound on';
  button.setAttribute('aria-pressed', String(!muted));
}
