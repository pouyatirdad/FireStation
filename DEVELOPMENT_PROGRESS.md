# Development progress

Roadmap: Quick Response stays as it is; Career, personnel, stations, finance, advanced operations,
support agencies, challenges and a scenario editor are added around it. This file is the honest
status. **Version 0.16.0.**

## Where things stand

| Release | Scope | Status |
|---|---|---|
| 0.10 | Gameplay improvements | Done |
| 0.11 | Career foundation | Done |
| 0.12 | Personnel management | Done |
| 0.13 | Station management | Done |
| 0.14 | Advanced operations | Done |
| 0.15 | Multi-agency support | Done |
| 0.16 | Challenge Mode and scenario editor | Done |
| 0.17 | Final polish and release | **Partly done** (see below) |

## Completed features (each has working simulation logic and tests)

**Phase 0 — foundation.** Campaign state (department, reputation, level, money, fleet, stations,
upgrades, people, objectives, history, totals) is separate from shift state. Versioned save envelope,
migration from version 16, validation with safe defaults, corrupt-save quarantine, newer-save protection.

**Phase 1 — gameplay.** Dispatch presets (CRUD, validation, multi-vehicle dispatch, duplicate
prevention, nearest stations, availability, call-off, redirect, warnings, medical vehicles stand by);
ETA from the real A* route (traffic, blockades, speed, driving skill, rush hour); shift report with
S–D grade; incident intelligence.

**Phase 2 — career.** New/continue career, three starts, six levels, reputation, objectives (main,
secondary, daily, long-term), shift end that pays a bonus, moves reputation and carries the fleet,
stations and people into the next shift.

**Phase 3 — personnel.** Profiles, five skills that change the simulation, XP, levels, ranks,
recruitment, training (cost, time, capacity, certifications, no duplicates), fatigue, injuries,
reserve staffing, vehicles that cannot be dispatched without a crew.

**Phase 4 — stations.** Seven upgrades with effects, department-level gating, station limits per
level, garage capacity, coverage and underserved districts, station comparison, station budgets,
upgrade markers on the map.

**Phase 5 — finance.** Salaries and maintenance (career only), monthly funding, monthly summaries,
budgets with warnings, bankruptcy status, emergency funding (manual and automatic at rock bottom),
performance bonuses, category ledger. All money goes through `earn`/`spend`.

**Phase 6 — advanced operations.** Hazmat zones, protection, contamination, decontamination and
leak containment; structural collapse with secondary collapse and rescue gear; evacuation with
shelters, street closures and zone lifting; six multi-stage disasters; weather.

**Phase 7 — agencies.** Police, EMS, civil protection, utility services, coast guard with cost,
response time, cooldown and effect.

**Phase 8–9 — challenges and editor.** Eight challenges with scoring and replay on their own slot;
a validated, data-driven scenario editor with save, edit, copy, delete and play.

**Phase 10 — UI.** Headquarters tabs (Dispatch, People, Stations, Career, Finance, Report, Play),
mode selection on the start screen, incident card with intel and dispatch buttons, search and filter
on the roster, phone-width layout, radio sound mapping, map overlays.

## Partly done or not done (release 0.17)

- **Audio and visuals** are limited to: radio sounds for dispatch and agency events, a promotion
  chime, hatching for collapses, hazard and evacuation zone outlines, route lines with ETAs and
  station upgrade markers. Not done: dedicated sirens per agency, radio chatter voices, new smoke
  variation, building-collapse animation.
- **Simulation polish** not done: smarter civilian evacuation paths (residents walk to the
  shelter, but only a few are drawn), automatic vehicle decision-making beyond the existing dispatch.
- **Station shifts and rosters**: there is no hour-by-hour shift roster; fatigue and rest cover the
  intent (people rest in quarters). Station "budgets" are monthly spending limits that warn, not hard caps.
- **Responsive UI** was checked at the preview-pane width only; no real-device test was run.
- Browser console was checked in the in-app pane; no other browsers were tested.
- The `index.html` bundle is about 900 KB; no performance profiling beyond the headless test runs.

## Known limitations and decisions

- An "incident" in the report is one open item on the map (a burning building, a forest fire, an
  injured person, a swimmer, a wreck). A block fire is one incident per burning building.
- Reputation moves a little with every incident and is recalculated from six factors at the end of a shift.
- A career shift lasts 16 real minutes (one game day); finishing it is the player's choice once the
  clock runs out.
- Saves older than shift version 16 cannot be migrated (the game never wrote them under the current key).
- Challenge and scenario boats are not allowed (the dock is a separate station).
- Building collapse via the earthquake and the gas-blast scene uses the same collapse mechanic.
- Presets are stored per browser and shared by every mode.

## Architecture decisions

- **No new engine.** New systems are modules called from `update()` in `game.js`. State is plain data.
- **Observer for the report.** `report.js` watches the map instead of being called from every incident
  site, so the original systems did not change; career experience and reputation hang off its
  `incident:done` hook (`hooks.js`).
- **Leaf modules** (`modifiers.js`, `hooks.js`, `weather.js`) let units, fire and medical code ask for
  skill rates or emit events without importing career code. The bundler cannot handle import cycles, so
  nothing new may import its importer.
- **Quick Response is untouched**: every new rule returns 1 / does nothing when `state.mode` is not
  `career`, and the default game passes the original tests.
- **Scenarios are data**; the editor and the built-in challenges share one format and validator.

## Tests

`npm test` — 329 tests, all passing (245 existing plus 84 new in `saves`, `operations`, `career`,
`advanced`, `scenarios` and `ui`). One existing test (`world`: early calls near the station) was made
robust because the new collapse and leak scenes change the mix of calls.

## Files changed

New: `src/data/personnel.js`, `src/data/scenarios.js`, `src/data/startScenarios.js`,
`src/systems/{agencies,campaign,careerStats,challenges,collapse,disasters,eta,evacuation,finance,hazmat,hooks,intel,modes,modifiers,objectives,personnel,presets,report,saves,stations,weather}.js`,
`src/ui/command.js`, `src/render/overlays.js`, six test files, this file and `CHANGELOG.md`.

Changed: `config.js` (career, personnel, training, upgrades, agencies, hazard, collapse, evacuation,
hazmat unit), `game.js` (tick order, serialize/load version 17, commands), `units.js` (skill rates,
crew add/remove, bay capacity, staffing gate, hydrant rule), `incidents.js`, `scenes.js`, `fire.js`,
`wildfire.js`, `blockades.js`, `economy.js`, `dispatch.js`, `wind.js`, `audio.js`, `main.js`,
`hud.js`, `render.js`, `index.html`, `styles/game.css`.

## Save migration

See README › Saves.
