// All DOM: the top bar, the selection card, the dispatch log, the unit roster
// and the overlay screens. The renderer never touches an element.

import { CONFIG } from '../core/config.js';
import { formatClock } from '../core/math.js';
import { hydrantInReach } from '../systems/units.js';

const $ = (id) => document.getElementById(id);

const TYPE_LABEL = {
  house: 'House',
  apartment: 'Apartment block',
  shop: 'Shop',
  office: 'Office',
  hotel: 'Hotel',
  warehouse: 'Warehouse',
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
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const pct = (v, max) => `${Math.round(Math.max(0, Math.min(1, v / max)) * 100)}%`;
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
  const fires = buildingFires + wildfires;
  const trapped = state.buildings.reduce((sum, b) => sum + (b.trapped ?? 0), 0);

  $('stat-clock').textContent = formatClock(state.clock);
  $('stat-credits').textContent = `$${state.credits.toLocaleString('en-US')}`;
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
  if (fires > 0) {
    banner.hidden = false;
    const parts = [];
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
  if (state.selected.kind === 'unit') {
    const supply = entity.kind === 'engine'
      ? (entity.supply ? 'S' : hydrantInReach(state, entity) ? 'R' : 'T')
      : '';
    return [
      entity.id, entity.status, Math.round(entity.water / 80), entity.riding,
      entity.kind === 'crew' ? entity.targetId : '', supply,
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

function statusChip(status) {
  const tone = STATUS_TONE[status] ?? '';
  return `<div class="sel__status" data-tone="${tone}"><i></i>${esc(SHORT_STATUS[status] ?? title(status))}</div>`;
}

function engineCard(state, engine) {
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
    <div class="sel__kind">Firefighter</div>
    <h2 class="sel__name">${esc(crew.name)}</h2>
    ${statusChip(crew.status)}
    <p class="sel__meta">
      ${crew.riding ? `Riding in ${esc(engine?.name ?? 'the engine')}.` : `On foot · ${distance} tiles from ${esc(engine?.name ?? 'the engine')}.`}<br>
      ${target ? `Working ${esc(target.name)}.` : 'No fire assigned.'}
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
      : state.buildings.find((b) => b.id === hover.id);
  if (!entity) {
    tip.hidden = true;
    return;
  }
  let detail;
  if (hover.kind === 'wildfire') {
    detail = `Forest fire · $${entity.reward ?? 0} · ${Math.round(entity.intensity * 100)}%`;
  } else if (hover.kind === 'unit') {
    detail = entity.kind === 'engine'
      ? `${SHORT_STATUS[entity.status] ?? entity.status} · ${Math.round(entity.water / entity.capacity * 100)}% water`
      : SHORT_STATUS[entity.status] ?? entity.status;
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
    <div><b>${state.stats.casualties}</b><span>Casualties</span></div>`;
  $('screen-over').hidden = false;
}

// ---------------------------------------------------------------- station ---

export function updateStation(state) {
  const maxed = state.engines.length >= state.city.bays.length;

  const engines = state.engines.map((engine, index) => {
    const crew = state.crew.filter((c) => c.engineId === engine.id);
    const aboard = crew.filter((c) => c.riding).length;
    const refund = Math.round(engine.spec.cost * engine.spec.refund);
    return `
      <div class="station__engine">
        <span class="station__num">${index + 1}</span>
        <div class="station__text">
          <b>${esc(engine.name)}</b>
          <span>${esc(SHORT_STATUS[engine.status] ?? engine.status)} · ${Math.round(
            (engine.water / engine.capacity) * 100,
          )}% water · ${aboard}/${crew.length} aboard</span>
        </div>
        <button type="button" class="station__sell" data-action="sell-vehicle" data-engine="${engine.id}">Sell $${refund}</button>
      </div>`;
  }).join('');

  const buys = Object.entries(CONFIG.vehicles).map(([type, spec]) => {
    const disabled = maxed || state.credits < spec.cost;
    return `
      <button type="button" class="station__buybtn" data-action="buy-vehicle" data-type="${type}"${
        disabled ? ' disabled' : ''
      }>
        <span class="station__buyhead"><b>${esc(spec.label)}</b><i>$${spec.cost.toLocaleString('en-US')}</i></span>
        <span>${spec.crew} crew · ${spec.capacity.toLocaleString('en-US')} L · hose ${spec.hoseRange}</span>
      </button>`;
  }).join('');

  $('station-body').innerHTML = `
    <p class="menu__eyebrow">Station 1 · Apparatus</p>
    <div class="station__balance">$${state.credits.toLocaleString('en-US')}<span>credits</span></div>
    <div class="station__list">${engines}</div>
    ${maxed ? '<p class="station__full">All six bays are full.</p>' : ''}
    <div class="station__buys">${buys}</div>
    <p class="station__note">
      A knockdown pays $${CONFIG.economy.saved}; a rescue $${CONFIG.economy.rescued}. Selling
      returns ${Math.round(CONFIG.vehicles.engine.refund * 100)}% of the price. Each vehicle brings
      its own crew and tank.
    </p>
    <div class="station__save">
      <button type="button" class="btn btn--small" data-action="save-game">Save<kbd>Ctrl+S</kbd></button>
      <button type="button" class="btn btn--small" data-action="load-game">Load</button>
      <button type="button" class="btn btn--small" data-action="new-shift">New shift</button>
    </div>
    <p class="station__saved">${state.saveStatus
      ? `Saved at ${state.saveStatus}`
      : 'Autosaves every 30 seconds'}</p>
    <p class="station__keys">
      <kbd>B</kbd> apparatus · <kbd>D</kbd> dispatch · <kbd>E</kbd> deploy ·
      <kbd>R</kbd> pack up · <kbd>G</kbd> hydrant · <kbd>H</kbd> return ·
      <kbd>F1</kbd> controls
    </p>`;
}
