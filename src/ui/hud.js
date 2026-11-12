// All DOM: the top bar, the selection card, the dispatch log, the unit roster
// and the overlay screens. The renderer never touches an element.

import { CONFIG } from '../core/config.js';
import { formatClock } from '../core/math.js';
import {
  availableUpgrades, hydrantInReach, ownsStation, totalBays, upgradeCost, upgradeLevel,
} from '../systems/units.js';
import { contractProgress } from '../systems/contracts.js';
import { TRAINING_LABEL, hourlyBudget } from '../systems/economy.js';
import { windLabel } from '../systems/wind.js';

const $ = (id) => document.getElementById(id);

const TYPE_LABEL = {
  house: 'House',
  apartment: 'Apartment block',
  shop: 'Shop',
  office: 'Office',
  hotel: 'Hotel',
  warehouse: 'Warehouse',
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
  transporting: 'warn',
  blocked: 'bad',
  'no kits': 'bad',
  'in quarters': 'good',
  'no water': 'bad',
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
  restocking: 'Restocking',
  treating: 'Treating',
  clearing: 'Clearing',
  transporting: 'To hospital',
  blocked: 'Blocked',
  'no kits': 'No kits',
};

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

  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-action]');
    if (button) {
      ev.preventDefault();
      handlers.onAction?.(button.dataset.action, button.dataset);
      return;
    }
    const unit = ev.target.closest('[data-unit]');
    if (unit) {
      ev.preventDefault();
      handlers.onUnit?.(unit.dataset.unit);
    }
  });

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

function buildRoster(state) {
  const box = $('roster-units');
  box.innerHTML = '';
  state.engines.forEach((engine, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'unit';
    button.dataset.unit = engine.id;
    button.innerHTML =
      `<span class="unit__key">${index + 1}</span>` +
      '<span class="unit__dot"></span>' +
      '<span class="unit__text">' +
      `<span class="unit__name">${esc(engine.name)}</span>` +
      `<span class="unit__status">—</span>` +
      '</span>';
    box.append(button);
  });
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
  const budget = hourlyBudget(state);
  const budgetEl = $('stat-budget');
  budgetEl.textContent = `${budget.net >= 0 ? '+' : '−'}$${Math.abs(budget.net)}/h`;
  budgetEl.dataset.tone = budget.net >= 0 ? 'good' : 'bad';
  budgetEl.title = `Subsidy ${money(budget.subsidy)} − wages ${money(budget.wages)} − upkeep ${money(budget.upkeep)} per game hour`;
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
  updateSelection(state);
  updateLog(state);
  updateToasts(state);
  updateTooltip(state);
  updateGameOver(state);
  if (!$('screen-station').hidden) updateStation(state);
}

function updateRoster(state) {
  const box = $('roster-units');
  if (box.children.length !== state.engines.length) buildRoster(state);

  for (const button of box.children) {
    const engine = state.engines.find((e) => e.id === button.dataset.unit);
    if (!engine) continue;
    button.classList.toggle('is-active', state.activeEngineId === engine.id);
    const dot = button.querySelector('.unit__dot');
    dot.dataset.tone = engineTone(engine);
    button.querySelector('.unit__status').textContent = SHORT_STATUS[engine.status] ?? title(engine.status);
  }
}

function engineTone(engine) {
  if (engine.pumping) return 'fire';
  if (engine.status === 'responding') return 'warn';
  if (engine.refilling) return 'good';
  return '';
}

function selectionSignature(state, entity) {
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
    return [
      entity.id, entity.status, Math.round(entity.water / 80), entity.riding,
      entity.kind === 'crew' ? entity.targetId : '', supply, entity.kits ?? '', entity.cargo?.length ?? '',
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
    : selected.kind === 'blockade'
      ? blockadeCard(state, entity)
      : selected.kind === 'patient'
      ? patientCard(state, entity)
      : selected.kind === 'unit'
      ? (entity.kind === 'engine' ? engineCard(state, entity) : crewCard(state, entity))
      : buildingCard(state, entity);
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
  const crew = state.crew.filter((c) => c.engineId === engine.id);
  const water = flying
    ? '<div class="bar__label"><span>Water</span><span>' + Math.round(engine.water) + ' / ' + engine.capacity + ' L</span></div><div class="bar"><i style="width:' + pct(engine.water, engine.capacity) + '"></i></div>'
    : '';
  const note = flying
    ? 'Flies straight to the target over roads, wrecks and traffic and drops water from ' + engine.spec.turretRange + ' tiles, forest fires included. Refills at a station apron or by dipping in the harbour, along the south edge of the map.'
    : 'Park it near the fight: every crew within ' + CONFIG.command.range + ' tiles sprays ' + Math.round(CONFIG.command.aura * 100) + '% harder while it stands still.';
  return '<div class="sel__kind">' + esc(engine.spec.label) + '</div><h2 class="sel__name">' + esc(engine.name) + '</h2>' + statusChip(engine.status) + water +
    '<p class="sel__meta">' + crew.length + ' crew<br>' + note + '</p>' +
    '<div class="sel__actions">' + (flying ? '<button type="button" class="btn" data-action="dispatch">Dispatch<kbd>D</kbd></button>' : '') +
    '<button type="button" class="btn" data-action="home">Station<kbd>H</kbd></button></div>';
}

function engineCard(state, engine) {
  if (engine.spec.medical) return ambulanceCard(state, engine);
  if (engine.spec.flying || engine.spec.command) return specialCard(state, engine);
  const crew = state.crew.filter((c) => c.engineId === engine.id);
  const aboard = crew.filter((c) => c.riding).length;
  const deployed = crew.length - aboard;
  const waterPct = pct(engine.water, engine.capacity);
  const hydrant = hydrantInReach(state, engine);
  const supply = engine.supply
    ? '<div class="supply is-on">Hydrant supply connected</div>'
    : hydrant
      ? '<div class="supply is-ready">Hydrant in reach — press G</div>'
      : '<div class="supply">Tank supply only</div>';
  return `
    <div class="sel__kind">${esc(engine.spec.label)} company</div>
    <h2 class="sel__name">${esc(engine.name)}</h2>
    ${statusChip(engine.status)}
    <div class="bar__label"><span>Water</span><span>${Math.round(engine.water)} / ${engine.capacity} L</span></div>
    <div class="bar"><i style="width:${waterPct}"></i></div>
    ${supply}
    <p class="sel__meta">${aboard} aboard · ${deployed} deployed<br>Hose reaches ${engine.spec.hoseRange} tiles; the deck gun ${engine.spec.turretRange}.</p>
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
  return `
    <div class="sel__kind">${crew.medic ? 'Paramedic' : 'Firefighter'}</div>
    <h2 class="sel__name">${esc(crew.name)}</h2>
    ${statusChip(crew.status)}
    <p class="sel__meta">
      ${crew.riding ? `Riding in ${esc(engine?.name ?? 'the engine')}.` : `On foot · ${distance} tiles from ${esc(engine?.name ?? 'the engine')}.`}<br>
      ${crew.medic ? (crew.patientId ? 'Treating a patient.' : 'No patient assigned.')
        : target ? `Working ${esc(target.name)}.` : 'No fire assigned.'}
    </p>
    <div class="sel__actions">
      <button type="button" class="btn" data-action="recall">Recall</button>
      <button type="button" class="btn" data-action="select-engine">Engine</button>
      <button type="button" class="btn" data-action="center">Locate</button>
    </div>`;
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

  return `
    <div class="sel__kind">Structure · ${esc(type)}</div>
    <h2 class="sel__name">${esc(building.name)}</h2>
    <div class="sel__status" data-tone="${tone}"><i></i>${status}</div>
    ${trapped > 0 ? `<div class="sel__alert">${trapped} trapped inside</div>` : ''}
    ${burning ? `
      <div class="bar__label"><span>Fire</span><span>${Math.round(building.fire * 100)}%</span></div>
      <div class="bar bar--fire"><i style="width:${firePct}"></i></div>` : ''}
    ${building.state !== 'rubble' ? `
      <div class="bar__label"><span>Structure</span><span>${healthValue}%</span></div>
      <div class="bar bar--health"><i style="width:${healthPct}"></i></div>` : ''}
    <p class="sel__meta">${esc(type)} · ${building.floors} floor${building.floors === 1 ? '' : 's'}${trapped > 0 ? '<br>A crew at the building will bring them out.' : ''}</p>
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
          : state.buildings.find((b) => b.id === hover.id);
  if (!entity) {
    tip.hidden = true;
    return;
  }
  let detail;
  if (hover.kind === 'blockade') {
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
  ['upgrades', 'Upgrades'],
  ['finance', 'Finance'],
  ['contracts', 'Contracts'],
];

const UPGRADE_TEXT = {
  tank: '+25% water',
  pump: '+15% pressure',
  hose: '+2 hose, +1 deck gun',
  speed: '+10% speed',
  kits: '+3 medical kits',
  stretcher: '+1 stretcher',
};

const vehicleBlurb = (spec) => {
  if (spec.medical) return spec.crew + ' paramedics · ' + spec.kits + ' kits · ' + spec.carry + ' stretchers';
  if (spec.flying) return 'no crew · ' + spec.capacity.toLocaleString('en-US') + ' L · flies over roads · dips in the harbour';
  if (spec.command) return spec.crew + ' crew · parked, boosts crews within ' + CONFIG.command.range + ' tiles by ' + Math.round(CONFIG.command.aura * 100) + '%';
  return spec.crew + ' crew · ' + spec.capacity.toLocaleString('en-US') + ' L · hose ' + spec.hoseRange;
};

function fleetTab(state) {
  const bays = totalBays(state);
  const maxed = state.engines.length >= bays;
  const stationName = (engine) => state.city.stations[state.city.bays[engine.bayIndex]?.station ?? 0]?.name ?? 'Station 1';

  const engines = state.engines.map((engine, index) => {
    const crew = state.crew.filter((c) => c.engineId === engine.id);
    const aboard = crew.filter((c) => c.riding).length;
    const refund = Math.round(engine.spec.cost * engine.spec.refund + (engine.invested ?? 0) * 0.5);
    const load = engine.spec.medical
      ? Math.floor(engine.kits) + '/' + engine.spec.kits + ' kits'
      : engine.capacity > 0
        ? Math.round((engine.water / engine.capacity) * 100) + '% water'
        : 'no tank';
    return '<div class="station__engine">' +
      '<span class="station__num">' + (index + 1) + '</span>' +
      '<div class="station__text"><b>' + esc(engine.name) + '</b>' +
      '<span>' + esc(SHORT_STATUS[engine.status] ?? engine.status) + ' · ' + load + ' · ' + aboard + '/' + crew.length + ' aboard · ' + esc(stationName(engine)) + '</span></div>' +
      '<button type="button" class="station__sell" data-action="sell-vehicle" data-engine="' + engine.id + '">Sell $' + refund.toLocaleString('en-US') + '</button>' +
      '</div>';
  }).join('');

  const two = state.city.stations[1];
  const open2 = ownsStation(state, 1);
  const stationBox = open2
    ? '<div class="station__chooser"><span>Deliver new vehicles to</span>' +
      state.city.stations.map((st, i) => '<button type="button" class="btn btn--small' + (buyStation === i ? ' is-active' : '') + '" data-action="deliver-to" data-station="' + i + '">' + esc(st.name) + '</button>').join('') +
      '</div>'
    : '<div class="station__expand"><div><b>' + esc(two.name) + ' · Civic Quarter</b><span>Eight more bays and a second helipad, deep in the city. Calls start coming from its district too.</span></div>' +
      '<button type="button" class="btn btn--small btn--primary" data-action="buy-station"' + (state.credits < CONFIG.economy.stationPrice ? ' disabled' : '') + '>Open $' + CONFIG.economy.stationPrice.toLocaleString('en-US') + '</button></div>';

  const buys = Object.entries(CONFIG.vehicles).map(([type, spec]) => {
    const disabled = maxed || state.credits < spec.cost;
    return '<button type="button" class="station__buybtn" data-action="buy-vehicle" data-type="' + type + '"' + (disabled ? ' disabled' : '') + '>' +
      '<span class="station__buyhead"><b>' + esc(spec.label) + '</b><i>$' + spec.cost.toLocaleString('en-US') + '</i></span>' +
      '<span>' + esc(vehicleBlurb(spec)) + '</span>' +
      '<span class="station__upkeep">upkeep $' + spec.upkeep + '/h</span></button>';
  }).join('');

  return '<div class="station__balance">$' + state.credits.toLocaleString('en-US') + '<span>credits · ' + state.engines.length + '/' + bays + ' bays</span></div>' +
    '<div class="station__list">' + engines + '</div>' +
    (maxed ? '<p class="station__full">Every bay you own is full' + (open2 ? '.' : ' — open Station 2 for eight more.') + '</p>' : '') +
    stationBox +
    '<div class="station__buys">' + buys + '</div>';
}

function upgradesTab(state) {
  const rows = state.engines.map((engine) => {
    const kinds = availableUpgrades(engine);
    const total = Object.values(engine.upgrades ?? {}).reduce((a, b) => a + b, 0);
    const lines = kinds.map((kind) => {
      const cfg = CONFIG.upgrades[kind];
      const level = upgradeLevel(engine, kind);
      const cost = upgradeCost(engine, kind);
      const pips = cfg.cost.map((_, i) => '<i class="pip' + (i < level ? ' is-on' : '') + '"></i>').join('');
      const button = cost == null
        ? '<span class="upgrade__max">Max</span>'
        : '<button type="button" class="btn btn--small" data-action="upgrade" data-engine="' + engine.id + '" data-kind="' + kind + '"' + (state.credits < cost ? ' disabled' : '') + '>$' + cost.toLocaleString('en-US') + '</button>';
      return '<div class="upgrade"><div class="upgrade__text"><b>' + esc(cfg.label) + '</b><span>' + esc(UPGRADE_TEXT[kind]) + ' per level</span></div><span class="pips">' + pips + '</span>' + button + '</div>';
    }).join('');
    return '<div class="upgrade__vehicle"><header><b>' + esc(engine.name) + '</b><span>' + total + ' levels · upkeep $' + engine.spec.upkeep + '/h</span></header>' + lines + '</div>';
  }).join('');
  return '<div class="station__balance">$' + state.credits.toLocaleString('en-US') + '<span>credits</span></div>' +
    '<p class="station__note">Each level costs more upkeep (+' + Math.round(CONFIG.upgrades.upkeep * 100) + '%) and is half refunded when you sell the vehicle.</p>' + rows;
}

function financeTab(state) {
  const b = hourlyBudget(state);
  const ledger = state.ledger;
  const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  const line = (label, value, tone) => '<div class="budget__row"' + (tone ? ' data-tone="' + tone + '"' : '') + '><span>' + label + '</span><b>' + value + '</b></div>';
  const loan = CONFIG.economy.loan;
  const owed = state.loan ?? 0;
  const ins = CONFIG.economy.insurance;
  const train = CONFIG.economy.training;

  const trainRows = Object.entries(TRAINING_LABEL).map(([kind, label]) => {
    const level = state.training?.[kind] ?? 0;
    const cost = train.cost[level];
    const pips = train.cost.map((_, i) => '<i class="pip' + (i < level ? ' is-on' : '') + '"></i>').join('');
    const effect = kind === 'fire' ? '+' + Math.round(train.fire * 100) + '% water power'
      : kind === 'medic' ? Math.round(train.medic * 100) + '% faster treatment'
        : Math.round(train.rescue * 100) + '% faster rescue';
    const button = cost == null
      ? '<span class="upgrade__max">Max</span>'
      : '<button type="button" class="btn btn--small" data-action="train" data-kind="' + kind + '"' + (state.credits < cost ? ' disabled' : '') + '>$' + cost.toLocaleString('en-US') + '</button>';
    return '<div class="upgrade"><div class="upgrade__text"><b>' + esc(label) + ' training</b><span>' + effect + ' per level</span></div><span class="pips">' + pips + '</span>' + button + '</div>';
  }).join('');

  const by = Object.entries(ledger.by ?? {}).sort((a, c) => c[1] - a[1]);
  const ledgerRows = by.length
    ? by.map(([tag, amount]) => line(esc(tag), (amount >= 0 ? '+' : '') + money(amount), amount >= 0 ? 'good' : 'bad')).join('')
    : '<p class="budget__total">Nothing yet this shift.</p>';

  return '<div class="station__balance">$' + state.credits.toLocaleString('en-US') + '<span>credits' + (owed ? ' · owe ' + money(owed) : '') + '</span></div>' +
    '<div class="budget"><p class="menu__eyebrow">Budget · per game hour</p>' +
    line('City subsidy (scales with rating)', '+' + money(b.subsidy), 'good') +
    line('Wages · ' + state.crew.length + ' crew', '−' + money(b.wages), 'bad') +
    line('Upkeep · ' + state.engines.length + ' vehicles', '−' + money(b.upkeep), 'bad') +
    (b.premium ? line('Insurance premium', '−' + money(b.premium), 'bad') : '') +
    (b.interest ? line('Loan interest', '−' + money(b.interest), 'bad') : '') +
    line('Net per hour', (b.net >= 0 ? '+' : '') + money(b.net), b.net >= 0 ? 'good' : 'bad') + '</div>' +

    '<div class="budget"><p class="menu__eyebrow">Loan · ' + Math.round(loan.rate * 100) + '% interest an hour</p>' +
    line('Owed', money(owed) + ' of ' + money(loan.max)) +
    '<div class="finance__buttons"><button type="button" class="btn btn--small" data-action="take-loan">Borrow ' + money(loan.step) + '</button>' +
    '<button type="button" class="btn btn--small" data-action="repay-loan"' + (owed <= 0 || state.credits < Math.min(owed, loan.step) ? ' disabled' : '') + '>Repay ' + money(Math.min(owed || loan.step, loan.step)) + '</button></div></div>' +

    '<div class="budget"><p class="menu__eyebrow">Insurance</p>' +
    '<p class="budget__total">' + money(ins.premium) + ' an hour. Buildings you lose cost ' + Math.round(ins.lossShare * 100) + '% instead of 100%.</p>' +
    '<div class="finance__buttons"><button type="button" class="btn btn--small' + (state.insured ? ' is-active' : '') + '" data-action="toggle-insurance">' + (state.insured ? 'Insured — cancel' : 'Take out insurance') + '</button></div></div>' +

    '<div class="budget"><p class="menu__eyebrow">Crew training · wages rise ' + Math.round(train.wageRise * 100) + '% per level</p>' + trainRows + '</div>' +

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
  const body = stationTab === 'upgrades' ? upgradesTab(state)
    : stationTab === 'finance' ? financeTab(state)
      : stationTab === 'contracts' ? contractsTab(state)
        : fleetTab(state);

  const footer = '<div class="station__save">' +
    '<button type="button" class="btn btn--small" data-action="save-game">Save<kbd>Ctrl+S</kbd></button>' +
    '<button type="button" class="btn btn--small" data-action="load-game">Load</button>' +
    '<button type="button" class="btn btn--small" data-action="new-shift">New shift</button></div>' +
    '<p class="station__saved">' + (state.saveStatus ? 'Saved at ' + state.saveStatus : 'Autosaves every 30 seconds') + '</p>' +
    '<p class="station__keys"><kbd>B</kbd> headquarters · <kbd>D</kbd> dispatch · <kbd>E</kbd> deploy · <kbd>R</kbd> pack up · <kbd>G</kbd> hydrant · <kbd>P</kbd> pharmacy · <kbd>K</kbd> hospital · <kbd>Tab</kbd> next incident · <kbd>M</kbd> sound · <kbd>F1</kbd> controls</p>';

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
