// Wiring: canvas, camera, pointer and keyboard, and the bridge between the
// simulation and the DOM HUD. No game rules live here.

import { CONFIG, TILE } from './core/config.js';
import { clamp, formatClock } from './core/math.js';
import { createLoop } from './core/loop.js';
import {
  createGame, startShift, update, pickAt, selectUnit, selectBuilding,
  commandMove, commandDispatch, commandDeploy, commandRecall, commandReturnHome,
  commandBuyVehicle, commandSellVehicle, commandHydrant, commandDispatchWildfire,
  commandDispatchPatient, commandDispatchBlockade, commandPharmacy, commandHospital,
  selectPatient, selectBlockade,
  commandBuyStation, commandUpgrade, commandLoan, commandRepay, commandInsurance,
  commandTrain, commandAcceptContract,
  selectWildfire, getSelected, serialize, loadState,
} from './systems/game.js';
import { createAudio } from './systems/audio.js';
import { spawnPatient } from './systems/medical.js';
import { trafficAccident, pileUp } from './systems/chains.js';
import { activeFires } from './systems/fire.js';
import { addEvent } from './systems/events.js';
import { engineForUnit } from './systems/units.js';
import { startWildfire } from './systems/wildfire.js';
import { ignite } from './systems/fire.js';
import { render, createCamera, clampCamera, screenToWorld } from './render/render.js';
import * as hud from './ui/hud.js';

const canvas = document.getElementById('game');
const stage = document.getElementById('stage');
const ctx = canvas.getContext('2d', { alpha: false });

const audio = createAudio();
const view = { width: 1, height: 1, dpr: 1 };
let state = createGame(CONFIG.city.seed);
let cam = createCamera(state);
let loop = null;
let pausedByOverlay = false;

const keys = new Set();
let drag = null;
let minimapDrag = false;

// ------------------------------------------------------------------ view ---

function resize() {
  const rect = stage.getBoundingClientRect();
  view.width = Math.max(1, rect.width);
  view.height = Math.max(1, rect.height);
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
}

window.addEventListener('resize', resize);
if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
resize();

function toWorld(mx, my) {
  return screenToWorld(cam, mx, my, view);
}

function pointerPos(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

// ------------------------------------------------------------------ loop ---

function frame(dt) {
  panCamera(dt || 0);
  clampCamera(cam, state, view);
  render(ctx, state, cam, view, { now: state.time });
  audio.update(state, cam, view);
  hud.update(state);
}

function beginLoop() {
  loop?.stop();
  loop = createLoop({
    state,
    update: (dt) => update(state, dt),
    render: (dt) => frame(dt),
  });
  loop.start();
}

function panCamera(dt) {
  let dx = 0;
  let dy = 0;
  if (keys.has('arrowleft')) dx -= 1;
  if (keys.has('arrowright')) dx += 1;
  if (keys.has('arrowup')) dy -= 1;
  if (keys.has('arrowdown')) dy += 1;
  if (dx === 0 && dy === 0) return;
  const speed = (CONFIG.camera.panSpeed / cam.zoom) * dt;
  cam.x += dx * speed;
  cam.y += dy * speed;
}

// ----------------------------------------------------------------- input ---

function updateHover(ev) {
  const p = pointerPos(ev);
  const world = toWorld(p.x, p.y);
  const hit = pickAt(state, world.x, world.y, 10 / cam.zoom);
  state.ui.hover = hit;
  state.ui.pointer = { x: ev.clientX, y: ev.clientY };
  canvas.style.cursor = hit ? 'pointer' : 'grab';
}

function clearHover() {
  state.ui.hover = null;
  state.ui.pointer = null;
  canvas.style.cursor = 'default';
}

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// Browsers only start audio after a gesture; the first click or key does it.
const unlockAudio = () => audio.unlock();
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

canvas.addEventListener('pointerdown', (ev) => {
  if (!state.running || state.over) return;
  const p = pointerPos(ev);
  const rect = state.ui.minimap;
  if (rect && p.x >= rect.x - 8 && p.x <= rect.x + rect.w + 8 && p.y >= rect.y - 8 && p.y <= rect.y + rect.h + 8) {
    minimapDrag = true;
    jumpFromMinimap(p.x, p.y);
    canvas.setPointerCapture(ev.pointerId);
    return;
  }
  if (ev.button === 2) {
    orderAt(p.x, p.y);
    return;
  }
  if (ev.button !== 0) return;
  drag = { sx: ev.clientX, sy: ev.clientY, camX: cam.x, camY: cam.y, moved: false };
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!state.running || state.over) return;
  const p = pointerPos(ev);
  if (minimapDrag) {
    jumpFromMinimap(p.x, p.y);
    return;
  }
  if (drag) {
    const dx = ev.clientX - drag.sx;
    const dy = ev.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) {
      cam.x = drag.camX - dx / cam.zoom;
      cam.y = drag.camY - dy / cam.zoom;
      clampCamera(cam, state, view);
      canvas.style.cursor = 'grabbing';
      state.ui.hover = null;
      return;
    }
  }
  updateHover(ev);
});

canvas.addEventListener('pointerup', (ev) => {
  if (minimapDrag) {
    minimapDrag = false;
    return;
  }
  if (!drag) return;
  const wasClick = !drag.moved;
  drag = null;
  if (!wasClick || ev.button !== 0) {
    canvas.style.cursor = 'grab';
    return;
  }
  const p = pointerPos(ev);
  const world = toWorld(p.x, p.y);
  const hit = pickAt(state, world.x, world.y, 10 / cam.zoom);
  if (hit) {
    if (hit.kind === 'unit') selectUnit(state, hit.id);
    else if (hit.kind === 'patient') selectPatient(state, hit.id);
    else if (hit.kind === 'blockade') selectBlockade(state, hit.id);
    else if (hit.kind === 'wildfire') selectWildfire(state, hit.id);
    else selectBuilding(state, hit.id);
  } else {
    state.selected = null;
  }
  if (hit) audio.play('select');
  updateHover(ev);
});

canvas.addEventListener('pointerleave', () => {
  if (!drag) clearHover();
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (!state.running) return;
  const p = pointerPos(ev);
  const before = toWorld(p.x, p.y);
  const factor = Math.exp(-ev.deltaY * 0.0015);
  cam.zoom = clamp(cam.zoom * factor, CONFIG.camera.minZoom, CONFIG.camera.maxZoom);
  const after = toWorld(p.x, p.y);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
  clampCamera(cam, state, view);
}, { passive: false });

function orderAt(mx, my) {
  const world = toWorld(mx, my);
  const hit = pickAt(state, world.x, world.y, 12 / cam.zoom);
  if (hit?.kind === 'wildfire') {
    if (commandDispatchWildfire(state, hit.id)) audio.play('radio');
    return;
  }
  if (hit?.kind === 'patient') {
    if (commandDispatchPatient(state, hit.id)) audio.play('radio');
    return;
  }
  if (hit?.kind === 'blockade') {
    if (commandDispatchBlockade(state, hit.id)) audio.play('radio');
    return;
  }
  const buildingId = hit?.kind === 'building' ? hit.id : null;
  if (commandMove(state, world.x, world.y, buildingId)) {
    state.ui.orderMark = { x: world.x, y: world.y, t: state.time };
    audio.play('radio');
  }
}

// ---------------------------------------------------------------- minimap ---

function jumpFromMinimap(mx, my) {
  const rect = state.ui.minimap;
  if (!rect) return;
  const tx = clamp((mx - rect.x) / rect.w, 0, 1);
  const ty = clamp((my - rect.y) / rect.h, 0, 1);
  cam.x = tx * state.city.w * TILE;
  cam.y = ty * state.city.h * TILE;
  clampCamera(cam, state, view);
}

// -------------------------------------------------------------- commands ---

function selectedEntity() {
  return getSelected(state);
}

function centerOnSelected() {
  const entity = selectedEntity();
  if (!entity) return;
  if (entity.kind === 'wildfire' || entity.kind === 'patient' || entity.kind === 'blockade') {
    cam.x = entity.x;
    cam.y = entity.y;
  } else if (entity.kind === 'engine' || entity.kind === 'crew') {
    cam.x = entity.x;
    cam.y = entity.y;
  } else {
    cam.x = (entity.x + entity.w / 2) * TILE;
    cam.y = (entity.y + entity.h / 2) * TILE;
  }
  clampCamera(cam, state, view);
}

/** Everything that needs a response, in a stable order, for the Tab key. */
function incidents() {
  const list = [];
  for (const b of activeFires(state)) {
    list.push({ kind: 'building', id: b.id, x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE });
  }
  for (const w of state.wildfires ?? []) list.push({ kind: 'wildfire', id: w.id, x: w.x, y: w.y });
  for (const q of state.patients) {
    if (!q.treated) list.push({ kind: 'patient', id: q.id, x: q.x, y: q.y });
  }
  for (const w of state.blockades) list.push({ kind: 'blockade', id: w.id, x: w.x, y: w.y });
  for (const b of state.buildings) {
    if ((b.trapped ?? 0) > 0 && b.state !== 'burning' && b.state !== 'rubble') {
      list.push({ kind: 'building', id: b.id, x: (b.x + b.w / 2) * TILE, y: (b.y + b.h / 2) * TILE });
    }
  }
  return list;
}

let incidentCursor = -1;
function jumpToNextIncident() {
  const list = incidents();
  if (list.length === 0) {
    addEvent(state, 'No active incidents', 'info');
    return;
  }
  incidentCursor = (incidentCursor + 1) % list.length;
  const target = list[incidentCursor];
  cam.x = target.x;
  cam.y = target.y;
  if (cam.zoom < 0.7) cam.zoom = 0.9;
  if (target.kind === 'patient') selectPatient(state, target.id);
  else if (target.kind === 'blockade') selectBlockade(state, target.id);
  else if (target.kind === 'wildfire') selectWildfire(state, target.id);
  else selectBuilding(state, target.id);
  clampCamera(cam, state, view);
}

function centerOnStation() {
  const station = state.city.station;
  cam.x = (station.x + station.w / 2) * TILE;
  cam.y = (station.y + station.h / 2) * TILE;
  clampCamera(cam, state, view);
}

function toggleSound() {
  audio.unlock();
  hud.setSoundState(audio.toggleMute());
}

function onAction(action, data = {}) {
  switch (action) {
    case 'pharmacy': commandPharmacy(state); break;
    case 'hospital': commandHospital(state); break;
    case 'dispatch': commandDispatch(state); break;
    case 'deploy': commandDeploy(state); break;
    case 'recall': commandRecall(state); break;
    case 'home': commandReturnHome(state); break;
    case 'select-engine': {
      const selected = getSelected(state);
      const engine = selected ? engineForUnit(state, selected) : null;
      if (engine) selectUnit(state, engine.id);
      break;
    }
    case 'center': centerOnSelected(); break;
    case 'hydrant': commandHydrant(state); break;
    case 'open-station': toggleStation(); break;
    case 'close-station': hideOverlay(stationScreen); break;
    case 'buy-vehicle': buyApparatus(data.type ?? 'engine'); break;
    case 'station-tab': hud.setStationTab(data.tab ?? 'fleet'); break;
    case 'deliver-to': hud.setBuyStation(Number(data.station ?? 0)); break;
    case 'buy-station': commandBuyStation(state); break;
    case 'upgrade': commandUpgrade(state, data.engine, data.kind); break;
    case 'take-loan': commandLoan(state); break;
    case 'repay-loan': commandRepay(state); break;
    case 'toggle-insurance': commandInsurance(state); break;
    case 'train': commandTrain(state, data.kind); break;
    case 'accept-contract': commandAcceptContract(state, data.id); break;
    case 'sell-vehicle': sellApparatus(data.engine); break;
    case 'save-game': saveGame(); break;
    case 'load-game': loadGame(); break;
    case 'new-shift': restart(); break;
    default: break;
  }
  if (!stationScreen.hidden) {
    hud.updateStation(state);
    hud.update(state, true);
  }
}

function togglePause() {
  if (!state.running || state.over) return;
  state.paused = !state.paused;
}

const helpScreen = document.getElementById('screen-help');
const stationScreen = document.getElementById('screen-station');

function showOverlay(screen) {
  if (!screen.hidden) return;
  const anyOpen = !helpScreen.hidden || !stationScreen.hidden;
  if (!anyOpen) pausedByOverlay = state.paused;
  if (!helpScreen.hidden) helpScreen.hidden = true;
  if (!stationScreen.hidden) stationScreen.hidden = true;
  state.paused = true;
  screen.hidden = false;
}

function hideOverlay(screen) {
  if (screen.hidden) return;
  screen.hidden = true;
  if (state.running && helpScreen.hidden && stationScreen.hidden) {
    state.paused = pausedByOverlay;
  }
}

function toggleHelp() {
  if (helpScreen.hidden) showOverlay(helpScreen);
  else hideOverlay(helpScreen);
}

function toggleStation() {
  if (stationScreen.hidden) {
    showOverlay(stationScreen);
    hud.updateStation(state);
  } else {
    hideOverlay(stationScreen);
  }
}

function buyApparatus(type) {
  const vehicle = commandBuyVehicle(state, type, hud.getBuyStation());
  if (vehicle) {
    hud.updateStation(state);
    hud.update(state, true);
  }
}

function sellApparatus(id) {
  commandSellVehicle(state, id);
  hud.updateStation(state);
  hud.update(state, true);
}

// ------------------------------------------------------------------- save ---

const SAVE_KEY = 'firestation.save.v4';

function hasSave() {
  try {
    return Boolean(localStorage.getItem(SAVE_KEY));
  } catch {
    return false;
  }
}

function saveGame(quiet = false) {
  if (!state.running) return false;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serialize(state)));
    state.saveStatus = formatClock(state.clock);
    if (!quiet) addEvent(state, 'Shift saved', 'good');
    hud.updateStation(state);
    return true;
  } catch {
    addEvent(state, 'Could not save — the browser blocked storage', 'warn');
    return false;
  }
}

function loadGame() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
  } catch {
    data = null;
  }
  if (!data) {
    addEvent(state, 'No saved shift found', 'warn');
    return false;
  }

  loop?.stop();
  state = loadState(data);
  cam = createCamera(state);
  const focus = state.engines[0];
  if (focus) {
    cam.x = focus.x;
    cam.y = focus.y;
  }
  cam.zoom = 1.05;
  clampCamera(cam, state, view);
  pausedByOverlay = false;
  helpScreen.hidden = true;
  stationScreen.hidden = true;
  document.getElementById('screen-start').hidden = true;
  document.getElementById('screen-over').hidden = true;
  hud.reset(state);
  beginLoop();
  return true;
}

function startGame() {
  document.getElementById('screen-start').hidden = true;
  if (!state.running) startShift(state);
}

function restart() {
  loop?.stop();
  state = createGame(CONFIG.city.seed);
  cam = createCamera(state);
  pausedByOverlay = false;
  helpScreen.hidden = true;
  stationScreen.hidden = true;
  hud.reset(state);
  document.getElementById('screen-over').hidden = true;
  document.getElementById('screen-start').hidden = true;
  startShift(state);
  beginLoop();
}

// --------------------------------------------------------------- keyboard ---

window.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    saveGame();
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const key = ev.key.toLowerCase();

  if (key === 'f1' || ev.key === '?') {
    ev.preventDefault();
    toggleHelp();
    return;
  }
  if (key === 'escape') {
    if (!helpScreen.hidden) hideOverlay(helpScreen);
    else if (!stationScreen.hidden) hideOverlay(stationScreen);
    else state.selected = null;
    return;
  }

  const overlayOpen = !helpScreen.hidden || !stationScreen.hidden;

  if (key === 'm' && !ev.repeat) {
    toggleSound();
    return;
  }

  // B is the one gameplay key that also works inside a panel, so it can close it.
  if (key === 'b' && !ev.repeat) {
    ev.preventDefault();
    toggleStation();
    return;
  }
  if (key === ' ') {
    ev.preventDefault();
    if (!overlayOpen) togglePause();
    return;
  }
  if (overlayOpen) return;
  if (!state.running || state.over) return;

  if (key.startsWith('arrow')) {
    keys.add(key);
    ev.preventDefault();
    return;
  }

  if (key === 'tab') {
    ev.preventDefault();
    jumpToNextIncident();
    return;
  }
  if (key === 'home') {
    ev.preventDefault();
    centerOnStation();
    return;
  }

  if (key >= '1' && key <= '9') {
    const engine = state.engines[Number(key) - 1];
    if (engine) selectUnit(state, engine.id);
    return;
  }

  switch (key) {
    case 'd': commandDispatch(state); break;
    case 'e': commandDeploy(state); break;
    case 'r': commandRecall(state); break;
    case 'h': commandReturnHome(state); break;
    case 'g': commandHydrant(state); break;
    case 'p': commandPharmacy(state); break;
    case 'k': commandHospital(state); break;
    case 'c': centerOnSelected(); break;
    case '+':
    case '=':
      cam.zoom = clamp(cam.zoom * 1.15, CONFIG.camera.minZoom, CONFIG.camera.maxZoom);
      clampCamera(cam, state, view);
      break;
    case '-':
      cam.zoom = clamp(cam.zoom / 1.15, CONFIG.camera.minZoom, CONFIG.camera.maxZoom);
      clampCamera(cam, state, view);
      break;
    default:
      break;
  }
});

window.addEventListener('keyup', (ev) => {
  keys.delete(ev.key.toLowerCase());
});

window.addEventListener('blur', () => {
  keys.clear();
  drag = null;
  minimapDrag = false;
});

// ------------------------------------------------------------------ boot ---

hud.mount(state, {
  onAction,
  onUnit: (id) => selectUnit(state, id),
  onSpeed: (speed) => { state.speed = speed; },
  onPause: togglePause,
  onHelp: toggleHelp,
  onHelpClose: () => hideOverlay(helpScreen),
  onStation: toggleStation,
  onStationClose: () => hideOverlay(stationScreen),
  onStart: startGame,
  onContinue: loadGame,
  onRestart: restart,
  onSound: toggleSound,
});
hud.setSoundState(audio.isMuted());

if (hasSave()) document.getElementById('btn-continue').hidden = false;

setInterval(() => {
  if (state.running && !state.paused) saveGame(true);
}, 30000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.running) saveGame(true);
});

beginLoop();
hud.update(state, true);

// Read-only hook for the headless UI smoke test (tools/smoke.mjs).
window.__fireStation = {
  get state() { return state; },
  get cam() { return cam; },
  view,
};

// Development helpers, used by the headless screenshots in the README:
//   ?autostart   skip the menu
//   ?demo        start, light a hotel and send the engine
//   ?warp=45     fast-forward this many seconds before the first frame
//   ?burn       light three buildings, for looking at fire without a dispatch
const params = new URLSearchParams(window.location.search);
if (params.has('autostart') || params.has('demo') || params.has('burn')) startGame();
if (params.has('demo')) {
  const target = state.buildings.find((b) => b.type === 'hotel') ?? state.buildings[5];
  ignite(state, target, 'alarm');
  selectUnit(state, 'engine');
  commandDispatch(state, target.id);
  cam.x = (target.x + target.w / 2) * TILE;
  cam.y = (target.y + target.h / 2) * TILE - 40;
  cam.zoom = 1.2;
  clampCamera(cam, state, view);
}
if (params.has('burn')) {
  const picks = state.buildings
    .filter((b) => b.type !== 'station' && b.type !== 'house')
    .slice(6, 9);
  for (const b of picks) ignite(state, b, 'alarm');
  const focus = picks[0];
  if (focus) {
    cam.x = (focus.x + focus.w / 2) * TILE;
    cam.y = (focus.y + focus.h / 2) * TILE;
    cam.zoom = 1.05;
    clampCamera(cam, state, view);
  }
}
const zoomParam = Number(params.get('zoom') ?? 0);
if (zoomParam > 0) {
  cam.zoom = clamp(zoomParam, CONFIG.camera.minZoom, CONFIG.camera.maxZoom);
  clampCamera(cam, state, view);
}
const warp = Number(params.get('warp') ?? 0);
if (warp > 0 && Number.isFinite(warp)) {
  const step = 1 / 30;
  for (let i = 0; i < Math.min(warp, 900) / step; i++) update(state, step);
}

// Park the first engine beside a hydrant (dev helper for the hydrant visuals).
if (params.has('hydrantpark')) {
  const engine = state.engines[0];
  const city = state.city;
  const roadAt = (x, y) => x >= 0 && y >= 0 && x < city.w && y < city.h
    && city.road[y * city.w + x] === 1;
  const station = city.station;
  const hydrant = city.hydrants.find((h) => (
    Math.abs(h.x - station.x) + Math.abs(h.y - station.y) > 16
    && !city.park[h.y * city.w + h.x]
    && (roadAt(h.x + 1, h.y) || roadAt(h.x - 1, h.y) || roadAt(h.x, h.y + 1) || roadAt(h.x, h.y - 1))
  )) ?? city.hydrants[0];

  let ex = (hydrant.x + 0.5) * TILE;
  let ey = (hydrant.y + 0.5) * TILE;
  if (roadAt(hydrant.x + 1, hydrant.y)) ex += 1.25 * TILE;
  else if (roadAt(hydrant.x - 1, hydrant.y)) ex -= 1.25 * TILE;
  else if (roadAt(hydrant.x, hydrant.y + 1)) ey += 1.25 * TILE;
  else if (roadAt(hydrant.x, hydrant.y - 1)) ey -= 1.25 * TILE;
  engine.x = ex;
  engine.y = ey;
  selectUnit(state, engine.id);
  cam.x = ex;
  cam.y = ey - 30;
  cam.zoom = 1.35;
  clampCamera(cam, state, view);
}
if (params.has('connect')) commandHydrant(state);

const selectId = params.get('select');
if (selectId) {
  if (state.units.some((u) => u.id === selectId)) selectUnit(state, selectId);
  else if (state.buildings.some((b) => b.id === selectId)) selectBuilding(state, selectId);
}
const creditsParam = Number(params.get('credits') ?? 0);
if (creditsParam > 0) state.credits = creditsParam;
if (params.has('buy')) {
  commandBuyVehicle(state, params.get('buy') || 'engine');
}
const fleet = params.get('fleet');
if (fleet) {
  for (const type of fleet.split(',')) commandBuyVehicle(state, type.trim());
}
if (params.has('wildfire')) {
  const tiles = state.city.forestTiles;
  if (tiles.length > 0) {
    const tile = tiles[Math.floor(tiles.length / 2)];
    const wf = startWildfire(state, (tile.x + 0.5) * TILE, (tile.y + 0.5) * TILE, 2200);
    cam.x = wf.x;
    cam.y = wf.y;
    cam.zoom = 0.8;
    clampCamera(cam, state, view);
  }
}
if (params.has('crash')) {
  startGame();
  const wreck = trafficAccident(state, () => true);
  if (wreck) {
    cam.x = wreck.x;
    cam.y = wreck.y;
    cam.zoom = 0.9;
    clampCamera(cam, state, view);
  }
}
if (params.has('pileup')) {
  startGame();
  pileUp(state, () => true);
  if (state.blockades[0]) {
    cam.x = state.blockades[0].x;
    cam.y = state.blockades[0].y;
    cam.zoom = 0.6;
    clampCamera(cam, state, view);
  }
}
if (params.has('heli')) {
  startGame();
  commandBuyVehicle(state, 'helicopter');
  commandBuyVehicle(state, 'command');
}
if (params.has('injured')) {
  // Two hurt people near the station, for looking at ambulances.
  startGame();
  const near = state.buildings.filter((b) => b.type !== 'station')
    .sort((a, b) => Math.hypot(a.x - 54, a.y - 47) - Math.hypot(b.x - 54, b.y - 47));
  for (const b of near.slice(0, 2)) spawnPatient(state, b, 0.6);
  cam.x = (near[0].x + near[0].w / 2) * TILE;
  cam.y = (near[0].y + near[0].h / 2) * TILE;
  cam.zoom = 1.1;
  clampCamera(cam, state, view);
}
if (params.has('station')) {
  startGame();
  toggleStation();
}
if (params.has('help')) toggleHelp();

