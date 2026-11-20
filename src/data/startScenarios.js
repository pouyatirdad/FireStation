// Starting points for a new career: which city, how much money, which vehicles
// and how many people the department begins with.

import { CONFIG } from '../core/config.js';

export const SCENARIOS_START = {
  harbor: {
    label: 'Harbor City',
    text: 'The standard start: the harbour city, one engine, one ambulance and a small crew.',
    seed: CONFIG.city.seed,
    credits: CONFIG.career.startCredits,
    fleet: [{ type: 'engine', station: 0 }, { type: 'ambulance', station: 0 }],
    roster: 6,
  },
  riverside: {
    label: 'Riverside',
    text: 'A different city (new street plan and forests). One engine, more money.',
    seed: 11,
    credits: 30000,
    fleet: [{ type: 'engine', station: 0 }],
    roster: 4,
  },
  lean: {
    label: 'Lean Years',
    text: 'Harbor City on a tight budget: one engine, three firefighters, very little money.',
    seed: CONFIG.city.seed,
    credits: 9000,
    fleet: [{ type: 'engine', station: 0 }],
    roster: 3,
  },
};
