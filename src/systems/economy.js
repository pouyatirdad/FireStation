// The money model. Every credit that moves goes through here so the ledger, the
// hourly budget and the "why did I lose money" log all agree.
//
//   income   incident rewards (with a speed bonus), knockdown fees, treatment
//            fees, the hourly city subsidy, and the odd donation
//   costs    crew wages and vehicle upkeep every game hour, medical kits, and the
//            penalties for losing a building or a life
//
// Credits may go negative (the city never closes the station) but nothing can be
// bought while they are below the price.

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { addEvent } from './events.js';

export const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

export function createLedger() {
  return {
    earned: 0,
    spent: 0,
    hourAcc: 0,
    hours: 0,
    lastBudget: null, // { subsidy, wages, upkeep, net }
    nextDonationAt: 0,
  };
}

/** Add credits and record where they came from. */
export function earn(state, amount, tag = 'other') {
  if (!(amount > 0)) return 0;
  state.credits += amount;
  const ledger = state.ledger;
  if (ledger) {
    ledger.earned += amount;
    ledger.by = ledger.by ?? {};
    ledger.by[tag] = (ledger.by[tag] ?? 0) + amount;
  }
  return amount;
}

/** Take credits away (a cost or a penalty). Never refuses; see the module note. */
export function spend(state, amount, tag = 'other') {
  if (!(amount > 0)) return 0;
  state.credits -= amount;
  const ledger = state.ledger;
  if (ledger) {
    ledger.spent += amount;
    ledger.by = ledger.by ?? {};
    ledger.by[tag] = (ledger.by[tag] ?? 0) - amount;
  }
  return amount;
}

/** How much a building is worth to the city, relative to a shop. */
export const valueFactor = (building) => CONFIG.economy.value[building.type] ?? 1;

/**
 * Bonus on an incident reward for getting the fire out quickly: the full bonus
 * inside `fast` seconds of ignition, fading to nothing by `slow`.
 */
export function speedBonus(state, building) {
  const { fast, slow, max } = CONFIG.economy.speedBonus;
  if (building.ignitedAt == null) return 0;
  const elapsed = state.time - building.ignitedAt;
  return max * clamp(1 - (elapsed - fast) / (slow - fast), 0, 1);
}

/** What the city is paying per game hour right now. */
export function hourlyBudget(state) {
  const budget = CONFIG.economy.budget;
  const rating = clamp(state.rating / CONFIG.rating.start, 0, 1);
  const subsidy = Math.round(
    budget.subsidy * (budget.subsidyFloor + (1 - budget.subsidyFloor) * rating),
  );
  const wages = state.crew.length * budget.wage;
  const upkeep = state.engines.reduce((sum, e) => sum + (e.spec?.upkeep ?? 0), 0);
  return { subsidy, wages, upkeep, net: subsidy - wages - upkeep };
}

/** Settle the budget at the top of every game hour; maybe a donation. */
export function updateEconomy(state, dt) {
  const ledger = state.ledger;
  if (!ledger) return;
  const budget = CONFIG.economy.budget;

  ledger.hourAcc += dt;
  if (ledger.hourAcc >= budget.hourEvery) {
    ledger.hourAcc -= budget.hourEvery;
    ledger.hours += 1;
    const b = hourlyBudget(state);
    earn(state, b.subsidy, 'subsidy');
    spend(state, b.wages, 'wages');
    spend(state, b.upkeep, 'upkeep');
    ledger.lastBudget = b;
    const sign = b.net >= 0 ? '+' : '−';
    addEvent(
      state,
      `Hourly budget ${sign}${money(Math.abs(b.net))} — subsidy ${money(b.subsidy)}, wages ${money(b.wages)}, upkeep ${money(b.upkeep)}`,
      b.net >= 0 ? 'info' : 'warn',
    );
  }

  const donation = CONFIG.economy.donation;
  if (state.time >= ledger.nextDonationAt) {
    if (ledger.nextDonationAt > 0 && state.rating >= donation.minRating) {
      const amount = Math.round(state.rng.range(donation.min, donation.max) / 10) * 10;
      earn(state, amount, 'donation');
      addEvent(state, `Community donation — ${money(amount)}`, 'good');
    }
    const [lo, hi] = donation.every;
    ledger.nextDonationAt = state.time + state.rng.range(lo, hi);
  }
}
