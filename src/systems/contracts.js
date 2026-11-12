// Sponsor contracts: optional side goals with a deadline.
//
// Every few minutes a sponsor offers one ("knock down five fires", "no
// casualties for seven minutes"). Offers wait a few minutes to be accepted; up to
// two can be active at once. Finish in time and the sponsor pays; miss the
// deadline and you forfeit a quarter of the fee. Progress is counted from the
// moment you accept, off the same stats the rest of the game keeps.

import { CONFIG } from '../core/config.js';
import { addEvent } from './events.js';
import { earn, money, spend } from './economy.js';

const SPONSORS = ['Harbor Insurance', 'Meridian Bank', 'Dockside Freight', 'Civic Foundation', 'Northgate Rotary'];
const OFFER_LIFE = 260; // seconds an offer stays on the table

const KINDS = [
  { kind: 'save', stat: 'saved', label: (n) => `Knock down ${n} fires`, count: [3, 6], each: 350, time: [420, 640] },
  { kind: 'treat', stat: 'treated', label: (n) => `Treat ${n} injured people`, count: [3, 6], each: 270, time: [420, 640] },
  { kind: 'clear', stat: 'cleared', label: (n) => `Reopen ${n} blocked roads`, count: [2, 4], each: 400, time: [420, 640] },
  { kind: 'transport', stat: 'transported', label: (n) => `Deliver ${n} critical patients to hospital`, count: [2, 3], each: 480, time: [480, 700] },
  { kind: 'safe', stat: 'casualties', label: () => 'No casualties', count: [0, 0], fixed: 1500, time: [360, 480] },
];

export function createContracts() {
  return { offers: [], active: [], seq: 1, nextOfferAt: 200, completed: 0, failed: 0 };
}

export function restoreContracts(data) {
  return { ...createContracts(), ...(data ?? {}) };
}

function makeOffer(state) {
  const rng = state.rng;
  const def = rng.pick(KINDS);
  const n = def.count[1] > 0 ? rng.int(def.count[0], def.count[1]) : 0;
  const duration = Math.round(rng.range(def.time[0], def.time[1]));
  const reward = def.fixed ?? Math.round((n * def.each) / 10) * 10;
  return {
    id: `contract${state.contracts.seq++}`,
    sponsor: rng.pick(SPONSORS),
    kind: def.kind,
    stat: def.stat,
    label: def.label(n),
    target: n,
    reward,
    duration,
    expiresAt: state.time + OFFER_LIFE,
  };
}

export function acceptContract(state, id) {
  const c = state.contracts;
  const offer = c.offers.find((o) => o.id === id);
  if (!offer) return false;
  if (c.active.length >= CONFIG.economy.contracts.maxActive) {
    addEvent(state, 'You already have two contracts running', 'warn');
    return false;
  }
  c.offers = c.offers.filter((o) => o !== offer);
  c.active.push({
    ...offer,
    startedAt: state.time,
    deadline: state.time + offer.duration,
    base: state.stats[offer.stat] ?? 0,
  });
  addEvent(state, `Contract accepted — ${offer.sponsor}: ${offer.label}`, 'info');
  return true;
}

/** Progress of an active contract: how much of it is done, and the target. */
export function contractProgress(state, contract) {
  if (contract.kind === 'safe') {
    return { done: Math.min(contract.duration, Math.max(0, state.time - contract.startedAt)), target: contract.duration };
  }
  return { done: Math.max(0, (state.stats[contract.stat] ?? 0) - contract.base), target: contract.target };
}

export function updateContracts(state) {
  const c = state.contracts;
  if (!c) return;
  const cfg = CONFIG.economy.contracts;

  c.offers = c.offers.filter((o) => o.expiresAt > state.time);
  if (state.time >= c.nextOfferAt) {
    const [lo, hi] = cfg.every;
    c.nextOfferAt = state.time + state.rng.range(lo, hi);
    if (c.offers.length < cfg.maxOffers) {
      const offer = makeOffer(state);
      c.offers.push(offer);
      addEvent(state, `Contract offer — ${offer.sponsor}: ${offer.label} for ${money(offer.reward)}`, 'info');
    }
  }

  for (const contract of [...c.active]) {
    let result = null;
    if (contract.kind === 'safe') {
      if ((state.stats.casualties ?? 0) > contract.base) result = 'fail';
      else if (state.time >= contract.deadline) result = 'win';
    } else {
      const { done, target } = contractProgress(state, contract);
      if (done >= target) result = 'win';
      else if (state.time >= contract.deadline) result = 'fail';
    }
    if (!result) continue;
    c.active = c.active.filter((a) => a !== contract);
    if (result === 'win') {
      c.completed += 1;
      earn(state, contract.reward, 'contract');
      addEvent(state, `Contract complete — ${contract.sponsor} pays ${money(contract.reward)}`, 'good');
    } else {
      c.failed += 1;
      const fine = Math.round(contract.reward * cfg.failPenalty);
      spend(state, fine, 'contract');
      addEvent(state, `Contract failed — ${contract.sponsor}: ${contract.label} (−${money(fine)})`, 'bad');
    }
  }
}
