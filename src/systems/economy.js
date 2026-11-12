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

export const trainingLevels = (state) => Object.values(state.training ?? {}).reduce((a, b) => a + b, 0);

/** Share of a building loss you still pay: 40% with insurance, all of it without. */
export const lossShare = (state) => (state.insured ? CONFIG.economy.insurance.lossShare : 1);

/** What the city is paying per game hour right now. */
export function hourlyBudget(state) {
  const budget = CONFIG.economy.budget;
  const rating = clamp(state.rating / CONFIG.rating.start, 0, 1);
  const subsidy = Math.round(
    budget.subsidy * (budget.subsidyFloor + (1 - budget.subsidyFloor) * rating),
  );
  // Trained crews cost more to keep.
  const wageRise = 1 + CONFIG.economy.training.wageRise * trainingLevels(state);
  const wages = Math.round(state.crew.length * budget.wage * wageRise);
  const upkeep = state.engines.reduce((sum, e) => sum + (e.spec?.upkeep ?? 0), 0);
  const premium = state.insured ? CONFIG.economy.insurance.premium : 0;
  const interest = Math.round((state.loan ?? 0) * CONFIG.economy.loan.rate);
  return { subsidy, wages, upkeep, premium, interest, net: subsidy - wages - upkeep - premium - interest };
}

// ------------------------------------------------------------- finance ---

/** Borrow one step. The loan accrues interest every game hour until repaid. */
export function takeLoan(state, amount = CONFIG.economy.loan.step) {
  const { max } = CONFIG.economy.loan;
  if ((state.loan ?? 0) + amount > max) {
    addEvent(state, `The bank will not lend more than ${money(max)}`, 'warn');
    return false;
  }
  state.loan = (state.loan ?? 0) + amount;
  state.credits += amount;
  addEvent(state, `Loan of ${money(amount)} taken — owed ${money(state.loan)}, ${Math.round(CONFIG.economy.loan.rate * 100)}% an hour`, 'info');
  return true;
}

export function repayLoan(state, amount = CONFIG.economy.loan.step) {
  const owed = state.loan ?? 0;
  if (owed <= 0) {
    addEvent(state, 'You owe nothing', 'info');
    return false;
  }
  const pay = Math.min(amount, owed);
  if (state.credits < pay) {
    addEvent(state, `Not enough credits to repay ${money(pay)}`, 'warn');
    return false;
  }
  state.credits -= pay;
  state.loan = owed - pay;
  addEvent(state, `Repaid ${money(pay)} — ${state.loan > 0 ? `${money(state.loan)} still owed` : 'loan cleared'}`, 'good');
  return true;
}

export function toggleInsurance(state) {
  state.insured = !state.insured;
  addEvent(
    state,
    state.insured
      ? `Insurance taken out — ${money(CONFIG.economy.insurance.premium)} an hour, losses cost ${Math.round(CONFIG.economy.insurance.lossShare * 100)}%`
      : 'Insurance cancelled',
    'info',
  );
  return state.insured;
}

const TRAINING_LABEL = { fire: 'Fire attack', medic: 'Paramedic', rescue: 'Rescue' };

/** Buy the next level of a crew training programme (applies to every crew). */
export function trainCrew(state, kind) {
  const t = CONFIG.economy.training;
  if (!(kind in TRAINING_LABEL)) return false;
  state.training = state.training ?? { fire: 0, medic: 0, rescue: 0 };
  const level = state.training[kind] ?? 0;
  if (level >= t.cost.length) {
    addEvent(state, `${TRAINING_LABEL[kind]} training is complete`, 'info');
    return false;
  }
  const cost = t.cost[level];
  if (state.credits < cost) {
    addEvent(state, `Not enough credits — ${money(cost)} for ${TRAINING_LABEL[kind]} training`, 'warn');
    return false;
  }
  spend(state, cost, 'training');
  state.training[kind] = level + 1;
  addEvent(state, `${TRAINING_LABEL[kind]} training level ${level + 1} complete`, 'good');
  return true;
}

export { TRAINING_LABEL };

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
    spend(state, b.premium, 'insurance');
    spend(state, b.interest, 'interest');
    ledger.lastBudget = b;
    const sign = b.net >= 0 ? '+' : '−';
    const extra = (b.premium ? `, insurance ${money(b.premium)}` : '') + (b.interest ? `, interest ${money(b.interest)}` : '');
    addEvent(
      state,
      `Hourly budget ${sign}${money(Math.abs(b.net))} — subsidy ${money(b.subsidy)}, wages ${money(b.wages)}, upkeep ${money(b.upkeep)}${extra}`,
      b.net >= 0 ? 'info' : 'warn',
    );
  }

  // A daily report at midnight: what came in, what went out.
  const day = Math.floor(state.clock / 1440);
  if (ledger.day == null) {
    ledger.day = day;
    ledger.dayMark = { earned: ledger.earned, spent: ledger.spent };
  } else if (day > ledger.day) {
    const earned = ledger.earned - ledger.dayMark.earned;
    const spent = ledger.spent - ledger.dayMark.spent;
    ledger.day = day;
    ledger.dayMark = { earned: ledger.earned, spent: ledger.spent };
    addEvent(
      state,
      `Day report — earned ${money(earned)}, spent ${money(spent)}, ${earned >= spent ? 'net +' : 'net −'}${money(Math.abs(earned - spent))}`,
      earned >= spent ? 'good' : 'warn',
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
