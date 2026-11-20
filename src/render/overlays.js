// Map overlays for the command layer: the route and ETA of the vehicles heading
// for the selected incident (or the selected vehicle), hazard and evacuation
// zones, collapsed buildings, support agencies on scene and the upgrades built
// at each station. Read-only: it draws from state and never changes it.

import { TILE } from '../core/config.js';
import { currentTarget, engineEta, formatEta } from '../systems/eta.js';

const ROUTE = 'rgba(111, 201, 255, 0.85)';

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
  ctx.arc(end.x, end.y, Math.max(3, 4 / Math.max(z, 0.3)), 0, Math.PI * 2);
  ctx.fill();
  const eta = engineEta(state, engine);
  if (eta != null && Number.isFinite(eta)) label(ctx, `${engine.name} ${formatEta(eta)}`, end.x, end.y - 10 / Math.max(z, 0.35), '#bfe9ff', z);
  ctx.restore();
}

/** Routes of the selected vehicle, or of everything heading for the selected incident. */
function drawRoutes(ctx, state, now, z) {
  const sel = state.selected;
  if (!sel) return;
  const drawn = new Set();
  if (sel.kind === 'unit') {
    const unit = state.units.find((u) => u.id === sel.id);
    const engine = unit?.kind === 'engine' ? unit : state.engines.find((e) => e.id === unit?.engineId);
    if (engine) {
      drawRoute(ctx, state, engine, now, z);
      drawn.add(engine.id);
    }
    return;
  }
  for (const e of state.engines) {
    const t = currentTarget(e);
    if (t && t.id === sel.id && !drawn.has(e.id)) drawRoute(ctx, state, e, now, z);
  }
}

function drawZones(ctx, state, now, z) {
  const pulse = 0.5 + 0.5 * Math.sin(now * 3);
  for (const h of state.hazards ?? []) {
    ctx.save();
    ctx.fillStyle = `rgba(224, 190, 40, ${0.07 + 0.05 * pulse})`;
    ctx.strokeStyle = `rgba(232, 200, 60, ${0.55 + 0.25 * pulse})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 8]);
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    label(ctx, h.leak ? 'HAZARD — LEAK' : 'HAZARD — TOXIC SMOKE', h.x, h.y - h.radius - 8, '#f0d35a', z);
  }
  for (const zone of state.evac?.zones ?? []) {
    ctx.save();
    ctx.fillStyle = 'rgba(90, 160, 230, 0.06)';
    ctx.strokeStyle = 'rgba(120, 185, 245, 0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 9]);
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    label(ctx, `EVACUATION ${zone.total - zone.queue.length}/${zone.total}`, zone.x, zone.y - zone.radius - 8, '#9fd0ff', z);
  }
}

function drawCollapsed(ctx, state, now, z) {
  for (const b of state.buildings) {
    if (!b.collapse) continue;
    const x = b.x * TILE;
    const y = b.y * TILE;
    const w = b.w * TILE;
    const h = b.h * TILE;
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
    ctx.restore();
    const done = 1 - (b.trapped ?? 0) / Math.max(1, b.collapse.initial);
    label(ctx, `COLLAPSE · ${b.trapped} buried`, x + w / 2, y - 6, '#f2c776', z);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y + h + 4, w, 5);
    ctx.fillStyle = '#7fd69a';
    ctx.fillRect(x, y + h + 4, w * Math.max(0, Math.min(1, done)), 5);
  }
}

const AGENCY_COLOR = {
  police: '#6e8cff', ems: '#ff7b7b', civil: '#7fe0a0', utility: '#ffd05a', coastguard: '#5ad0ff',
};

function drawSupport(ctx, state, now, z) {
  for (const s of state.support?.active ?? []) {
    const arrived = state.time >= s.arriveAt;
    const color = AGENCY_COLOR[s.agency] ?? '#ffffff';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = arrived ? 0.8 : 0.4;
    ctx.lineWidth = 2;
    ctx.setLineDash(arrived ? [] : [6, 6]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    const name = { police: 'POLICE', ems: 'EMS', civil: 'CIVIL PROTECTION', utility: 'UTILITIES', coastguard: 'COAST GUARD' }[s.agency];
    label(ctx, arrived ? `${name} ON SCENE` : `${name} · ${Math.ceil(s.arriveAt - state.time)} s`, s.x, s.y + s.radius + 14, color, z);
  }
  for (const b of state.buildings) {
    if (!b.utilityCut || b.state === 'rubble') continue;
    label(ctx, 'GAS + POWER OFF', (b.x + b.w / 2) * TILE, (b.y + b.h) * TILE + 14, '#ffd05a', z);
  }
}

const UPGRADE_STYLE = {
  garage: ['G', '#c9a24a'], training: ['T', '#6bb8d8'], medical: ['M', '#e06b6b'], workshop: ['W', '#9aa7b4'],
  comms: ['C', '#a98bf0'], storage: ['S', '#7fd69a'], tower: ['F', '#ff9c4a'],
};

/** Each upgrade built at a station shows as a small tagged block beside it; a fire watch tower stands up. */
function drawStationUpgrades(ctx, state, z) {
  if (state.mode !== 'career') return;
  state.city.stations.forEach((st, i) => {
    const ups = state.campaign.stations?.[i]?.upgrades;
    if (!ups || !state.ownedStations[i] || st.sea) return;
    const b = st.building;
    let x = (b.x + b.w) * TILE + 6;
    const y = (b.y + b.h) * TILE - 18;
    for (const [key, [letter, color]] of Object.entries(UPGRADE_STYLE)) {
      const level = ups[key] ?? 0;
      if (!level) continue;
      if (key === 'tower') {
        // A lattice mast with a lookout cab.
        ctx.fillStyle = '#4d4338';
        ctx.fillRect(x + 6, y - 26 - level * 6, 4, 26 + level * 6);
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 34 - level * 6, 16, 9);
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
        ctx.fillStyle = '#10161b';
        ctx.fillRect(x + 2 + k * 4, y + 17, 3, 3);
      }
      x += 20;
    }
  });
}

export function drawCommandOverlays(ctx, state, now, z) {
  drawCollapsed(ctx, state, now, z);
  drawZones(ctx, state, now, z);
  drawSupport(ctx, state, now, z);
  drawStationUpgrades(ctx, state, z);
  drawRoutes(ctx, state, now, z);
}

