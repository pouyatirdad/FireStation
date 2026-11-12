// Particles are decoration, not simulation: they never feed back into the game.
// Smoke rises from burning roofs, embers tumble out of windows, water turns to
// steam where it lands, and a lost building comes down in a burst of debris.

import { buildingRect } from './fire.js';
import { windVector } from './wind.js';

const MAX_FX = 700;

export function spawnSmoke(state, x, y, scale = 1) {
  if (state.fx.length >= MAX_FX) return;
  const rng = state.rng;
  const life = rng.range(3.4, 6.2);
  state.fx.push({
    kind: 'smoke',
    x,
    y,
    vx: rng.range(9, 20),
    vy: rng.range(-20, -9),
    size: rng.range(4, 8) * scale,
    grow: rng.range(8, 15),
    life,
    maxLife: life,
    tone: rng.range(0, 1),
  });
}

export function spawnSteam(state, x, y) {
  if (state.fx.length >= MAX_FX) return;
  const rng = state.rng;
  const life = rng.range(0.5, 1.3);
  state.fx.push({
    kind: 'steam',
    x: x + rng.range(-8, 8),
    y: y + rng.range(-6, 6),
    vx: rng.range(-18, 18),
    vy: rng.range(-34, -12),
    size: rng.range(3, 7),
    grow: rng.range(9, 16),
    life,
    maxLife: life,
    tone: rng.range(0, 1),
  });
}

export function spawnEmber(state, x, y) {  if (state.fx.length >= MAX_FX) return;
  const rng = state.rng;
  const life = rng.range(0.5, 1.4);
  state.fx.push({
    kind: 'ember',
    x,
    y,
    vx: rng.range(-20, 26),
    vy: rng.range(-70, -30),
    size: rng.range(1.2, 2.6),
    grow: 0,
    life,
    maxLife: life,
    tone: rng.range(0, 1),
  });
}

/** A white cross rising from a firefighter: somebody made it out. */
export function spawnRescue(state, x, y) {
  state.fx.push({
    kind: 'rescue',
    x,
    y: y - 10,
    vx: 0,
    vy: -26,
    size: 0,
    grow: 0,
    life: 1.5,
    maxLife: 1.5,
    tone: 0,
  });
}

export function spawnDebris(state, building) {
  const rng = state.rng;
  const rect = buildingRect(building);
  for (let i = 0; i < 26; i++) {
    if (state.fx.length >= MAX_FX) break;
    const life = rng.range(0.9, 2.1);
    state.fx.push({
      kind: 'debris',
      x: rect.x + rng.range(0.1, 0.9) * rect.w,
      y: rect.y + rng.range(0.2, 0.9) * rect.h,
      vx: rng.range(-90, 90),
      vy: rng.range(-130, 10),
      size: rng.range(2, 5),
      grow: 0,
      rot: rng.range(0, Math.PI),
      vr: rng.range(-6, 6),
      life,
      maxLife: life,
      tone: rng.range(0, 1),
    });
  }
  for (let i = 0; i < 10; i++) {
    spawnSmoke(state, rect.x + rng.range(0.15, 0.85) * rect.w, rect.y + rng.range(0.1, 0.9) * rect.h, 1.4);
  }
}

export function updateEffects(state, dt) {
  const rng = state.rng;

  // Fire produces smoke at a rate that follows its intensity.
  for (const b of state.buildings) {
    if (b.state !== 'burning') {
      b.smokeAcc = 0;
      continue;
    }
    b.smokeAcc = (b.smokeAcc ?? 0) + dt * (6 + b.fire * 18);
    const rect = buildingRect(b);
    while (b.smokeAcc >= 1) {
      b.smokeAcc -= 1;
      spawnSmoke(
        state,
        rect.x + rng.range(0.1, 0.9) * rect.w,
        rect.y - b.elevation + rng.range(0.05, 0.8) * rect.h,
        0.7 + b.fire * 0.6,
      );
    }
    if (rng.float() < b.fire * dt * 4) {
      spawnEmber(
        state,
        rect.x + rng.range(0.15, 0.85) * rect.w,
        rect.y - b.elevation + rng.range(0.1, 0.9) * rect.h,
      );
    }
  }

  // Water turning to steam where it lands.
  for (const stream of state.streams) {
    if (rng.float() < dt * 22) spawnSteam(state, stream.tx, stream.ty);
  }

  const wind = windVector(state);
  for (let i = state.fx.length - 1; i >= 0; i--) {
    const p = state.fx[i];
    p.life -= dt;
    if (p.life <= 0) {
      state.fx[i] = state.fx[state.fx.length - 1];
      state.fx.pop();
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.size += p.grow * dt;
    if (p.kind === 'debris') {
      p.vy += 260 * dt;
      p.rot += p.vr * dt;
    } else if (p.kind === 'ember') {
      p.vy += 40 * dt;
      p.vx += wind.x * 70 * dt;
      p.vy += wind.y * 40 * dt;
    } else if (p.kind === 'smoke') {
      // Smoke leans with the wind: it settles toward a drift speed of ~70 px/s at full strength.
      p.vx += (wind.x * 70 - p.vx) * 0.5 * dt;
      p.vy += (wind.y * 40 - 16 - p.vy) * 0.35 * dt;
    }
  }
}

export function clearEffects(state) {
  state.fx.length = 0;
}

// Where a stream should land on a building: its facade, not its roof.
export function streamImpact(building, fromX, fromY) {
  const rect = buildingRect(building);
  const x = Math.min(Math.max(fromX, rect.x), rect.x + rect.w);
  const y = Math.min(Math.max(fromY, rect.y), rect.y + rect.h);
  return { x, y: y - building.elevation * 0.55 };
}
