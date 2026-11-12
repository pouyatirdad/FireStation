// The city is drawn to a canvas in a shallow 2.5D: footprints on the ground,
// roofs lifted north by the building's height, south walls in between. Units and
// buildings share one painter's list sorted by where they meet the ground, so a
// engine parked on the avenue is correctly hidden by the block in front of it.

import { CONFIG, TILE } from '../core/config.js';
import { clamp } from '../core/math.js';
import { buildingRect } from '../systems/fire.js';
import {
  V_ROADS, H_ROADS, APRON, SEA_Y, RIVER_HALF_WIDTH, riverCentre,
} from '../data/city.js';

const PALETTE = {
  sidewalk: '#a3a49f',
  sidewalkJoint: 'rgba(40,40,38,0.16)',
  park: '#586b40',
  parkEdge: '#4d5f38',
  road: '#36393c',
  apron: '#6d7073',
  marking: 'rgba(226,226,218,0.75)',
  centre: '#d4a62a',
  crosswalk: 'rgba(232,232,226,0.62)',
  shadow: 'rgba(12,17,22,0.22)',
  select: '#5fd0ff',
  fire: '#ff7a1f',
};

// Speckled tiles for asphalt, concrete and grass, painted once and repeated, so
// large flat areas read as material instead of flat colour.
const textures = {};
function texture(ctx, name, base, speckles) {
  if (textures[name] !== undefined) return textures[name];
  textures[name] = base;
  if (typeof document === 'undefined') return base;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const t = c.getContext('2d');
  t.fillStyle = base;
  t.fillRect(0, 0, 128, 128);
  let s = 12345 + name.length * 977;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < speckles; i++) {
    const light = rnd() < 0.5;
    t.fillStyle = light ? `rgba(255,255,255,${0.03 + rnd() * 0.07})` : `rgba(0,0,0,${0.04 + rnd() * 0.1})`;
    const sz = rnd() < 0.85 ? 1 : 2;
    t.fillRect((rnd() * 128) | 0, (rnd() * 128) | 0, sz, sz);
  }
  textures[name] = ctx.createPattern(c, 'repeat') ?? base;
  return textures[name];
}

// --------------------------------------------------------------- helpers ---

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296 * 1000;
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amount >= 0) {
    r += (255 - r) * amount;
    g += (255 - g) * amount;
    b += (255 - b) * amount;
  } else {
    r *= 1 + amount;
    g *= 1 + amount;
    b *= 1 + amount;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function rr(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function visibleTiles(cam, view) {
  const halfW = view.width / (2 * cam.zoom);
  const halfH = view.height / (2 * cam.zoom);
  return {
    x0: Math.max(0, Math.floor((cam.x - halfW) / TILE) - 1),
    y0: Math.max(0, Math.floor((cam.y - halfH) / TILE) - 1),
    x1: Math.min(cityW - 1, Math.floor((cam.x + halfW) / TILE) + 1),
    y1: Math.min(cityH - 1, Math.floor((cam.y + halfH) / TILE) + 1),
  };
}
// These two are replaced by the closure keeping the city size; kept simple by
// storing the current city on the module while rendering.
let cityW = 60;
let cityH = 40;

export function screenToWorld(cam, sx, sy, view) {
  return {
    x: (sx - view.width / 2) / cam.zoom + cam.x,
    y: (sy - view.height / 2) / cam.zoom + cam.y,
  };
}

export function worldToScreen(cam, wx, wy, view) {
  return {
    x: (wx - cam.x) * cam.zoom + view.width / 2,
    y: (wy - cam.y) * cam.zoom + view.height / 2,
  };
}

export function createCamera(state) {
  cityW = state.city.w;
  cityH = state.city.h;
  const spawn = state.city.spawn;
  return { x: spawn.x, y: spawn.y - 90, zoom: CONFIG.camera.startZoom };
}

export function clampCamera(cam, state, view) {
  const worldW = state.city.w * TILE;
  const worldH = state.city.h * TILE;
  const halfW = view.width / (2 * cam.zoom);
  const halfH = view.height / (2 * cam.zoom);
  const margin = CONFIG.camera.margin * TILE;

  if (worldW + margin * 2 < halfW * 2) cam.x = worldW / 2;
  else cam.x = clamp(cam.x, halfW - margin, worldW - halfW + margin);

  if (worldH + margin * 2 < halfH * 2) cam.y = worldH / 2;
  else cam.y = clamp(cam.y, halfH - margin, worldH - halfH + margin);
}

// ------------------------------------------------------------------ main ---

export function render(ctx, state, cam, view, opts = {}) {
  const { dpr, width: W, height: H } = view;
  const now = opts.now ?? state.time;
  cityW = state.city.w;
  cityH = state.city.h;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#181c21';
  ctx.fillRect(0, 0, W, H);

  const z = cam.zoom;
  const bounds = visibleTiles(cam, view);

  ctx.save();
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));

  // Ground beyond the city edge, so the map never floats in a black void.
  const halfW = W / (2 * z);
  const halfH = H / (2 * z);
  ctx.fillStyle = '#1c241d';
  ctx.fillRect(cam.x - halfW - 64, cam.y - halfH - 64, halfW * 2 + 128, halfH * 2 + 128);

  drawGround(ctx, state, bounds, z);
  drawBuildingShadows(ctx, state, bounds);
  drawHoses(ctx, state, now);
  drawEntities(ctx, state, bounds, now, z);
  drawWildfires(ctx, state, now, z);
  drawDistrictLabels(ctx, state, z);
  drawStreams(ctx, state, now);
  drawParticles(ctx, state);
  drawWorldSelection(ctx, state, now, z);

  ctx.restore();

  drawNight(ctx, state, W, H);
  drawFloatingBars(ctx, state, cam, view);
  drawHydrantPrompt(ctx, state, cam, view);
  drawSelectedLabel(ctx, state, cam, view);
  drawOffscreenAlarms(ctx, state, cam, view, now);
  drawOffscreenPatients(ctx, state, cam, view, now);
  drawOffscreenWrecks(ctx, state, cam, view, now);
  drawOffscreenVictims(ctx, state, cam, view, now);
  drawMinimap(ctx, state, cam, view);
  drawVignette(ctx, W, H);
}

// ------------------------------------------------------------- daylight ---

/**
 * 0 in full daylight, 1 at night. Dusk runs 18:00–21:00 and dawn 05:00–07:00,
 * so a shift that starts at 07:00 begins in full light and reaches night after
 * about eleven game hours.
 */
export function daylight(clockMinutes) {
  const h = (((clockMinutes / 60) % 24) + 24) % 24;
  if (h >= 7 && h < 18) return 0;
  if (h >= 18 && h < 21) return (h - 18) / 3;
  if (h >= 21 || h < 5) return 1;
  return 1 - (h - 5) / 2;
}

function drawNight(ctx, state, W, H) {
  const dark = daylight(state.clock);
  if (dark <= 0.01) return;
  ctx.fillStyle = `rgba(8,16,46,${0.46 * dark})`;
  ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------- ground ---

function inBounds(b, x, y) {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

function drawGround(ctx, state, b, z) {
  const city = state.city;
  const left = b.x0 * TILE;
  const top = b.y0 * TILE;
  const width = (b.x1 - b.x0 + 1) * TILE;
  const height = (b.y1 - b.y0 + 1) * TILE;
  // The city has 17 avenues and 16 streets; only paint the ones in view.
  const vr = V_ROADS.filter((vx) => vx + 2 >= b.x0 && vx <= b.x1 + 1);
  const hr = H_ROADS.filter((hy) => hy + 2 >= b.y0 && hy <= b.y1 + 1);

  const concrete = texture(ctx, 'concrete', PALETTE.sidewalk, 900);
  const asphalt = texture(ctx, 'asphalt', PALETTE.road, 1800);
  const grass = texture(ctx, 'grass', PALETTE.park, 1400);
  ctx.fillStyle = concrete;
  ctx.fillRect(left, top, width, height);

  // Grass under the blocks, then the streets on top of it.
  ctx.fillStyle = '#2f4226';
  for (const area of city.forestAreas ?? []) {
    ctx.fillRect(
      area.x0 * TILE,
      area.y0 * TILE,
      (area.x1 - area.x0 + 1) * TILE,
      (area.y1 - area.y0 + 1) * TILE,
    );
  }
  ctx.fillStyle = grass;
  for (const p of city.parks) {
    ctx.fillRect(
      p.x0 * TILE,
      p.y0 * TILE,
      (p.x1 - p.x0 + 1) * TILE,
      (p.y1 - p.y0 + 1) * TILE,
    );
  }

  // Sidewalk joints — only worth drawing when they are a pixel apart.
  if (z >= 0.8) {
    ctx.beginPath();
    ctx.strokeStyle = PALETTE.sidewalkJoint;
    ctx.lineWidth = 1;
    for (let x = b.x0; x <= b.x1 + 1; x++) {
      ctx.moveTo(x * TILE, top);
      ctx.lineTo(x * TILE, top + height);
    }
    for (let y = b.y0; y <= b.y1 + 1; y++) {
      ctx.moveTo(left, y * TILE);
      ctx.lineTo(left + width, y * TILE);
    }
    ctx.stroke();
  }

  drawWater(ctx, state, b, z);

  // Streets stop at the quay.
  const roadH = Math.max(0, Math.min(top + height, SEA_Y * TILE) - top);
  ctx.fillStyle = asphalt;
  for (const vx of vr) ctx.fillRect(vx * TILE, top, 2 * TILE, roadH);
  for (const hy of hr) ctx.fillRect(left, hy * TILE, width, 2 * TILE);

  // Kerbs: a pale lip and a dark gutter line along both sides of every street.
  if (z >= 0.5) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(20,20,20,0.35)';
    ctx.beginPath();
    for (const vx of vr) {
      ctx.moveTo(vx * TILE + 1, top); ctx.lineTo(vx * TILE + 1, top + roadH);
      ctx.moveTo((vx + 2) * TILE - 1, top); ctx.lineTo((vx + 2) * TILE - 1, top + roadH);
    }
    for (const hy of hr) {
      ctx.moveTo(left, hy * TILE + 1); ctx.lineTo(left + width, hy * TILE + 1);
      ctx.moveTo(left, (hy + 2) * TILE - 1); ctx.lineTo(left + width, (hy + 2) * TILE - 1);
    }
    ctx.stroke();
  }

  // Double yellow centre lines, then intersections painted back over them so
  // the lines stop at the junction like they should.
  if (z >= 0.5) {
    ctx.strokeStyle = PALETTE.centre;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const vx of vr) {
      const x = (vx + 1) * TILE;
      ctx.moveTo(x - 2, top); ctx.lineTo(x - 2, top + roadH);
      ctx.moveTo(x + 2, top); ctx.lineTo(x + 2, top + roadH);
    }
    for (const hy of hr) {
      const y = (hy + 1) * TILE;
      ctx.moveTo(left, y - 2); ctx.lineTo(left + width, y - 2);
      ctx.moveTo(left, y + 2); ctx.lineTo(left + width, y + 2);
    }
    ctx.stroke();
  }

  ctx.fillStyle = asphalt;
  for (const vx of vr) {
    for (const hy of hr) {
      ctx.fillRect(vx * TILE, hy * TILE, 2 * TILE, 2 * TILE);
    }
  }

  if (z >= 0.7) {
    for (const vx of vr) {
      for (const hy of hr) drawCrosswalks(ctx, vx * TILE, hy * TILE);
    }
  }

  // The station apron and its parking bays.
  for (const st of city.stations ?? [{ apron: APRON }]) {
    const a = st.apron;
    if (a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1) continue;
    ctx.fillStyle = PALETTE.apron;
    ctx.fillRect(a.x0 * TILE, a.y0 * TILE, (a.x1 - a.x0 + 1) * TILE, (a.y1 - a.y0 + 1) * TILE);
    ctx.strokeStyle = 'rgba(232,200,90,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 1; i <= 3; i++) {
      const x = (a.x0 + i * 2.4) * TILE;
      ctx.moveTo(x, a.y0 * TILE + 8);
      ctx.lineTo(x, (a.y1 + 1) * TILE - 6);
    }
    ctx.stroke();
  }

  // The staff car park beside the station.
  if (city.lot) {
    const lot = city.lot;
    ctx.fillStyle = '#7d858d';
    ctx.fillRect(
      lot.x0 * TILE,
      lot.y0 * TILE,
      (lot.x1 - lot.x0 + 1) * TILE,
      (lot.y1 - lot.y0 + 1) * TILE,
    );
    ctx.strokeStyle = 'rgba(232,232,226,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const x = (lot.x0 + 1 + i * 1.45) * TILE;
      ctx.moveTo(x, (lot.y0 + 1.2) * TILE);
      ctx.lineTo(x, (lot.y0 + 4.8) * TILE);
    }
    ctx.stroke();
  }

  // Trees and hydrants sit on the ground, in front of the streets.
  for (const tree of z < 0.16 ? [] : city.trees) {
    if (tree.x < left - 40 || tree.x > left + width + 40) continue;
    if (tree.y < top - 40 || tree.y > top + height + 40) continue;
    drawTree(ctx, tree, z);
  }
  for (const h of z < 0.3 ? [] : city.hydrants) {
    if (!inBounds(b, h.x, h.y)) continue;
    drawHydrant(ctx, (h.x + 0.5) * TILE, (h.y + 0.5) * TILE, z);
  }
  for (const car of z < 0.3 ? [] : city.cars) {
    if (car.x < left - 50 || car.x > left + width + 50) continue;
    if (car.y < top - 50 || car.y > top + height + 50) continue;
    drawCar(ctx, car);
  }
  // Moving traffic, which queues behind a blockade.
  for (const car of z < 0.3 ? [] : state.traffic?.cars ?? []) {
    if (car.x < left - 50 || car.x > left + width + 50) continue;
    if (car.y < top - 50 || car.y > top + height + 50) continue;
    drawCar(ctx, car);
    if (car.v < 8 && z >= 0.6) {
      // Brake lights on a car that is stopped in a jam.
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(car.angle);
      ctx.fillStyle = 'rgba(255,60,50,0.9)';
      ctx.fillRect(-21, -6, 3, 4);
      ctx.fillRect(-21, 2, 3, 4);
      ctx.restore();
    }
  }
}

// The sea along the south, the river down the east, bridge rails where a street
// crosses it, and the dock's jetties. Water is the one thing drawn row by row:
// a few hundred fillRects at most.
function drawWater(ctx, state, b, z) {
  const city = state.city;
  const left = b.x0 * TILE;
  const right = (b.x1 + 1) * TILE;

  // Sea.
  if (b.y1 >= SEA_Y) {
    const y0 = Math.max(b.y0, SEA_Y) * TILE;
    const y1 = (b.y1 + 1) * TILE;
    ctx.fillStyle = '#2f5f73';
    ctx.fillRect(left, y0, right - left, y1 - y0);
    ctx.fillStyle = '#244d60';
    ctx.fillRect(left, Math.max(y0, (SEA_Y + 10) * TILE), right - left, Math.max(0, y1 - Math.max(y0, (SEA_Y + 10) * TILE)));
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(left, SEA_Y * TILE, right - left, 3); // the foam line on the quay
  }

  // River: one span per row of tiles.
  const rowTop = Math.max(0, b.y0);
  const rowBottom = Math.min(SEA_Y - 1, b.y1);
  ctx.fillStyle = '#33697c';
  for (let y = rowTop; y <= rowBottom; y++) {
    const c = riverCentre(y + 0.5);
    ctx.fillRect((c - RIVER_HALF_WIDTH) * TILE, y * TILE, RIVER_HALF_WIDTH * 2 * TILE, TILE + 1);
  }
  if (z >= 0.35) {
    // Banks, and a few ripples so the water reads as moving.
    ctx.strokeStyle = 'rgba(15,35,50,0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let y = rowTop; y <= rowBottom; y++) {
      const c = riverCentre(y + 0.5);
      ctx.moveTo((c - RIVER_HALF_WIDTH) * TILE, y * TILE);
      ctx.lineTo((c - RIVER_HALF_WIDTH) * TILE, (y + 1) * TILE);
      ctx.moveTo((c + RIVER_HALF_WIDTH) * TILE, y * TILE);
      ctx.lineTo((c + RIVER_HALF_WIDTH) * TILE, (y + 1) * TILE);
    }
    ctx.stroke();
  }
  if (z >= 0.55) {
    const t = state.time;
    ctx.strokeStyle = 'rgba(210,235,250,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let y = rowTop; y <= rowBottom; y += 2) {
      const c = riverCentre(y + 0.5);
      const off = ((y * 7.3 + t * 0.9) % 6) - 3;
      ctx.moveTo((c + off - 1) * TILE, (y + 0.5) * TILE);
      ctx.lineTo((c + off + 1) * TILE, (y + 0.5) * TILE);
    }
    if (b.y1 >= SEA_Y) {
      for (let y = Math.max(SEA_Y + 2, b.y0); y <= b.y1; y += 3) {
        for (let x = b.x0 - (b.x0 % 5); x <= b.x1; x += 5) {
          const off = Math.sin(t * 0.8 + x * 0.5 + y) * 0.6;
          ctx.moveTo((x + off) * TILE, (y + 0.5) * TILE);
          ctx.lineTo((x + off + 1.2) * TILE, (y + 0.5) * TILE);
        }
      }
    }
    ctx.stroke();
  }

  // Bridges: the road is already drawn over the river; add the railings.
  if (z >= 0.3) {
    ctx.strokeStyle = '#c9ced3';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const hy of H_ROADS) {
      if (hy + 2 < b.y0 || hy > b.y1 + 1) continue;
      const c = riverCentre(hy + 1);
      const x0 = (c - RIVER_HALF_WIDTH - 0.5) * TILE;
      const x1 = (c + RIVER_HALF_WIDTH + 0.5) * TILE;
      ctx.moveTo(x0, hy * TILE + 2);
      ctx.lineTo(x1, hy * TILE + 2);
      ctx.moveTo(x0, (hy + 2) * TILE - 2);
      ctx.lineTo(x1, (hy + 2) * TILE - 2);
    }
    ctx.stroke();
  }

  // The harbour dock: a jetty beside every berth.
  const dock = city.stations?.[2];
  if (dock && z >= 0.3 && b.y1 >= SEA_Y - 2) {
    ctx.fillStyle = '#8a6a45';
    for (const berth of dock.bays) {
      ctx.fillRect(berth.x + 1.3 * TILE, SEA_Y * TILE, 7, 3.2 * TILE);
    }
    ctx.fillStyle = '#7a5d3b';
    ctx.fillRect(dock.bays[0].x - 1.2 * TILE, SEA_Y * TILE, (dock.bays.length * 3 + 0.4) * TILE, 5);
  }
}

function drawCar(ctx, car) {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.fillStyle = 'rgba(10,14,18,0.28)';
  ctx.beginPath();
  ctx.ellipse(2, 3, 14, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(car.angle);
  // Wheels peeking out, body, glasshouse with raked screens, bonnet highlight.
  ctx.fillStyle = '#15171a';
  ctx.fillRect(-15, -9.5, 8, 3); ctx.fillRect(7, -9.5, 8, 3);
  ctx.fillRect(-15, 6.5, 8, 3); ctx.fillRect(7, 6.5, 8, 3);
  ctx.fillStyle = shade(car.color, -0.18);
  rr(ctx, -20, -8, 40, 16, 4);
  ctx.fill();
  ctx.fillStyle = car.color;
  rr(ctx, -19, -7, 38, 14, 4);
  ctx.fill();
  ctx.fillStyle = '#1f2a33';
  ctx.beginPath();
  ctx.moveTo(10, -6); ctx.lineTo(10, 6); ctx.lineTo(6, 7); ctx.lineTo(-9, 7);
  ctx.lineTo(-11, 5.5); ctx.lineTo(-11, -5.5); ctx.lineTo(-9, -7); ctx.lineTo(6, -7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = car.color;
  rr(ctx, -6, -5.5, 11, 11, 2); // roof
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(11, -6, 7, 3);
  ctx.restore();
}

function drawCrosswalks(ctx, x, y) {
  ctx.fillStyle = PALETTE.crosswalk;
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(x + 7 + i * 14, y - 13, 7, 11);
    ctx.fillRect(x + 7 + i * 14, y + 2 * TILE + 2, 7, 11);
    ctx.fillRect(x - 13, y + 7 + i * 14, 11, 7);
    ctx.fillRect(x + 2 * TILE + 2, y + 7 + i * 14, 11, 7);
  }
}

// District names, only when the whole city is on screen. They are a map
// annotation, not UI: low contrast so they never fight the streets.
function drawDistrictLabels(ctx, state, z) {
  if (z > 0.7) return;
  const size = Math.max(22, Math.min(230, 14 / z));
  ctx.font = `800 ${Math.round(size)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const district of state.city.districts ?? []) {
    const label = district.name.split('').join(' ');
    ctx.fillStyle = 'rgba(10,14,18,0.18)';
    ctx.fillText(label, district.x + 2, district.y + 2);
    ctx.fillStyle = 'rgba(236,242,248,0.2)';
    ctx.fillText(label, district.x, district.y);
  }
}

function drawTree(ctx, tree, z) {
  // At map scale a tree is a dot; do not pay for three arcs and a shadow.
  if (z < 0.45) {
    ctx.fillStyle = tree.tone;
    ctx.beginPath();
    ctx.arc(tree.x, tree.y, tree.r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.fillStyle = 'rgba(20,30,20,0.22)';
  ctx.beginPath();
  ctx.ellipse(tree.x + 4, tree.y + 5, tree.r * 1.05, tree.r * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = shade(tree.tone, -0.25);
  ctx.beginPath();
  ctx.arc(tree.x, tree.y, tree.r, 0, Math.PI * 2);
  ctx.fill();
  // Foliage as a cluster of lobes, lit from the top-left.
  const lobes = [[-0.35, -0.3, 0.62], [0.4, -0.15, 0.55], [-0.1, 0.4, 0.55], [0.1, -0.1, 0.5]];
  lobes.forEach(([dx, dy, k], i) => {
    ctx.fillStyle = shade(tree.tone, -0.08 + i * 0.07);
    ctx.beginPath();
    ctx.arc(tree.x + dx * tree.r, tree.y + dy * tree.r, tree.r * k, 0, Math.PI * 2);
    ctx.fill();
  });
  if (z >= 1.1) {
    ctx.strokeStyle = 'rgba(20,40,20,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(tree.x, tree.y, tree.r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHydrant(ctx, x, y, z) {
  ctx.fillStyle = 'rgba(15,20,24,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 3, 5, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = z >= 1 ? '#d64535' : '#c94032';
  rr(ctx, x - 4, y - 5, 8, 10, 2);
  ctx.fill();
  ctx.fillStyle = '#e8dcc7';
  ctx.fillRect(x - 4, y - 5, 8, 2.5);
  ctx.fillStyle = '#b23a2c';
  ctx.fillRect(x - 6, y - 2, 12, 2);
}

// ------------------------------------------------------------- buildings ---

function buildingVisible(b, bounds) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  return (
    x + b.w * TILE > bounds.x0 * TILE - 40 &&
    x < (bounds.x1 + 1) * TILE + 40 &&
    y + b.h * TILE > bounds.y0 * TILE - 40 &&
    y - b.elevation < (bounds.y1 + 1) * TILE + 40
  );
}

function drawBuildingShadows(ctx, state, bounds) {
  for (const b of state.buildings) {
    if (b.state === 'rubble' || !buildingVisible(b, bounds)) continue;
    ctx.fillStyle = 'rgba(12,17,22,0.26)';
    ctx.fillRect(b.x * TILE + 12, b.y * TILE + 16, b.w * TILE, b.h * TILE);
  }
}

function drawEntities(ctx, state, bounds, now, z) {
  const list = [];
  for (const b of state.buildings) {
    if (!buildingVisible(b, bounds)) continue;
    list.push({ key: b.y * TILE + b.h * TILE, building: b });
  }
  for (const u of state.units) {
    if (u.kind === 'crew' && u.riding) continue;
    // Helicopters fly over everything.
    list.push({ key: u.spec?.flying ? u.y + 100000 : u.y + 12, unit: u });
  }
  for (const person of state.fleeing) {
    list.push({ key: person.y + 8, person });
  }
  for (const patient of state.patients ?? []) {
    list.push({ key: patient.y + 6, patient });
  }
  for (const blockade of state.blockades ?? []) {
    list.push({ key: blockade.y - 40, blockade });
  }
  for (const victim of state.victims ?? []) {
    list.push({ key: victim.y + 6, victim });
  }
  list.sort((a, b) => a.key - b.key);
  for (const item of list) {
    if (item.building) drawBuilding(ctx, state, item.building, now, z);
    else if (item.unit) drawUnit(ctx, item.unit, now, z);
    else if (item.patient) drawPatient(ctx, item.patient, now, z);
    else if (item.blockade) drawBlockade(ctx, item.blockade, now, z);
    else if (item.victim) drawVictim(ctx, item.victim, now);
    else drawCivilian(ctx, item.person, now);
  }
}

function drawBuilding(ctx, state, b, now, z) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  const e = b.elevation;

  if (b.state === 'rubble') {
    drawRubble(ctx, b);
    return;
  }

  const facadeTop = y + h - e;
  const detailed = z >= 0.55;

  // South wall: masonry, darker toward the pavement, with a cornice under the
  // roof so the two surfaces never blur into one another.
  ctx.fillStyle = shade(b.roofColor, -0.42);
  ctx.fillRect(x, facadeTop, w, e);
  if (detailed) {
    const wall = ctx.createLinearGradient(0, facadeTop, 0, facadeTop + e);
    wall.addColorStop(0, 'rgba(255,255,255,0.07)');
    wall.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = wall;
    ctx.fillRect(x, facadeTop, w, e);
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x, facadeTop + e * 0.66, w, e * 0.34);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(x, facadeTop, w, 2);

  if (detailed && b.type !== 'station') drawFacadeWindows(ctx, b, x, facadeTop, w, e);
  if (detailed && (b.trapped ?? 0) > 0 && b.state !== 'rubble') {
    drawTrapped(ctx, b, x, facadeTop, w, e, now);
  }

  // Roof. A light band on the north and west edges, a shadow on the south and
  // east, reads as sunlight from the top-left without a gradient per frame.
  ctx.fillStyle = b.roofColor;
  ctx.fillRect(x, y - e, w, h);
  if (detailed) {
    // Gravel / membrane roofing grain over the colour.
    ctx.fillStyle = texture(ctx, 'roof', 'rgba(0,0,0,0)', 1600);
    ctx.fillRect(x, y - e, w, h);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.11)';
  ctx.fillRect(x, y - e, w, 3);
  ctx.fillRect(x, y - e, 3, h);
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(x, y - e + h - 4, w, 4);
  ctx.fillRect(x + w - 4, y - e, 4, h);

  // Parapet line around the roof.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 2.5, y - e + 2.5, w - 5, h - 5);

  if (detailed) drawRoofDetails(ctx, b, x, y - e, w, h);
  if (b.type === 'pharmacy') drawPharmacyMark(ctx, x, y - e, w, h);
  if (b.type === 'hospital') drawHospitalMark(ctx, x, y - e, w, h, detailed);
  if (detailed && b.type === 'station') drawStationFace(
    ctx, b, x, facadeTop, w, e, z,
    (b.id === 'station2' && !state.ownedStations?.[1]) || (b.id === 'dock' && !state.ownedStations?.[2]),
  );

  if (b.state === 'burning') {
    if (b.integrity < b.maxIntegrity * 0.75) {
      const char = (1 - b.integrity / b.maxIntegrity) * 0.45;
      ctx.fillStyle = `rgba(24,20,17,${char})`;
      ctx.fillRect(x, y - e, w, h);
    }
    drawFire(ctx, b, now, z);
  } else if (b.state === 'out') {
    ctx.fillStyle = 'rgba(26,22,19,0.34)';
    ctx.fillRect(x, y - e, w, h);
    ctx.fillStyle = 'rgba(15,13,12,0.25)';
    ctx.fillRect(x, facadeTop, w, e);
  }
}

function drawFacadeWindows(ctx, b, x, y, w, h) {  const seed = hashString(b.id);
  const rows = Math.max(1, b.floors);
  const cols = Math.max(2, Math.round(w / 24));
  const cw = w / cols;
  const ch = h / rows;
  const ww = Math.max(3, cw * 0.5);
  const wh = Math.max(3, ch * 0.46);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = x + cw * (c + 0.5) - ww / 2;
      const wy = y + ch * (r + 0.54) - wh / 2;
      ctx.fillStyle = 'rgba(10,14,18,0.55)';
      ctx.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);

      const lit = hash(seed + r * 71 + c * 37) < 0.16;
      let color = lit ? '#f1d18d' : '#28313b';
      if (b.state === 'burning' && hash(seed + r * 19 + c * 53) < b.fire) color = '#ffb24a';
      ctx.fillStyle = color;
      ctx.fillRect(wx, wy, ww, wh);
      ctx.fillStyle = 'rgba(150,190,220,0.14)';
      ctx.beginPath(); // a diagonal glint across the glass
      ctx.moveTo(wx, wy + wh); ctx.lineTo(wx + ww * 0.55, wy); ctx.lineTo(wx + ww, wy); ctx.lineTo(wx + ww * 0.45, wy + wh);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(210,210,200,0.35)'; // sill
      ctx.fillRect(wx - 1, wy + wh + 1, ww + 2, 1);
    }
  }
}

function drawTrapped(ctx, b, x, y, w, h, now) {
  const count = Math.min(b.trapped, 3);
  for (let i = 0; i < count; i++) {
    const px = x + w * (0.22 + i * 0.27);
    const py = y + h * 0.42;
    const wave = Math.sin(now * 6 + i * 1.7) * 2.6;

    ctx.fillStyle = 'rgba(255,210,120,0.2)';
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = i % 2 === 0 ? '#a8c9e4' : '#ece6d6';
    ctx.fillRect(px - 2, py, 4, 5.5);
    ctx.fillStyle = '#f0cba6';
    ctx.beginPath();
    ctx.arc(px, py - 2.2, 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#f0cba6';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(px + 2, py + 1.5);
    ctx.lineTo(px + 4 + wave, py - 2.5);
    ctx.stroke();
  }
}

function drawPharmacyMark(ctx, x, y, w, h) {
  const size = Math.min(w, h) * 0.56;
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2f9e5a';
  const arm = size * 0.2;
  ctx.fillRect(cx - arm, cy - size * 0.46, arm * 2, size * 0.92);
  ctx.fillRect(cx - size * 0.46, cy - arm, size * 0.92, arm * 2);
}

// A helipad-style H in a ring, with a red cross: unmistakable from the full-map zoom.
function drawHospitalMark(ctx, x, y, w, h, detailed) {
  const size = Math.min(w, h) * 0.7;
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
  ctx.fillStyle = '#d3382f';
  const arm = size * 0.14;
  ctx.fillRect(cx - arm, cy - size * 0.38, arm * 2, size * 0.76);
  ctx.fillRect(cx - size * 0.38, cy - arm, size * 0.76, arm * 2);
  if (detailed) {
    ctx.strokeStyle = 'rgba(30,50,70,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
  }
}

function drawRoofDetails(ctx, b, x, y, w, h) {
  if (b.type === 'pharmacy' || b.type === 'hospital') return;
  for (const d of b.details) {
    const dx = x + d.u * w;
    const dy = y + d.v * h;
    const dw = Math.max(4, d.w * w);
    const dh = Math.max(3, d.h * h);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(dx + 2, dy + 2, dw, dh);
    if (d.kind === 'tank') {
      ctx.fillStyle = '#6d747c';
      ctx.beginPath();
      ctx.arc(dx + dw / 2, dy + dh / 2, Math.min(dw, dh) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#565d64';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = d.kind === 'skylight' ? '#8fb4c4' : '#6c737b';
      ctx.fillRect(dx, dy, dw, dh);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(dx, dy, dw, 2);
    }
  }
}

function drawStationFace(ctx, b, x, y, w, e, z, forSale = false) {
  ctx.fillStyle = '#f1ead9';
  ctx.fillRect(x + w * 0.06, y + 2, w * 0.88, Math.max(5, e * 0.16));
  if (z >= 0.85) {
    ctx.fillStyle = forSale ? '#2b5f8f' : '#8f2f22';
    ctx.font = `bold ${Math.max(6, e * 0.11)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(forSale ? 'FOR SALE' : (b.name ?? 'STATION').toUpperCase(), x + w / 2, y + 2 + Math.max(5, e * 0.16) / 2 + 0.5);
  }

  for (const t of [0.1, 0.53]) {
    const dx = x + w * t;
    const dw = w * 0.36;
    const dh = e * 0.62;
    const dy = y + e - dh;
    ctx.fillStyle = '#5b1d17';
    ctx.fillRect(dx, dy, dw, dh);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let i = 1; i < 5; i++) ctx.fillRect(dx, dy + (dh / 5) * i, dw, 1.5);
    ctx.strokeStyle = '#2a1714';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(dx, dy, dw, dh);
  }
}

function drawRubble(ctx, b) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  ctx.fillStyle = '#3a3833';
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  const seed = hashString(b.id);
  for (let i = 0; i < 18; i++) {
    const rw = 4 + hash(seed + i * 3.1) * 12;
    const rh = 4 + hash(seed + i * 5.7) * 12;
    const rx = x + hash(seed + i * 11.3) * (w - rw);
    const ry = y + hash(seed + i * 17.9) * (h - rh);
    ctx.fillStyle = i % 3 === 0 ? '#6b675e' : i % 3 === 1 ? '#55524b' : '#48453f';
    ctx.fillRect(rx, ry, rw, rh);
  }
  ctx.strokeStyle = '#242019';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.18, y + h * 0.25);
  ctx.lineTo(x + w * 0.55, y + h * 0.72);
  ctx.moveTo(x + w * 0.78, y + h * 0.2);
  ctx.lineTo(x + w * 0.5, y + h * 0.8);
  ctx.stroke();
}

// ------------------------------------------------------------------ fire ---

function drawFire(ctx, b, now, z) {
  const f = b.fire;
  const x = b.x * TILE;
  const y = b.y * TILE - b.elevation;
  const w = b.w * TILE;
  const h = b.h * TILE;
  const seed = hashString(b.id);
  const cx = x + w / 2;
  const cy = y + h / 2;

  const glowR = Math.max(w, h) * (0.6 + f * 0.5);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glow.addColorStop(0, `rgba(255,160,60,${0.42 * f})`);
  glow.addColorStop(0.5, `rgba(255,90,15,${0.2 * f})`);
  glow.addColorStop(1, 'rgba(255,60,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

  const count = 2 + Math.round(f * 5);
  for (let i = 0; i < count; i++) {
    const px = x + (0.1 + hash(seed + i * 13.7) * 0.8) * w;
    const py = y + (0.12 + hash(seed + i * 7.3 + 40) * 0.8) * h;
    const flick = 0.72 + 0.28 * Math.sin(now * 9 + i * 1.9 + seed);
    const height = (16 + f * 34) * flick;
    const width = (7 + f * 10) * flick;

    // Flame tongue: a teardrop leaning up and to the wind.
    const tongue = ctx.createLinearGradient(px, py, px + 4, py - height);
    tongue.addColorStop(0, 'rgba(255,120,20,0.85)');
    tongue.addColorStop(0.45, 'rgba(255,186,60,0.8)');
    tongue.addColorStop(0.8, 'rgba(255,226,130,0.55)');
    tongue.addColorStop(1, 'rgba(255,180,60,0)');
    ctx.fillStyle = tongue;
    ctx.beginPath();
    ctx.moveTo(px - width, py);
    ctx.bezierCurveTo(px - width * 1.05, py - height * 0.45, px - width * 0.3, py - height * 0.75, px + 3, py - height);
    ctx.bezierCurveTo(px + width * 0.4, py - height * 0.72, px + width * 1.05, py - height * 0.4, px + width, py);
    ctx.quadraticCurveTo(px + width * 0.2, py + width * 0.55, px - width, py);
    ctx.closePath();
    ctx.fill();

    // Hot core.
    ctx.fillStyle = `rgba(255,246,205,${0.55 * f})`;
    ctx.beginPath();
    ctx.ellipse(px + 1, py - height * 0.22, width * 0.32, height * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Flames coming out of the ground-floor windows.
  if (f > 0.3) {
    const facadeTop = b.y * TILE + b.h * TILE - b.elevation;
    for (let i = 0; i < 4; i++) {
      const px = x + (0.12 + hash(seed + i * 23.1) * 0.76) * w;
      const py = facadeTop + b.elevation * 0.5;
      const rad = (6 + f * 9) * (0.7 + 0.3 * Math.sin(now * 12 + i));
      const flame = ctx.createRadialGradient(px, py, 0, px, py, rad);
      flame.addColorStop(0, 'rgba(255,230,150,0.95)');
      flame.addColorStop(0.6, 'rgba(255,120,20,0.5)');
      flame.addColorStop(1, 'rgba(255,90,10,0)');
      ctx.fillStyle = flame;
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ----------------------------------------------------------------- units ---

function drawUnit(ctx, u, now) {
  if (u.kind === 'engine') {
    if (u.spec?.plane) drawAirtanker(ctx, u, now);
    else if (u.spec?.flying) drawHelicopter(ctx, u, now);
    else if (u.spec?.boat) drawBoat(ctx, u, now);
    else drawEngine(ctx, u, now);
  } else drawCrew(ctx, u, now);
}

// A scooping air tanker: twin-engine high wing, with its shadow far below.
function drawAirtanker(ctx, e, now) {
  const lift = 44;
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.fillStyle = 'rgba(10,14,18,0.28)';
  ctx.beginPath();
  ctx.ellipse(18, 40, 46, 12, e.angle, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(0, -lift);
  ctx.rotate(e.angle);
  // Wings, tailplane, fuselage.
  ctx.fillStyle = '#e8e4d8';
  ctx.fillRect(-6, -52, 18, 104);
  ctx.fillStyle = '#c93a2f';
  ctx.fillRect(-6, -52, 18, 7);
  ctx.fillRect(-6, 45, 18, 7);
  ctx.fillStyle = '#d9d5c8';
  ctx.fillRect(-58, -20, 12, 40);
  ctx.fillStyle = '#f2efe6';
  ctx.beginPath();
  ctx.moveTo(52, 0);
  ctx.quadraticCurveTo(46, -11, 28, -11);
  ctx.lineTo(-52, -6);
  ctx.lineTo(-52, 6);
  ctx.lineTo(28, 11);
  ctx.quadraticCurveTo(46, 11, 52, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#c93a2f';
  ctx.fillRect(-40, -3, 70, 6);
  ctx.fillStyle = '#1b2b3a';
  ctx.beginPath();
  ctx.ellipse(36, 0, 8, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Propellers, blurred.
  const spin = now * 40;
  for (const y of [-22, 22]) {
    ctx.fillStyle = '#394048';
    ctx.beginPath();
    ctx.arc(14, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,46,52,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14 + Math.cos(spin) * 2, y + Math.sin(spin) * 14);
    ctx.lineTo(14 - Math.cos(spin) * 2, y - Math.sin(spin) * 14);
    ctx.stroke();
  }
  // The water as it drops.
  if (e.pumping) {
    ctx.fillStyle = 'rgba(190,225,248,0.5)';
    ctx.beginPath();
    ctx.ellipse(-40, 0, 26, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${(e.spec?.label ?? 'A')[0]}${e.number}`, e.x, e.y - lift - 26);
}

// Boats: a fireboat with its monitor, and the orange rescue boat with its tubes.
function drawBoat(ctx, e, now) {
  const fire = e.type === 'fireboat';
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.rotate(e.angle);

  // Wake.
  const moving = e.path.length > 0;
  ctx.strokeStyle = 'rgba(235,245,252,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const wake = moving ? 34 : 12;
  ctx.moveTo(-34, -9);
  ctx.lineTo(-34 - wake, -20 - Math.sin(now * 6) * 2);
  ctx.moveTo(-34, 9);
  ctx.lineTo(-34 - wake, 20 + Math.sin(now * 6) * 2);
  ctx.stroke();

  // Hull.
  ctx.fillStyle = fire ? '#bf2f27' : '#e86f1f';
  ctx.beginPath();
  ctx.moveTo(48, 0);
  ctx.quadraticCurveTo(38, -17, 8, -18);
  ctx.lineTo(-38, -16);
  ctx.lineTo(-38, 16);
  ctx.lineTo(8, 18);
  ctx.quadraticCurveTo(38, 17, 48, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(-36, -2, 70, 4);

  if (fire) {
    ctx.fillStyle = '#efece1';
    rr(ctx, -22, -11, 30, 22, 4);
    ctx.fill();
    ctx.fillStyle = '#17222d';
    ctx.fillRect(2, -8, 5, 16);
    // Water monitor on the bow.
    ctx.fillStyle = '#3a3f45';
    ctx.beginPath();
    ctx.arc(26, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a3f45';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(26, 0);
    ctx.lineTo(38, 0);
    ctx.stroke();
  } else {
    // Inflatable tubes and a little console.
    ctx.strokeStyle = '#2a2f35';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(46, 0);
    ctx.quadraticCurveTo(38, -17, 8, -18);
    ctx.lineTo(-36, -16);
    ctx.moveTo(46, 0);
    ctx.quadraticCurveTo(38, 17, 8, 18);
    ctx.lineTo(-36, 16);
    ctx.stroke();
    ctx.fillStyle = '#efece1';
    rr(ctx, -10, -7, 18, 14, 3);
    ctx.fill();
    ctx.fillStyle = '#2d7fd0';
    ctx.fillRect(-34, -4, 10, 8);
  }

  const busy = e.status === 'responding' || e.pumping;
  ctx.fillStyle = busy && Math.floor(now * 6) % 2 === 0 ? '#ff4b3e' : '#58b8ff';
  ctx.beginPath();
  ctx.arc(-4, 0, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${(e.spec?.label ?? 'B')[0]}${e.number}`, e.x, e.y - 28);
}

// Someone in the water: head and arms, ripples, a life ring and the clock.
function drawVictim(ctx, v, now) {
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.strokeStyle = 'rgba(220,240,252,0.55)';
  ctx.lineWidth = 2;
  for (const k of [0, 0.5]) {
    const r = 8 + ((now * 10 + k * 14) % 14);
    ctx.globalAlpha = 1 - (r - 8) / 14;
    ctx.beginPath();
    ctx.arc(0, 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const flail = Math.sin(now * 9 + v.x) * 3;
  ctx.fillStyle = '#efd3b4';
  ctx.beginPath();
  ctx.arc(0, -2, 3.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#efd3b4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-3, 1);
  ctx.lineTo(-9, -5 + flail);
  ctx.moveTo(3, 1);
  ctx.lineTo(9, -5 - flail);
  ctx.stroke();

  const frac = clamp(v.life / v.maxLife, 0, 1);
  ctx.strokeStyle = `hsla(${Math.round(frac * 110)},85%,55%,0.95)`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, -2, 17, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  ctx.stroke();

  // A bouncing life ring, so they can be found on a big river.
  const bob = Math.sin(now * 6 + v.y) * 2.5;
  ctx.strokeStyle = '#ff6a3d';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, -30 + bob, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.arc(0, -30 + bob, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  if (v.rescueTimer > 0) {
    const prog = Math.min(1, v.rescueTimer / 5);
    ctx.fillStyle = 'rgba(8,12,16,0.7)';
    ctx.fillRect(-14, 12, 28, 4);
    ctx.fillStyle = '#7cc8ff';
    ctx.fillRect(-14, 12, 28 * prog, 4);
  }
  ctx.restore();
}

// A water-bombing helicopter: a shadow on the ground, the airframe lifted above
// it, a spinning rotor and a bucket under it while the tank is working.
function drawHelicopter(ctx, e, now) {
  const lift = 34;
  ctx.save();
  ctx.translate(e.x, e.y);

  ctx.fillStyle = 'rgba(10,14,18,0.3)';
  ctx.beginPath();
  ctx.ellipse(10, 24, 38, 14, e.angle, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(0, -lift);
  ctx.rotate(e.angle);

  // Tail boom, fuselage, cockpit.
  ctx.fillStyle = '#b8bec4';
  ctx.fillRect(-58, -3, 40, 6);
  ctx.fillStyle = '#d9dde0';
  ctx.fillRect(-62, -9, 8, 18);
  ctx.fillStyle = '#c93a2f';
  ctx.beginPath();
  ctx.ellipse(0, 0, 28, 15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f0ece2';
  ctx.fillRect(-18, -3, 30, 6);
  ctx.fillStyle = '#1b2b3a';
  ctx.beginPath();
  ctx.ellipse(16, 0, 11, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(140,200,235,0.35)';
  ctx.beginPath();
  ctx.ellipse(18, -2, 6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Skids.
  ctx.strokeStyle = '#3a3f45';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-22, -16);
  ctx.lineTo(24, -16);
  ctx.moveTo(-22, 16);
  ctx.lineTo(24, 16);
  ctx.stroke();

  // Main rotor: a translucent disc and two blades.
  const spin = now * 26;
  ctx.fillStyle = 'rgba(210,220,230,0.12)';
  ctx.beginPath();
  ctx.arc(0, 0, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,46,52,0.85)';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(Math.cos(spin) * 50, Math.sin(spin) * 50);
  ctx.lineTo(-Math.cos(spin) * 50, -Math.sin(spin) * 50);
  ctx.moveTo(Math.cos(spin + Math.PI / 2) * 50, Math.sin(spin + Math.PI / 2) * 50);
  ctx.lineTo(-Math.cos(spin + Math.PI / 2) * 50, -Math.sin(spin + Math.PI / 2) * 50);
  ctx.stroke();
  ctx.fillStyle = '#2a2f35';
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fill();

  // Beacon.
  if (e.status === 'responding' || e.pumping) {
    ctx.fillStyle = Math.floor(now * 6) % 2 === 0 ? '#ff4b3e' : '#58b8ff';
    ctx.beginPath();
    ctx.arc(-4, -10, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${(e.spec?.label ?? 'H')[0]}${e.number}`, e.x, e.y - lift - 22);
}

function drawEngine(ctx, e, now) {
  const type = e.type ?? 'engine';
  const label = `${(e.spec?.label ?? 'Engine')[0]}${e.number}`;

  ctx.save();
  ctx.translate(e.x, e.y);

  ctx.fillStyle = 'rgba(10,14,18,0.34)';
  ctx.beginPath();
  ctx.ellipse(4, 6, 44, 24, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(e.angle);

  // Wheels.
  ctx.fillStyle = '#15191e';
  for (const wx of [-26, 20]) {
    for (const wy of [-19, 19]) {
      ctx.fillRect(wx - 6, wy - 4, 12, 8);
    }
  }

  // Small and large relatives of the ambulance reuse its art, scaled.
  if (type === 'medcar') ctx.scale(0.62, 0.78);
  else if (type === 'ambubus') ctx.scale(1.38, 1.04);
  const body = type === 'divetruck' ? '#f0f2f2' : type === 'command' ? '#f2f0ea' : type === 'tanker' ? '#a9b1b8'
    : type === 'rescue' ? '#d97a2b'
      : type === 'ambulance' ? '#f1efe8' : '#bf2f27';
  ctx.fillStyle = body;
  rr(ctx, -42, -19, 84, 38, 6);
  ctx.fill();

  if (type === 'divetruck') {
    // A white van with a blue stripe, a rooftop rack and a dive flag.
    ctx.fillStyle = '#f0f2f2';
    rr(ctx, -40, -17, 60, 34, 5);
    ctx.fill();
    ctx.fillStyle = '#2d7fd0';
    ctx.fillRect(-40, 2, 60, 7);
    ctx.fillStyle = '#e04a2f';
    ctx.fillRect(-30, -13, 14, 8);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-27, -11.5, 8, 2);
    ctx.fillStyle = '#e8e5dc';
    rr(ctx, 14, -17, 27, 34, 4);
    ctx.fill();
    ctx.fillStyle = '#17222d';
    ctx.fillRect(31, -13, 7, 26);
    ctx.fillStyle = '#c9ced3';
    ctx.fillRect(-14, -16, 22, 3);
    ctx.fillRect(-14, 13, 22, 3);
  } else if (type === 'command') {
    // A white-and-red command SUV with a roof light bar and a mast.
    ctx.fillStyle = '#f2f0ea';
    rr(ctx, -36, -16, 74, 32, 7);
    ctx.fill();
    ctx.fillStyle = '#c93a2f';
    ctx.fillRect(-36, -3, 74, 6);
    ctx.fillStyle = '#17222d';
    ctx.fillRect(6, -12, 14, 24);
    ctx.fillRect(-26, -12, 10, 24);
    ctx.fillStyle = 'rgba(130,190,230,0.25)';
    ctx.fillRect(6, -12, 5, 24);
    ctx.strokeStyle = '#3a3f45';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(-8, -24);
    ctx.stroke();
    ctx.fillStyle = '#2d7fd0';
    ctx.fillRect(-2, -12, 5, 24);
  } else if (type === 'ambulance' || type === 'medcar' || type === 'ambubus') {
    // White box body, a red stripe and a cross on the side, light bar on the cab.
    ctx.fillStyle = '#f7f5ee';
    rr(ctx, -40, -17, 60, 34, 5);
    ctx.fill();
    ctx.fillStyle = '#d3382f';
    ctx.fillRect(-40, 3, 60, 5);
    ctx.fillRect(-14, -9, 8, 22);
    ctx.fillRect(-21, -2, 22, 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-28, -16);
    ctx.lineTo(-28, 16);
    ctx.stroke();
    ctx.fillStyle = '#e8e5dc';
    rr(ctx, 14, -17, 27, 34, 4);
    ctx.fill();
    ctx.fillStyle = '#17222d';
    ctx.fillRect(31, -13, 7, 26);
    ctx.fillStyle = 'rgba(130,190,230,0.22)';
    ctx.fillRect(31, -13, 3, 26);
    ctx.fillStyle = '#d3382f';
    ctx.fillRect(18, -17, 3, 34);
  } else if (type === 'rescue') {
    // A boxy rescue van with an orange stripe and equipment lockers.
    ctx.fillStyle = '#ece7db';
    rr(ctx, -40, -17, 60, 34, 5);
    ctx.fill();
    ctx.fillStyle = '#d97a2b';
    ctx.fillRect(-40, -7, 60, 14);
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1.5;
    for (const dx of [-34, -22, -10]) {
      ctx.beginPath();
      ctx.moveTo(dx, -16);
      ctx.lineTo(dx, 16);
      ctx.stroke();
    }
    ctx.fillStyle = '#b7601c';
    rr(ctx, 14, -17, 27, 34, 4);
    ctx.fill();
    ctx.fillStyle = '#17222d';
    ctx.fillRect(31, -13, 7, 26);
    ctx.fillStyle = 'rgba(130,190,230,0.22)';
    ctx.fillRect(31, -13, 3, 26);
  } else if (type === 'tanker') {
    // A big cylindrical tank on the back, red cab in front.
    ctx.fillStyle = '#cdd3d8';
    rr(ctx, -39, -16, 57, 32, 12);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(-39, -16, 57, 5);
    ctx.strokeStyle = 'rgba(70,80,90,0.45)';
    ctx.lineWidth = 2;
    for (const dx of [-24, -8, 8]) {
      ctx.beginPath();
      ctx.moveTo(dx, -15);
      ctx.lineTo(dx, 15);
      ctx.stroke();
    }
    ctx.fillStyle = '#b23a2c';
    rr(ctx, 15, -17, 26, 34, 4);
    ctx.fill();
    ctx.fillStyle = '#17222d';
    ctx.fillRect(32, -13, 7, 26);
    ctx.fillStyle = 'rgba(130,190,230,0.22)';
    ctx.fillRect(32, -13, 3, 26);
  } else {
    // Pump / ladder body: white band, red cab, compartment doors.
    ctx.fillStyle = '#efece1';
    ctx.fillRect(-41, -4, 82, 8);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(-42, 12, 84, 3);
    ctx.fillStyle = '#9d211b';
    rr(ctx, 14, -17, 27, 34, 4);
    ctx.fill();
    ctx.fillStyle = '#17222d';
    ctx.fillRect(31, -13, 7, 26);
    ctx.fillStyle = 'rgba(130,190,230,0.22)';
    ctx.fillRect(31, -13, 3, 26);
    ctx.fillStyle = '#243341';
    ctx.fillRect(18, -17, 3, 34);

    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    for (const dx of [-36, -24, -12]) {
      ctx.beginPath();
      ctx.moveTo(dx, -18);
      ctx.lineTo(dx, 18);
      ctx.stroke();
    }

    if (type === 'ladder') {
      // Turntable and the aerial ladder, longer than the truck itself.
      ctx.fillStyle = '#6d7278';
      ctx.beginPath();
      ctx.arc(-16, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#d9d4c4';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-36, -9);
      ctx.lineTo(46, -9);
      ctx.moveTo(-36, 9);
      ctx.lineTo(46, 9);
      for (let x = -34; x <= 44; x += 8) {
        ctx.moveTo(x, -9);
        ctx.lineTo(x, 9);
      }
      ctx.stroke();
      ctx.strokeStyle = '#3a3f45';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-24, -18);
      ctx.lineTo(-24, -28);
      ctx.moveTo(-24, 18);
      ctx.lineTo(-24, 28);
      ctx.stroke();
    } else {
      // Roof ladder on the pump.
      ctx.strokeStyle = '#dad5c5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-38, -11);
      ctx.lineTo(6, -11);
      ctx.moveTo(-38, 11);
      ctx.lineTo(6, 11);
      for (let x = -36; x <= 4; x += 7) {
        ctx.moveTo(x, -11);
        ctx.lineTo(x, 11);
      }
      ctx.stroke();
    }
  }

  // Beacon bar on the cab.
  const flash = Math.floor(now * 6) % 2 === 0;
  const busy = e.status === 'responding' || e.pumping;
  ctx.fillStyle = busy && flash ? '#ff4b3e' : '#7d2a24';
  ctx.fillRect(22, -13, 5, 6);
  ctx.fillStyle = busy && !flash ? '#58b8ff' : '#24455f';
  ctx.fillRect(22, 7, 5, 6);

  // Unit number.
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, -24, 0);

  ctx.restore();
}

function drawCrew(ctx, c, now) {
  if (c.diver && (c.status === 'swimming' || c.status === 'rescuing')) {
    ctx.strokeStyle = 'rgba(220,240,252,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y + 2, 10 + ((now * 8) % 6), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,240,252,0.6)';
    for (let i = 0; i < 3; i++) {
      const t = (now * 1.4 + i * 0.33) % 1;
      ctx.beginPath();
      ctx.arc(c.x + 8 + Math.sin(now * 5 + i) * 2, c.y - 6 - t * 18, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const bob = c.status === 'moving' ? Math.sin(now * 12 + c.x * 0.1) * 1.2 : 0;
  ctx.save();
  ctx.translate(c.x, c.y + bob);

  ctx.fillStyle = 'rgba(10,14,18,0.3)';
  ctx.beginPath();
  ctx.ellipse(2, 4, 9, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(c.angle + Math.PI / 2);

  // Jacket: yellow for firefighters, white and green for paramedics, a black
  // wetsuit and an orange tank for divers.
  ctx.fillStyle = c.diver ? '#20262c' : c.medic ? '#f1f4f0' : '#e0ae3c';
  ctx.beginPath();
  ctx.arc(0, 0, 7.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = c.diver ? '#e86f1f' : c.medic ? '#3a9d6a' : '#8f6a1e';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Reflective band.
  ctx.fillStyle = c.diver ? '#e86f1f' : c.medic ? '#3a9d6a' : '#ece8d9';
  ctx.fillRect(-7.2, -2, 14.4, 2.4);

  // Helmet toward the direction of travel.
  ctx.fillStyle = c.diver ? '#2d7fd0' : c.medic ? '#e6f1ea' : '#f3d34a';
  ctx.beginPath();
  ctx.arc(0, -4.8, 3.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.medic ? '#d64535' : '#c33a2c';
  ctx.beginPath();
  ctx.arc(0, -4.8, 1.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Treatment progress, drawn upright above the paramedic.
  if (c.medic && c.treatTimer > 0) {
    const p = Math.min(1, c.treatTimer / CONFIG.vehicles.ambulance.treatTime);
    ctx.strokeStyle = 'rgba(120,200,255,0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y - 17, 7, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,200,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y - 17, 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Rescue progress rings are drawn upright, above the firefighter.
  if (c.rescueTimer > 0) {
    const p = Math.min(1, c.rescueTimer / CONFIG.crew.rescueTime);
    ctx.strokeStyle = 'rgba(143,224,168,0.9)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y - 17, 7, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(143,224,168,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y - 17, 7, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPatient(ctx, p, now, z) {
  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.fillStyle = 'rgba(10,14,18,0.26)';
  ctx.beginPath();
  ctx.ellipse(1, 3, 13, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // A person lying down, with a blanket once they have been treated.
  ctx.fillStyle = p.treated ? '#7fc99a' : '#b9a58f';
  ctx.beginPath();
  ctx.ellipse(0, 0, 10, 4.6, 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#efd3b4';
  ctx.beginPath();
  ctx.arc(-10, -1, 3.2, 0, Math.PI * 2);
  ctx.fill();

  if (!p.treated) {
    // Urgency ring: full and green at first, draining to red as time runs out.
    const frac = clamp(p.life / p.maxLife, 0, 1);
    const hue = Math.round(frac * 110);
    ctx.strokeStyle = `hsla(${hue},85%,55%,0.95)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, -2, 17, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, -2, 17, 0, Math.PI * 2);
    ctx.stroke();

    // A bouncing red cross so they can be spotted on a big map.
    const bob = Math.sin(now * 6 + p.x) * 2.5;
    const cy = -30 + bob;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(-7, cy - 7, 14, 14);
    ctx.fillStyle = '#d3382f';
    ctx.fillRect(-2, cy - 6, 4, 12);
    ctx.fillRect(-6, cy - 2, 12, 4);
  }

  if (p.treatTimer > 0 && !p.treated) {
    const prog = Math.min(1, p.treatTimer / CONFIG.vehicles.ambulance.treatTime);
    ctx.fillStyle = 'rgba(8,12,16,0.7)';
    ctx.fillRect(-14, 12, 28, 4);
    ctx.fillStyle = '#7cc8ff';
    ctx.fillRect(-14, 12, 28 * prog, 4);
  }
  ctx.restore();
}

function drawBlockade(ctx, b, now, z) {
  const x = b.x - b.w / 2;
  const y = b.y - b.h / 2;
  const seed = hashString(b.id);

  // Scorched asphalt.
  ctx.fillStyle = 'rgba(14,12,10,0.38)';
  ctx.fillRect(x, y, b.w, b.h);

  // Hazard stripes around the closed stretch.
  ctx.strokeStyle = 'rgba(245,190,40,0.9)';
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 9]);
  ctx.strokeRect(x + 1.5, y + 1.5, b.w - 3, b.h - 3);
  ctx.setLineDash([]);

  if (b.debris) {
    for (let i = 0; i < 14; i++) {
      const rw = 6 + hash(seed + i * 3.3) * 14;
      const rh = 5 + hash(seed + i * 5.9) * 11;
      ctx.fillStyle = i % 3 === 0 ? '#6b675e' : i % 3 === 1 ? '#55524b' : '#403d37';
      ctx.fillRect(x + hash(seed + i * 11.7) * (b.w - rw), y + hash(seed + i * 17.1) * (b.h - rh), rw, rh);
    }
  } else {
    // Two crumpled cars, one on its side.
    for (let i = 0; i < 2; i++) {
      ctx.save();
      ctx.translate(b.x + (i === 0 ? -14 : 16), b.y + (i === 0 ? 6 : -8));
      ctx.rotate(0.5 + i * 1.7 + hash(seed) * 0.4);
      ctx.fillStyle = 'rgba(10,14,18,0.3)';
      ctx.fillRect(-19, -6, 40, 16);
      ctx.fillStyle = i === 0 ? '#8f2f27' : '#3d4d63';
      rr(ctx, -20, -8, 40, 16, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-8, -6, 14, 12);
      ctx.restore();
    }
  }

  // A fuse that is burning down looks like trouble: smoke, then flames.
  if (b.fuelAt != null && !b.fuelDone) {
    const left = b.fuelAt - (now ?? 0);
    if (left < 20) {
      const flick = 0.6 + 0.4 * Math.sin(now * 14);
      ctx.fillStyle = `rgba(255,140,30,${0.55 * flick})`;
      ctx.beginPath();
      ctx.arc(b.x - 4, b.y - 6, 9 + 4 * flick, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Flashing amber beacon.
  if (Math.floor(now * 4) % 2 === 0) {
    ctx.fillStyle = '#ffb81f';
    ctx.beginPath();
    ctx.arc(x + 8, y + 8, 4, 0, Math.PI * 2);
    ctx.arc(x + b.w - 8, y + b.h - 8, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (b.progress > 0) {
    const bw = Math.max(34, Math.min(b.w, 70));
    ctx.fillStyle = 'rgba(8,12,16,0.75)';
    ctx.fillRect(b.x - bw / 2 - 2, b.y - b.h / 2 - 14, bw + 4, 9);
    ctx.fillStyle = '#7cc8ff';
    ctx.fillRect(b.x - bw / 2, b.y - b.h / 2 - 12, bw * b.progress, 5);
  }
}

function drawCivilian(ctx, person, now) {
  const bob = Math.sin(now * 10 + person.phase) * 1.2;
  ctx.save();
  ctx.translate(person.x, person.y + bob);

  ctx.fillStyle = 'rgba(10,14,18,0.26)';
  ctx.beginPath();
  ctx.ellipse(1, 3, 6, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = person.color;
  ctx.beginPath();
  ctx.arc(0, 0, 4.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#efd3b4';
  ctx.beginPath();
  ctx.arc(0, -4.2, 2.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// -------------------------------------------------------------- streams ---

function drawHoses(ctx, state, now) {
  for (const hose of state.hoses) {
    const mx = (hose.ax + hose.bx) / 2 + 8;
    const my = (hose.ay + hose.by) / 2 + 10;
    ctx.strokeStyle = hose.live ? '#93301f' : 'rgba(120,96,86,0.55)';
    ctx.lineWidth = hose.live ? 3 : 2;
    if (!hose.live) ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(hose.ax, hose.ay);
    ctx.quadraticCurveTo(mx, my, hose.bx, hose.by);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Supply lines: hydrant to pump. Drawn under the units, with water visibly
  // running the wrong way down the hose while the pump is working.
  for (const engine of state.engines) {
    if (!engine.supply) continue;
    const ax = engine.x;
    const ay = engine.y;
    const bx = engine.supply.x;
    const by = engine.supply.y;
    const mx = (ax + bx) / 2 + 5;
    const my = (ay + by) / 2 + 9;

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(mx, my, bx, by);
    ctx.strokeStyle = '#2b4a63';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(140,205,240,0.45)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    for (let i = 0; i < 8; i++) {
      const t = ((i / 8) + (now * 1.3) % 1) % 1;
      const inv = 1 - t;
      const x = inv * inv * bx + 2 * inv * t * mx + t * t * ax;
      const y = inv * inv * by + 2 * inv * t * my + t * t * ay;
      ctx.fillStyle = `rgba(175,222,250,${0.55 + 0.35 * Math.sin(now * 8 + i)})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawStreams(ctx, state, now) {
  for (const s of state.streams) {
    const dx = s.tx - s.sx;
    const dy = s.ty - s.sy;
    const len = Math.hypot(dx, dy);
    if (len < 2) continue;
    const arc = Math.min(52, len * 0.2);
    const midX = (s.sx + s.tx) / 2;
    const midY = (s.sy + s.ty) / 2 - arc * 1.4;
    const turret = s.kind === 'turret';

    // The body of the jet: a soft, slightly see-through curve.
    ctx.strokeStyle = turret ? 'rgba(200,232,250,0.34)' : 'rgba(190,225,248,0.24)';
    ctx.lineWidth = turret ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(s.sx, s.sy);
    ctx.quadraticCurveTo(midX, midY, s.tx, s.ty);
    ctx.stroke();

    // Droplets along the same curve, so the water reads as moving.
    const drops = Math.min(30, Math.max(12, Math.round(len / 5)));
    for (let i = 0; i < drops; i++) {
      const t = ((i / drops) + (now * 1.8) % 1) % 1;
      const inv = 1 - t;
      const x = inv * inv * s.sx + 2 * inv * t * midX + t * t * s.tx;
      const y = inv * inv * s.sy + 2 * inv * t * midY + t * t * s.ty;
      const alpha = 0.95 - t * 0.4;
      ctx.fillStyle = `rgba(214,238,252,${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, (turret ? 2 : 1.6) + (1 - t) * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nozzle mist and a splash where it lands.
    ctx.fillStyle = `rgba(220,240,252,${0.2 + 0.1 * Math.sin(now * 14)})`;
    ctx.beginPath();
    ctx.arc(s.sx, s.sy, turret ? 7 : 4.5, 0, Math.PI * 2);
    ctx.fill();

    const pulse = 0.6 + 0.4 * Math.sin(now * 15 + len);
    ctx.fillStyle = `rgba(210,235,250,${0.3 * pulse})`;
    ctx.beginPath();
    ctx.arc(s.tx, s.ty, 5 + pulse * 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------ particles ---

// Soft puffs are drawn from a pre-rendered sprite: hundreds of radial gradients
// per frame would be far too slow, one 64px image is free.
let smokeSprite = null;
let steamSprite = null;

function puff(rgb) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb},0.95)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.42)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return canvas;
}

function drawParticles(ctx, state) {
  if (!smokeSprite) {
    smokeSprite = puff('108,114,122');
    steamSprite = puff('228,238,246');
  }

  for (const p of state.fx) {
    const life = p.life / p.maxLife;
    if (p.kind === 'smoke') {
      const size = p.size * 2.8;
      ctx.globalAlpha = life * 0.5 * (0.65 + p.tone * 0.35);
      ctx.drawImage(smokeSprite, p.x - size / 2, p.y - size / 2, size, size);
    } else if (p.kind === 'steam') {
      const size = p.size * 3;
      ctx.globalAlpha = life * 0.3;
      ctx.drawImage(steamSprite, p.x - size / 2, p.y - size / 2, size, size);
    } else if (p.kind === 'ember') {
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(255,${150 + Math.round(p.tone * 70)},60,${life})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.kind === 'rescue') {
      ctx.globalAlpha = Math.min(1, life * 1.6);
      ctx.fillStyle = 'rgba(180,255,210,0.95)';
      const s = 4 + (1 - life) * 2;
      ctx.fillRect(p.x - s / 2, p.y - s * 1.5, s, s * 3);
      ctx.fillRect(p.x - s * 1.5, p.y - s / 2, s * 3, s);
    } else if (p.kind === 'debris') {
      ctx.globalAlpha = Math.min(1, life * 1.5);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = 'rgba(78,73,66,1)';
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------ selection ---

function drawWorldSelection(ctx, state, now, z) {
  const selected = state.selected;
  const pulse = 0.55 + 0.45 * Math.sin(now * 4);

  // The ripple where the last order landed.
  const mark = state.ui.orderMark;
  if (mark) {
    const age = now - mark.t;
    if (age > 0.9) {
      state.ui.orderMark = null;
    } else {
      const k = age / 0.9;
      ctx.strokeStyle = `rgba(95,208,255,${0.75 * (1 - k)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(mark.x, mark.y, 7 + k * 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(95,208,255,${0.7 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(mark.x, mark.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Hover: a quiet outline, so the pointer says what it is about to click.
  const hover = state.ui.hover;
  if (hover && !(selected && selected.id === hover.id)) {
    if (hover.kind === 'wildfire') {
      const wf = (state.wildfires ?? []).find((w) => w.id === hover.id);
      if (wf) {
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(wf.x, wf.y, wf.radius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (hover.kind === 'blockade') {
      const wreck = (state.blockades ?? []).find((q) => q.id === hover.id);
      if (wreck) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(wreck.x - wreck.w / 2 - 5, wreck.y - wreck.h / 2 - 5, wreck.w + 10, wreck.h + 10);
      }
    } else if (hover.kind === 'patient') {
      const patient = (state.patients ?? []).find((q) => q.id === hover.id);
      if (patient) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(patient.x, patient.y, 24, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (hover.kind === 'unit') {
      const unit = state.units.find((u) => u.id === hover.id);
      if (unit && !(unit.kind === 'crew' && unit.riding)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(unit.x, unit.y, unit.kind === 'engine' ? 54 : 17, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      const b = state.buildings.find((x) => x.id === hover.id);
      if (b) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x * TILE - 3, b.y * TILE - 3, b.w * TILE + 6, b.h * TILE + 6);
      }
    }
  }

  // Fires get a dashed ring on the ground even when nothing is selected.
  for (const b of state.buildings) {
    if (b.state !== 'burning') continue;
    const rect = buildingRect(b);
    ctx.strokeStyle = `rgba(255,122,31,${0.28 + pulse * 0.25})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.strokeRect(rect.x - 6, rect.y - 6, rect.w + 12, rect.h + 12);
    ctx.setLineDash([]);
  }

  if (!selected) return;
  const entity = lookup(state, selected);
  if (!entity) return;

  if (selected.kind === 'victim') {
    ctx.strokeStyle = PALETTE.select;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.arc(entity.x, entity.y, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (selected.kind === 'blockade') {
    ctx.strokeStyle = PALETTE.select;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(entity.x - entity.w / 2 - 6, entity.y - entity.h / 2 - 6, entity.w + 12, entity.h + 12);
    ctx.setLineDash([]);
    return;
  }

  if (selected.kind === 'patient') {
    ctx.strokeStyle = PALETTE.select;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.arc(entity.x, entity.y, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (selected.kind === 'wildfire') {
    ctx.strokeStyle = PALETTE.select;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.arc(entity.x, entity.y, entity.radius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (selected.kind === 'unit') {
    const radius = entity.kind === 'engine' ? 52 : 16;
    ctx.strokeStyle = PALETTE.select;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.arc(entity.x, entity.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (entity.kind === 'engine' && entity.spec.command) {
      ctx.strokeStyle = 'rgba(95,208,255,0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 10]);
      ctx.beginPath();
      ctx.arc(entity.x, entity.y, CONFIG.command.range * TILE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (entity.kind === 'engine') {
      // Where the hose can still reach, and where the deck gun can.
      ctx.strokeStyle = 'rgba(95,208,255,0.13)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 12]);
      ctx.beginPath();
      ctx.arc(entity.x, entity.y, (entity.spec.medical ? entity.spec.medRange : entity.spec.hoseRange) * TILE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,180,80,0.12)';
      ctx.beginPath();
      ctx.arc(entity.x, entity.y, entity.spec.turretRange * TILE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (!entity.supply) {
        const hydrant = nearestHydrantInReach(state, entity);
        if (hydrant) {
          const pulse = 0.5 + 0.5 * Math.sin(now * 5);
          ctx.strokeStyle = `rgba(95,208,255,${0.35 + pulse * 0.4})`;
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(hydrant.x, hydrant.y, 12 + pulse * 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  } else {
    const rect = buildingRect(entity);
    ctx.strokeStyle = PALETTE.select;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(rect.x - 5, rect.y - 5, rect.w + 10, rect.h + 10);
    ctx.setLineDash([]);

    // Corner brackets, so the shape reads at any zoom.
    const arm = Math.min(18, rect.w * 0.25, rect.h * 0.25);
    ctx.strokeStyle = '#d8f3ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const corners = [
      [rect.x - 5, rect.y - 5, 1, 1],
      [rect.x + rect.w + 5, rect.y - 5, -1, 1],
      [rect.x - 5, rect.y + rect.h + 5, 1, -1],
      [rect.x + rect.w + 5, rect.y + rect.h + 5, -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.moveTo(cx + arm * sx, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + arm * sy);
    }
    ctx.stroke();
  }
}

// ------------------------------------------------------------- overlays ---

function lookup(state, ref) {
  if (!ref) return null;
  if (ref.kind === 'wildfire') return (state.wildfires ?? []).find((w) => w.id === ref.id) ?? null;
  if (ref.kind === 'patient') return (state.patients ?? []).find((q) => q.id === ref.id) ?? null;
  if (ref.kind === 'blockade') return (state.blockades ?? []).find((q) => q.id === ref.id) ?? null;
  if (ref.kind === 'victim') return (state.victims ?? []).find((q) => q.id === ref.id) ?? null;
  if (ref.kind === 'unit') return state.units.find((u) => u.id === ref.id) ?? null;
  return state.buildings.find((b) => b.id === ref.id) ?? null;
}

function nearestHydrantInReach(state, engine) {
  if (!engine) return null;
  const range = CONFIG.refillRange * TILE;
  let best = null;
  let bestD = Infinity;
  for (const h of state.city.hydrants) {
    const hx = (h.x + 0.5) * TILE;
    const hy = (h.y + 0.5) * TILE;
    const d = Math.hypot(hx - engine.x, hy - engine.y);
    if (d < bestD) {
      bestD = d;
      best = { x: hx, y: hy };
    }
  }
  return bestD <= range ? best : null;
}

function drawHydrantPrompt(ctx, state, cam, view) {
  const selected = state.selected;
  if (!selected || selected.kind !== 'unit') return;
  const engine = state.engines.find((e) => e.id === selected.id)
    ?? state.engines.find((e) => e.crewIds.includes(selected.id));
  if (!engine || engine.supply) return;
  const hydrant = nearestHydrantInReach(state, engine);
  if (!hydrant) return;

  const p = worldToScreen(cam, engine.x, engine.y - 72, view);
  const text = 'G  CONNECT HYDRANT';
  ctx.font = '700 10px "Segoe UI", system-ui, sans-serif';
  const w = ctx.measureText(text).width + 18;
  ctx.fillStyle = 'rgba(8,12,17,0.86)';
  rr(ctx, p.x - w / 2, p.y - 11, w, 21, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(95,208,255,0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#c6ecff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x, p.y);
}

function drawWildfires(ctx, state, now, z) {
  for (const wf of state.wildfires ?? []) {
    const r = wf.radius;
    const seed = hashString(wf.id);

    ctx.fillStyle = 'rgba(26,22,17,0.45)';
    ctx.beginPath();
    ctx.arc(wf.x, wf.y, r, 0, Math.PI * 2);
    ctx.fill();

    const glow = ctx.createRadialGradient(wf.x, wf.y, 0, wf.x, wf.y, r * 1.5);
    glow.addColorStop(0, `rgba(255,150,50,${0.28 * wf.intensity})`);
    glow.addColorStop(0.6, `rgba(255,90,10,${0.14 * wf.intensity})`);
    glow.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(wf.x - r * 1.5, wf.y - r * 1.5, r * 3, r * 3);

    const count = Math.min(30, 10 + Math.round(r / TILE));
    for (let i = 0; i < count; i++) {
      const angle = hash(seed + i * 3.1) * Math.PI * 2;
      const dist = Math.sqrt(hash(seed + i * 7.7)) * r;
      const px = wf.x + Math.cos(angle) * dist;
      const py = wf.y + Math.sin(angle) * dist;
      const flick = 0.65 + 0.35 * Math.sin(now * 10 + i * 1.7);
      const rad = (6 + wf.intensity * 10) * flick;
      const flame = ctx.createRadialGradient(px, py, 0, px, py, rad);
      flame.addColorStop(0, 'rgba(255,245,190,0.95)');
      flame.addColorStop(0.5, 'rgba(255,150,40,0.8)');
      flame.addColorStop(1, 'rgba(200,40,0,0)');
      ctx.fillStyle = flame;
      ctx.beginPath();
      ctx.ellipse(px, py, rad * 0.7, rad, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = `rgba(255,120,30,${0.25 + 0.2 * Math.sin(now * 4)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(wf.x, wf.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawFloatingBars(ctx, state, cam, view) {  const z = cam.zoom;
  for (const b of state.buildings) {
    const burning = b.state === 'burning';
    const trapped = b.trapped ?? 0;
    if (!burning && trapped === 0) continue;
    const rect = buildingRect(b);
    const p = worldToScreen(cam, rect.x + rect.w / 2, rect.y - b.elevation - 12, view);
    if (p.x < -60 || p.x > view.width + 60 || p.y < -40 || p.y > view.height + 40) continue;

    if (burning) {
      const width = Math.max(34, Math.min(64, rect.w * z * 0.7));
      const x = p.x - width / 2;
      const y = p.y;
      ctx.fillStyle = 'rgba(8,12,16,0.7)';
      rr(ctx, x - 2, y - 2, width + 4, 10, 3);
      ctx.fill();
      ctx.fillStyle = '#ff7a1f';
      ctx.fillRect(x, y, width * b.fire, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x, y + 6, width * (b.integrity / b.maxIntegrity), 2);
    }

    if (trapped > 0) {
      // Keep the badge clear of the alarm banner when a fire is on the top edge.
      const badgeY = Math.max(p.y - (burning ? 18 : 0), 118);
      drawTrappedBadge(ctx, p.x, badgeY, trapped);
    }
  }
}

function drawTrappedBadge(ctx, cx, y, count) {
  const w = 44;
  const h = 17;
  ctx.fillStyle = 'rgba(126,28,23,0.94)';
  rr(ctx, cx - w / 2, y - h, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,178,150,0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const ix = cx - w / 2 + 11;
  ctx.fillStyle = '#ffd9c9';
  ctx.beginPath();
  ctx.arc(ix, y - 10, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(ix - 3, y - 7.5, 6, 4.5);

  ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffe8df';
  ctx.fillText(String(count), cx + 8, y - h / 2 + 0.5);
}

function drawSelectedLabel(ctx, state, cam, view) {
  const selected = state.selected;
  if (!selected) return;
  const entity = lookup(state, selected);
  if (!entity) return;

  const isUnit = selected.kind === 'unit';
  const isPatient = selected.kind === 'patient';
  const isBlockade = selected.kind === 'blockade';
  const isVictim = selected.kind === 'victim';
  const p = isVictim
    ? worldToScreen(cam, entity.x, entity.y - 48, view)
    : isBlockade
    ? worldToScreen(cam, entity.x, entity.y - entity.h / 2 - 30, view)
    : isPatient
    ? worldToScreen(cam, entity.x, entity.y - 46, view)
    : isUnit
    ? worldToScreen(cam, entity.x, entity.y - (entity.kind === 'engine' ? 34 : 18), view)
    : selected.kind === 'wildfire'
      ? worldToScreen(cam, entity.x, entity.y - entity.radius - 18, view)
      : worldToScreen(
        cam,
        (entity.x + entity.w / 2) * TILE,
        entity.y * TILE - entity.elevation - 22,
        view,
      );

  const title = entity.name;
  let detail;
  if (isVictim) {
    detail = `IN THE WATER · ${Math.ceil(entity.life)}s LEFT · DIVERS NEEDED`;
  } else if (isBlockade) {
    detail = `ROAD BLOCKED · ${Math.round(entity.progress * 100)}% CLEARED`;
  } else if (isPatient) {
    detail = entity.treated ? 'STABILISED' : `${entity.critical ? 'CRITICAL · ' : ''}NEEDS AMBULANCE · ${Math.ceil(entity.life)}s LEFT`;
  } else if (selected.kind === 'wildfire') {
    detail = `MAJOR INCIDENT · ${Math.round(entity.intensity * 100)}% · $${entity.reward ?? 0}`;
  } else if (isUnit) {
    detail = entity.kind !== 'engine'
      ? entity.status.toUpperCase()
      : entity.spec.medical
        ? `${entity.status.toUpperCase()} · ${entity.kits}/${entity.spec.kits} KITS${(entity.cargo?.length ?? 0) > 0 ? ` · ${entity.cargo.length} ABOARD` : ''}`
        : !(entity.capacity > 0) || entity.capacity >= 50000
          ? entity.status.toUpperCase()
          : `${entity.status.toUpperCase()} · ${Math.round((entity.water / entity.capacity) * 100)}% WATER${entity.supply ? ' · HYDRANT' : ''}`;
  } else if (entity.state === 'burning') {
    detail = `BURNING · ${Math.round(entity.fire * 100)}% · ${Math.round((entity.integrity / entity.maxIntegrity) * 100)}% STANDING`;
  } else if (entity.state === 'rubble') {
    detail = 'LOST';
  } else if (entity.state === 'out') {
    detail = 'KNOCKED DOWN';
  } else {
    detail = 'NO FIRE';
  }
  if (!isUnit && (entity.trapped ?? 0) > 0) {
    detail += ` · ${entity.trapped} TRAPPED`;
  }

  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
  const titleW = ctx.measureText(title).width;
  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  const detailW = ctx.measureText(detail).width;
  const w = Math.max(titleW, detailW) + 18;
  const x = clamp(p.x - w / 2, 6, view.width - w - 6);
  const y = clamp(p.y - 34, 6, view.height - 40);

  ctx.fillStyle = 'rgba(8,12,17,0.82)';
  rr(ctx, x, y, w, 36, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(95,208,255,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f2f6fa';
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(title, x + 9, y + 12);
  ctx.fillStyle = 'rgba(190,205,218,0.85)';
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(detail, x + 9, y + 26);
}

function drawOffscreenAlarms(ctx, state, cam, view, now) {
  const pad = 34;
  const pulse = 0.6 + 0.4 * Math.sin(now * 5);
  for (const b of state.buildings) {
    if (b.state !== 'burning') continue;
    const rect = buildingRect(b);
    const p = worldToScreen(cam, rect.x + rect.w / 2, rect.y + rect.h / 2, view);
    if (p.x > -20 && p.x < view.width + 20 && p.y > -20 && p.y < view.height + 20) continue;

    const cx = clamp(p.x, pad, view.width - pad);
    const cy = clamp(p.y, pad, view.height - pad);
    const angle = Math.atan2(p.y - cy, p.x - cx);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = `rgba(255,122,31,${0.55 + pulse * 0.35})`;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, -7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawOffscreenVictims(ctx, state, cam, view, now) {
  const pad = 34;
  const pulse = 0.6 + 0.4 * Math.sin(now * 7);
  for (const v of state.victims ?? []) {
    const p = worldToScreen(cam, v.x, v.y, view);
    if (p.x > -20 && p.x < view.width + 20 && p.y > -20 && p.y < view.height + 20) continue;
    const cx = clamp(p.x, pad, view.width - pad);
    const cy = clamp(p.y, pad, view.height - pad);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(p.y - cy, p.x - cx));
    ctx.fillStyle = `rgba(80,190,255,${0.55 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-5, -6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawOffscreenWrecks(ctx, state, cam, view, now) {
  const pad = 34;
  const pulse = 0.6 + 0.4 * Math.sin(now * 4);
  for (const b of state.blockades ?? []) {
    const p = worldToScreen(cam, b.x, b.y, view);
    if (p.x > -20 && p.x < view.width + 20 && p.y > -20 && p.y < view.height + 20) continue;
    const cx = clamp(p.x, pad, view.width - pad);
    const cy = clamp(p.y, pad, view.height - pad);
    const angle = Math.atan2(p.y - cy, p.x - cx);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = `rgba(255,190,40,${0.5 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-5, -6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawOffscreenPatients(ctx, state, cam, view, now) {
  const pad = 34;
  const pulse = 0.6 + 0.4 * Math.sin(now * 6);
  for (const patient of state.patients ?? []) {
    if (patient.treated) continue;
    const p = worldToScreen(cam, patient.x, patient.y, view);
    if (p.x > -20 && p.x < view.width + 20 && p.y > -20 && p.y < view.height + 20) continue;
    const cx = clamp(p.x, pad, view.width - pad);
    const cy = clamp(p.y, pad, view.height - pad);
    const angle = Math.atan2(p.y - cy, p.x - cx);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = `rgba(120,200,255,${0.5 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-5, -6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// The map is 200,000 tiles; the roads and buildings of the minimap change only
// when something is lost, so they are painted once into an offscreen canvas.
let miniCache = null;
function miniStatic(state, mw, mh) {
  const city = state.city;
  const rubble = state.buildings.reduce((n, b) => n + (b.state === 'rubble' ? 1 : 0), 0);
  if (miniCache && miniCache.city === city && miniCache.w === mw && miniCache.h === mh
    && miniCache.rubble === rubble) {
    return miniCache.canvas;
  }
  const canvas = miniCache?.canvas ?? document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const g = canvas.getContext('2d');
  const sx = mw / (city.w * TILE);
  const sy = mh / (city.h * TILE);

  g.fillStyle = '#2f353c';
  g.fillRect(0, 0, mw, mh);
  g.fillStyle = '#245b82';
  g.fillRect(0, SEA_Y * TILE * sy, mw, mh - SEA_Y * TILE * sy);
  g.fillStyle = '#2b6a94';
  for (let y = 0; y < SEA_Y; y += 2) {
    const c = riverCentre(y + 1);
    g.fillRect((c - RIVER_HALF_WIDTH) * TILE * sx, y * TILE * sy, RIVER_HALF_WIDTH * 2 * TILE * sx, 2 * TILE * sy + 1);
  }
  g.fillStyle = '#33482a';
  for (const a of city.forestAreas ?? []) {
    g.fillRect(a.x0 * TILE * sx, a.y0 * TILE * sy, (a.x1 - a.x0 + 1) * TILE * sx, (a.y1 - a.y0 + 1) * TILE * sy);
  }
  g.fillStyle = '#3c4a38';
  for (const pk of city.parks) {
    g.fillRect(pk.x0 * TILE * sx, pk.y0 * TILE * sy, (pk.x1 - pk.x0 + 1) * TILE * sx, (pk.y1 - pk.y0 + 1) * TILE * sy);
  }
  g.fillStyle = '#5a626b';
  for (const vx of V_ROADS) g.fillRect(vx * TILE * sx, 0, Math.max(1, 2 * TILE * sx), SEA_Y * TILE * sy);
  for (const hy of H_ROADS) g.fillRect(0, hy * TILE * sy, mw, Math.max(1, 2 * TILE * sy));
  for (const b of state.buildings) {
    g.fillStyle = b.state === 'rubble' ? '#4d4a44' : b.type === 'pharmacy' ? '#7fcf9c' : b.type === 'hospital' ? '#ff8f8f' : '#7d848d';
    const bigger = b.type === 'hospital' ? 2.5 : 1.2;
    g.fillRect(b.x * TILE * sx, b.y * TILE * sy, Math.max(bigger, b.w * TILE * sx), Math.max(bigger, b.h * TILE * sy));
  }
  miniCache = { canvas, city, w: mw, h: mh, rubble };
  return canvas;
}

function drawMinimap(ctx, state, cam, view) {
  const city = state.city;
  const mw = Math.round(Math.min(280, view.width * 0.25));
  const mh = Math.round((mw * city.h) / city.w);
  const x = view.width - mw - 16;
  const y = view.height - mh - 16;
  state.ui.minimap = { x, y, w: mw, h: mh };
  const sx = mw / (city.w * TILE);
  const sy = mh / (city.h * TILE);

  ctx.fillStyle = 'rgba(8,12,17,0.78)';
  rr(ctx, x - 6, y - 6, mw + 12, mh + 12, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.drawImage(miniStatic(state, mw, mh), x, y);

  // Station 1, so the way home is never lost on a map this size.
  (city.stations ?? []).forEach((station, i) => {
    const st = station.building;
    ctx.fillStyle = state.ownedStations?.[i] ?? i === 0 ? '#ff5b4d' : 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + (st.x + st.w / 2) * TILE * sx - 3, y + (st.y + st.h / 2) * TILE * sy - 3, 6, 6);
  });

  const pulse = 0.6 + 0.4 * Math.sin(state.time * 5);
  for (const b of state.buildings) {
    if (b.state !== 'burning') continue;
    ctx.fillStyle = `rgba(255,110,30,${0.6 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.arc(x + (b.x + b.w / 2) * TILE * sx, y + (b.y + b.h / 2) * TILE * sy, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const wf of state.wildfires ?? []) {
    ctx.fillStyle = `rgba(255,120,30,${0.65 + pulse * 0.3})`;
    ctx.beginPath();
    ctx.arc(x + wf.x * sx, y + wf.y * sy, Math.max(2.5, wf.radius * sx), 0, Math.PI * 2);
    ctx.fill();
  }

  for (const wreck of state.blockades ?? []) {
    ctx.fillStyle = `rgba(255,190,40,${0.7 + pulse * 0.3})`;
    ctx.fillRect(x + wreck.x * sx - 2.5, y + wreck.y * sy - 2.5, 5, 5);
  }

  for (const v of state.victims ?? []) {
    ctx.fillStyle = `rgba(80,190,255,${0.7 + pulse * 0.3})`;
    ctx.fillRect(x + v.x * sx - 2, y + v.y * sy - 2, 4, 4);
  }

  for (const patient of state.patients ?? []) {
    if (patient.treated) continue;
    ctx.fillStyle = `rgba(255,255,255,${0.7 + pulse * 0.3})`;
    ctx.fillRect(x + patient.x * sx - 2.5, y + patient.y * sy - 2.5, 5, 5);
    ctx.fillStyle = '#d3382f';
    ctx.fillRect(x + patient.x * sx - 0.8, y + patient.y * sy - 2.5, 1.6, 5);
    ctx.fillRect(x + patient.x * sx - 2.5, y + patient.y * sy - 0.8, 5, 1.6);
  }

  for (const u of state.units) {
    if (u.kind === 'engine') {
      ctx.fillStyle = u.spec?.medical ? '#ffffff' : '#63d6ff';
      ctx.fillRect(x + u.x * sx - 2.5, y + u.y * sy - 2.5, 5, 5);
    } else if (!u.riding) {
      ctx.fillStyle = '#f0c648';
      ctx.fillRect(x + u.x * sx - 1.2, y + u.y * sy - 1.2, 2.4, 2.4);
    }
  }

  // Viewport.
  const halfW = view.width / (2 * cam.zoom);
  const halfH = view.height / (2 * cam.zoom);
  ctx.strokeStyle = 'rgba(230,240,248,0.75)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(
    x + (cam.x - halfW) * sx,
    y + (cam.y - halfH) * sy,
    halfW * 2 * sx,
    halfH * 2 * sy,
  );
}

let vignette = null;
function drawVignette(ctx, w, h) {
  if (!vignette || vignette.w !== w || vignette.h !== h) {
    const g = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.35,
      w / 2, h / 2, Math.max(w, h) * 0.75,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    vignette = { w, h, g };
  }
  ctx.fillStyle = vignette.g;
  ctx.fillRect(0, 0, w, h);
}

export { PALETTE };
