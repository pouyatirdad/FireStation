// Forest fires. Unlike a building fire, a wildfire is an area: it grows, it
// throws embers into whatever building it reaches, and it takes sustained water
// on its edge to bring down.

import { TILE } from '../core/config.js';
import { addEvent } from './events.js';
import { earn, money } from './economy.js';
import { buildingRect, ignite } from './fire.js';
import { spawnSmoke } from './effects.js';
import { placeNear } from './places.js';
import { alignment } from './wind.js';
import { emit } from './hooks.js';
import { nextId, registerPersistence } from './persistence.js';
import { SCHEMAS, applyFields, loadFields, saveFields, uniqueById } from './schema.js';

export function startWildfire(state, x, y, reward = 2200, opts = {}) {
  const wildfire = {
    id: nextId(state, 'wildfire'),
    kind: 'wildfire',
    name: opts.name ?? 'Forest fire',
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
  emit(state, 'wildfire:start', wildfire);
  addEvent(state, opts.text ?? `MAJOR INCIDENT — forest fire in ${placeNear(state, x, y)}`, 'big');
  return wildfire;
}

export function restoreWildfires(state, list = [], issues = []) {
  const unique = uniqueById(list, 'wildfires');
  issues.push(...unique.issues);
  state.wildfires = unique.list.map((entry) => {
    const wildfire = { kind: 'wildfire', id: entry.id, smokeAcc: 0 };
    const loaded = loadFields(SCHEMAS.wildfire, entry, wildfire, { where: `wildfire ${entry.id}` });
    issues.push(...loaded.issues);
    return applyFields(wildfire, loaded);
  });
  return state.wildfires;
}

registerPersistence({
  key: 'wildfires',
  order: 50,
  save: (state) => (state.wildfires ?? []).map((w) => saveFields(SCHEMAS.wildfire, w)),
  load: (state, data, ctx) => restoreWildfires(state, data.wildfires, ctx.issues),
});

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

    const wind = state.wind;
    const gust = wind?.speed ?? 0;
    if (water > 0) wf.intensity -= water * dt * 1.7;
    else wf.intensity = Math.min(1, wf.intensity + (0.005 + 0.004 * gust) * dt);
    wf.radius = Math.min(wf.maxRadius, wf.radius + 0.22 * TILE * (1 + 0.7 * gust) * dt);
    // The burning area creeps downwind, within the map.
    if (wind) {
      wf.x = Math.min(state.city.w * TILE - TILE, Math.max(TILE, wf.x + Math.cos(wind.dir) * gust * 0.45 * TILE * dt));
      wf.y = Math.min(state.city.h * TILE - TILE, Math.max(TILE, wf.y + Math.sin(wind.dir) * gust * 0.45 * TILE * dt));
    }

    if (wf.intensity <= 0.02) {
      earn(state, wf.reward, 'incident');
      addEvent(state, `Forest fire contained — ${money(wf.reward)}`, 'good');
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
        // Embers carry further downwind.
        const lean = state.wind ? Math.max(0, alignment(state.wind, cx - wf.x, cy - wf.y)) * state.wind.speed : 0;
        if (Math.hypot(cx - wf.x, cy - wf.y) <= wf.radius + TILE + lean * 7 * TILE) {
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
