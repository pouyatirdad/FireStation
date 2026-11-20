// Career totals: what the department has done over all its shifts, including the
// shift in progress. Objectives and reputation read this.

const SPECIAL = ['rescue', 'hazmat', 'helicopter', 'airtanker', 'fireboat', 'rescueboat', 'ambubus'];

export function emptyTotals() {
  return {
    resolved: 0, failed: 0, rescued: 0, treated: 0, saved: 0, lost: 0, cleared: 0, fatalities: 0,
    injuries: 0, forestFires: 0, responses: 0, responseSum: 0, sShifts: 0, incomeTotal: 0, expensesTotal: 0,
  };
}

/** Everything counted so far this shift, as the same keys the career totals use. */
export function shiftDelta(state) {
  const base = state.report?.base?.stats ?? {};
  const d = (k) => Math.max(0, (state.stats[k] ?? 0) - (base[k] ?? 0));
  const counts = state.report?.counts ?? {};
  const responses = [];
  for (const row of state.report?.done ?? []) if (row.response != null) responses.push(row.response);
  return {
    resolved: counts.resolved ?? 0,
    failed: counts.failed ?? 0,
    rescued: d('rescued'),
    treated: d('treated'),
    saved: d('saved'),
    lost: d('lost'),
    cleared: d('cleared'),
    fatalities: d('casualties'),
    injuries: state.report?.patientsSeen ?? 0,
    forestFires: counts['wildfire:resolved'] ?? 0,
    responses: responses.length,
    responseSum: responses.reduce((a, b) => a + b, 0),
  };
}

export function liveTotals(state) {
  const c = state.campaign;
  const t = c.totals;
  const s = shiftDelta(state);
  const responses = t.responses + s.responses;
  const people = c.personnel;
  return {
    shifts: c.shifts,
    level: c.level,
    stations: state.city.stations.filter((st, i) => !st.sea && state.ownedStations[i]).length,
    roster: people.length,
    resolved: t.resolved + s.resolved,
    rescued: t.rescued + s.rescued,
    treated: t.treated + s.treated,
    saved: t.saved + s.saved,
    cleared: t.cleared + s.cleared,
    forestFires: t.forestFires + s.forestFires,
    responses,
    avgResponse: responses ? (t.responseSum + s.responseSum) / responses : null,
    rescueSpecialists: people.filter((p) => p.skills.rescue >= 4).length,
    trainings: people.reduce((n, p) => n + (p.stats.trainings ?? 0), 0),
    specialVehicles: state.engines.filter((e) => SPECIAL.includes(e.type)).length,
    sShifts: t.sShifts,
  };
}

