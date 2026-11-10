// Forest fires. Unlike a building fire, a wildfire is an area: it grows, it
// throws embers into whatever building it reaches, and it takes sustained water
// on its edge to bring down.

import { TILE } from '../core/config.js';
import { addEvent } from './events.js';
import { buildingRect, ignite } from './fire.js';
import { spawnSmoke } from './effects.js';

let seq = 1;

export function startWildfire(state, x, y, reward = 2200) {
  const wildfire = {
    id: `wildfire${seq++}`,
    kind: 'wildfire',
    name: 'Forest fire',
    x,
    y,
    radius: 2.5 * TILE,
    maxRadius: 18 * TILE,
    intensity: 0.55,
    reward,
    spreadTimer: 4,
    smokeAcc: 0,
    big: true,
  };
  state.wildfires.push(wildfire);
  addEvent(state, 'MAJOR INCIDENT — forest fire in the north woods', 'big');
  return wildfire;
}

export function restoreWildfires(state, list = []) {
  state.wildfires = list.map((w) => ({
    ...w,
    radius: w.radius ?? 2.5 * TILE,
    maxRadius: w.maxRadius ?? 18 * TILE,
    intensity: w.intensity ?? 0.55,
    spreadTimer: w.spreadTimer ?? 5,
    smokeAcc: 0,
  }));
  for (const wf of state.wildfires) {
    const match = /(\d+)$/.exec(wf.id ?? '');
    if (match) seq = Math.max(seq, Number(match[1]) + 1);
  }
  return state.wildfires;
}

export function updateWildfires(state, dt) {
  if (!state.wildfires || state.wildfires.length === 0) return;

  const wet = new Map();
  for (const stream of state.streams) {
    if (!stream.wildfireId) continue;
    wet.set(stream.wildfireId, (wet.get(stream.wildfireId) ?? 0) + stream.power);
  }

  for (let i = state.wildfires.length - 1; i >= 0; i--) {
    const wf = state.wildfires[i];
    const water = wet.get(wf.id) ?? 0;

    if (water > 0) wf.intensity -= water * dt * 1.7;
    else wf.intensity = Math.min(1, wf.intensity + 0.005 * dt);
    wf.radius = Math.min(wf.maxRadius, wf.radius + 0.22 * TILE * dt);

    if (wf.intensity <= 0.02) {
      state.credits += wf.reward;
      addEvent(state, `Forest fire contained — $${wf.reward}`, 'good');
      state.wildfires.splice(i, 1);
      continue;
    }

    wf.spreadTimer -= dt;
    if (wf.spreadTimer <= 0) {
      wf.spreadTimer = 6;
      for (const b of state.buildings) {
        if (b.state !== 'ok') continue;
        const rect = buildingRect(b);
        const cx = Math.max(rect.x, Math.min(wf.x, rect.x + rect.w));
        const cy = Math.max(rect.y, Math.min(wf.y, rect.y + rect.h));
        if (Math.hypot(cx - wf.x, cy - wf.y) <= wf.radius + TILE) {
          ignite(state, b, 'wildfire');
        }
      }
    }

    wf.smokeAcc += dt * (8 + wf.intensity * 14);
    while (wf.smokeAcc >= 1) {
      wf.smokeAcc -= 1;
      const angle = state.rng.range(0, Math.PI * 2);
      const r = state.rng.range(0, wf.radius);
      spawnSmoke(
        state,
        wf.x + Math.cos(angle) * r,
        wf.y + Math.sin(angle) * r,
        1.1 + wf.intensity,
      );
    }
  }
}
