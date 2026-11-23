// Map overlays for the command layer: routes with ETAs, incident rings, hazard and
// evacuation zones, collapse animations, support agencies on scene and the
// upgrades built at each station. Read-only: it draws from state and never changes
// it. Everything is culled to the visible tiles and animated from the clock, so
// there is no per-effect state to keep and an off-screen incident costs nothing.

import { TILE } from '../core/config.js';
import { currentTarget, engineEta, formatEta } from '../systems/eta.js';

const ROUTE = 'rgba(111, 201, 255, 0.85)';
const TAU = Math.PI * 2;

const inView = (b, x, y, w, h, pad = 0) => !b || (
  x + w >= (b.x0 - pad) * TILE && x <= (b.x1 + 1 + pad) * TILE && y + h >= (b.y0 - pad) * TILE && y <= (b.y1 + 1 + pad) * TILE);

function label(ctx, text, x, y, color, z) {
  const size = Math.max(9, 12 / Math.max(z, 0.35));
  ctx.font = `700 ${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = size / 4;
  ctx.strokeStyle = 'rgba(8, 12, 16, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// ------------------------------------------------------------------ routes ---

function drawRoute(ctx, state, engine, now, z) {
  if (engine.path.length === 0) return;
  ctx.save();
  ctx.strokeStyle = ROUTE;
  ctx.lineWidth = Math.max(2, 3 / Math.max(z, 0.3));
  ctx.setLineDash([10, 8]);
  ctx.lineDashOffset = -now * 18;
  ctx.beginPath();
  ctx.moveTo(engine.x, engine.y);
  for (const p of engine.path) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const end = engine.path[engine.path.length - 1];
  ctx.fillStyle = ROUTE;
  ctx.beginPath();
  ctx.arc(end.x, end.y, Math.max(3, 4 / Math.max(z, 0.3)), 0, TAU);
  ctx.fill();
  const eta = engineEta(state, engine);
  if (eta != null && Number.isFinite(eta)) label(ctx, `${engine.name} ${formatEta(eta)}`, end.x, end.y - 10 / Math.max(z, 0.35), '#bfe9ff', z);
  ctx.restore();
}

/** Routes of the selected vehicle, or of everything heading for the selected incident. */
function drawRoutes(ctx, state, now, z) {
  const sel = state.selected;
  if (!sel) return;
  if (sel.kind === 'unit') {
    const unit = state.units.find((u) => u.id === sel.id);
    const engine = unit?.kind === 'engine' ? unit : state.engines.find((e) => e.id === unit?.engineId);
    if (engine) drawRoute(ctx, state, engine, now, z);
    return;
  }
  for (const e of state.engines) {
    const t = currentTarget(e);
    if (t && t.id === sel.id) drawRoute(ctx, state, e, now, z);
  }
}

// --------------------------------------------------------- incident rings ---

const RING = { fire: '255, 120, 40', rescue: '110, 175, 255', hazmat: '235, 205, 60', collapse: '210, 160, 90' };

/**
 * A slow pulsing ring on the ground under every open building incident, coloured by
 * what it is, so a crowded map reads at a glance. A ring that is answered (a vehicle
 * within reach) calms to a thin steady line.
 */
function drawIncidentRings(ctx, state, now, z, bounds) {
  for (const b of state.buildings) {
    const burning = b.state === 'burning';
    const kind = b.collapse ? 'collapse' : burning ? 'fire' : (b.leak ?? 0) > 0 ? 'hazmat' : (b.trapped ?? 0) > 0 ? 'rescue' : null;
    if (!kind) continue;
    const x = b.x * TILE;
    const y = b.y * TILE;
    const w = b.w * TILE;
    const h = b.h * TILE;
    if (!inView(bounds, x, y, w, h, 3)) continue;
    const answered = state.engines.some((e) => e.targetId === b.id && e.arrived);
    const phase = (now * (answered ? 0.5 : 1.4) + b.x * 0.13) % 1;
    const r = Math.max(w, h) * 0.5 + 10 + (answered ? 0 : phase * 22);
    ctx.strokeStyle = `rgba(${RING[kind]}, ${answered ? 0.35 : 0.6 * (1 - phase)})`;
    ctx.lineWidth = Math.max(1.5, 2.5 / Math.max(z, 0.3));
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2 + 4, r * 1.12, r * 0.8, 0, 0, TAU);
    ctx.stroke();
  }
}

// ---------------------------------------------------------- hazards, zones ---

function drawHazards(ctx, state, now, z) {
  const pulse = 0.5 + 0.5 * Math.sin(now * 3);
  for (const h of state.hazards ?? []) {
    ctx.save();
    ctx.fillStyle = `rgba(224, 190, 40, ${0.07 + 0.05 * pulse})`;
    ctx.strokeStyle = `rgba(232, 200, 60, ${0.55 + 0.25 * pulse})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 8]);
    ctx.lineDashOffset = now * 6;
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.radius, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    label(ctx, h.leak ? 'HAZARD — LEAK' : 'HAZARD — TOXIC SMOKE', h.x, h.y - h.radius - 8, '#f0d35a', z);
  }
}

/**
 * An evacuation: dashes marching round the zone, a progress arc, the buildings still to
 * clear outlined and the cleared ones tinted with a tick, and a line to the shelter.
 */
function drawEvacuation(ctx, state, now, z, bounds) {
  for (const zone of state.evac?.zones ?? []) {
    const done = zone.total === 0 ? 1 : (zone.total - zone.queue.length) / zone.total;
    ctx.save();
    ctx.fillStyle = 'rgba(90, 160, 230, 0.06)';
    ctx.strokeStyle = 'rgba(120, 185, 245, 0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 9]);
    ctx.lineDashOffset = -now * 14;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(140, 230, 170, 0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius + 7, -Math.PI / 2, -Math.PI / 2 + TAU * done);
    ctx.stroke();
    ctx.restore();

    const queued = new Set(zone.queue);
    for (const b of state.buildings) {
      const clear = b.evacZone === zone.id;
      if (!clear && !queued.has(b.id)) continue;
      const x = b.x * TILE;
      const y = b.y * TILE;
      const w = b.w * TILE;
      const h = b.h * TILE;
      if (!inView(bounds, x, y, w, h)) continue;
      if (clear) {
        ctx.fillStyle = 'rgba(95, 150, 230, 0.2)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(160, 235, 185, 0.95)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x + w * 0.38, y + h * 0.52);
        ctx.lineTo(x + w * 0.48, y + h * 0.64);
        ctx.lineTo(x + w * 0.66, y + h * 0.36);
        ctx.stroke();
      } else {
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.lineDashOffset = -now * 10;
        ctx.strokeStyle = 'rgba(255, 215, 110, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.restore();
      }
    }

    const shelter = zone.shelter ? state.buildings.find((b) => b.id === zone.shelter.buildingId) : null;
    if (shelter) {
      const sx = (shelter.x + shelter.w / 2) * TILE;
      const sy = (shelter.y + shelter.h / 2) * TILE;
      ctx.save();
      ctx.strokeStyle = 'rgba(140, 230, 170, 0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 10]);
      ctx.lineDashOffset = -now * 24;
      ctx.beginPath();
      ctx.moveTo(zone.x, zone.y);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.restore();
      label(ctx, `SHELTER ${zone.shelter.sheltered}`, sx, sy - (shelter.h * TILE) / 2 - 8, '#9ff0bd', z);
    }
    label(ctx, `EVACUATION ${zone.total - zone.queue.length}/${zone.total}`, zone.x, zone.y - zone.radius - 16, '#9fd0ff', z);
  }
}

// ---------------------------------------------------------------- collapse ---

const DUST_TIME = 3; // seconds of the big collapse cloud

/**
 * A collapsed building: a flash and an expanding dust cloud with falling debris for the
 * first few seconds (drawn from the building's age, so it plays for whoever is looking),
 * then cracked rubble hatching and a few drifting puffs for as long as people are buried.
 */
function drawCollapsed(ctx, state, now, z, bounds) {
  for (const b of state.buildings) {
    const c = b.collapse;
    if (!c) continue;
    const x = b.x * TILE;
    const y = b.y * TILE;
    const w = b.w * TILE;
    const h = b.h * TILE;
    if (!inView(bounds, x - w, y - h, w * 3, h * 3)) continue;
    const age = Math.max(0, now - c.at);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y - b.elevation * 0.25, w, h + b.elevation * 0.25);
    ctx.clip();
    ctx.fillStyle = 'rgba(70, 58, 48, 0.55)';
    ctx.fillRect(x, y - b.elevation, w, h + b.elevation);
    ctx.strokeStyle = 'rgba(214, 170, 90, 0.8)';
    ctx.lineWidth = 3;
    for (let k = -h; k < w + h; k += 14) {
      ctx.beginPath();
      ctx.moveTo(x + k, y + h);
      ctx.lineTo(x + k + h, y);
      ctx.stroke();
    }
    if (age < 0.5) {
      ctx.fillStyle = `rgba(255, 245, 225, ${0.7 * (1 - age / 0.5)})`;
      ctx.fillRect(x, y - b.elevation, w, h + b.elevation);
    }
    ctx.restore();

    const cx = x + w / 2;
    const cy = y + h / 2;
    if (age < DUST_TIME) {
      const k = age / DUST_TIME;
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7 + b.x;
        const r = (0.35 + 0.8 * k) * Math.max(w, h) * (0.55 + 0.2 * i);
        ctx.fillStyle = `rgba(150, 135, 118, ${0.34 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * w * 0.25 * k, cy - h * 0.25 * k + Math.sin(a) * h * 0.2, r, 0, TAU);
        ctx.fill();
      }
      // Chunks falling out of the cloud.
      ctx.fillStyle = 'rgba(92, 78, 66, 0.9)';
      for (let i = 0; i < 9; i++) {
        const px = x + ((i * 0.618 + b.y * 0.07) % 1) * w;
        const fall = k * (0.4 + (i % 3) * 0.3) * (h + b.elevation);
        ctx.fillRect(px, y - b.elevation + fall, 4, 4);
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const p = (now * 0.18 + i / 3 + b.x * 0.1) % 1;
        ctx.fillStyle = `rgba(150, 140, 128, ${0.28 * (1 - p)})`;
        ctx.beginPath();
        ctx.arc(cx + Math.sin(now * 0.7 + i * 2) * w * 0.2, cy - p * (h + b.elevation) * 0.8, Math.max(w, h) * (0.16 + 0.14 * p), 0, TAU);
        ctx.fill();
      }
    }

    label(ctx, `COLLAPSE · ${b.trapped} buried`, cx, y - 6, '#f2c776', z);
    const done = 1 - (b.trapped ?? 0) / Math.max(1, c.initial);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y + h + 4, w, 5);
    ctx.fillStyle = '#7fd69a';
    ctx.fillRect(x, y + h + 4, w * Math.max(0, Math.min(1, done)), 5);
  }
}

// ------------------------------------------------------------------ support ---

const AGENCY_COLOR = {
  police: '#6e8cff', ems: '#ff7b7b', civil: '#7fe0a0', utility: '#ffd05a', coastguard: '#5ad0ff',
};
const AGENCY_NAME = { police: 'POLICE', ems: 'EMS', civil: 'CIVIL PROTECTION', utility: 'UTILITIES', coastguard: 'COAST GUARD' };

function drawSupport(ctx, state, now, z, bounds) {
  for (const s of state.support?.active ?? []) {
    if (!inView(bounds, s.x - s.radius, s.y - s.radius, s.radius * 2, s.radius * 2)) continue;
    const arrived = state.time >= s.arriveAt;
    const color = AGENCY_COLOR[s.agency] ?? '#ffffff';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = arrived ? 0.8 : 0.4;
    ctx.lineWidth = 2;
    ctx.setLineDash(arrived ? [] : [6, 6]);
    ctx.lineDashOffset = -now * 12;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.radius, 0, TAU);
    ctx.stroke();
    ctx.restore();
    // A flashing light bar on the spot where they are working.
    if (arrived) {
      const on = Math.floor(now * 4) % 2 === 0;
      ctx.fillStyle = on ? color : '#ffffff';
      ctx.globalAlpha = 0.9;
      ctx.fillRect(s.x - 10, s.y - 3, 8, 6);
      ctx.fillStyle = on ? '#ffffff' : color;
      ctx.fillRect(s.x + 2, s.y - 3, 8, 6);
      ctx.globalAlpha = 1;
    }
    label(ctx, arrived ? `${AGENCY_NAME[s.agency]} ON SCENE` : `${AGENCY_NAME[s.agency]} · ${Math.ceil(s.arriveAt - state.time)} s`, s.x, s.y + s.radius + 14, color, z);
  }
  for (const b of state.buildings) {
    if (!b.utilityCut || b.state === 'rubble') continue;
    if (!inView(bounds, b.x * TILE, b.y * TILE, b.w * TILE, b.h * TILE)) continue;
    label(ctx, 'GAS + POWER OFF', (b.x + b.w / 2) * TILE, (b.y + b.h) * TILE + 14, '#ffd05a', z);
  }
}

// ---------------------------------------------------------------- stations ---

const UPGRADE_STYLE = {
  garage: ['G', '#c9a24a'], training: ['T', '#6bb8d8'], medical: ['M', '#e06b6b'], workshop: ['W', '#9aa7b4'],
  comms: ['C', '#a98bf0'], storage: ['S', '#7fd69a'], tower: ['F', '#ff9c4a'],
};

/**
 * Each upgrade built at a station is a tagged block beside it with pips for its level;
 * a plate over the station gives its overall level. The fire watch tower stands up
 * with a blinking beacon, and the communication centre has an antenna that pulses.
 */
function drawStationUpgrades(ctx, state, now, z, bounds) {
  if (state.mode !== 'career') return;
  state.city.stations.forEach((st, i) => {
    const ups = state.campaign.stations?.[i]?.upgrades;
    if (!ups || !state.ownedStations[i] || st.sea) return;
    const b = st.building;
    if (!inView(bounds, b.x * TILE, b.y * TILE, (b.w + 8) * TILE, b.h * TILE, 4)) return;
    const total = Object.values(ups).reduce((a, c) => a + c, 0);
    if (total === 0) return;
    label(ctx, `LEVEL ${1 + total}`, (b.x + b.w / 2) * TILE, b.y * TILE - 14 - b.elevation, '#ffd27a', z);

    let x = (b.x + b.w) * TILE + 6;
    const y = (b.y + b.h) * TILE - 18;
    for (const [key, [letter, color]] of Object.entries(UPGRADE_STYLE)) {
      const level = ups[key] ?? 0;
      if (!level) continue;
      if (key === 'tower') {
        ctx.fillStyle = '#4d4338';
        ctx.fillRect(x + 6, y - 26 - level * 6, 4, 26 + level * 6);
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 34 - level * 6, 16, 9);
        const blink = Math.floor(now * 1.5) % 2 === 0;
        ctx.fillStyle = blink ? '#ff4a3a' : '#5a1a14';
        ctx.beginPath();
        ctx.arc(x + 8, y - 38 - level * 6, 3, 0, TAU);
        ctx.fill();
      } else if (key === 'comms') {
        ctx.fillStyle = '#4d4a58';
        ctx.fillRect(x + 7, y - 20, 2, 20);
        for (let r = 0; r < 2; r++) {
          const p = (now * 0.8 + r * 0.5) % 1;
          ctx.strokeStyle = `rgba(190, 160, 255, ${0.8 * (1 - p)})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x + 8, y - 20, 4 + p * 14, 0, TAU);
          ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(14, 18, 22, 0.9)';
      ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, y + 1, 14, 14);
      ctx.fillStyle = '#10161b';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(letter, x + 8, y + 12);
      for (let k = 0; k < level; k++) {
        ctx.fillStyle = '#ffd27a';
        ctx.fillRect(x + 2 + k * 4, y + 17, 3, 3);
      }
      x += 20;
    }
  });
}

/** Everything the command layer adds to the map, back to front. `bounds` is the visible tile rectangle. */
export function drawCommandOverlays(ctx, state, now, z, bounds = null) {
  drawIncidentRings(ctx, state, now, z, bounds);
  drawCollapsed(ctx, state, now, z, bounds);
  drawHazards(ctx, state, now, z);
  drawEvacuation(ctx, state, now, z, bounds);
  drawSupport(ctx, state, now, z, bounds);
  drawStationUpgrades(ctx, state, now, z, bounds);
  drawRoutes(ctx, state, now, z);
}
