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
import { pointAt, trainsAt } from '../data/transit.js';

// What the ground of each kind of block looks like, painted over the pavement:
// lawns round the houses, dark yards in industry, pale paving downtown.
const ZONE_GROUND = {
  housing: 'rgba(104,128,78,0.5)',
  industrial: 'rgba(52,56,62,0.62)',
  company: 'rgba(206,214,224,0.3)',
  commercial: 'rgba(160,140,112,0.2)',
};
const ZONE_MINIMAP = {
  housing: '#4b6a45',
  industrial: '#4a4a52',
  company: '#5d6f86',
  commercial: '#6a5f52',
};

const PALETTE = {
  sidewalk: '#9b9b95',
  sidewalkJoint: 'rgba(40,40,38,0.16)',
  park: '#566340',
  parkEdge: '#4d5f38',
  road: '#3a3b3d',
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
  const SZ = 256;
  const c = document.createElement('canvas');
  c.width = SZ;
  c.height = SZ;
  const t = c.getContext('2d');
  t.fillStyle = base;
  t.fillRect(0, 0, SZ, SZ);
  let s = 12345 + name.length * 977;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Large soft mottling (wear, stains, patchy growth) wrapped so the tile repeats
  // without a seam, then fine grain on top.
  const blotch = name === 'grass' ? 46 : name === 'asphalt' ? 30 : name === 'roof' ? 0 : 22;
  for (let i = 0; i < blotch; i++) {
    const r = 14 + rnd() * 46;
    const x = rnd() * SZ;
    const y = rnd() * SZ;
    const light = rnd() < 0.5;
    const a = 0.03 + rnd() * 0.06;
    for (const ox of [-SZ, 0, SZ]) {
      for (const oy of [-SZ, 0, SZ]) {
        const g = t.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, light ? `rgba(255,255,235,${a})` : `rgba(0,0,0,${a * 1.3})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        t.fillStyle = g;
        t.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  for (let i = 0; i < speckles * 4; i++) {
    const light = rnd() < 0.5;
    t.fillStyle = light ? `rgba(255,255,255,${0.03 + rnd() * 0.08})` : `rgba(0,0,0,${0.05 + rnd() * 0.12})`;
    const sz = rnd() < 0.85 ? 1 : 2;
    t.fillRect((rnd() * SZ) | 0, (rnd() * SZ) | 0, sz, sz);
  }
  if (name === 'grass') {
    for (let i = 0; i < 900; i++) {
      const x = rnd() * SZ;
      const y = rnd() * SZ;
      t.strokeStyle = rnd() < 0.5 ? 'rgba(150,175,90,0.22)' : 'rgba(30,50,22,0.3)';
      t.lineWidth = 1;
      t.beginPath();
      t.moveTo(x, y);
      t.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 3);
      t.stroke();
    }
  }
  if (name === 'asphalt') {
    t.strokeStyle = 'rgba(0,0,0,0.22)';
    t.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      let x = rnd() * SZ;
      let y = rnd() * SZ;
      t.beginPath();
      t.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (rnd() - 0.5) * 18;
        y += (rnd() - 0.3) * 14;
        t.lineTo(x, y);
      }
      t.stroke();
    }
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

// Shaded colours are asked for thousands of times a frame (every tree crown),
// from a small set of base colours, so remember them.
const shadeCache = new Map();
function shade(hex, amount) {
  const key = hex + amount;
  let out = shadeCache.get(key);
  if (out === undefined) {
    out = shadeRaw(hex, amount);
    if (shadeCache.size < 4000) shadeCache.set(key, out);
  }
  return out;
}

function shadeRaw(hex, amount) {
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
  // Slack past the city edge: a few tiles, or at least `edgePad` screen pixels,
  // so anything at the very left or right can be panned out from under a panel.
  const margin = Math.max(CONFIG.camera.margin * TILE, CONFIG.camera.edgePad / cam.zoom);

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
  currentDark = daylight(state.clock);
  currentSun = sunShadow(state.clock);

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
  drawRail(ctx, state, bounds, z);
  drawTrams(ctx, state, bounds, z);
  drawWildfires(ctx, state, now, z);
  if (currentDark > 0.12) {
    ctx.globalCompositeOperation = 'lighter';
    if (currentDark > 0.15) drawStreetLights(ctx, state.city, bounds, z, true);
    drawVehicleLights(ctx, state, bounds, now, z);
    ctx.globalCompositeOperation = 'source-over';
  }
  drawDistrictLabels(ctx, state, z);
  drawStreams(ctx, state, now);
  drawParticles(ctx, state);
  drawWorldSelection(ctx, state, now, z);

  ctx.restore();

  drawNight(ctx, state, W, H, z);
  drawPhotoGrade(ctx, W, H, state.time);
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

// ---------------------------------------------------------- night lights ---

/**
 * The vehicles' lights at night, drawn additively over the scene: long headlight
 * beams with a pool of light on the road ahead, big alternating red and blue
 * pulses from the light bars of anything responding or working, a floodlight
 * round an engine on scene, and a searchlight under a helicopter.
 */
function drawVehicleLights(ctx, state, bounds, now, z) {
  if (z < 0.1) return;
  const dark = Math.min(1, currentDark * 1.15);
  const pad = 8;
  const phase = Math.floor(now * 7) % 2;
  const pulse = 0.75 + 0.25 * Math.sin(now * 14);
  for (const e of state.engines) {
    const tx = e.x / TILE;
    const ty = e.y / TILE;
    if (tx < bounds.x0 - pad || tx > bounds.x1 + pad || ty < bounds.y0 - pad || ty > bounds.y1 + pad) continue;
    const spec = e.spec ?? {};
    if (spec.boat && !spec.diver) continue;
    const moving = e.path.length > 0;
    const working = moving || e.pumping || e.status === 'on scene' || e.status === 'responding' || e.status === 'transporting';
    const scale = e.type === 'medcar' || e.type === 'rapid' ? 0.7 : e.type === 'ambubus' ? 1.2 : 1;

    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.angle);

    // Headlight beams: two cones with a pool where they land.
    if (moving && !spec.flying) {
      const len = 150 * scale + 20;
      for (const side of [-1, 1]) {
        const x0 = 38 * scale;
        const y0 = side * 11 * scale;
        const beam = ctx.createLinearGradient(x0, 0, x0 + len, 0);
        beam.addColorStop(0, `rgba(255,240,200,${0.5 * dark})`);
        beam.addColorStop(0.5, `rgba(255,236,190,${0.2 * dark})`);
        beam.addColorStop(1, 'rgba(255,236,190,0)');
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.moveTo(x0, y0 - 3 * side);
        ctx.lineTo(x0 + len, y0 + side * 46 - 20);
        ctx.lineTo(x0 + len, y0 + side * 46 + 20);
        ctx.lineTo(x0, y0 + 3 * side);
        ctx.closePath();
        ctx.fill();
      }
      const pool = ctx.createRadialGradient(38 * scale + len * 0.55, 0, 0, 38 * scale + len * 0.55, 0, 90 * scale + 20);
      pool.addColorStop(0, `rgba(255,238,196,${0.34 * dark})`);
      pool.addColorStop(1, 'rgba(255,238,196,0)');
      ctx.fillStyle = pool;
      const px = 38 * scale + len * 0.55;
      ctx.fillRect(px - 120, -120, 240, 240);
      // The lamps themselves.
      for (const side of [-1, 1]) {
        const lamp = ctx.createRadialGradient(40 * scale, side * 11 * scale, 0, 40 * scale, side * 11 * scale, 16);
        lamp.addColorStop(0, `rgba(255,248,224,${0.9 * dark})`);
        lamp.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.fillStyle = lamp;
        ctx.fillRect(40 * scale - 16, side * 11 * scale - 16, 32, 32);
      }
    }

    // Floodlights: an engine working at a scene lights the whole fireground.
    if (!moving && (e.pumping || e.status === 'on scene') && !spec.flying) {
      const r = 150 * scale + 20;
      const flood = ctx.createRadialGradient(30 * scale, 0, 0, 30 * scale, 0, r);
      flood.addColorStop(0, `rgba(255,244,214,${0.42 * dark})`);
      flood.addColorStop(0.5, `rgba(255,236,196,${0.16 * dark})`);
      flood.addColorStop(1, 'rgba(255,236,196,0)');
      ctx.fillStyle = flood;
      ctx.fillRect(30 * scale - r, -r, r * 2, r * 2);
    }

    // The light bar: red and blue (red and white on an ambulance) pulse out across
    // the street, side by side, flashing alternately.
    if (working && !spec.boat) {
      const second = spec.medical ? '255,255,255' : '47,140,255';
      const colours = [['255,59,48', -1], [second, 1]];
      for (const [rgb, side] of colours) {
        const on = (phase === 0) === (side < 0);
        const r = (on ? 130 : 56) * scale + 16;
        const a = (on ? 0.62 : 0.14) * dark * (on ? pulse : 1);
        const cx = 8 * scale;
        const cy = side * 9 * scale;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(${rgb},${a})`);
        g.addColorStop(0.4, `rgba(${rgb},${a * 0.4})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
    }

    // A helicopter's searchlight, sweeping the ground ahead of it.
    if (spec.flying && !spec.plane && (e.path.length > 0 || e.pumping || e.status === 'on scene')) {
      const sx = 46 + Math.sin(now * 1.3) * 10;
      const g = ctx.createRadialGradient(sx, 24, 0, sx, 24, 92);
      g.addColorStop(0, `rgba(235,244,255,${0.5 * dark})`);
      g.addColorStop(0.6, `rgba(220,236,255,${0.18 * dark})`);
      g.addColorStop(1, 'rgba(220,236,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(sx - 92, 24 - 92, 184, 184);
    }
    ctx.restore();
  }
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

// Dark amount of the frame being drawn, shared with the helpers below.
let currentDark = 0;
let currentSun = { dx: 0.3, dy: 0.5 };

// Colour grade: warm low sun at either end of the day, a cool haze when the
// whole city is in view, and a deep blue at night.
function drawNight(ctx, state, W, H, z) {
  const dark = currentDark;
  const hour = (((state.clock / 60) % 24) + 24) % 24;
  const golden = Math.max(0, 1 - Math.abs(hour - 7.5) / 2.2, 1 - Math.abs(hour - 17.2) / 2.2);
  if (golden > 0.01 && dark < 0.6) {
    ctx.fillStyle = `rgba(255,164,84,${0.13 * golden})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (z < 0.35) {
    ctx.fillStyle = `rgba(176,194,212,${0.1 * (1 - z / 0.35) * (1 - dark)})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (dark <= 0.01) return;
  ctx.fillStyle = `rgba(6,14,44,${0.52 * dark})`;
  ctx.fillRect(0, 0, W, H);
}

// Street lights: a post on each junction corner and a pool of warm light
// under it after dark.
function drawStreetLights(ctx, city, b, z, glowPass) {
  if (z < 0.4) return;
  const vr = V_ROADS.filter((vx) => vx + 2 >= b.x0 - 1 && vx <= b.x1 + 1);
  const hr = H_ROADS.filter((hy) => hy + 2 >= b.y0 - 1 && hy <= b.y1 + 1);
  for (const vx of vr) {
    for (const hy of hr) {
      if (hy >= SEA_Y - 1 || !city.road[hy * city.w + vx] || ruralJunction(city, vx, hy)) continue;
      for (const [cx, cy] of [[vx - 0.35, hy - 0.35], [vx + 2.35, hy + 2.35]]) {
        const px = cx * TILE;
        const py = cy * TILE;
        if (glowPass) {
          const r = 120;
          const g = ctx.createRadialGradient(px, py, 0, px, py, r);
          g.addColorStop(0, `rgba(255,214,140,${0.55 * currentDark})`);
          g.addColorStop(0.45, `rgba(255,196,120,${0.2 * currentDark})`);
          g.addColorStop(1, 'rgba(255,190,110,0)');
          ctx.fillStyle = g;
          ctx.fillRect(px - r, py - r, r * 2, r * 2);
        } else {
          ctx.fillStyle = 'rgba(10,12,14,0.3)';
          ctx.beginPath();
          ctx.ellipse(px + 3, py + 3, 3.5, 2.2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#2b2f33';
          ctx.beginPath();
          ctx.arc(px, py, 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = currentDark > 0.3 ? '#ffe6a8' : '#9aa0a6';
          ctx.beginPath();
          ctx.arc(px, py, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}

// ---------------------------------------------------------------- ground ---

function inBounds(b, x, y) {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

// Curvy roads: each is a list of points in tile coordinates, drawn as a smooth
// stroke two tiles wide. Cached bounds let a view skip the ones it cannot see.
const curveBounds = new WeakMap();
function curvesInView(city, b) {
  let list = curveBounds.get(city);
  if (!list) {
    list = (city.curves ?? []).map((curve) => ({
      curve,
      x0: Math.min(...curve.pts.map((p) => p.x)),
      x1: Math.max(...curve.pts.map((p) => p.x)),
      y0: Math.min(...curve.pts.map((p) => p.y)),
      y1: Math.max(...curve.pts.map((p) => p.y)),
    }));
    curveBounds.set(city, list);
  }
  return list
    .filter((e) => !(e.x1 < b.x0 - 2 || e.x0 > b.x1 + 2 || e.y1 < b.y0 - 2 || e.y0 > b.y1 + 2))
    .map((e) => e.curve);
}

/** Trace a curve's points as a smooth path (quadratic curves through the midpoints). */
function traceCurve(ctx, pts, from = 0, to = pts.length - 1) {
  ctx.beginPath();
  ctx.moveTo(pts[from].x * TILE, pts[from].y * TILE);
  for (let i = from + 1; i < to; i++) {
    ctx.quadraticCurveTo(
      pts[i].x * TILE,
      pts[i].y * TILE,
      ((pts[i].x + pts[i + 1].x) / 2) * TILE,
      ((pts[i].y + pts[i + 1].y) / 2) * TILE,
    );
  }
  ctx.lineTo(pts[to].x * TILE, pts[to].y * TILE);
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

  // Forest: a closed canopy of crowns over a dark floor, painted from a tile so
  // a whole forest costs one fill. The trees drawn on top break up the repeat
  // and give the edges their ragged line.
  const forests = (city.forestAreas ?? []).filter((a) => !(a.x1 < b.x0 - 1 || a.x0 > b.x1 + 1 || a.y1 < b.y0 - 1 || a.y0 > b.y1 + 1));
  // One path per forest type, so neighbouring blocks and the strips where
  // streets used to run join without a seam.
  for (const woods of ['mixed', 'pine']) {
    ctx.beginPath();
    let any = false;
    for (const area of forests) {
      if ((area.woods ?? 'mixed') !== woods) continue;
      ctx.rect(area.x0 * TILE, area.y0 * TILE, (area.x1 - area.x0 + 1) * TILE, (area.y1 - area.y0 + 1) * TILE);
      any = true;
    }
    if (!any) continue;
    ctx.fillStyle = canopy(ctx, woods, z >= 0.7 ? 2 : z >= 0.24 ? 1 : 0.25);
    ctx.fill();
  }
  for (const blk of city.blocks ?? []) {
    const tint = ZONE_GROUND[blk.zone];
    if (!tint || blk.x1 < b.x0 || blk.x0 > b.x1 || blk.y1 < b.y0 || blk.y0 > b.y1) continue;
    ctx.fillStyle = tint;
    ctx.fillRect(blk.x0 * TILE, blk.y0 * TILE, (blk.x1 - blk.x0 + 1) * TILE, (blk.y1 - blk.y0 + 1) * TILE);
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
  if (z >= 0.35) drawParkPaths(ctx, city.parks, b);

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

  // Streets: only the stretches that are left of each avenue and street — none
  // in the woods, none in the sea.
  const vRuns = runsInView(city, 'v', vr, b.y0, b.y1);
  const hRuns = runsInView(city, 'h', hr, b.x0, b.x1);
  const roadAt = (x, y) => city.road[y * city.w + x] === 1;
  const curves = curvesInView(city, b);
  // The dark edge of each curvy road goes down first, so the streets it joins
  // are painted over it and the junctions come out clean.
  if (curves.length > 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(24,24,24,0.5)';
    ctx.lineWidth = 2 * TILE + 5;
    for (const c of curves) {
      traceCurve(ctx, c.pts);
      ctx.stroke();
    }
  }
  ctx.fillStyle = asphalt;
  for (const r of vRuns) ctx.fillRect(r.line * TILE, r.a * TILE, 2 * TILE, (r.b - r.a + 1) * TILE);
  for (const r of hRuns) ctx.fillRect(r.a * TILE, r.line * TILE, (r.b - r.a + 1) * TILE, 2 * TILE);

  // Kerbs: a dark gutter line along both sides of every street.
  if (z >= 0.5) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(20,20,20,0.35)';
    ctx.beginPath();
    for (const r of vRuns) {
      const y0 = r.a * TILE;
      const y1 = (r.b + 1) * TILE;
      ctx.moveTo(r.line * TILE + 1, y0); ctx.lineTo(r.line * TILE + 1, y1);
      ctx.moveTo((r.line + 2) * TILE - 1, y0); ctx.lineTo((r.line + 2) * TILE - 1, y1);
    }
    for (const r of hRuns) {
      const x0 = r.a * TILE;
      const x1 = (r.b + 1) * TILE;
      ctx.moveTo(x0, r.line * TILE + 1); ctx.lineTo(x1, r.line * TILE + 1);
      ctx.moveTo(x0, (r.line + 2) * TILE - 1); ctx.lineTo(x1, (r.line + 2) * TILE - 1);
    }
    ctx.stroke();
  }

  // The curvy roads themselves, over the edges of the streets they join, with
  // a dashed centre line that stops short of those junctions.
  if (curves.length > 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = asphalt;
    ctx.lineWidth = 2 * TILE - 2;
    for (const c of curves) {
      traceCurve(ctx, c.pts);
      ctx.stroke();
    }
    if (z >= 0.5) {
      ctx.strokeStyle = PALETTE.centre;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([10, 9]);
      ctx.lineCap = 'butt';
      for (const c of curves) {
        if (c.pts.length < 8) continue;
        traceCurve(ctx, c.pts, 2, c.pts.length - 3);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'butt';
  }

  // Double yellow centre lines, then intersections painted back over them so
  // the lines stop at the junction like they should.
  if (z >= 0.5) {
    ctx.strokeStyle = PALETTE.centre;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const r of vRuns) {
      const x = (r.line + 1) * TILE;
      ctx.moveTo(x - 2, r.a * TILE); ctx.lineTo(x - 2, (r.b + 1) * TILE);
      ctx.moveTo(x + 2, r.a * TILE); ctx.lineTo(x + 2, (r.b + 1) * TILE);
    }
    for (const r of hRuns) {
      const y = (r.line + 1) * TILE;
      ctx.moveTo(r.a * TILE, y - 2); ctx.lineTo((r.b + 1) * TILE, y - 2);
      ctx.moveTo(r.a * TILE, y + 2); ctx.lineTo((r.b + 1) * TILE, y + 2);
    }
    ctx.stroke();
  }

  ctx.fillStyle = asphalt;
  for (const vx of vr) {
    for (const hy of hr) {
      if (roadAt(vx, hy)) ctx.fillRect(vx * TILE, hy * TILE, 2 * TILE, 2 * TILE);
    }
  }

  if (z >= 0.7) {
    for (const vx of vr) {
      for (const hy of hr) {
        if (roadAt(vx, hy) && !ruralJunction(city, vx, hy)) {
          // A crossing only where the street it crosses actually runs on.
          drawCrosswalks(ctx, vx * TILE, hy * TILE, {
            n: hy > 0 && roadAt(vx, hy - 1),
            s: roadAt(vx, hy + 2),
            w: vx > 0 && roadAt(vx - 1, hy),
            e: roadAt(vx + 2, hy),
          });
        }
      }
    }
  }

  drawBridges(ctx, b, z);
  if (z >= 0.3) drawVerges(ctx, city, forests, z);
  drawTracks(ctx, state, b, z);

  drawAirfields(ctx, city, b, z);
  drawBoulevards(ctx, state.city, b, z);
  drawTramRails(ctx, state, b, z);

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

  if (z >= 0.7) drawRoadWear(ctx, city, vr, hr, b);
  drawStreetLights(ctx, city, b, z, false);

  // Trees and hydrants sit on the ground, in front of the streets.
  if (z >= 0.16) {
    const x0 = left - 40;
    const x1 = left + width + 40;
    const y0 = top - 40;
    const y1 = top + height + 40;
    if (z < 0.45) {
      // At map scale a tree is a dot: one path per species, not a fill per tree.
      for (const kind of ['conifer', 'broadleaf', 'birch']) {
        ctx.fillStyle = TREE_DOT[kind];
        ctx.beginPath();
        for (const tree of city.trees) {
          if ((tree.kind ?? 'broadleaf') !== kind) continue;
          if (tree.x < x0 || tree.x > x1 || tree.y < y0 || tree.y > y1) continue;
          if (felled(state, tree)) continue;
          ctx.moveTo(tree.x + tree.r, tree.y);
          ctx.arc(tree.x, tree.y, tree.r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    } else {
      // All the shadows in one path (overlapping shade does not double up),
      // then each crown as a cached sprite.
      const visible = city.trees.filter((t) => t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1 && !felled(state, t));
      const rot = Math.atan2(currentSun.dy, currentSun.dx);
      const stretch = 1 + 0.25 * Math.abs(currentSun.dx);
      ctx.fillStyle = `rgba(10,18,10,${0.32 * (1 - currentDark * 0.85)})`;
      ctx.beginPath();
      for (const t of visible) {
        const cx = t.x + currentSun.dx * t.r * 1.1;
        const cy = t.y + currentSun.dy * t.r * 1.1 + 2;
        const rx = t.r * stretch;
        ctx.moveTo(cx + Math.cos(rot) * rx, cy + Math.sin(rot) * rx);
        ctx.ellipse(cx, cy, rx, t.r * 0.82, rot, 0, Math.PI * 2);
      }
      ctx.fill();
      for (const t of visible) drawTree(ctx, t);
    }
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

let seaGradient = null;

// Bridges, drawn after the roads: concrete parapets along both sides of the
// deck and the deck's shadow on the water downstream.
// ------------------------------------------------------- rail and tram ---

const lineInView = (line, b) => {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of line.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return !(x1 + 3 < b.x0 || x0 - 3 > b.x1 || y1 + 3 < b.y0 || y0 - 3 > b.y1);
};

const tracePolyline = (ctx, line) => {
  ctx.beginPath();
  line.pts.forEach((p, i) => (i === 0 ? ctx.moveTo((p.x + 1) * TILE, (p.y + 1) * TILE) : ctx.lineTo((p.x + 1) * TILE, (p.y + 1) * TILE)));
};

/** One rounded car of a train, centred on (x, y) tiles and pointing along `angle`. */
function drawTrainCar(ctx, car, color, length, width, head) {
  ctx.save();
  ctx.translate(car.x * TILE, car.y * TILE);
  ctx.rotate(car.angle);
  const l = length * TILE;
  const w = width * TILE;
  ctx.fillStyle = head ? '#e9edf0' : '#dfe4e8';
  rr(ctx, -l / 2, -w / 2, l, w, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(-l / 2 + 3, -w / 2 + 3, l - 6, 3);
  ctx.fillStyle = 'rgba(30,40,55,0.8)';
  ctx.fillRect(-l / 2 + 4, -1, l - 8, 2);
  if (head) {
    ctx.fillStyle = '#ffe9a8';
    ctx.fillRect(l / 2 - 3, -w / 2 + 2, 2, 3);
    ctx.fillRect(l / 2 - 3, w / 2 - 5, 2, 3);
  }
  ctx.restore();
}

/** One tram car, centred on (x, y) tiles and pointing along `angle`. */
function drawTramCar(ctx, car, color, head) {
  ctx.save();
  ctx.translate(car.x * TILE, car.y * TILE);
  ctx.rotate(car.angle);
  const l = 1.7 * TILE;
  const w = 0.8 * TILE;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  rr(ctx, -l / 2 + 2, -w / 2 + 4, l, w, 5);
  ctx.fill();
  ctx.fillStyle = color;
  rr(ctx, -l / 2, -w / 2, l, w, 5);
  ctx.fill();
  ctx.fillStyle = '#f1f3f4';
  ctx.fillRect(-l / 2 + 4, -w / 2 + 4, l - 8, 4);
  ctx.fillRect(-l / 2 + 4, w / 2 - 8, l - 8, 4);
  ctx.fillStyle = 'rgba(40,55,70,0.85)';
  for (let x = -l / 2 + 6; x < l / 2 - 8; x += 9) ctx.fillRect(x, -3, 6, 6);
  // The pantograph on the roof.
  ctx.strokeStyle = '#2b2f33';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-4, -4, 8, 8);
  if (head) {
    ctx.fillStyle = '#ffe9a8';
    ctx.fillRect(l / 2 - 3, -w / 2 + 3, 2.5, 4);
    ctx.fillRect(l / 2 - 3, w / 2 - 7, 2.5, 4);
  }
  ctx.restore();
}

/** Tram streets are four tiles wide: new asphalt over the pavement, with a lane line each side of the tram. */
function drawBoulevards(ctx, city, b, z) {
  const wide = city.wide ?? [];
  if (wide.length === 0) return;
  const asphalt = texture(ctx, 'asphalt', PALETTE.road, 1800);
  for (const r of wide) {
    if (r.x1 < b.x0 - 1 || r.x0 > b.x1 + 1 || r.y1 < b.y0 - 1 || r.y0 > b.y1 + 1) continue;
    const horizontal = r.x1 - r.x0 > r.y1 - r.y0;
    // Only the tiles that really became road: the rest keeps its pavement.
    ctx.fillStyle = asphalt;
    for (let y = r.y0; y <= r.y1; y++) {
      let run = -1;
      for (let x = r.x0; x <= r.x1 + 1; x++) {
        const on = x <= r.x1 && city.road[y * city.w + x] === 1;
        if (on && run < 0) run = x;
        if (!on && run >= 0) {
          ctx.fillRect(run * TILE, y * TILE, (x - run) * TILE, TILE);
          run = -1;
        }
      }
    }
    if (z < 0.3) continue;
    ctx.strokeStyle = 'rgba(235,235,225,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    if (horizontal) {
      for (const dy of [1, 3]) { ctx.moveTo(r.x0 * TILE, (r.y0 + dy) * TILE); ctx.lineTo((r.x1 + 1) * TILE, (r.y0 + dy) * TILE); }
    } else {
      for (const dx of [1, 3]) { ctx.moveTo((r.x0 + dx) * TILE, r.y0 * TILE); ctx.lineTo((r.x0 + dx) * TILE, (r.y1 + 1) * TILE); }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** The tram: two rails set into the street, with a platform at each stop. */
function drawTramRails(ctx, state, b, z) {
  const lines = (state.city.transit?.lines ?? []).filter((l) => l.kind === 'tram');
  if (lines.length === 0 || z < 0.2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  for (const line of lines) {
    if (!lineInView(line, b)) continue;
    ctx.strokeStyle = 'rgba(40,36,30,0.28)';
    ctx.lineWidth = 15;
    tracePolyline(ctx, line);
    ctx.stroke();
    // Two rails: a light line either side of the lane's centre.
    for (const off of [-0.3, 0.3]) {
      ctx.strokeStyle = 'rgba(205,208,212,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < line.pts.length; i++) {
        const a = line.pts[i];
        const prev = line.pts[Math.max(0, i - 1)];
        const next = line.pts[Math.min(line.pts.length - 1, i + 1)];
        const dx = Math.sign(next.x - prev.x);
        const dy = Math.sign(next.y - prev.y);
        // The offset is across the direction of travel.
        const ox = dy !== 0 && dx === 0 ? off : 0;
        const oy = dx !== 0 && dy === 0 ? off : 0;
        const px = (a.x + 1 + ox) * TILE;
        const py = (a.y + 1 + oy) * TILE;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    for (const stop of line.stops) {
      if (stop.x < b.x0 - 2 || stop.x > b.x1 + 2 || stop.y < b.y0 - 2 || stop.y > b.y1 + 2) continue;
      ctx.fillStyle = 'rgba(214,203,170,0.85)';
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 3;
      rr(ctx, (stop.x + 1 - 0.9) * TILE, (stop.y + 1 - 0.9) * TILE, 1.8 * TILE, 1.8 * TILE, 5);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The trams themselves, above the traffic, with the overhead wire. */
function drawTrams(ctx, state, b, z) {
  const lines = (state.city.transit?.lines ?? []).filter((l) => l.kind === 'tram');
  if (lines.length === 0 || z < 0.2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  for (const line of lines) {
    if (!lineInView(line, b)) continue;
    if (z >= 0.5) {
      ctx.strokeStyle = 'rgba(30,32,36,0.55)';
      ctx.lineWidth = 1;
      tracePolyline(ctx, line);
      ctx.stroke();
    }
    for (const train of trainsAt(line, state.time)) {
      train.cars.forEach((car, i) => drawTramCar(ctx, car, line.color, i === 0));
    }
  }
  ctx.restore();
}

/** The railway: a viaduct over the street, on pillars, with the trains on top. */
function drawRail(ctx, state, b, z) {
  const lines = (state.city.transit?.lines ?? []).filter((l) => l.kind === 'rail');
  if (lines.length === 0) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  for (const line of lines) {
    if (!lineInView(line, b)) continue;
    // Its shadow on the street below.
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 26;
    ctx.save();
    ctx.translate(7, 12);
    tracePolyline(ctx, line);
    ctx.stroke();
    ctx.restore();
    // Pillars, every few tiles.
    if (z >= 0.3) {
      ctx.fillStyle = '#4c5259';
      for (let d = 0; d <= line.length; d += 5) {
        const p = pointAt(line, d);
        if (p.x < b.x0 - 1 || p.x > b.x1 + 1 || p.y < b.y0 - 1 || p.y > b.y1 + 1) continue;
        ctx.fillRect(p.x * TILE - 4, p.y * TILE - 4 + 6, 8, 8);
      }
    }
    // The deck, lifted a little off the ground.
    ctx.save();
    ctx.translate(0, -8);
    ctx.strokeStyle = '#4a4f56';
    ctx.lineWidth = 26;
    tracePolyline(ctx, line);
    ctx.stroke();
    ctx.strokeStyle = '#8b9199';
    ctx.lineWidth = 22;
    tracePolyline(ctx, line);
    ctx.stroke();
    // Two rails with the ballast between.
    ctx.strokeStyle = '#cfd3d8';
    ctx.lineWidth = 12;
    tracePolyline(ctx, line);
    ctx.stroke();
    ctx.strokeStyle = '#5b5f66';
    ctx.lineWidth = 8;
    tracePolyline(ctx, line);
    ctx.stroke();
    // Stations: a platform canopy over the track.
    for (const stop of line.stops) {
      if (stop.x < b.x0 - 3 || stop.x > b.x1 + 3 || stop.y < b.y0 - 3 || stop.y > b.y1 + 3) continue;
      ctx.fillStyle = 'rgba(150,190,215,0.85)';
      rr(ctx, (stop.x + 1 - 1.6) * TILE, (stop.y + 1 - 1.6) * TILE, 3.2 * TILE, 3.2 * TILE, 6);
      ctx.fill();
      ctx.strokeStyle = '#2f6fa8';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    if (z >= 0.2) {
      for (const train of trainsAt(line, state.time)) {
        train.cars.forEach((car, i) => drawTrainCar(ctx, car, line.color, 1.6, 0.62, i === 0));
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

// ----------------------------------------------------------- airfields ---

const inView = (r, b) => !(r.x1 < b.x0 - 1 || r.x0 > b.x1 + 1 || r.y1 < b.y0 - 1 || r.y0 > b.y1 + 1);
const tileRect = (r) => [r.x0 * TILE, r.y0 * TILE, (r.x1 - r.x0 + 1) * TILE, (r.y1 - r.y0 + 1) * TILE];

/** Runways, taxiways and aprons: flat ground, drawn under the buildings. */
function drawAirfields(ctx, city, b, z) {
  for (const f of city.airfields ?? []) {
    if (!inView(f, b)) continue;
    // The airside is a lighter concrete than the streets, with grass between.
    ctx.fillStyle = '#3d4f3a';
    ctx.fillRect(...tileRect({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 }));
    ctx.fillStyle = '#4b5258';
    ctx.fillRect(...tileRect(f.apron));
    ctx.fillRect(...tileRect(f.forecourt));
    ctx.fillRect(...tileRect(f.gate));
    ctx.fillRect(...tileRect(f.service));
    ctx.fillStyle = '#383d42';
    ctx.fillRect(...tileRect(f.taxi));
    for (const c of f.connectors) ctx.fillRect(...tileRect(c));
    ctx.fillStyle = '#2b2f33';
    ctx.fillRect(...tileRect(f.runway));
    if (z < 0.2) continue;
    // Markings: yellow taxi lines, white runway edges, centre dashes, thresholds.
    ctx.strokeStyle = '#d8b83a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(f.taxi.x0 * TILE, (f.taxi.y0 + 1) * TILE);
    ctx.lineTo((f.taxi.x1 + 1) * TILE, (f.taxi.y0 + 1) * TILE);
    for (const c of f.connectors) {
      ctx.moveTo((c.x0 + 1) * TILE, c.y0 * TILE);
      ctx.lineTo((c.x0 + 1) * TILE, (c.y1 + 1) * TILE);
    }
    ctx.stroke();
    const r = f.runway;
    ctx.strokeStyle = 'rgba(240,240,235,0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x0 * TILE + 6, r.y0 * TILE + 3, (r.x1 - r.x0 + 1) * TILE - 12, (r.y1 - r.y0 + 1) * TILE - 6);
    ctx.setLineDash([26, 22]);
    ctx.beginPath();
    ctx.moveTo((r.x0 + 4) * TILE, (r.y0 + 2) * TILE);
    ctx.lineTo((r.x1 - 3) * TILE, (r.y0 + 2) * TILE);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(240,240,235,0.85)';
    for (const end of [r.x0 + 1, r.x1 - 2]) {
      for (let k = 0; k < 4; k++) ctx.fillRect(end * TILE, (r.y0 + 0.4 + k * 0.9) * TILE, TILE * 1.3, TILE * 0.5);
    }
    // Aircraft stands on the apron.
    ctx.strokeStyle = 'rgba(216,184,58,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = f.apron.x0 + 4; x < f.apron.x1 - 2; x += 10) {
      ctx.moveTo(x * TILE, f.apron.y0 * TILE + 6);
      ctx.lineTo(x * TILE, (f.apron.y1 + 1) * TILE - 6);
    }
    ctx.stroke();
    // A parked airliner or two, for scale.
    if (z >= 0.35) {
      for (let x = f.apron.x0 + 9; x < f.apron.x1 - 8; x += 20) drawAirliner(ctx, x * TILE, (f.apron.y0 + 3.4) * TILE);
    }
  }
}

/** A parked airliner seen from above, nose to the south. */
function drawAirliner(ctx, cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(5, 7, 14, 38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e4e7ea';
  ctx.beginPath();
  ctx.ellipse(0, 0, 8, 38, 0, 0, Math.PI * 2);
  ctx.fill();
  // Wings and tailplane.
  ctx.fillStyle = '#cfd4d8';
  ctx.beginPath();
  ctx.moveTo(-6, -4); ctx.lineTo(-44, 14); ctx.lineTo(-44, 20); ctx.lineTo(-6, 12); ctx.closePath();
  ctx.moveTo(6, -4); ctx.lineTo(44, 14); ctx.lineTo(44, 20); ctx.lineTo(6, 12); ctx.closePath();
  ctx.moveTo(-3, -30); ctx.lineTo(-16, -38); ctx.lineTo(-16, -34); ctx.lineTo(-3, -26); ctx.closePath();
  ctx.moveTo(3, -30); ctx.lineTo(16, -38); ctx.lineTo(16, -34); ctx.lineTo(3, -26); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2f6fa8';
  ctx.fillRect(-1.5, -36, 3, 10);
  ctx.fillStyle = '#5a6770';
  ctx.beginPath();
  ctx.ellipse(0, 31, 4, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBridges(ctx, b, z) {
  if (z < 0.3) return;
  for (const hy of H_ROADS) {
    if (hy >= SEA_Y - 1 || hy + 2 < b.y0 || hy > b.y1 + 1) continue;
    const c = riverCentre(hy + 1);
    const x0 = (c - RIVER_HALF_WIDTH - 0.6) * TILE;
    const x1 = (c + RIVER_HALF_WIDTH + 0.6) * TILE;
    ctx.fillStyle = 'rgba(8,18,24,0.4)';
    ctx.fillRect(x0 + 6, (hy + 2) * TILE, x1 - x0 - 12, 10);
    for (const y of [hy * TILE, (hy + 2) * TILE - 5]) {
      ctx.fillStyle = '#bdbab0';
      ctx.fillRect(x0, y, x1 - x0, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(x0, y + 4, x1 - x0, 1);
    }
    if (z >= 0.6) {
      ctx.fillStyle = '#8f8c83';
      for (let x = x0; x <= x1; x += 24) {
        ctx.fillRect(x, hy * TILE - 1, 4, 7);
        ctx.fillRect(x, (hy + 2) * TILE - 6, 4, 7);
      }
    }
  }
}

// The sea along the south, the river down the east and the dock's jetties.
function drawWater(ctx, state, b, z) {
  const city = state.city;
  const left = b.x0 * TILE;
  const right = (b.x1 + 1) * TILE;

  // Sea: shallow and green-grey against the quay, deep blue further out.
  if (b.y1 >= SEA_Y) {
    const y0 = Math.max(b.y0, SEA_Y) * TILE;
    const y1 = (b.y1 + 1) * TILE;
    if (!seaGradient) {
      seaGradient = ctx.createLinearGradient(0, SEA_Y * TILE, 0, (SEA_Y + 34) * TILE);
      seaGradient.addColorStop(0, '#3e6f78');
      seaGradient.addColorStop(0.25, '#2c5a6c');
      seaGradient.addColorStop(1, '#1b3b4f');
    }
    ctx.fillStyle = seaGradient;
    ctx.fillRect(left, y0, right - left, y1 - y0);
    // The quay: a stone wall with a wet, dark foot.
    ctx.fillStyle = '#7b786c';
    ctx.fillRect(left, SEA_Y * TILE, right - left, 6);
    ctx.fillStyle = 'rgba(10,20,26,0.45)';
    ctx.fillRect(left, SEA_Y * TILE + 6, right - left, 4);
    ctx.fillStyle = 'rgba(235,242,245,0.18)';
    ctx.fillRect(left, SEA_Y * TILE + 10, right - left, 2);
  }

  // River: one smooth polygon down the valley, a darker channel in the middle,
  // grassy banks and a stone embankment at the water's edge.
  const rowTop = Math.max(0, b.y0 - 1);
  const rowBottom = Math.min(SEA_Y, b.y1 + 2);
  if (rowTop <= rowBottom) {
    const hw = RIVER_HALF_WIDTH + 0.25;
    const edge = (side, k) => {
      const pts = [];
      for (let y = rowTop; y <= rowBottom; y++) pts.push([(riverCentre(y) + side * hw * k) * TILE, y * TILE]);
      return pts;
    };
    const leftEdge = edge(-1, 1);
    const rightEdge = edge(1, 1);
    const line = (pts) => {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts) ctx.lineTo(x, y);
    };
    if (z >= 0.3) {
      ctx.strokeStyle = '#4f5a38';
      ctx.lineWidth = 18;
      ctx.beginPath();
      line(leftEdge);
      line(rightEdge);
      ctx.stroke();
    }
    ctx.fillStyle = '#3a6b78';
    ctx.beginPath();
    line(leftEdge);
    for (let i = rightEdge.length - 1; i >= 0; i--) ctx.lineTo(rightEdge[i][0], rightEdge[i][1]);
    ctx.closePath();
    ctx.fill();
    const midL = edge(-1, 0.5);
    const midR = edge(1, 0.5);
    ctx.fillStyle = 'rgba(20,52,66,0.55)';
    ctx.beginPath();
    line(midL);
    for (let i = midR.length - 1; i >= 0; i--) ctx.lineTo(midR[i][0], midR[i][1]);
    ctx.closePath();
    ctx.fill();
    if (z >= 0.35) {
      ctx.strokeStyle = '#7b786c';
      ctx.lineWidth = 4;
      ctx.beginPath();
      line(leftEdge);
      line(rightEdge);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(10,22,28,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      line(edge(-1, 0.94));
      line(edge(1, 0.94));
      ctx.stroke();
    }
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

  // The harbour dock: a jetty beside every berth.
  const dock = city.stations?.[2];
  if (dock && z >= 0.3 && b.y1 >= SEA_Y - 2) {
    ctx.fillStyle = '#8a6a45';
    const front = dock.bays.filter((berth) => !berth.extra);
    const deep = dock.bays.some((berth) => berth.extra);
    for (const berth of front) {
      ctx.fillRect(berth.x + 1.3 * TILE, SEA_Y * TILE, 7, (deep ? 6.6 : 3.2) * TILE);
    }
    ctx.fillStyle = '#7a5d3b';
    ctx.fillRect(front[0].x - 1.2 * TILE, SEA_Y * TILE, (front.length * 3 + 0.4) * TILE, 5);
  }
}

// Patches, cracks, oil stains and manhole covers, scattered deterministically
// along each street so the asphalt looks used.
function drawRoadWear(ctx, city, vr, hr, b) {
  const mark = (px, py, along, id) => {
    const r = hash(id);
    if (r > 0.42) return;
    if (!city.road[Math.floor(py / TILE) * city.w + Math.floor(px / TILE)]) return;
    const kind = Math.floor(r * 10) % 4;
    if (kind === 0) { // manhole
      ctx.fillStyle = 'rgba(18,19,21,0.55)';
      ctx.beginPath(); ctx.arc(px, py, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(120,124,128,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, 5.2, 0, Math.PI * 2); ctx.stroke();
    } else if (kind === 1) { // patch
      ctx.fillStyle = 'rgba(14,15,17,0.28)';
      ctx.fillRect(px - (along ? 4 : 14), py - (along ? 14 : 4), along ? 8 : 28, along ? 28 : 8);
    } else if (kind === 2) { // oil stain
      ctx.fillStyle = 'rgba(10,10,12,0.26)';
      ctx.beginPath(); ctx.ellipse(px, py, 9, 5, r * 6, 0, Math.PI * 2); ctx.fill();
    } else { // crack
      ctx.strokeStyle = 'rgba(10,10,12,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px + (along ? 5 : 12), py + (along ? 12 : 5));
      ctx.lineTo(px + (along ? -2 : 20), py + (along ? 22 : 2)); ctx.stroke();
    }
  };
  for (const vx of vr) {
    for (let ty = b.y0; ty <= b.y1; ty += 2) {
      if (H_ROADS.some((hy) => ty >= hy - 1 && ty <= hy + 2)) continue;
      mark((vx + 0.35 + hash(vx * 7 + ty) * 1.3) * TILE, ty * TILE, true, vx * 977 + ty * 31);
    }
  }
  for (const hy of hr) {
    for (let tx = b.x0; tx <= b.x1; tx += 2) {
      if (V_ROADS.some((vx) => tx >= vx - 1 && tx <= vx + 2)) continue;
      mark(tx * TILE, (hy + 0.35 + hash(hy * 5 + tx) * 1.3) * TILE, false, hy * 853 + tx * 17 + 5);
    }
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
  if (currentDark > 0.25) { // headlight beams
    ctx.globalCompositeOperation = 'lighter';
    const beam = ctx.createLinearGradient(19, 0, 52, 0);
    beam.addColorStop(0, `rgba(255,236,190,${0.4 * currentDark})`);
    beam.addColorStop(1, 'rgba(255,236,190,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(19, -6); ctx.lineTo(54, -16); ctx.lineTo(54, 16); ctx.lineTo(19, 6);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

function drawCrosswalks(ctx, x, y, arms = { n: true, s: true, w: true, e: true }) {
  ctx.fillStyle = PALETTE.crosswalk;
  for (let i = 0; i < 4; i++) {
    if (arms.n) ctx.fillRect(x + 7 + i * 14, y - 13, 7, 11);
    if (arms.s) ctx.fillRect(x + 7 + i * 14, y + 2 * TILE + 2, 7, 11);
    if (arms.w) ctx.fillRect(x - 13, y + 7 + i * 14, 11, 7);
    if (arms.e) ctx.fillRect(x + 2 * TILE + 2, y + 7 + i * 14, 11, 7);
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

// ----------------------------------------------------------------- trees ---

const felled = (state, tree) => state.cutCount > 0
  && state.cut[Math.floor(tree.y / TILE) * state.city.w + Math.floor(tree.x / TILE)] === 1;

const TREE_DOT = { conifer: '#22392a', broadleaf: '#3f5d33', birch: '#5f7a3e' };
const CANOPY_FLAT = { pine: '#1f3426', mixed: '#2a4026' };
const TREE_TONES = {
  conifer: ['#24412c', '#2b4a31', '#203a2a', '#2f4f34'],
  broadleaf: ['#46683a', '#4f7339', '#3d5e32', '#587b3f'],
  birch: ['#6f8a45', '#7a9350', '#66843f'],
};

// One tree crown seen from above, lit from the north-west.
// Conifers are stars of needle whorls stacked toward the leader; broadleaf and
// birch crowns are clusters of leafy lobes with a dark underside and lit tops.
function drawCrown(ctx, x, y, r, kind, tone, seed) {
  if (kind === 'conifer') {
    const spikes = 9 + Math.floor(hash(seed) * 4);
    const rot = hash(seed + 1) * Math.PI;
    const n = spikes * 2;
    for (const [k, amt] of [[1, -0.3], [0.74, -0.1], [0.5, 0.08], [0.24, 0.26]]) {
      const ox = -(1 - k) * r * 0.14;
      const oy = -(1 - k) * r * 0.18;
      ctx.fillStyle = shade(tone, amt);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = rot + k * 0.6 + (i / n) * Math.PI * 2;
        const rad = r * k * (i % 2 ? 0.56 : 1) * (0.86 + 0.28 * hash(seed + i * 1.37));
        const px = x + ox + Math.cos(a) * rad;
        const py = y + oy + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  const birch = kind === 'birch';
  const lobes = birch ? 5 : 7;
  const spin = hash(seed) * 6.283;
  const layers = [[1, 0, 0, -0.34], [0.8, -0.08, -0.1, 0], [0.5, -0.2, -0.24, 0.16]];
  for (const [k, ox, oy, amt] of layers) {
    ctx.fillStyle = shade(tone, amt);
    ctx.beginPath();
    const count = k < 0.6 ? 3 : lobes;
    for (let i = 0; i < count; i++) {
      const a = spin + (i / count) * Math.PI * 2 + (k < 0.6 ? 3.6 : 0);
      const d = r * (k < 0.6 ? 0.22 : 0.4) * (birch ? 1.1 : 1);
      const lr = r * k * (0.5 + 0.14 * hash(seed + i * 2.1 + k)) * (birch ? 0.86 : 1);
      const cx = x + ox * r + Math.cos(a) * d;
      const cy = y + oy * r + Math.sin(a) * d;
      ctx.moveTo(cx + lr, cy);
      ctx.arc(cx, cy, lr, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

// Crowns are drawn once into small sprites (by species, colour, size and one
// of six shapes) and stamped from then on: a vector crown is four or five
// path fills, a sprite is one drawImage.
const crownSprites = new Map();
function crownSprite(kind, tone, r, variant) {
  const rb = Math.max(6, Math.round(r / 2) * 2);
  const key = `${kind}|${tone}|${rb}|${variant}`;
  let sprite = crownSprites.get(key);
  if (!sprite) {
    const k = 2;
    const size = Math.ceil(rb * 2.6);
    const c = document.createElement('canvas');
    c.width = size * k;
    c.height = size * k;
    const g = c.getContext('2d');
    g.scale(k, k);
    drawCrown(g, size / 2, size / 2, rb, kind, tone, variant * 191.3 + 7);
    // Leaf texture and a soft top-left light, clipped to the crown's own shape.
    g.globalCompositeOperation = 'source-atop';
    const seed = variant * 53.1 + rb;
    const n = Math.round(rb * rb * 0.9);
    for (let i = 0; i < n; i++) {
      const a = hash(seed + i * 1.7) * 6.283;
      const d = Math.sqrt(hash(seed + i * 3.1 + 9)) * rb;
      const lit = hash(seed + i * 5.3 + 2) < 0.5;
      g.fillStyle = lit ? 'rgba(190,210,120,0.22)' : 'rgba(8,20,8,0.3)';
      g.fillRect(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, 1.4, 1.4);
    }
    const sheen = g.createRadialGradient(size / 2 - rb * 0.35, size / 2 - rb * 0.4, 0, size / 2, size / 2, rb * 1.1);
    sheen.addColorStop(0, 'rgba(255,250,200,0.16)');
    sheen.addColorStop(1, 'rgba(0,0,20,0.22)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over';
    sprite = { c, size, rb };
    crownSprites.set(key, sprite);
  }
  return sprite;
}

function drawTree(ctx, tree) {
  const variant = Math.floor(hash(tree.x * 0.37 + tree.y * 0.61) * 6);
  const sprite = crownSprite(tree.kind ?? 'broadleaf', tree.tone, tree.r, variant);
  const size = sprite.size * (tree.r / sprite.rb);
  ctx.drawImage(sprite.c, tree.x - size / 2, tree.y - size / 2, size, size);
}

// The repeating forest canopy: hundreds of crowns on a 16-tile square that
// wraps seamlessly. Built once per forest type and resolution: double for
// close zoom, a quarter for the whole-city view.
const canopies = {};
function canopy(ctx, woods, res) {
  const key = `${woods}:${res}`;
  if (canopies[key] !== undefined) return canopies[key];
  canopies[key] = CANOPY_FLAT[woods];
  if (typeof document === 'undefined') return canopies[key];
  const S = 512;
  const k = res;
  const c = document.createElement('canvas');
  c.width = S * k;
  c.height = S * k;
  const g = c.getContext('2d');
  g.scale(k, k);
  g.fillStyle = woods === 'pine' ? '#121f15' : '#182414';
  g.fillRect(0, 0, S, S);
  // Leaf litter and needles on the floor, seen through the gaps.
  let s = woods === 'pine' ? 7771 : 4242;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(70,58,36,0.35)' : 'rgba(30,48,26,0.4)';
    g.fillRect(rnd() * S, rnd() * S, 2, 2);
  }
  const pine = woods === 'pine' ? 0.82 : 0.35;
  const crowns = [];
  for (let i = 0; i < 640; i++) {
    const roll = rnd();
    const kind = roll < pine ? 'conifer' : roll < pine + 0.1 ? 'birch' : 'broadleaf';
    const tones = TREE_TONES[kind];
    crowns.push({
      x: rnd() * S,
      y: rnd() * S,
      r: kind === 'conifer' ? 11 + rnd() * 9 : 13 + rnd() * 10,
      kind,
      tone: tones[Math.floor(rnd() * tones.length)],
      seed: rnd() * 997,
    });
  }
  crowns.sort((a, b) => a.y - b.y);
  for (const t of crowns) {
    for (const dx of [-S, 0, S]) {
      for (const dy of [-S, 0, S]) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (x < -t.r * 2 || x > S + t.r * 2 || y < -t.r * 2 || y > S + t.r * 2) continue;
        g.fillStyle = 'rgba(5,10,6,0.45)';
        g.beginPath();
        g.ellipse(x + t.r * 0.35, y + t.r * 0.5, t.r, t.r * 0.9, 0, 0, Math.PI * 2);
        g.fill();
        drawCrown(g, x, y, t.r, t.kind, t.tone, t.seed);
      }
    }
  }
  const pattern = ctx.createPattern(c, 'repeat');
  if (pattern && k !== 1 && typeof DOMMatrix !== 'undefined') pattern.setTransform(new DOMMatrix().scale(1 / k));
  canopies[key] = pattern ?? CANOPY_FLAT[woods];
  return canopies[key];
}

// A junction with forest on three or four corners is a country crossroads:
// no zebra crossings, no street lamps.
function ruralJunction(city, vx, hy) {
  const woods = city.woods;
  if (!woods) return false;
  let n = 0;
  for (const [x, y] of [[vx - 1, hy - 1], [vx + 2, hy - 1], [vx - 1, hy + 2], [vx + 2, hy + 2]]) {
    if (x >= 0 && y >= 0 && x < city.w && y < city.h && woods[y * city.w + x]) n++;
  }
  return n >= 3;
}

// Where a road runs past a forest, a grass verge and a dirt edge replace the
// kerb, so it reads as a country road through the trees.
function drawVerges(ctx, city, forests, z) {
  const grassy = texture(ctx, 'verge', '#4b5a34', 900);
  const vw = 8;
  const roadAt = (tx, ty) => tx >= 0 && ty >= 0 && tx < city.w && ty < city.h && city.road[ty * city.w + tx] === 1;
  for (const a of forests) {
    if (a.cleared) continue;
    const x = a.x0 * TILE;
    const y = a.y0 * TILE;
    const w = (a.x1 - a.x0 + 1) * TILE;
    const h = (a.y1 - a.y0 + 1) * TILE;
    const mx = Math.floor((a.x0 + a.x1) / 2);
    const my = Math.floor((a.y0 + a.y1) / 2);
    const sides = [
      [roadAt(mx, a.y0 - 1), x, y - vw, w, vw, x, y - vw, x + w, y - vw],
      [roadAt(mx, a.y1 + 1), x, y + h, w, vw, x, y + h + vw, x + w, y + h + vw],
      [roadAt(a.x0 - 1, my), x - vw, y, vw, h, x - vw, y, x - vw, y + h],
      [roadAt(a.x1 + 1, my), x + w, y, vw, h, x + w + vw, y, x + w + vw, y + h],
    ];
    ctx.fillStyle = grassy;
    for (const [road, rx, ry, rw, rh] of sides) if (road) ctx.fillRect(rx, ry, rw, rh);
    if (z >= 0.6) {
      ctx.strokeStyle = 'rgba(92,78,52,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [road, , , , , ax, ay, bx, by] of sides) {
        if (!road) continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }
  }
}

// What is left of each avenue (axis 'v') or street ('h') in view, as
// { line, a, b } tile ranges along it.
const runIndex = new WeakMap();
function runsInView(city, axis, lines, lo, hi) {
  let index = runIndex.get(city);
  if (!index) {
    index = { v: new Map(), h: new Map() };
    for (const k of ['v', 'h']) for (const r of city.roadRuns?.[k] ?? []) index[k].set(r.line, r.spans);
    runIndex.set(city, index);
  }
  const out = [];
  for (const line of lines) {
    const spans = index[axis].get(line) ?? [[0, (axis === 'v' ? Math.min(city.h, SEA_Y) : city.w) - 1]];
    for (const [a, b] of spans) {
      if (b < lo - 2 || a > hi + 2) continue;
      out.push({ line, a: Math.max(a, lo - 2), b: Math.min(b, hi + 2) });
    }
  }
  return out;
}

// Tracks cut through the forest: bare earth with tyre ruts, sawdust, and the
// stumps and stacked logs left along the edges.
function drawTracks(ctx, state, b, z) {
  const cut = state.cut;
  if (!cut || !state.cutCount) return;
  const w = state.city.w;
  const dirt = texture(ctx, 'dirt', '#6b5a43', 1200);
  ctx.fillStyle = dirt;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (cut[y * w + x]) ctx.fillRect(x * TILE - 1, y * TILE - 1, TILE + 2, TILE + 2);
    }
  }
  if (z < 0.5) return;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (!cut[y * w + x]) continue;
      const seed = x * 31.7 + y * 17.3;
      // Ruts where the wheels go.
      ctx.fillStyle = 'rgba(40,30,20,0.25)';
      const vertical = cut[(y - 1) * w + x] || cut[(y + 1) * w + x];
      if (vertical) {
        ctx.fillRect(x * TILE + 8, y * TILE, 4, TILE);
        ctx.fillRect(x * TILE + 20, y * TILE, 4, TILE);
      } else {
        ctx.fillRect(x * TILE, y * TILE + 8, TILE, 4);
        ctx.fillRect(x * TILE, y * TILE + 20, TILE, 4);
      }
      // A stump or a log pile on tiles at the edge of the track.
      const edge = !cut[y * w + x - 1] || !cut[y * w + x + 1] || !cut[(y - 1) * w + x] || !cut[(y + 1) * w + x];
      if (!edge || hash(seed) > 0.55) continue;
      const px = x * TILE + 6 + hash(seed + 1) * 20;
      const py = y * TILE + 6 + hash(seed + 2) * 20;
      if (hash(seed + 3) < 0.6) {
        ctx.fillStyle = '#5a4430';
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c9a77a';
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(90,64,40,0.6)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = i % 2 ? '#6e5338' : '#7d5f40';
          rr(ctx, px - 9, py - 5 + i * 3.6, 18, 3.8, 1.8);
          ctx.fill();
          ctx.fillStyle = '#c9a77a';
          ctx.beginPath();
          ctx.arc(px + 9, py - 3.1 + i * 3.6, 1.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}

// A gravel footpath winding through each park.
function drawParkPaths(ctx, parks, b) {
  ctx.lineCap = 'round';
  for (const p of parks) {
    if (p.x1 < b.x0 || p.x0 > b.x1 || p.y1 < b.y0 || p.y0 > b.y1) continue;
    const w = p.x1 - p.x0 + 1;
    const h = p.y1 - p.y0 + 1;
    if (w < 5 || h < 5) continue;
    const seed = p.x0 * 13.1 + p.y0 * 7.7;
    const x0 = p.x0 * TILE;
    const y0 = p.y0 * TILE;
    const ay = y0 + h * TILE * (0.3 + hash(seed) * 0.4);
    const by = y0 + h * TILE * (0.3 + hash(seed + 1) * 0.4);
    const cx = x0 + w * TILE * (0.3 + hash(seed + 2) * 0.4);
    const cy = y0 + h * TILE * hash(seed + 3);
    for (const [width, colour] of [[11, 'rgba(70,66,50,0.45)'], [8, '#a89c7e']]) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x0, ay);
      ctx.quadraticCurveTo(cx, cy, x0 + w * TILE, by);
      ctx.stroke();
    }
  }
  ctx.lineCap = 'butt';
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

// Where the sun is: shadows swing from west in the morning to east in the
// evening and are longest at the ends of the day. Returned as a unit-ish
// vector scaled by building height.
function sunShadow(clock) {
  const h = (((clock / 60) % 24) + 24) % 24;
  const t = clamp((h - 6) / 13, 0, 1);
  const side = 2 * t - 1;
  const len = 0.45 + 0.9 * side * side;
  return { dx: side * len * 1.1, dy: 0.35 + 0.25 * len };
}

function drawBuildingShadows(ctx, state, bounds) {
  const sun = sunShadow(state.clock);
  const fade = 1 - currentDark * 0.9;
  if (fade <= 0.05) return;
  // Shadow of a block = its footprint swept along the shadow vector. Rects in
  // one path share a winding, so overlaps never double-darken.
  ctx.fillStyle = `rgba(12,17,22,${0.3 * fade})`;
  ctx.beginPath();
  for (const b of state.buildings) {
    if (b.state === 'rubble' || !buildingVisible(b, bounds)) continue;
    const sx = sun.dx * b.elevation;
    const sy = sun.dy * b.elevation + 4;
    const steps = Math.min(14, Math.max(2, Math.ceil(Math.hypot(sx, sy) / 5)));
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      ctx.rect(b.x * TILE + sx * k, b.y * TILE + sy * k, b.w * TILE, b.h * TILE);
    }
  }
  ctx.fill();
  // Ambient occlusion: a tight dark halo where walls meet the ground, fading out.
  for (const [grow, alpha] of [[7, 0.07], [4, 0.09], [2, 0.12]]) {
    ctx.fillStyle = `rgba(8,10,12,${alpha * fade})`;
    ctx.beginPath();
    for (const b of state.buildings) {
      if (b.state === 'rubble' || !buildingVisible(b, bounds)) continue;
      ctx.rect(b.x * TILE - grow, b.y * TILE - grow * 0.5, b.w * TILE + grow * 2, b.h * TILE + grow * 1.5);
    }
    ctx.fill();
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
  ctx.fillStyle = wallColor(b);
  ctx.fillRect(x, facadeTop, w, e);
  if ((b.type === 'office' || b.type === 'tower') && detailed) drawCurtainWall(ctx, b, x, facadeTop, w, e);
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

  if (detailed && b.type !== 'station' && b.type !== 'office' && b.type !== 'tower' && b.type !== 'tankfarm') drawFacadeWindows(ctx, b, x, facadeTop, w, e);
  if (detailed && b.type !== 'station') drawEntrance(ctx, b, x, facadeTop, w, e, z);
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

  if (detailed && (b.type === 'house' || b.type === 'villa')) drawPitchedRoof(ctx, b, x, y - e, w, h);
  if (detailed && (b.type === 'warehouse' || b.type === 'factory')) drawCorrugation(ctx, x, y - e, w, h);
  if (b.type === 'tankfarm') drawTankFarm(ctx, b, x, y - e, w, h);
  if (b.type === 'factory') drawStacks(ctx, b, x, y - e, w, h, e);
  if (b.type === 'tower') drawMast(ctx, b, x, y - e, w, h);
  if (detailed) drawRoofDetails(ctx, b, x, y - e, w, h);
  if (b.type === 'terminal') drawTerminalRoof(ctx, x, y - e, w, h);
  if (b.type === 'hangar') drawHangarRoof(ctx, x, y - e, w, h);
  if (b.type === 'railstation') drawRailRoof(ctx, x, y - e, w, h);
  if (b.type === 'tramstop') drawTramMark(ctx, x, y - e, w, h);
  if (b.type === 'pharmacy') drawPharmacyMark(ctx, x, y - e, w, h);
  if (b.type === 'hospital') drawHospitalMark(ctx, x, y - e, w, h, detailed);
  if (detailed && b.type === 'station') drawStationFace(
    ctx, b, x, facadeTop, w, e, z,
    b.stationIndex > 0 && !state.ownedStations?.[b.stationIndex],
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

const WALLS = {
  house: ['#d9cfba', '#cbbfa8', '#bfc5b8', '#d2c3ab'],
  apartment: ['#9a5d4b', '#a66a52', '#8d5a49'],
  shop: ['#a8785a', '#b59a7c', '#9a7b62'],
  office: ['#5d7384'],
  hotel: ['#cdbd9e', '#c2b08f', '#d3c6aa'],
  warehouse: ['#8e9498', '#9a9f9c', '#80878c'],
  villa: ['#e6dcc6', '#ddd0b4', '#e8e0d0'],
  tower: ['#5d7384'],
  mall: ['#b9b4a8', '#c4bfb2', '#aeb0b0'],
  factory: ['#8a8f92', '#9b9d98', '#7b8286'],
  school: ['#a56a4c', '#b57a58', '#9a6248'],
  tankfarm: ['#9aa0a4'],
  terminal: ['#b8c2c9', '#aab6be'],
  hangar: ['#8d9498', '#80878c'],
  railstation: ['#a89a86', '#9d8f7b'],
  tramstop: ['#8d97a0', '#838d96'],
  pharmacy: ['#e3e6e2'],
  hospital: ['#e6e8e6'],
  station: ['#a2503f'],
};

function wallColor(b) {
  const list = WALLS[b.type] ?? WALLS.house;
  return list[Math.floor(hashString(b.id) * 7) % list.length];
}

// Glass curtain wall: pale sky reflection fading down, with mullions.
function drawCurtainWall(ctx, b, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#7fa0b4');
  g.addColorStop(0.5, '#4d6a7e');
  g.addColorStop(1, '#34495a');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const seed = hashString(b.id);
  ctx.strokeStyle = 'rgba(20,30,40,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const cols = Math.max(3, Math.round(w / 14));
  for (let c = 1; c < cols; c++) { ctx.moveTo(x + (w * c) / cols, y); ctx.lineTo(x + (w * c) / cols, y + h); }
  for (let r = 1; r < Math.max(1, b.floors); r++) { ctx.moveTo(x, y + (h * r) / b.floors); ctx.lineTo(x + w, y + (h * r) / b.floors); }
  ctx.stroke();
  // Lit offices after dark.
  if (currentDark > 0.2) {
    for (let r = 0; r < b.floors; r++) {
      for (let c = 0; c < cols; c++) {
        if (hash(seed + r * 61 + c * 29) > 0.55 * currentDark) continue;
        ctx.fillStyle = 'rgba(255,226,150,0.65)';
        ctx.fillRect(x + (w * c) / cols + 1, y + (h * r) / b.floors + 1, w / cols - 2, h / b.floors - 2);
      }
    }
  }
}

// A front door; shops get a striped awning and a name board.
function drawEntrance(ctx, b, x, y, w, h, z) {
  const seed = hashString(b.id);
  const dw = Math.min(14, w * 0.2);
  const dh = Math.min(h * 0.5, 13);
  const dx = x + w * (0.3 + hash(seed) * 0.4) - dw / 2;
  ctx.fillStyle = '#2a2623';
  ctx.fillRect(dx, y + h - dh, dw, dh);
  ctx.fillStyle = 'rgba(210,190,140,0.5)';
  ctx.fillRect(dx, y + h - dh, dw, 1.5);
  if (b.type !== 'shop' && b.type !== 'pharmacy') return;
  const colors = [['#b8372c', '#efe8da'], ['#2f6a8f', '#efe8da'], ['#2f7a52', '#efe8da'], ['#c08a2e', '#efe8da']][Math.floor(seed * 3) % 4];
  const ah = Math.min(9, h * 0.22);
  const ay = y + h - h * 0.62;
  const n = Math.max(4, Math.round(w / 8));
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[i % 2];
    ctx.fillRect(x + (w * i) / n, ay, w / n + 0.5, ah);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(x, ay + ah, w, 2);
  if (z >= 0.9 && w >= 60) {
    ctx.fillStyle = '#1f2326';
    ctx.fillRect(x + w * 0.1, y + 2, w * 0.8, Math.max(6, h * 0.17));
    ctx.fillStyle = '#e9e3d2';
    ctx.font = `600 ${Math.max(5, h * 0.12)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((b.name ?? '').toUpperCase().slice(0, 16), x + w / 2, y + 2 + Math.max(6, h * 0.17) / 2 + 0.5);
  }
}

// A gabled roof: ridge along the long axis, the sun-facing (south) slope lit
// and the north slope in shade, with shingle courses.
function drawPitchedRoof(ctx, b, x, y, w, h) {
  const alongX = w >= h;
  ctx.fillStyle = 'rgba(255,240,215,0.14)';
  if (alongX) ctx.fillRect(x, y + h / 2, w, h / 2); else ctx.fillRect(x + w / 2, y, w / 2, h);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  if (alongX) ctx.fillRect(x, y, w, h / 2); else ctx.fillRect(x, y, w / 2, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 5;
  if (alongX) for (let yy = y + step; yy < y + h; yy += step) { ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); }
  else for (let xx = x + step; xx < x + w; xx += step) { ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (alongX) { ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); } else { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); }
  ctx.stroke();
}

function drawCorrugation(ctx, x, y, w, h) {
  ctx.strokeStyle = 'rgba(0,0,0,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let xx = x + 4; xx < x + w; xx += 4) { ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); }
  ctx.stroke();
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

      const lit = hash(seed + r * 71 + c * 37) < 0.08 + 0.6 * currentDark;
      let color = lit ? (currentDark > 0.2 ? '#ffd98a' : '#e8cf98') : '#303a44';
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

// A glass-roofed terminal: long skylights, and a pale sign.
function drawTerminalRoof(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(150,190,215,0.55)';
  const n = Math.max(3, Math.floor(w / 36));
  for (let i = 0; i < n; i++) ctx.fillRect(x + 8 + (i * (w - 16)) / n, y + 8, (w - 16) / n - 6, h - 16);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 6.5, y + 6.5, w - 13, h - 13);
}

// An aircraft hangar: a barrel roof, ribbed across.
function drawHangarRoof(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(x, y, w, h / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(x, y + h / 2, w, h / 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let xx = x + 10; xx < x + w; xx += 10) { ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); }
  ctx.stroke();
}

// A railway terminus: a vaulted shed over the platforms, with the tracks showing
// through the glass.
function drawRailRoof(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(190,200,205,0.28)';
  ctx.fillRect(x + 6, y + 6, w - 12, h - 12);
  ctx.strokeStyle = 'rgba(60,66,72,0.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const lanes = Math.max(3, Math.floor(h / 24));
  for (let i = 0; i < lanes; i++) {
    const yy = y + 12 + (i * (h - 24)) / Math.max(1, lanes - 1);
    ctx.moveTo(x + 8, yy); ctx.lineTo(x + w - 8, yy);
    ctx.moveTo(x + 8, yy + 4); ctx.lineTo(x + w - 8, yy + 4);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  for (let xx = x + 18; xx < x + w - 10; xx += 18) { ctx.moveTo(xx, y + 4); ctx.lineTo(xx, y + h - 4); }
  ctx.stroke();
}

// A tram stop: a shelter roof with a yellow tram sign.
function drawTramMark(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(150,190,215,0.5)';
  ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
  const r = Math.min(w, h) * 0.22;
  ctx.fillStyle = '#e8b923';
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2b2f33';
  ctx.fillRect(x + w / 2 - r * 0.55, y + h / 2 - r * 0.35, r * 1.1, r * 0.7);
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

/** A fuel tank farm: a bunded yard of round tanks seen from above. */
function drawTankFarm(ctx, b, x, y, w, h) {
  ctx.fillStyle = '#5a6066';
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  const cols = Math.max(2, Math.round(w / 92));
  const rows = Math.max(1, Math.round(h / 92));
  const rx = (w - 10) / cols;
  const ry = (h - 10) / rows;
  const r = Math.min(rx, ry) / 2 - 4;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = x + 5 + rx * (i + 0.5);
      const cy = y + 5 + ry * (j + 0.5);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.arc(cx + 4, cy + 4, r, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      g.addColorStop(0, '#e4e8ea');
      g.addColorStop(1, '#8f979c');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#6b737a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#c0453a';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, r * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Chimney stacks on a factory roof. */
function drawStacks(ctx, b, x, y, w, h, e) {
  const n = w > 18 * TILE ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const sx = x + w * (0.2 + (0.6 * (i + hash(hashString(b.id) + i))) / n);
    const sy = y + h * (0.25 + 0.3 * hash(hashString(b.id) * 3 + i));
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(sx + 5, sy + 5, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8c8279';
    ctx.beginPath();
    ctx.arc(sx, sy - 14, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(sx - 7, sy - 14, 14, 14);
    ctx.fillStyle = '#5d554e';
    ctx.beginPath();
    ctx.arc(sx, sy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a2724';
    ctx.beginPath();
    ctx.arc(sx, sy - 14, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A tower's roof gear: a helipad ring and a mast. */
function drawMast(ctx, b, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.strokeStyle = 'rgba(235,235,225,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.min(w, h) * 0.28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#2d3238';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.78, y + h * 0.78);
  ctx.lineTo(x + w * 0.78, y + h * 0.78 - 26);
  ctx.stroke();
  ctx.fillStyle = '#d63a30';
  ctx.beginPath();
  ctx.arc(x + w * 0.78, y + h * 0.78 - 26, 2.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawRoofDetails(ctx, b, x, y, w, h) {
  if (b.type === 'pharmacy' || b.type === 'hospital' || b.type === 'tankfarm') return;
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

  // Heat glow, additive so it lights the street at night instead of greying it.
  const glowR = Math.max(w, h) * (0.7 + f * 0.7) * (1 + currentDark * 0.8);
  const boost = 1 + currentDark * 0.9;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glow.addColorStop(0, `rgba(255,150,50,${0.4 * f * boost})`);
  glow.addColorStop(0.45, `rgba(255,86,14,${0.18 * f * boost})`);
  glow.addColorStop(1, 'rgba(255,60,0,0)');
  ctx.fillStyle = glow;
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
  ctx.globalCompositeOperation = 'source-over';

  const count = 2 + Math.round(f * 5);
  for (let i = 0; i < count; i++) {
    const px = x + (0.1 + hash(seed + i * 13.7) * 0.8) * w;
    const py = y + (0.12 + hash(seed + i * 7.3 + 40) * 0.8) * h;
    const flick = 0.72 + 0.28 * Math.sin(now * 9 + i * 1.9 + seed);
    const height = (16 + f * 34) * flick;
    const width = (7 + f * 10) * flick;

    // Flame tongue: ragged, licking upward and bending with the wind.
    const sway = Math.sin(now * 5 + i * 2.3 + seed) * width * 0.5;
    const tongue = ctx.createLinearGradient(px, py, px + sway, py - height);
    tongue.addColorStop(0, 'rgba(150,40,8,0.85)');
    tongue.addColorStop(0.3, 'rgba(235,98,18,0.8)');
    tongue.addColorStop(0.65, 'rgba(250,165,50,0.55)');
    tongue.addColorStop(1, 'rgba(255,190,80,0)');
    ctx.fillStyle = tongue;
    ctx.beginPath();
    ctx.moveTo(px - width, py);
    const steps = 6;
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const lean = sway * u * u;
      const jag = (hash(seed + i * 9.1 + k * 3.7 + Math.floor(now * 8) * 0.31) - 0.5) * width * 0.7;
      ctx.lineTo(px - width * (1 - u) * 0.9 + lean + jag, py - height * u);
    }
    for (let k = steps - 1; k >= 0; k--) {
      const u = k / steps;
      const lean = sway * u * u;
      const jag = (hash(seed + i * 4.3 + k * 6.1 + Math.floor(now * 8) * 0.17) - 0.5) * width * 0.7;
      ctx.lineTo(px + width * (1 - u) * 0.9 + lean + jag, py - height * u);
    }
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
  // High wing with aileron lines, tailplane, tapered fuselage.
  ctx.fillStyle = '#e6e2d6';
  ctx.fillRect(-6, -52, 18, 104);
  ctx.fillStyle = '#c93a2f';
  ctx.fillRect(-6, -52, 18, 6);
  ctx.fillRect(-6, 46, 18, 6);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(8, -50);
  ctx.lineTo(8, 50);
  ctx.moveTo(-6, -30);
  ctx.lineTo(12, -30);
  ctx.moveTo(-6, 30);
  ctx.lineTo(12, 30);
  ctx.stroke();
  ctx.fillStyle = '#d6d2c5';
  ctx.fillRect(-58, -20, 12, 40);
  ctx.fillStyle = '#c93a2f';
  ctx.fillRect(-58, -20, 12, 3);
  ctx.fillRect(-58, 17, 12, 3);
  const fg = ctx.createLinearGradient(0, -11, 0, 11);
  fg.addColorStop(0, '#fbf8ef');
  fg.addColorStop(0.5, '#ece8dc');
  fg.addColorStop(1, '#b3b0a4');
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.moveTo(54, 0);
  ctx.quadraticCurveTo(46, -11, 28, -11);
  ctx.lineTo(-52, -5);
  ctx.lineTo(-52, 5);
  ctx.lineTo(28, 11);
  ctx.quadraticCurveTo(46, 11, 54, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#c93a2f';
  ctx.fillRect(-42, -2.5, 72, 5);
  ctx.fillStyle = '#bfc4c9'; // fin
  ctx.fillRect(-56, -1, 14, 2);
  const cg = ctx.createLinearGradient(30, -6, 42, 6);
  cg.addColorStop(0, '#5f8199');
  cg.addColorStop(1, '#101c27');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.ellipse(37, 0, 8, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8b9095'; // engine nacelles
  for (const y of [-22, 22]) {
    ctx.beginPath();
    ctx.ellipse(8, y, 12, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
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

  // Hull: gradient paint, white gunwale, a dark boot-top line.
  const hull = () => {
    ctx.beginPath();
    ctx.moveTo(48, 0);
    ctx.quadraticCurveTo(38, -17, 8, -18);
    ctx.lineTo(-38, -16);
    ctx.lineTo(-38, 16);
    ctx.lineTo(8, 18);
    ctx.quadraticCurveTo(38, 17, 48, 0);
    ctx.closePath();
  };
  const base = fire ? '#b3261e' : '#e0651a';
  const hg = ctx.createLinearGradient(0, -18, 0, 18);
  hg.addColorStop(0, shade(base, 0.22));
  hg.addColorStop(0.5, base);
  hg.addColorStop(1, shade(base, -0.35));
  ctx.fillStyle = hg;
  hull();
  ctx.fill();
  ctx.strokeStyle = 'rgba(245,245,240,0.85)';
  ctx.lineWidth = 1.6;
  hull();
  ctx.stroke();

  // Foam at the bow and stern.
  ctx.fillStyle = 'rgba(240,248,252,0.5)';
  ctx.beginPath();
  ctx.ellipse(46, 0, 5, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-42, -9, 5, 18);

  if (fire) {
    // Deck in non-slip grey, a wheelhouse with raked glass, mast and monitor.
    ctx.fillStyle = '#8d9398';
    ctx.beginPath();
    ctx.moveTo(42, 0);
    ctx.quadraticCurveTo(34, -12, 8, -13);
    ctx.lineTo(-34, -12);
    ctx.lineTo(-34, 12);
    ctx.lineTo(8, 13);
    ctx.quadraticCurveTo(34, 12, 42, 0);
    ctx.closePath();
    ctx.fill();
    const wg = ctx.createLinearGradient(0, -11, 0, 11);
    wg.addColorStop(0, '#f6f3ea');
    wg.addColorStop(1, '#b9b6aa');
    ctx.fillStyle = wg;
    rr(ctx, -24, -11, 30, 22, 4);
    ctx.fill();
    const gg = ctx.createLinearGradient(2, 0, 8, 0);
    gg.addColorStop(0, '#0e161d');
    gg.addColorStop(1, '#58788f');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.moveTo(1, -9);
    ctx.lineTo(8, -10);
    ctx.lineTo(8, 10);
    ctx.lineTo(1, 9);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#3a3f45';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(-12, -2);
    ctx.stroke();
    ctx.fillStyle = '#2c3136';
    ctx.fillRect(-18, -2, 12, 1.4); // radar bar
    // Water monitor on the foredeck.
    ctx.fillStyle = '#d8dadc';
    ctx.beginPath();
    ctx.arc(26, 0, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2f3438';
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(26, 0);
    ctx.lineTo(39, 0);
    ctx.stroke();
    ctx.fillStyle = '#ff6a3d'; // life rings
    ctx.beginPath();
    ctx.arc(-30, -9, 2.6, 0, Math.PI * 2);
    ctx.arc(-30, 9, 2.6, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Inflatable tubes with seams, a floor, console with screen and outboard.
    ctx.fillStyle = '#8f8a80';
    ctx.beginPath();
    ctx.moveTo(40, 0);
    ctx.quadraticCurveTo(34, -11, 8, -12);
    ctx.lineTo(-34, -11);
    ctx.lineTo(-34, 11);
    ctx.lineTo(8, 12);
    ctx.quadraticCurveTo(34, 11, 40, 0);
    ctx.closePath();
    ctx.fill();
    for (const side of [-1, 1]) {
      const tube = ctx.createLinearGradient(0, side * 12, 0, side * 19);
      tube.addColorStop(0, side < 0 ? '#c9501a' : '#f08a3c');
      tube.addColorStop(1, side < 0 ? '#f08a3c' : '#c9501a');
      ctx.strokeStyle = tube;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(47, 0);
      ctx.quadraticCurveTo(38, side * 16, 8, side * 16.5);
      ctx.lineTo(-36, side * 14.5);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -30; x <= 30; x += 12) {
      ctx.moveTo(x, -19);
      ctx.lineTo(x, -13);
      ctx.moveTo(x, 19);
      ctx.lineTo(x, 13);
    }
    ctx.stroke();
    ctx.fillStyle = '#e9e6dc';
    rr(ctx, -10, -7, 18, 14, 3);
    ctx.fill();
    ctx.fillStyle = '#17222d';
    ctx.fillRect(4, -5, 3, 10);
    ctx.fillStyle = '#2b3035'; // outboard
    rr(ctx, -42, -5, 9, 10, 2);
    ctx.fill();
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

  // Tail boom tapering to a fin, with a horizontal stabiliser.
  ctx.fillStyle = '#c4c9ce';
  ctx.beginPath();
  ctx.moveTo(-14, -5.5);
  ctx.lineTo(-62, -1.8);
  ctx.lineTo(-62, 1.8);
  ctx.lineTo(-14, 5.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#b6342b';
  ctx.fillRect(-64, -1.1, 14, 2.2);
  ctx.fillStyle = '#d3d7da';
  ctx.fillRect(-60, -9, 7, 18);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(-60, -9, 7, 18);

  // Skids with cross tubes.
  ctx.strokeStyle = '#2c3136';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-24, -17);
  ctx.lineTo(26, -17);
  ctx.moveTo(-24, 17);
  ctx.lineTo(26, 17);
  ctx.moveTo(-10, -17);
  ctx.lineTo(-10, 17);
  ctx.moveTo(14, -17);
  ctx.lineTo(14, 17);
  ctx.stroke();

  // Fuselage: lit from above, white belly line, engine deck, canopy glass.
  const fg = ctx.createLinearGradient(0, -15, 0, 15);
  fg.addColorStop(0, '#ec5a4c');
  fg.addColorStop(0.45, '#c3342a');
  fg.addColorStop(1, '#7c1c16');
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.ellipse(-2, 0, 31, 14.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#efeadd';
  ctx.fillRect(-24, -2.4, 28, 4.8);
  ctx.fillStyle = '#7d8388';
  ctx.beginPath();
  ctx.ellipse(-10, 0, 9, 6.5, 0, 0, Math.PI * 2);
  ctx.fill();
  const cg = ctx.createLinearGradient(8, -10, 26, 10);
  cg.addColorStop(0, '#6f94ad');
  cg.addColorStop(0.5, '#1f3445');
  cg.addColorStop(1, '#0d1822');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.ellipse(17, 0, 12.5, 10.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.ellipse(19, -4, 6, 2.6, -0.4, 0, Math.PI * 2);
  ctx.fill();

  // Main rotor: a faint disc, a ghost pair of blades and the sharp pair.
  const spin = now * 26;
  const disc = ctx.createRadialGradient(0, 0, 8, 0, 0, 52);
  disc.addColorStop(0, 'rgba(210,220,230,0.16)');
  disc.addColorStop(1, 'rgba(210,220,230,0.04)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(0, 0, 52, 0, Math.PI * 2);
  ctx.fill();
  for (const [off, alpha] of [[-0.35, 0.2], [0, 0.85]]) {
    ctx.strokeStyle = `rgba(34,38,42,${alpha})`;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    for (const q of [0, Math.PI / 2]) {
      const a = spin + off + q;
      ctx.moveTo(Math.cos(a) * 52, Math.sin(a) * 52);
      ctx.lineTo(-Math.cos(a) * 52, -Math.sin(a) * 52);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#23272b';
  ctx.beginPath();
  ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6a7076';
  ctx.beginPath();
  ctx.arc(-1, -1, 2, 0, Math.PI * 2);
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

// Painted body panel: lit from the north-west, darker toward the south edge,
// with a thin dark seam so panels read as sheet metal.
function paint(ctx, x, y, w, h, r, color) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, shade(color, 0.2));
  g.addColorStop(0.45, color);
  g.addColorStop(1, shade(color, -0.3));
  ctx.fillStyle = g;
  rr(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  // Clear-coat reflection: a thin bright band along the upper body panel.
  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.clip();
  const sheen = ctx.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.18, 'rgba(255,255,255,0.22)');
  sheen.addColorStop(0.3, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function tyres(ctx, xs, y) {
  for (const wx of xs) {
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#0d0f11';
      rr(ctx, wx - 7, s * y - 4.5, 14, 9, 3);
      ctx.fill();
      ctx.fillStyle = '#2a2e32';
      ctx.fillRect(wx - 4, s * y - 2, 8, 4);
    }
  }
}

// Cab: roof, raked windscreen with sky reflection, mirrors, headlamps.
function cab(ctx, x0, w, color) {
  paint(ctx, x0, -17, w, 34, 5, color);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(x0 + 3, -13, w * 0.42, 26);
  const gl = ctx.createLinearGradient(x0 + w - 11, 0, x0 + w - 2, 0);
  gl.addColorStop(0, '#0e161d');
  gl.addColorStop(0.6, '#26384a');
  gl.addColorStop(1, '#5d7d95');
  ctx.fillStyle = gl;
  ctx.beginPath();
  ctx.moveTo(x0 + w - 11, -13);
  ctx.lineTo(x0 + w - 3, -15);
  ctx.lineTo(x0 + w - 3, 15);
  ctx.lineTo(x0 + w - 11, 13);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x0 + w - 9, -12, 1.5, 24);
  ctx.fillStyle = '#16191c';
  ctx.fillRect(x0 + w - 12, -20.5, 4, 3.5);
  ctx.fillRect(x0 + w - 12, 17, 4, 3.5);
  ctx.fillStyle = '#fff3cf';
  ctx.fillRect(x0 + w - 1.5, -14, 2, 5);
  ctx.fillRect(x0 + w - 1.5, 9, 2, 5);
  if (currentDark > 0.25) {
    ctx.globalCompositeOperation = 'lighter';
    const beam = ctx.createLinearGradient(x0 + w, 0, x0 + w + 46, 0);
    beam.addColorStop(0, `rgba(255,236,190,${0.42 * currentDark})`);
    beam.addColorStop(1, 'rgba(255,236,190,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(x0 + w, -13);
    ctx.lineTo(x0 + w + 50, -26);
    ctx.lineTo(x0 + w + 50, 26);
    ctx.lineTo(x0 + w, 13);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}

// Diamond-plate walkway.
function plate(ctx, x, y, w, h) {
  ctx.fillStyle = '#8d9399';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let px = x + 3; px < x + w; px += 5) {
    ctx.moveTo(px, y);
    ctx.lineTo(px - 3, y + h);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.strokeRect(x, y, w, h);
}

// Roller-shutter lockers down both sides.
function lockers(ctx, x0, x1) {
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x0, -18, x1 - x0, 4);
  ctx.fillRect(x0, 14, x1 - x0, 4);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = x0 + 4; x < x1; x += 6) {
    ctx.moveTo(x, -18);
    ctx.lineTo(x, -14);
    ctx.moveTo(x, 14);
    ctx.lineTo(x, 18);
  }
  ctx.stroke();
}

// Rear chevrons: red and fluorescent yellow, the way real appliances are marked.
function chevrons(ctx, x, w = 5) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, -17, w, 34);
  ctx.clip();
  for (let i = -3; i < 7; i++) {
    ctx.fillStyle = i % 2 ? '#d62d24' : '#e8e04a';
    ctx.beginPath();
    ctx.moveTo(x, -17 + i * 6);
    ctx.lineTo(x + w, -17 + i * 6 + w);
    ctx.lineTo(x + w, -17 + i * 6 + w + 6);
    ctx.lineTo(x, -17 + i * 6 + 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// Coiled hose in a hose bed.
function hoseBed(ctx, x, y, w, h) {
  ctx.fillStyle = '#23272b';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#c9b15a';
  ctx.lineWidth = 2.4;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(x + w * (0.2 + i * 0.3), y + h / 2, w * 0.13, h * 0.38, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Emergency lights: a bar with a glow that alternates when the unit is working.
function lightBar(ctx, x, busy, now, colors = ['#ff3b30', '#2f8cff']) {
  const phase = Math.floor(now * 7) % 2;
  ctx.fillStyle = '#1a1d20';
  ctx.fillRect(x - 1.5, -13, 7, 26);
  for (let i = 0; i < 4; i++) {
    const left = i < 2;
    const on = busy && ((phase === 0) === left);
    const c = colors[left ? 0 : 1];
    ctx.fillStyle = on ? c : shade(c, -0.6);
    const y = -12 + i * 6.2;
    ctx.fillRect(x - 0.5, y, 5, 5);
    if (on) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x + 2, y + 2.5, 0, x + 2, y + 2.5, 22);
      g.addColorStop(0, c + 'aa');
      g.addColorStop(1, c + '00');
      ctx.fillStyle = g;
      ctx.fillRect(x - 20, y - 20, 44, 44);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

function drawEngine(ctx, e, now) {
  const type = e.type ?? 'engine';
  const label = `${e.spec?.tag ?? (e.spec?.label ?? 'Engine')[0]}${e.number}`;
  const busy = e.status === 'responding' || e.pumping;

  ctx.save();
  ctx.translate(e.x, e.y);

  // Ground shadow, thrown by the sun and rotated with the vehicle.
  ctx.save();
  ctx.translate(currentSun.dx * 9 + 3, currentSun.dy * 9 + 4);
  ctx.rotate(e.angle);
  ctx.fillStyle = `rgba(10,14,18,${0.3 * (1 - currentDark * 0.85)})`;
  rr(ctx, -42, -19, 84, 38, 7);
  ctx.fill();
  ctx.restore();

  ctx.rotate(e.angle);
  tyres(ctx, [-27, 20], 18.5);

  // Small and large relatives of the ambulance reuse its art, scaled.
  if (type === 'medcar') ctx.scale(0.62, 0.78);
  else if (type === 'rapid') ctx.scale(0.68, 0.8);
  else if (type === 'ambubus') ctx.scale(1.38, 1.04);

  if (type === 'ambulance' || type === 'medcar' || type === 'ambubus') {
    paint(ctx, -41, -17, 59, 34, 5, '#f4f3ee');
    ctx.fillStyle = '#d3382f';
    ctx.fillRect(-41, -17, 59, 3.5);
    ctx.fillRect(-41, 13.5, 59, 3.5);
    ctx.fillStyle = '#e5de45';
    for (let x = -41; x < 18; x += 8) {
      ctx.fillRect(x, -17, 4, 3.5);
      ctx.fillRect(x + 4, 13.5, 4, 3.5);
    }
    ctx.fillStyle = '#d3382f';
    ctx.fillRect(-18, -8, 7, 16);
    ctx.fillRect(-22.5, -3.5, 16, 7);
    ctx.fillStyle = '#c9ced1';
    rr(ctx, -34, -4, 8, 8, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-26, -16);
    ctx.lineTo(-26, 16);
    ctx.stroke();
    cab(ctx, 15, 27, '#eceae3');
    lightBar(ctx, 21, busy, now);
    chevrons(ctx, -41, 3);
  } else if (type === 'rapid') {
    // A small red utility car: tool lockers behind the cab, a hose reel on the roof.
    paint(ctx, -41, -17, 58, 34, 7, '#c4281f');
    ctx.fillStyle = '#efe9d6';
    ctx.fillRect(-41, -17, 58, 2.2);
    ctx.fillRect(-41, 14.8, 58, 2.2);
    lockers(ctx, -39, 13);
    ctx.fillStyle = '#2f3438';
    ctx.beginPath();
    ctx.arc(-17, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e4e6e8';
    ctx.lineWidth = 1.6;
    for (const r of [3, 5.5, 8]) {
      ctx.beginPath();
      ctx.arc(-17, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    cab(ctx, 15, 27, '#a8221b');
    lightBar(ctx, 21, busy, now);
    chevrons(ctx, -41, 3);
  } else if (type === 'rescue') {
    paint(ctx, -41, -17, 58, 34, 5, '#e9e4d8');
    ctx.fillStyle = '#d97a2b';
    ctx.fillRect(-41, -17, 58, 4);
    ctx.fillRect(-41, 13, 58, 4);
    plate(ctx, -36, -9, 30, 18);
    ctx.fillStyle = '#c9ced3';
    ctx.fillRect(-4, -12, 1.8, 24);
    ctx.fillRect(8, -12, 1.8, 24);
    ctx.fillStyle = '#3a3f45';
    ctx.fillRect(-2, -8, 10, 4);
    ctx.fillRect(-2, 3, 10, 5);
    lockers(ctx, -40, 12);
    cab(ctx, 15, 27, '#b7601c');
    lightBar(ctx, 21, busy, now);
    chevrons(ctx, -41, 4);
  } else if (type === 'tanker') {
    const tg = ctx.createLinearGradient(0, -16, 0, 16);
    tg.addColorStop(0, '#8e969d');
    tg.addColorStop(0.35, '#e3e8ec');
    tg.addColorStop(0.55, '#c9d0d6');
    tg.addColorStop(1, '#6d757c');
    ctx.fillStyle = tg;
    rr(ctx, -41, -16, 58, 32, 13);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,48,56,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const dx of [-30, -16, -2, 11]) {
      ctx.moveTo(dx, -15);
      ctx.lineTo(dx, 15);
    }
    ctx.stroke();
    for (const dx of [-24, -6]) {
      ctx.fillStyle = '#9aa2a9';
      ctx.beginPath();
      ctx.arc(dx, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#575e64';
      ctx.stroke();
    }
    ctx.fillStyle = '#23272b';
    ctx.fillRect(-42, -7, 4, 14);
    cab(ctx, 16, 25, '#a8281f');
    lightBar(ctx, 22, busy, now);
    chevrons(ctx, -42, 3);
  } else {
    // Pump / ladder: red body, aluminium walkway, hose bed, lockers, ladders.
    paint(ctx, -42, -19, 58, 38, 5, '#b3241d');
    ctx.fillStyle = '#efe9d6';
    ctx.fillRect(-42, -19, 58, 2.2);
    ctx.fillRect(-42, 16.8, 58, 2.2);
    lockers(ctx, -40, 14);
    plate(ctx, -36, -9, 36, 18);
    hoseBed(ctx, -35, -8, 22, 16);
    cab(ctx, 15, 26, '#9d211b');
    lightBar(ctx, 21, busy, now);
    chevrons(ctx, -42, 4);

    if (type === 'ladder') {
      ctx.fillStyle = '#5b6168';
      ctx.beginPath();
      ctx.arc(-16, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c9ccd0';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-38, -8);
      ctx.lineTo(46, -8);
      ctx.moveTo(-38, 8);
      ctx.lineTo(46, 8);
      ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#e4e6e8';
      ctx.beginPath();
      for (let x = -36; x <= 44; x += 5) {
        ctx.moveTo(x, -8);
        ctx.lineTo(x, 8);
      }
      ctx.stroke();
      ctx.fillStyle = '#e7e0cc';
      ctx.fillRect(-12, -3, 6, 6);
      ctx.strokeStyle = '#2f3438';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-26, -19);
      ctx.lineTo(-26, -27);
      ctx.moveTo(-26, 19);
      ctx.lineTo(-26, 27);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#d4d7da';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-10, -5);
      ctx.lineTo(12, -5);
      ctx.moveTo(-10, 5);
      ctx.lineTo(12, 5);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -8; x <= 10; x += 4) {
        ctx.moveTo(x, -5);
        ctx.lineTo(x, 5);
      }
      ctx.stroke();
    }
  }

  // Unit number on the roof.
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, type === 'ladder' || type === 'tanker' ? -30 : -22, type === 'ladder' ? 13 : 0);

  ctx.restore();
}

// The tool in a firefighter's hands, in the crew's rotated frame (forward is -y).
function drawHeldTool(ctx, c, now, swing) {
  if (c.riding) return;
  if (c.tool === 'chainsaw') {
    const buzz = c.status === 'cutting' ? Math.sin(now * 60) * 0.6 : 0;
    ctx.save();
    ctx.translate(5.5 + buzz, -6 - swing * 0.3);
    ctx.fillStyle = '#e2701e'; // body
    rr(ctx, -2.6, -2, 5.2, 5.6, 1.2);
    ctx.fill();
    ctx.fillStyle = '#2a2d31'; // handle
    ctx.fillRect(-2.2, 2.8, 4.4, 1.4);
    ctx.fillStyle = '#b9bdc1'; // bar and chain
    rr(ctx, -1.1, -12, 2.2, 10.4, 1);
    ctx.fill();
    ctx.restore();
  } else if (c.tool === 'cutter') {
    ctx.save();
    ctx.translate(0, -8);
    ctx.fillStyle = '#d9b51e'; // spreader arms
    ctx.beginPath();
    ctx.moveTo(-1.6, 2);
    ctx.lineTo(-3.6, -7);
    ctx.lineTo(-1.6, -7);
    ctx.lineTo(0, 0);
    ctx.lineTo(1.6, -7);
    ctx.lineTo(3.6, -7);
    ctx.lineTo(1.6, 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c0392b'; // hydraulic body
    rr(ctx, -2.4, 1.5, 4.8, 4, 1);
    ctx.fill();
    ctx.restore();
  } else if (c.tool === 'medkit') {
    ctx.fillStyle = '#e9eee9';
    rr(ctx, 6, -3, 5, 4.4, 1);
    ctx.fill();
    ctx.fillStyle = '#d64535';
    ctx.fillRect(8, -2.4, 1, 3.2);
    ctx.fillRect(6.9, -1.3, 3.2, 1);
  } else if (c.fetch) {
    // Reaching into the locker.
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(0, -11, 1.6 + Math.abs(Math.sin(now * 6)) * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCrew(ctx, c, now) {
  const diver = c.tool === 'diving';
  if (diver && (c.status === 'swimming' || c.status === 'rescuing')) {
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

  ctx.fillStyle = `rgba(10,14,18,${0.3 * (1 - currentDark * 0.85)})`;
  ctx.beginPath();
  ctx.ellipse(currentSun.dx * 4 + 1, currentSun.dy * 4 + 3, 8.5, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(c.angle + Math.PI / 2);

  // A person seen from above: arms swinging, shoulders, kit on the back and a
  // helmet. Firefighters in tan turnout gear, paramedics in white and green,
  // divers in black with an orange tank.
  const swing = c.status === 'moving' ? Math.sin(now * 12 + c.x * 0.1) * 2.6 : 0;
  const coat = diver ? '#262c33' : c.medic ? '#e9eee9' : '#c9a24a';
  const coatDark = diver ? '#14181c' : c.medic ? '#aeb8b0' : '#8c6d2b';
  ctx.fillStyle = coatDark; // arms
  ctx.beginPath();
  ctx.ellipse(-7.6, 0.5 + swing, 2.5, 4, 0, 0, Math.PI * 2);
  ctx.ellipse(7.6, 0.5 - swing, 2.5, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#15181b'; // boots peeking out front and back
  ctx.fillRect(-4.6, -8.2 + swing * 0.5, 3.4, 3.4);
  ctx.fillRect(1.2, -8.2 - swing * 0.5, 3.4, 3.4);
  const body = ctx.createLinearGradient(0, -5, 0, 6);
  body.addColorStop(0, shade(coat, 0.15));
  body.addColorStop(1, shade(coat, -0.2));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, 1, 7.8, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = diver ? '#e86f1f' : c.medic ? '#3a9d6a' : '#e4e0c8'; // reflective bands
  ctx.fillRect(-4.6, -3.6, 1.8, 9.2);
  ctx.fillRect(2.8, -3.6, 1.8, 9.2);
  ctx.fillStyle = diver ? '#e86f1f' : c.medic ? '#2f6f9a' : '#3a3f44'; // tank / pack
  rr(ctx, -3.4, 2.4, 6.8, 4.6, 1.5);
  ctx.fill();
  // Helmet: shell, brim to the front, reflective crest.
  ctx.fillStyle = diver ? '#2d7fd0' : c.medic ? '#f2f6f3' : '#e6c93d';
  ctx.beginPath();
  ctx.ellipse(0, -0.5, 4.2, 4.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(0, -3.6, 4, 1.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.medic ? '#d64535' : '#b92f23';
  ctx.fillRect(-0.7, -4, 1.4, 7);
  if (diver) {
    // Fins behind, mask in front.
    ctx.fillStyle = '#e8d23a';
    ctx.fillRect(-4.8, 7 + swing * 0.4, 3.2, 4.6);
    ctx.fillRect(1.6, 7 - swing * 0.4, 3.2, 4.6);
    ctx.fillStyle = 'rgba(120,190,230,0.85)';
    ctx.fillRect(-2.6, -4.6, 5.2, 1.6);
  }
  drawHeldTool(ctx, c, now, swing);
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

  ctx.fillStyle = `rgba(10,14,18,${0.26 * (1 - currentDark * 0.85)})`;
  ctx.beginPath();
  ctx.ellipse(currentSun.dx * 3 + 1, currentSun.dy * 3 + 3, 6, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const stride = Math.sin(now * 10 + person.phase) * 2;
  ctx.fillStyle = shade(person.color, -0.4); // arms
  ctx.beginPath();
  ctx.ellipse(-5.4, stride, 1.8, 3.2, 0, 0, Math.PI * 2);
  ctx.ellipse(5.4, -stride, 1.8, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = person.color; // shoulders
  ctx.beginPath();
  ctx.ellipse(0, 0.5, 5.8, 3.8, 0, 0, Math.PI * 2);
  ctx.fill();
  const hair = ['#2a211b', '#5a3b22', '#a8793a', '#8a8a86'][Math.floor(person.phase * 3) % 4];
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.arc(0, -0.4, 3.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e6c3a0';
  ctx.beginPath();
  ctx.arc(0, -2.2, 1.6, 0, Math.PI * 2);
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
let darkSmokeSprite = null;
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
    darkSmokeSprite = puff('34,32,31');
  }

  for (const p of state.fx) {
    const life = p.life / p.maxLife;
    if (p.kind === 'smoke') {
      // Young smoke is dark and dense; it greys, spreads and thins with age.
      const age = 1 - life;
      const size = p.size * (2.4 + age * 1.6);
      if (age < 0.55 && p.tone > 0.35) {
        ctx.globalAlpha = life * 0.55 * (1 - age / 0.55 * 0.5);
        ctx.drawImage(darkSmokeSprite, p.x - size / 2, p.y - size / 2, size, size);
      }
      ctx.globalAlpha = life * 0.42 * (0.65 + p.tone * 0.35);
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
    } else if (p.kind === 'chip') {
      ctx.globalAlpha = Math.min(1, life * 1.8);
      ctx.fillStyle = p.tone < 0.5 ? '#d8b98a' : '#a6835a';
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size * 0.7);
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
  g.fillStyle = '#28526a';
  g.fillRect(0, SEA_Y * TILE * sy, mw, mh - SEA_Y * TILE * sy);
  g.fillStyle = '#336676';
  for (let y = 0; y < SEA_Y; y += 2) {
    const c = riverCentre(y + 1);
    g.fillRect((c - RIVER_HALF_WIDTH) * TILE * sx, y * TILE * sy, RIVER_HALF_WIDTH * 2 * TILE * sx, 2 * TILE * sy + 1);
  }
  for (const blk of city.blocks ?? []) {
    if (!ZONE_MINIMAP[blk.zone]) continue;
    g.fillStyle = ZONE_MINIMAP[blk.zone];
    g.fillRect(blk.x0 * TILE * sx, blk.y0 * TILE * sy, (blk.x1 - blk.x0 + 1) * TILE * sx, (blk.y1 - blk.y0 + 1) * TILE * sy);
  }
  for (const a of city.forestAreas ?? []) {
    g.fillStyle = a.woods === 'pine' ? '#22382a' : '#2f4628';
    g.fillRect(a.x0 * TILE * sx, a.y0 * TILE * sy, (a.x1 - a.x0 + 1) * TILE * sx, (a.y1 - a.y0 + 1) * TILE * sy);
  }
  g.fillStyle = '#3c4a38';
  for (const pk of city.parks) {
    g.fillRect(pk.x0 * TILE * sx, pk.y0 * TILE * sy, (pk.x1 - pk.x0 + 1) * TILE * sx, (pk.y1 - pk.y0 + 1) * TILE * sy);
  }
  g.strokeStyle = '#5a626b';
  g.lineWidth = Math.max(1, 2 * TILE * sx);
  g.lineJoin = 'round';
  for (const c of city.curves ?? []) {
    g.beginPath();
    c.pts.forEach((p, i) => (i === 0 ? g.moveTo(p.x * TILE * sx, p.y * TILE * sy) : g.lineTo(p.x * TILE * sx, p.y * TILE * sy)));
    g.stroke();
  }
  g.fillStyle = '#5a626b';
  for (const r of runsInView(city, 'v', V_ROADS, 0, city.h)) {
    g.fillRect(r.line * TILE * sx, r.a * TILE * sy, Math.max(1, 2 * TILE * sx), (r.b - r.a + 1) * TILE * sy);
  }
  for (const r of runsInView(city, 'h', H_ROADS, 0, city.w)) {
    g.fillRect(r.a * TILE * sx, r.line * TILE * sy, (r.b - r.a + 1) * TILE * sx, Math.max(1, 2 * TILE * sy));
  }
  g.lineWidth = 1.4;
  for (const line of city.transit?.lines ?? []) {
    g.strokeStyle = line.kind === 'rail' ? '#d8d2c2' : line.color;
    g.globalAlpha = line.kind === 'rail' ? 0.95 : 0.8;
    g.beginPath();
    line.pts.forEach((p, i) => (i === 0 ? g.moveTo((p.x + 1) * TILE * sx, (p.y + 1) * TILE * sy) : g.lineTo((p.x + 1) * TILE * sx, (p.y + 1) * TILE * sy)));
    g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = '#3d4f3a';
  for (const f of city.airfields ?? []) g.fillRect(f.x0 * TILE * sx, f.y0 * TILE * sy, (f.x1 - f.x0 + 1) * TILE * sx, (f.y1 - f.y0 + 1) * TILE * sy);
  g.fillStyle = '#b9bec3';
  for (const f of city.airfields ?? []) {
    g.fillRect(f.runway.x0 * TILE * sx, f.runway.y0 * TILE * sy, (f.runway.x1 - f.runway.x0 + 1) * TILE * sx, Math.max(1.5, 4 * TILE * sy));
  }
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
  // A small screen gets a smaller map, parked above the bottom action bar.
  const compact = view.width <= 900 || view.height <= 520;
  const mw = compact
    ? Math.round(Math.min(280, Math.max(96, view.width * 0.28), view.height * 0.3 * (city.w / city.h)))
    : Math.round(Math.min(280, view.width * 0.25));
  const mh = Math.round((mw * city.h) / city.w);
  // A window squeezed down to a sliver (DevTools docked, a tiny browser window)
  // leaves no room for it: a zero-size canvas cannot be drawn.
  if (mw < 24 || mh < 16 || view.height < mh + 80) {
    state.ui.minimap = null;
    return;
  }
  const x = view.width - mw - (compact ? 10 : 16);
  const y = view.height - mh - (compact ? 58 : 16);
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

// A photographic finish over the world: colours pulled toward natural, a touch
// more contrast, warm highlights and fine film grain. UI is drawn after it.
let grainTile = null;
function drawPhotoGrade(ctx, w, h, time) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  ctx.globalCompositeOperation = 'saturation';
  ctx.fillStyle = 'rgba(128,128,128,0.2)';
  ctx.fillRect(0, 0, cw, ch);
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = 'rgba(255,238,214,0.1)';
  ctx.fillRect(0, 0, cw, ch);
  if (typeof document !== 'undefined') {
    if (!grainTile) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const g = c.getContext('2d');
      const img = g.createImageData(128, 128);
      let sd = 99991;
      for (let i = 0; i < img.data.length; i += 4) {
        sd = (sd * 1664525 + 1013904223) >>> 0;
        const v = (sd >>> 24) & 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      grainTile = ctx.createPattern(c, 'repeat');
    }
    if (grainTile) {
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.07;
      ctx.translate((Math.floor(time * 24) * 37) % 128, (Math.floor(time * 24) * 91) % 128);
      ctx.fillStyle = grainTile;
      ctx.fillRect(-128, -128, cw + 256, ch + 256);
    }
  }
  ctx.restore();
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
