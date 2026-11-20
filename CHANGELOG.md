# Changelog

All notable changes to FireStation. The game is one self-contained `index.html`; rebuild it with
`node tools/build.mjs` after changing `src/` or `styles/`.

## 0.16.0 — Challenge Mode and the scenario editor

- **Challenge Mode.** Eight scored challenges (One Engine Only, No Water Supply, Night Emergency,
  Highway Disaster, Forest Under Siege, Budget Crisis, Mass Casualty, Industrial Emergency) with
  starting conditions, fleets, budgets, time limits, success and failure conditions, a final score
  and replay. Best scores are kept per challenge. Challenges use their own save slot and cannot touch a
  Quick Response or career save.
- **Scenario editor** (Headquarters › Play). A data-driven editor: name, start time, weather, wind,
  credits, vehicles, restrictions (dead hydrants, no loans, no purchases, random calls), scripted
  incidents (type, time, location, fire intensity, trapped, injured), success and failure conditions.
  Scenarios are validated, saved, edited, copied from a challenge and deleted. The location model
  (`auto`, `type`, `building`) is extensible for a future map editor.
- Dev helpers: `?career`, `?challenge=<id>`, `?disaster=<id>`.

## 0.15.0 — Multi-agency support

- Police, emergency medical service, civil protection, utility services and the coast guard as
  support call-outs with a cost, response time, cooldown and one real effect each: police remove the
  rush-hour penalty and speed wreck clearing near the scene; EMS treats up to four injured people;
  civil protection opens a shelter and doubles evacuation pace; utility services cut gas and power
  (no explosion, slower fire); the coast guard pulls swimmers out. Careers unlock them by level.

## 0.14.0 — Advanced operations

- **Hazmat.** Leaking and chemically burning buildings have hazard zones. Unprotected crews are
  contaminated and overcome (a casualty to treat; in a career the person is injured). A new hazmat
  unit and hazmat-certified personnel are protected, can contain leaks and decontaminate crews.
- **Structural collapse.** Buried people, slow rescue by hand and fast with cutting gear, secondary
  collapses that bury more people and hurt rescuers, and a clock after which people are lost.
- **Evacuation.** Evacuation zones empty buildings one by one, walk residents to emergency shelters,
  close the streets, protect against deaths when an emptied building burns, and lift when safe.
- **Major disasters.** Multi-stage earthquake, hurricane, airport disaster, industrial explosion,
  forest siege and multiple building fires, built from the existing incident primitives. In a career at
  level 4 and above they can strike on their own.
- Collapse, leak and gas-blast scenes join the incident scenes; weather (rain, fog, storm, heat) slows
  roads and shifts the wind.

## 0.13.0 — Station management

- Seven station upgrades with real effects: garage (bays), training centre (places and speed),
  medical centre (recovery), maintenance workshop (upkeep), communication centre (response speed),
  equipment storage (tools per vehicle) and fire watch tower (smaller forest fires). Costs, levels,
  department-level requirements, map markers and save persistence.
- Stations tab: coverage by district with underserved districts, a station comparison table and
  per-station monthly budgets.

## 0.12.0 — Personnel management

- Every firefighter is a persistent person: name, rank, level, five skills, certifications,
  fatigue, injuries, assigned vehicle and career statistics.
- Skills change the simulation: firefighting (spray power), rescue, medical (treatment time),
  driving (vehicle speed) and technical (cutting gear). Fatigue slows work; injuries take people off
  their vehicle and the reserve steps in.
- Recruitment with a candidate list, training courses with cost, time, capacity and certifications,
  experience, levels and rank promotion.

## 0.11.0 — Career foundation

- **Career mode**: a persistent campaign (department, reputation, level, money, fleet, stations,
  people, objectives, finance history, totals) separate from the shift. Three starting points.
- Six department levels that unlock vehicles, stations and upgrade levels.
- Main, secondary, daily and long-term objectives with rewards and persistent progress.
- Reputation from response efficiency, rescues, outcomes, safety, finances and readiness.
- Career finance through the one economy: salaries, maintenance, monthly government funding,
  monthly summaries, per-category budgets, bankruptcy warnings, emergency funding and performance bonuses.
- Versioned saves with migration, validation and safe defaults (see README › Saves).

## 0.10.0 — Gameplay improvements

- **Dispatch presets**: create, edit and delete named vehicle combinations; one action sends the
  whole set, never sends duplicates, reports what is missing, and can call vehicles off or redirect them.
- **ETA**: arrival times from the real route and speed, traffic, blockades and driving skill; routes
  drawn on the map.
- **Shift report** with a graded rating (S–D) that weighs resolution, response time, safety, property
  and finances.
- **Incident intelligence** on the incident card: severity, danger, explosion risk, secondary risks,
  trapped people, required equipment, recommended presets and conditions.

## 0.9.0 and earlier

See the git history.
