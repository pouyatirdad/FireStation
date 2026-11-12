// Fire, smoke and debris. Fire is the only thing in the game that can win.

import { CONFIG, TILE } from '../core/config.js';
import { clamp, lerp, rectsTouch } from '../core/math.js';
import { addEvent } from './events.js';
import { evacuate } from './civilians.js';
import { downwindFactor } from './wind.js';
import {
  earn, lossShare, money, spend, speedBonus, valueFactor,
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

/**
 * How many times harder than a plain fire this one is to knock down.
 *  - Size: a small house is easy (below 1); a big building is hard (up to 2).
 *  - Stage: the size only counts as the fire takes hold. An early fire in a big
 *    building is still easy, so a fast response keeps it that way.
 *  - Neglect: a fire nobody has fought for a while has taken hold of the whole
 *    building and is much harder, whatever its size.
 */
export function fireResistance(b) {
  const F = CONFIG.fire;
  const mass = b.w * b.h * (0.7 + 0.15 * (b.floors ?? 1));
  const sizeFactor = lerp(F.sizeEasy, F.sizeHard, clamp((mass - F.sizeRange[0]) / (F.sizeRange[1] - F.sizeRange[0]), 0, 1));
  const neglect = b.neglect ?? 0;
  const stage = clamp(Math.max(neglect, (b.fire - 0.15) / 0.6), 0, 1);
  // Only the part of the size penalty above 1 is held back early on.
  const size = sizeFactor > 1 ? 1 + (sizeFactor - 1) * (F.earlyShare + (1 - F.earlyShare) * stage) : sizeFactor;
  return size * (1 + F.neglectHard * neglect);
}

/** A word for how hard a fire is to fight, for the HUD. */
export function fireDifficulty(b) {
  const r = fireResistance(b);
  if (r < 0.8) return { label: 'Easy', tone: 'good', value: r };
  if (r < 1.35) return { label: 'Moderate', tone: '', value: r };
  if (r < 2.2) return { label: 'Hard', tone: 'warn', value: r };
  return { label: 'Very hard', tone: 'bad', value: r };
}

export function ignite(state, building, cause = 'alarm') {
  if (!building || building.state !== 'ok') return false;
  building.state = 'burning';
  building.dryTime = 0;
  building.neglect = 0;
  building.tookHold = false;
  building.runaway = false;
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
  const penalty = spend(
    state,
    Math.round(CONFIG.economy.lossPenalty * valueFactor(building) * lossShare(state)),
    'loss',
  );
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

/**
 * A fire nobody is fighting gets worse: the longer it burns dry, the more
 * often it lights its neighbours and the further it throws. Water on it cools
 * that down again at twice the pace.
 */
export const unattendedFactor = (building) => 1 + Math.min(3, (building.dryTime ?? 0) / 35);

function trySpread(state, building) {
  const dry = building.dryTime ?? 0;
  // A fire that has been left alone spreads even when it is not yet roaring.
  if (building.fire < (dry > 40 ? 0.4 : 0.6)) return;
  if (dry > 60 && !building.runaway) {
    building.runaway = true;
    addEvent(state, `${building.name} is out of control — no one is fighting it and it is spreading`, 'bad');
  }
  const rect = buildingRect(building);
  const wind = state.wind;
  // Downwind the fire reaches further; upwind it barely crosses the gap. An
  // unattended fire reaches further still.
  // Chemicals and fuel (industrial calls) throw the fire further and faster.
  const hazmat = building.hazmat ? 1.5 : 1;
  const reach = CONFIG.fire.spreadRange * TILE * (1 + 0.9 * (wind?.speed ?? 0)) * (1 + Math.min(0.6, dry / 150)) * (building.hazmat ? 1.25 : 1);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  for (const other of state.buildings) {
    if (other === building || other.state !== 'ok') continue;
    const o = buildingRect(other);
    if (!rectsTouch(rect, o, reach)) continue;
    const ox = o.x + o.w / 2;
    const oy = o.y + o.h / 2;
    const factor = downwindFactor(state, cx, cy, ox, oy);
    // The extended reach is only available downwind.
    if (!rectsTouch(rect, o, CONFIG.fire.spreadRange * TILE * (building.hazmat ? 1.25 : 1)) && factor <= 1) continue;
    if (state.rng.float() < CONFIG.fire.spreadChance * building.fire * factor * unattendedFactor(building) * hazmat) {
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
    // Time spent burning with no water on it.
    b.dryTime = water > 0 ? Math.max(0, (b.dryTime ?? 0) - dt * 2) : (b.dryTime ?? 0) + dt;
    if (b.dryTime < 20) b.runaway = false;
    // A fire nobody is fighting takes hold (twice as fast once it is roaring); it
    // eases only slowly when water is on it.
    const T = CONFIG.fire.neglectTime;
    b.neglect = clamp(
      (b.neglect ?? 0) + (water > 0 ? (-dt * CONFIG.fire.neglectEase) / T : (dt / T) * (b.fire >= 0.5 ? 2 : 1)),
      0,
      1,
    );
    if (b.neglect >= 0.5 && !b.tookHold) {
      b.tookHold = true;
      addEvent(state, `The fire at ${b.name} has taken hold — it will be hard to put out now`, 'warn');
    }
    const resistance = fireResistance(b);
    b.fire = Math.min(
      1,
      b.fire + CONFIG.fire.growth * dt * (0.75 + 0.5 * (1 - b.fire)) * b.risk,
    );
    if (water > 0) {
      b.fire -= (water * dt * 1.7) / resistance;
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

    // An industrial fire left to run can take the whole building up with it.
    if ((b.type === 'warehouse' || b.type === 'factory' || b.type === 'tankfarm') && b.fire >= (b.hazmat ? 0.7 : 0.85) && !b.exploded && state.rng.float() < dt * (b.hazmat ? 0.08 : 0.04)) {
      b.exploded = true;
      state.onExplosion?.(b);
    }

    b.spreadTimer -= dt;
    if (b.spreadTimer <= 0) {
      b.spreadTimer = CONFIG.fire.spreadEvery;
      trySpread(state, b);
    }
  }
}
