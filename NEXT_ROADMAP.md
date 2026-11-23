# Roadmap — 0.18.0 and later

Status of this plan: a proposal. Nothing here is implemented. Sizes are relative effort (S about a few days, M a
week or two, L several weeks) for one developer who knows the code. The order follows the priorities set
for the next cycle: more dynamic and unpredictable incidents, deeper personnel, vehicle and equipment
condition, a more realistic city and traffic, better multi-station management, more complex multi-stage
scenarios, better challenge balance, and better feedback. A stabilisation release comes first because three of
those themes depend on it (see section 1).

Rules for the cycle: Quick Response keeps working and its original tests keep passing; every new rule is a
no-op outside the mode it belongs to; nothing is marked done until it has tests and has been seen running.

## 1. Architecture review: can this carry the plan without a rewrite?

**Short answer: yes.** The simulation is plain data updated by a fixed list of `update` functions, the
renderer and audio only read it, money goes through one economy, and scenarios and scenes are data. Every
theme below fits as new modules called from `update()` plus extra fields on existing records. No rewrite of a
working system is needed. Four pieces of the structure will, however, hurt if they are left as they are.

| Concern | Evidence | What it blocks | Action |
|---|---|---|---|
| **Hand-written serializer.** `serialize`/`loadState` list every saved field by hand (engines, crews, patients...). | Vehicles en route freeze after a load because their route is not saved (RELEASE_STATUS bug 1). Every new field is a chance to forget. | Vehicle condition, person traits, traffic state, anything long-lived. | **Refactor first** (0.18): a small schema per entity (`fields`, `defaults`, `version`) driving both save and load. Do not rewrite the format; keep version 17 readable. |
| **Incident generation is one module that mixes three jobs.** `incidents.js` holds the call cadence (cycle phase, coverage radius), all the spawn functions and the scene runner. | Adding a director (memory, escalation, weather, time of day) means editing the cadence and the spawners together. | Dynamic incidents, scenario v2. | Split into `director.js` (when and what), `spawners.js` (how), `scenes.js` data stays. Keep `updateIncidents` as the entry point. |
| **Traffic lives with wrecks.** `blockades.js` owns visual lane cars, wrecks and the single `state.trafficFactor`. | Real traffic needs per-road load, signals and closures that routing can see. | City and traffic realism, evacuation closures, police effects. | Extract `traffic.js`; give `nav.driveCost` a per-tile dynamic term; keep the visual cars as a view of that load. |
| **`units.js` is 2,350 lines** (orders, driving, crew behaviour, buying, hydrants, medical). | Wear, fuel, breakdowns and crew rotation all need to touch driving, pumping and crew behaviour. | Vehicle condition, personnel depth. | Do not rewrite. Move the purchase/sale/fleet code and crew behaviour into their own files when a feature needs to touch them; add condition through `modifiers.js`, as skills were added. |

Smaller points: `dispatch.js` ranks vehicles by straight-line distance, not ETA (it should use `eta.js`); `hud.js`
and `ui/command.js` build HTML strings (workable, but a small element helper would stop quoting bugs and
re-render churn); `state.stats` is an open bag of counters (fine, but name them in one place); module-level id
counters (`seq`) make ids depend on how many games ran in the page. These are listed in `TECHNICAL_DEBT.md`.

Modules that already suit the plan and need only extension: `modifiers.js` (the single place that turns people,
stations and agencies into rates), `hooks.js` (events between systems), `report.js` (observer; extends to
after-action timelines), `eta.js` (route and ETA with a cache), `scenes.js`/`data/scenarios.js` (data), `saves.js`
(versioned with migration steps), `overlays.js` (view-culled drawing), `audio.js` (categories and limits).

## 2. Release 0.18.0 — Stabilise and measure (size M)

Goal: fix what is known to be wrong and build the tools every later release needs.

1. ~~**Save the route.**~~ **Done in 0.17.1** (route, goal, order ids, stand-by, mission, patient claims; nine tests). Still to
   do: a test for hospital and diving trips. *(S)*
2. **Schema-driven save and load** for engines, crews, patients, wildfires, blockades and the new records, with a
   round-trip test that fills every field and compares. *(M)*
3. **Real save compatibility.** Obtain or produce a genuine save from the 0.9 game (check out the tag before
   `d404995`, play, save) and add it as a fixture. *(S)*
4. **Balance harness** in `tools/`: scripted bots (idle, dispatch-all, a competent one that buys, hires and
   uses presets) that play careers and every challenge and print a table. Run it in CI as a smoke test with loose
   bounds. This replaces the throw-away scripts used in 0.17. *(M)*
5. **Browser smoke test** that can run unattended (a script driving the page through `step()`), covering the
   flows listed in RELEASE_STATUS 3a. Keep it dependency-free if possible (a documented manual checklist is
   the fallback). Add a real-device checklist. *(M)*
6. Investigate and settle RELEASE_STATUS items 2 to 9; deepen the backups (keep the last three saves per slot) and
   check quota failure in a browser. *(S)*
7. Clean the documentation drift (`CLAUDE.md` save key, stale comment, new screenshots). *(S)*

Acceptance: the load bug has a failing-then-passing test; the harness runs in under two minutes; the three bots
rank in the order idle < dispatch-all < competent on every challenge; no known bug in RELEASE_STATUS section 5
is left unexplained.

## 3. Release 0.19.0 — Dynamic and unpredictable incidents (size L)

Goal: calls that have causes, memories and consequences instead of independent dice rolls.

- **Incident director** (`director.js`): keeps a "pressure" value (open incidents, fatigue, vehicles away,
  time since the last big one) and a short history; chooses what is plausible for the hour (cooking fires at
  dinner time, rush-hour crashes, night electrical fires, heat and dry spells for wildfires, storms for
  flooding and fallen trees).
- **Escalation and cascades as data**: an unattended small fire can become a block fire; a gas leak can become
  an explosion; a crash on a bridge can become a water rescue; a hospital under strain slows patient
  hand-over. Each is a row with a trigger, a delay and a probability, using the same hooks as today.
- **Variability inside a scene**: the same scene row rolls trapped people, wind, access problems (a blocked
  hydrant, a locked gate), a second hidden casualty or a false alarm, so no two playings read the same.
- **Weather as a system** (it is only a modifier today): rain, fog, heat and storm change road speed,
  fire spread, visibility and which calls occur, and move on a forecast the player can see.
- Difficulty keeps the cycle idea but is driven by the director's pressure rather than a fixed ramp.

Acceptance: a seeded 30-shift run produces a wide spread of call types with no repeats of the same opening;
every cascade is reachable in a test; the harness bots still rank correctly; Quick Response difficulty is
not harder unless the player chooses it.

## 4. Release 0.20.0 — Vehicles, equipment and deeper personnel (size L)

- **Vehicle condition**: wear from use and distance, fuel/water/foam consumables, breakdown chance, a
  maintenance schedule and downtime in the workshop (the existing workshop upgrade shortens it and cuts cost).
  Condition affects speed, pump power and tank, and is shown on the vehicle card and in the Fleet tab.
- **Equipment as items**: hoses, breathing sets, cutters, medical kits and hazmat suits with condition and
  counts per vehicle and station store, restocking and loss; replaces today's fixed tool counts.
- **Personnel depth**: a duty roster (shifts, days off, overtime and its cost), morale and stress after bad
  calls, traits and specialisations (driver, medic, hazmat, rope rescue, officer), mentoring, retirement and
  the age of the roster, injuries with lasting effects, an officer role that boosts the crew on scene. Reuse
  `modifiers.js`; people stay records in the campaign.
- Costs flow through `finance.js` (parts, fuel, overtime), with station budgets applying.

Acceptance: a vehicle neglected for a month visibly performs worse and can fail on a call; a roster left
alone runs out of rested people; a balanced department can sustain itself in the harness without the bailout.

## 5. Release 0.21.0 — City and traffic realism (size L)

- `traffic.js`: per-road load by time of day and by events, signal and junction delay, closures that routing
  sees (evacuations, police cordons, wrecks), emergency vehicles that clear a queue as they pass, and
  congestion that feeds `nav.driveCost` so ETAs and routes change.
- A road hierarchy with realistic speeds, one-ways and bridges that can close; level crossings and the tram
  as obstacles; response routes that react when a road closes.
- Life in the city: occupancy by hour (offices full at noon, homes at night), which already changes who is
  trapped; hydrant pressure that drops when many engines draw water; power cuts that darken districts.
- Keep rendering cheap: cars stay a view of the load numbers.

Acceptance: ETAs at 08:00 and 03:00 differ; closing a bridge changes the route and the ETA shown; the
benchmark stays under 2% of a frame for the simulation.

## 6. Release 0.22.0 — Multi-station management (size M to L)

- **Dispatch zones and policies**: first-due station per district, automatic mutual aid when a station is
  empty, a move-up that covers an empty district, and dispatch by ETA instead of straight distance.
- **Station roles**: engine, rescue, medical, hazmat, aviation stations with specialised stock; transfer of
  vehicles and people between stations; a station's own call volume and response record.
- **Coverage model**: a cached response-time map for each station and for the department, "if this station
  closes" and "if I build here" previews, and goals such as "90% of buildings within four minutes".
- Per-station budgets become sub-accounts with transfers; a station can be closed and reopened.
- A department-wide board: open incidents by station, units by state, and fatigue by station.

Acceptance: with two stations a call goes to the faster one by ETA; moving a ladder changes the coverage map;
mutual aid happens in a test with one station empty.

## 7. Release 0.23.0 — Multi-stage scenarios and challenge balance (size M to L)

- **Scenario format v2**: stages with triggers (time, "incident resolved", "casualties above n", "unit on
  scene"), branches, optional objectives and timed deadlines; v1 scenarios keep loading through a migration
  step. Disasters become scenarios in this format, so there is one engine for stories, disasters and
  challenges.
- Editor support for stages and triggers; a map picker for locations (a first step towards a map editor).
- **Challenge balance**: rebalance with the 0.18 harness and with human playtests; give each challenge a
  stated target (bot win rates and a par score), a medal threshold and a daily or weekly seed.
- New scenarios built on the engine: a flood, a refinery fire with a chemical cloud and an evacuation, a
  multi-day storm, a stadium crowd emergency.

Acceptance: every built-in challenge has a documented par; no challenge is won by the dispatch-all bot except
the two labelled "introductory"; a v1 scenario file from 0.17 still plays.

## 8. Release 0.24.0 — Feedback and immersion (size M)

- **After-action report** with a timeline and map replay of the shift (extend `report.js`), and the ability
  to see why an incident was lost.
- **Clearer feedback**: a notification centre instead of a scrolling log, call-taker voice lines and radio
  traffic that matches what is happening, a short tutorial and contextual hints, an incident timeline on each
  card, more distinct sirens and stronger audio mixing after real listening tests.
- Visual: smoke and fire that scale with intensity and wind, night-time scene lighting, damage states,
  weather rendering, accessibility options (colour-blind-safe rings, reduced motion, larger text).
- Mobile: a verified layout on real devices, haptics that respect permissions, one-handed controls.

Acceptance: a new player can finish the first shift using only the tutorial; audio has been reviewed by
listening; the layout has been checked on at least one real phone and one tablet.

## 9. Toward 1.0

1.0 means: the 0.18 harness and smoke tests run on every change; saves are schema-driven and migrate from
every released version; balance is checked by bots and by people; the game has been played on real devices and
in more than one browser; documentation, screenshots and the in-game help match the game.

## 10. Cross-cutting rules

- Every feature ships with tests, a harness check and a line in `RELEASE_STATUS.md` saying what was seen
  running.
- New saved fields go through the schema (after 0.18), with a migration step if the meaning changes.
- Balance numbers stay in `config.js`; scenario and scene content stays data.
- Keep `index.html` self-contained and playable by double-click; add no runtime dependency.
- Keep the 60 Hz tick under 2% of a frame on the benchmark.
