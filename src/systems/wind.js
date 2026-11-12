// Wind: one direction and one strength for the whole city, drifting slowly.
//
// It pushes fire. A burning building is far more likely to light the building
// downwind of it (and less likely to light the one upwind), a forest fire creeps
// downwind and throws embers further that way, and smoke and sparks lean with it.
// Where you park an engine and which side you defend becomes a decision.
//
// `dir` is the direction the wind blows TOWARD, in radians, 0 = east and
// positive turning clockwise on screen (y grows downward).

import { TAU, clamp } from '../core/math.js';
import { addEvent } from './events.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const KMH = 42; // km/h at full strength, for the label only

export function createWind(rng) {
  const dir = rng.range(0, TAU);
  const speed = rng.range(0.25, 0.6);
  return { dir, speed, targetDir: dir, targetSpeed: speed, changeIn: rng.range(80, 140) };
}

export function updateWind(state, dt) {
  const wind = state.wind;
  if (!wind) return;
  wind.changeIn -= dt;
  if (wind.changeIn <= 0) {
    wind.changeIn = state.rng.range(90, 180);
    wind.targetDir = wind.dir + state.rng.range(-1.1, 1.1);
    wind.targetSpeed = state.rng.range(0.12, 1);
    if (Math.abs(wind.targetSpeed - wind.speed) > 0.35) {
      addEvent(state, `Wind ${wind.targetSpeed > wind.speed ? 'picking up' : 'easing'} — now from the ${windFrom(wind.targetDir)}`, 'info');
    }
  }
  // Ease toward the targets: a gust takes about half a minute to settle.
  const k = 1 - Math.exp(-dt / 12);
  wind.dir += (wind.targetDir - wind.dir) * k;
  wind.speed += (wind.targetSpeed - wind.speed) * k;
}

/** Wind as a vector in world units: direction times strength. */
export function windVector(state) {
  const wind = state.wind;
  if (!wind) return { x: 0, y: 0 };
  return { x: Math.cos(wind.dir) * wind.speed, y: Math.sin(wind.dir) * wind.speed };
}

/**
 * How much more (or less) likely fire is to travel from A to B in this wind:
 * above 1 downwind, below 1 upwind, and 1 in calm air.
 */
export function downwindFactor(state, ax, ay, bx, by) {
  const wind = state.wind;
  if (!wind) return 1;
  const cos = alignment(wind, bx - ax, by - ay);
  return clamp(1 + 1.4 * wind.speed * cos, 0.3, 2.6);
}

/** Cosine of the angle between the wind and a direction (1 = straight downwind). */
export function alignment(wind, dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return (Math.cos(wind.dir) * dx + Math.sin(wind.dir) * dy) / len;
}

/** The compass point the wind blows FROM, which is how people say it. */
export function windFrom(dir) {
  const bearingTo = Math.atan2(Math.cos(dir), -Math.sin(dir)); // 0 = north, clockwise
  const from = (bearingTo + Math.PI + TAU) % TAU;
  return COMPASS[Math.round(from / (TAU / 8)) % 8];
}

export function windLabel(wind) {
  return `${windFrom(wind.dir)} ${Math.round(wind.speed * KMH)} km/h`;
}
