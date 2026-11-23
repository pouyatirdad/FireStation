# Changelog

All notable changes to FireStation. The game is one self-contained `index.html`; rebuild it with
`node tools/build.mjs` after changing `src/` or `styles/`.

## 0.18.0 (in progress) — Depth

### Milestone 1 — Hospitals and diving

- **Hospital choice.** Any standing hospital can take a patient, not only the one in a base you own, and it is
  chosen by driving time (the nearest few are routed, the quickest wins), not by straight line. A destroyed
  hospital is unavailable at once; so is one on fire. All of it is in `CONFIG.medical.hospital` (`anyIntact`,
  `byRoute`, `avoidBurning`, `candidates`, `retry`); switching the first three off restores the 0.17 rule exactly.
- **Diversion on the road.** An ambulance that loses its destination while driving (even a few metres from the
  door) says so, picks another hospital from where it is and drives on. With no hospital left the patients stay
  aboard, one warning is given (it used to repeat at every retry) and delivery follows when one stands again.
  The destination is saved (`hospitalId`).
- **The emergency medical service now transports.** Its critical patients used to be stabilised and then simply
  disappear from the street, with no transport fee and no `transported` count. They now go to a hospital in the
  service's own ambulance (travel time from the distance), diverting or waiting in the same way, and are paid
  and counted once, through the same `deliverPatients` an ambulance uses. The call stays on the books, and in
  the save, until they are delivered.
- **Water rescue preset.** It asked for "a rescue boat" by name, so a city without a boat could never answer a
  drowning call from it. Presets have a new **Diving unit** slot (anything that can put divers in the water);
  the built-in water preset uses it, an untouched old one is migrated on load, an edited one is kept.
- **Dive Rescue Training (career).** A new course and certificate: a certified diver brings someone out
  25 % faster, one without it 25 % slower (`CONFIG.water.dive`). Quick Response is unchanged.
- Tests: `hospital.test.js` (14), `diving.test.js` (11), `parity.test.js` (2); one existing test changed
  because it asserted the old owned-bases-only rule. `tools/parity-run.mjs` and
  `test/fixtures/parity-quick.json` hold four deterministic Quick Response shifts recorded on 0.17.1 before any
  change: with the old hospital rules the new code reproduces them exactly.
- Not in this milestone: a hospital's **capacity** and diversion when it is full (milestone 3), and the save
  schema (milestone 2).

## 0.17.1 — Vehicles keep driving after a load

- **Fixed:** a vehicle driving to a call stopped where it was after a save was loaded (a browser refresh
  during a response, or Continue). Saves now keep each vehicle's route, goal, whether it has arrived, what it
  was sent to, a stand-by order, an aircraft's mission and the claims on patients. Saves written before this
  still load, with vehicles at rest as they always did; damaged order data is cleaned on load.
- Tests: 9 new (the 7 that exercise the fix fail on the old code). Checked in a real page reload: the engine
  kept its route, drove on, deployed its crew and put the fire out.

## 0.17.0 — Final QA, polish and release

**Fixed**
- Objectives completed in the very first shift paid out every second (the completion marker was `0`,
  which read as "not done"). A first shift could earn millions.
- A career shift could be filed at once for a free grade, bonus, experience and promotion. A shift now
  has to run half its length, the bonus scales with the time played, and a shift with nothing to do cannot
  earn a top grade.
- Every shift of a career replayed the same calls and wind; each shift now has its own, and a loaded shift
  carries on with fresh luck.
- A newer campaign version inside a current save could be overwritten; it is now refused.
- A new quick shift or career no longer silently replaces a save: the old one is kept
  (`<slot>.replaced`, `<slot>.prev`).
- Unloadable saves now say why on the start screen.
- Hiring candidates topped up over time (they never refilled); station upkeep is tracked for every station.
- The start screen's mode cards fit a phone; the mode cards sit above the long intro.
- Dead code removed; the Headquarters panel is no longer rebuilt every frame.

**Added**
- **Station budgets are enforced.** A monthly budget per station (0 = no limit): upkeep is tracked and
  always paid; vehicles, upgrades and training that would pass the budget are refused with a clear reason;
  warnings at 80% and when passed; monthly reset; refunds on sale; allocation compared with funding.
- **Audio.** Five agency sirens, radio effects (squelch, chatter), rumble, hazard and evacuation sounds,
  a sound panel with volume and five categories (alerts, radio, sirens, ambience, effects), and limits
  against excessive playback.
- **Visuals.** A collapse dust-cloud animation with falling debris, drifting dust while people are buried,
  pulsing incident rings, an evacuation progress ring with queued and cleared buildings and a shelter line,
  station level plates with a blinking tower beacon and a pulsing comms antenna. All culled to the view.
- **Save recovery** screen: restore a backup (an upgraded Quick Response save, a replaced career, an
  unreadable save) without losing the current one.
- Emergency funding clears the debt with a cushion (capped); level 6 needs reputation 85; four challenges
  made harder; a won challenge never scores nothing.
- Dev hook `window.__fireStation.step(seconds)` with a timing breakdown.

**Tested**
- Real-browser run-through (desktop and a 375x812 emulation): see DEVELOPMENT_PROGRESS.md.

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
