// Fire, smoke and debris. Fire is the only thing in the game that can win.

import { CONFIG, TILE } from '../core/config.js';
import { rectsTouch } from '../core/math.js';
import { addEvent } from './events.js';
import { evacuate } from './civilians.js';
import {
  earn, money, spend, speedBonus, valueFactor,
} from './economy.js';

export const buildingRect = (b) => ({
  x: b.x * TILE,
  y: b.y * TILE,
  w: b.w * TILE,
  h: b.h * TILE,
});

export function activeFires(state) {
  const list = [];
  for (const b of state.buildings) if (b.state === 'burning') list.push(b);
  return list;
}

export function ignite(state, building, cause = 'alarm') {
  if (!building || building.state !== 'ok') return false;
  building.state = 'burning';
  building.fire = Math.max(building.fire, 0.1);
  building.spreadTimer = CONFIG.fire.spreadEvery;
  building.ignitedAt = state.time;
  state.stats.alarms += 1;
  evacuate(state, building);
  addEvent(
    state,
    cause === 'spread' ? `Fire spread — ${building.name}` : `Structure fire — ${building.name}`,
    'fire',
  );
  return true;
}

function extinguish(state, building) {
  building.state = 'out';
  building.fire = 0;
  building.big = false;
  state.stats.saved += 1;
  state.rating = Math.min(CONFIG.rating.start, state.rating + 2);
  const fee = earn(state, Math.round(CONFIG.economy.saved * valueFactor(building)), 'knockdown');
  addEvent(state, `Knockdown — ${building.name} saved (+${money(fee)})`, 'good');
  if (building.reward > 0) {
    const bonus = speedBonus(state, building);
    const reward = Math.round(building.reward * (1 + bonus));
    building.reward = 0;
    earn(state, reward, 'incident');
    const extra = bonus >= 0.05 ? ` incl. ${Math.round(bonus * 100)}% speed bonus` : '';
    addEvent(state, `Incident closed — ${money(reward)}${extra} — ${building.name}`, 'good');
  }
}

function destroy(state, building) {
  const trapped = building.trapped ?? 0;
  building.trapped = 0;
  building.state = 'rubble';
  building.fire = 0;
  building.integrity = 0;
  building.big = false;
  building.reward = 0;
  state.stats.lost += 1;
  state.rating = Math.max(0, state.rating - CONFIG.rating.perLost);
  const penalty = spend(state, Math.round(CONFIG.economy.lossPenalty * valueFactor(building)), 'loss');
  addEvent(state, `Building lost — ${building.name} (−${money(penalty)})`, 'bad');

  if (trapped > 0) {
    state.stats.casualties += trapped;
    state.rating = Math.max(0, state.rating - trapped * 6);
    spend(state, trapped * CONFIG.economy.casualtyPenalty, 'casualty');
    addEvent(
      state,
      `${trapped} ${trapped === 1 ? 'person' : 'people'} lost in the collapse of ${building.name}`,
      'bad',
    );
  }

  state.onDestroyed?.(building);
}

function trySpread(state, building) {
  if (building.fire < 0.6) return;
  const rect = buildingRect(building);
  for (const other of state.buildings) {
    if (other === building || other.state !== 'ok') continue;
    if (!rectsTouch(rect, buildingRect(other), CONFIG.fire.spreadRange * TILE)) continue;
    if (state.rng.float() < CONFIG.fire.spreadChance * building.fire) {
      ignite(state, other, 'spread');
    }
  }
}

export function updateFire(state, dt) {
  // Water is declared by the units as they spray; sum it per building.
  const wet = new Map();
  for (const stream of state.streams) {
    if (!stream.targetId) continue;
    wet.set(stream.targetId, (wet.get(stream.targetId) ?? 0) + stream.power);
  }

  for (const b of state.buildings) {
    if (b.state !== 'burning') continue;

    const water = wet.get(b.id) ?? 0;
    b.fire = Math.min(
      1,
      b.fire + CONFIG.fire.growth * dt * (0.75 + 0.5 * (1 - b.fire)) * b.risk,
    );
    if (water > 0) {
      b.fire -= water * dt * 1.7;
      b.integrity = Math.min(b.maxIntegrity, b.integrity + 2.5 * dt);
    }
    b.fire = Math.max(0, b.fire);

    const damageScale = water > 0 ? CONFIG.fire.wetDamage : 1;
    b.integrity -= b.fire * CONFIG.fire.damage * dt * damageScale;

    if (b.integrity <= 0) {
      destroy(state, b);
      continue;
    }
    if (b.fire <= CONFIG.fire.outAt) {
      extinguish(state, b);
      continue;
    }

    b.spreadTimer -= dt;
    if (b.spreadTimer <= 0) {
      b.spreadTimer = CONFIG.fire.spreadEvery;
      trySpread(state, b);
    }
  }
}
