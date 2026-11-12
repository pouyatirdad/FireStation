// Names for places on the map, for incident text ("crash near Civic Quarter").

import { TILE } from '../core/config.js';

/** The map label nearest a world point, as a name ("Civic Quarter"). */
export function districtName(state, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const d of state.city.districts ?? []) {
    const dd = Math.hypot(d.x - x, d.y - y);
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  if (!best) return null;
  return best.name.toLowerCase().split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** "the Civic Quarter" or "the city" when there are no labels. */
export function placeNear(state, x, y) {
  const name = districtName(state, x, y);
  return name ? `the ${name}` : 'the city';
}

export const tileCentre = (tx, ty) => ({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });
