// Career finance, built on the one economy in economy.js: every credit still
// moves through `earn` and `spend`; this module decides *what* is charged.
//
//   hourly    salaries, station and vehicle maintenance (career only)
//   monthly   government funding, a finance summary, budget checks
//   anytime   bankruptcy warnings, emergency funding, performance bonuses
//
// Quick Response never calls any of it, so its simplified economy is unchanged.

import { CONFIG } from '../core/config.js';
import { salaryOf } from '../data/personnel.js';
import { addEvent } from './events.js';
import { earn, hourlyCharges, money, spend } from './economy.js';
import { isCareer, upgradeLevel } from './modifiers.js';
import { emit } from './hooks.js';
import { people } from './personnel.js';

export const CATEGORIES = {
  income: {
    incidents: ['incident', 'knockdown', 'rescue', 'treatment', 'transport'],
    contracts: ['contract'],
    funding: ['funding', 'grant', 'donation', 'bonus', 'emergency'],
    other: ['vehicle'],
  },
  expense: {
    personnel: ['salary', 'recruitment', 'training'],
    operations: ['maintenance', 'kits', 'agency'],
    capital: ['vehicle', 'station', 'upgrade'],
    losses: ['loss', 'casualty', 'contract'],
    finance: ['interest', 'insurance'],
  },
};

export const categoryOf = (tag, side) => {
  for (const [name, tags] of Object.entries(CATEGORIES[side])) if (tags.includes(tag)) return name;
  return 'other';
};

export function createFinance() {
  return {
    hourAcc: 0,
    monthAcc: 0,
    month: 1,
    monthMark: null,
    budget: {}, // category -> credits allowed per month
    warned: {}, // 'category:month' -> true
    level: 'ok',
    lastEmergencyAt: null, // campaign.shifts when emergency money was last given
    stationCosts: {}, // station index -> maintenance paid so far
  };
}

export const monthSeconds = () => CONFIG.career.monthDays * (1440 / CONFIG.clockRate);

// -------------------------------------------------------------- operating ---

/** Per game hour: what the stations and vehicles cost to keep, with the workshop discount. */
export function maintenanceBreakdown(state) {
  const cfg = CONFIG.career.maintenance;
  const perStation = {};
  const add = (i, v) => { perStation[i] = (perStation[i] ?? 0) + v; };
  state.city.stations.forEach((st, i) => {
    if (!(state.ownedStations?.[i])) return;
    const ups = state.campaign.stations?.[i]?.upgrades ?? {};
    const levels = Object.values(ups).reduce((a, b) => a + b, 0);
    add(i, cfg.station + cfg.upgradeLevel * levels);
  });
  for (const e of state.engines) {
    const i = state.city.bays[e.bayIndex]?.station ?? 0;
    const discount = Math.min(0.75, CONFIG.upgrades.workshop.per * upgradeLevel(state, i, 'workshop'));
    add(i, cfg.vehicle * (1 + (e.spec.cost ?? 1000) / 4000) * (1 - discount));
  }
  const total = Object.values(perStation).reduce((a, b) => a + b, 0);
  return { total, perStation };
}

export function payroll(state) {
  let total = 0;
  for (const p of people(state)) total += salaryOf(p);
  return total;
}

/** Everything that leaves per game hour. */
export function hourlyBurn(state) {
  const fixed = hourlyCharges(state).total;
  return payroll(state) + maintenanceBreakdown(state).total + fixed;
}

export function fundingForMonth(state) {
  const f = CONFIG.career.funding;
  return Math.round((f.baseMonthly + f.perRep * (state.campaign.reputation ?? 0)) / 50) * 50;
}

// ------------------------------------------------------------- bankruptcy ---

/** 'ok' | 'low' | 'critical' | 'bankrupt', and how many game hours the money will last. */
export function bankruptcyStatus(state) {
  const b = CONFIG.career.bankruptcy;
  const burn = hourlyBurn(state);
  const hoursLeft = burn > 0 ? Math.max(0, state.credits) / burn : Infinity;
  let level = 'ok';
  if (state.credits <= b.emergencyAt) level = 'bankrupt';
  else if (state.credits < 0) level = 'critical';
  else if (state.credits < b.warnAt || hoursLeft < 2) level = 'low';
  return { level, hoursLeft, burn };
}

/** Why emergency funding cannot be asked for now, or null if it can. */
export function emergencyBlock(state) {
  const fin = state.campaign.finance;
  const b = CONFIG.career.bankruptcy;
  const status = bankruptcyStatus(state);
  if (status.level === 'ok' || status.level === 'low') return 'The department is not in trouble';
  if (fin.lastEmergencyAt != null && state.campaign.shifts - fin.lastEmergencyAt < b.cooldownDays) {
    return 'The city has already bailed you out recently';
  }
  return null;
}

/** The city steps in with emergency money; it costs reputation and can be asked for only now and then. */
export function requestEmergencyFunding(state) {
  const block = emergencyBlock(state);
  if (block) {
    addEvent(state, block, 'warn');
    return false;
  }
  const b = CONFIG.career.bankruptcy;
  const fin = state.campaign.finance;
  // Enough to clear the debt and leave a cushion, so one bailout is never swallowed by the next hour's bills.
  const amount = Math.min(b.emergencyMax, Math.max(b.emergencyAmount, Math.ceil((-state.credits + b.cushion) / 500) * 500));
  earn(state, amount, 'emergency');
  state.campaign.reputation = Math.max(0, state.campaign.reputation - b.repPenalty);
  fin.lastEmergencyAt = state.campaign.shifts;
  addEvent(state, `Emergency funding — the city pays ${money(amount)}, reputation −${b.repPenalty}`, 'warn');
  return true;
}

// -------------------------------------------------------- performance pay ---

export const BONUS = { S: 3000, A: 1800, B: 900, C: 300, D: 0 };

/** The performance bonus for a grade, scaled by how much of the shift was played. */
export function payShiftBonus(state, grade, share = 1) {
  const amount = Math.round(((BONUS[grade] ?? 0) * Math.max(0, Math.min(1, share))) / 50) * 50;
  if (amount > 0) {
    earn(state, amount, 'bonus');
    addEvent(state, `Performance bonus for a grade ${grade} shift — ${money(amount)}`, 'good');
  }
  return amount;
}

// ------------------------------------------------------------ month / hour ---

function sumByCategory(by) {
  const income = {};
  const expense = {};
  let totalIn = 0;
  let totalOut = 0;
  for (const [tag, amount] of Object.entries(by)) {
    if (amount > 0) {
      const c = categoryOf(tag, 'income');
      income[c] = (income[c] ?? 0) + amount;
      totalIn += amount;
    } else if (amount < 0) {
      const c = categoryOf(tag, 'expense');
      expense[c] = (expense[c] ?? 0) - amount;
      totalOut -= amount;
    }
  }
  return { income, expense, totalIn, totalOut, net: totalIn - totalOut };
}

/** What happened since the month began, by category. */
export function monthToDate(state) {
  const fin = state.campaign.finance;
  const now = state.ledger?.by ?? {};
  const mark = fin.monthMark ?? {};
  const diff = {};
  for (const [tag, v] of Object.entries(now)) diff[tag] = v - (mark[tag] ?? 0);
  return sumByCategory(diff);
}

export function setBudget(state, category, amount) {
  const fin = state.campaign.finance;
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n < 0) return false;
  if (n === 0) delete fin.budget[category];
  else fin.budget[category] = n;
  return true;
}

function checkBudgets(state) {
  const fin = state.campaign.finance;
  const m = monthToDate(state);
  for (const [category, limit] of Object.entries(fin.budget)) {
    const spent = m.expense[category] ?? 0;
    const key = `${category}:${fin.month}`;
    if (spent > limit && !fin.warned[key]) {
      fin.warned[key] = true;
      addEvent(state, `Over budget — ${category}: ${money(spent)} of ${money(limit)} this month`, 'warn');
    }
  }
}

function closeMonth(state) {
  const c = state.campaign;
  const fin = c.finance;
  const m = monthToDate(state);
  c.history.months.push({ month: fin.month, income: m.totalIn, expenses: m.totalOut, net: m.net, byIncome: m.income, byExpense: m.expense });
  if (c.history.months.length > 24) c.history.months.shift();
  addEvent(state, `Month ${fin.month} summary — income ${money(m.totalIn)}, expenses ${money(m.totalOut)}, net ${m.net >= 0 ? '+' : '−'}${money(Math.abs(m.net))}`, m.net >= 0 ? 'good' : 'warn');
  fin.month += 1;
  fin.monthMark = { ...(state.ledger?.by ?? {}) };
  const funding = fundingForMonth(state);
  earn(state, funding, 'funding');
  addEvent(state, `Government funding for month ${fin.month} — ${money(funding)}`, 'good');
  fin.warned = {};
  emit(state, 'finance:month', { month: fin.month });
}

export function updateCareerFinance(state, dt) {
  if (!isCareer(state)) return;
  const c = state.campaign;
  const fin = c.finance;
  if (!fin.monthMark) fin.monthMark = { ...(state.ledger?.by ?? {}) };

  fin.hourAcc += dt;
  if (fin.hourAcc >= CONFIG.economy.hourEvery) {
    fin.hourAcc -= CONFIG.economy.hourEvery;
    const wages = payroll(state);
    const upkeep = maintenanceBreakdown(state);
    if (wages > 0) spend(state, wages, 'salary');
    if (upkeep.total > 0) spend(state, upkeep.total, 'maintenance');
    for (const [i, v] of Object.entries(upkeep.perStation)) fin.stationCosts[i] = (fin.stationCosts[i] ?? 0) + v;
    if (wages + upkeep.total > 0) {
      addEvent(state, `Payroll ${money(wages)} · upkeep ${money(upkeep.total)}`, 'warn');
    }
    emit(state, 'finance:hour', { perStation: upkeep.perStation });
    checkBudgets(state);
  }

  fin.monthAcc += dt;
  if (fin.monthAcc >= monthSeconds()) {
    fin.monthAcc -= monthSeconds();
    closeMonth(state);
  }

  const status = bankruptcyStatus(state);
  if (status.level !== fin.level) {
    if (status.level === 'low') addEvent(state, 'Money is running low — the department can pay its bills for under two more hours', 'warn');
    if (status.level === 'critical') addEvent(state, 'The department is in debt — ask the city for emergency funding in Finance', 'bad');
    if (status.level === 'bankrupt') addEvent(state, 'BANKRUPTCY — emergency funding is available in Finance', 'bad');
    fin.level = status.level;
  }
  // Rock bottom: the city steps in by itself, once, and it costs standing.
  if (status.level === 'bankrupt' && !emergencyBlock(state)) requestEmergencyFunding(state);
}

/** Everything the finance screen shows. */
export function financialReport(state) {
  const c = state.campaign;
  const maint = maintenanceBreakdown(state);
  return {
    balance: state.credits,
    status: bankruptcyStatus(state),
    payroll: payroll(state),
    maintenance: maint.total,
    perStation: maint.perStation,
    loanCharges: hourlyCharges(state),
    funding: fundingForMonth(state),
    month: c.finance.month,
    monthToDate: monthToDate(state),
    budget: c.finance.budget,
    history: c.history.months.slice(-6),
    emergencyBlock: emergencyBlock(state),
    monthProgress: c.finance.monthAcc / monthSeconds(),
  };
}
