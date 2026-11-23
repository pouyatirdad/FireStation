# Development progress

Roadmap: Quick Response stays as it is; Career, personnel, stations, finance, advanced operations,
support agencies, challenges and a scenario editor are added around it. This file is the honest
status. **Version 0.17.1 — release candidate** (0.17.1 fixes vehicles stopping after a load).

## Where things stand

| Release | Scope | Status |
|---|---|---|
| 0.10 | Gameplay improvements | Done |
| 0.11 | Career foundation | Done |
| 0.12 | Personnel management | Done |
| 0.13 | Station management (with enforced budgets) | Done |
| 0.14 | Advanced operations | Done |
| 0.15 | Multi-agency support | Done |
| 0.16 | Challenge Mode and scenario editor | Done |
| 0.17 | Final QA, polish and release | Done, with the limits listed below |
| 0.18 M1 | Hospitals (choice, diversion, EMS transport) and diving | Done on `feature/0.18-depth`; M2–M5 not started |

## Features (each has working simulation logic and tests)

**Foundation.** Campaign state (department, reputation, level, money, fleet, stations, upgrades, people,
objectives, history, totals) is separate from shift state. Versioned save envelope, migration from
version 16, validation with safe defaults, quarantine of unreadable saves, protection of newer saves,
backups and a restore screen.

**Gameplay.** Dispatch presets (create, edit, delete, multi-vehicle dispatch, no duplicates, nearest
stations, availability, call-off, redirect, warnings; medical vehicles stand by at fires); ETA from the
real A* route with traffic, blockades, speed and driving skill; shift report graded S to D; incident
intelligence on the incident card.

**Career.** New/continue career, three starts, six levels, reputation, objectives, shift filing (after
half a shift) that pays a bonus scaled to the time played, moves reputation and carries the fleet,
stations and people into the next shift, with its own calls and wind each shift.

**Personnel.** Profiles; five skills that change work rates and speed; XP, levels, ranks; recruitment
with a candidate list that tops itself up; training (cost, time, capacity, certifications, no
duplicates); fatigue; injuries; reserve staffing; a vehicle with no crew cannot be dispatched.

**Stations.** Seven upgrades with effects, department-level gating, station limits per level, garage
capacity, coverage and underserved districts, comparison, map markers (levels, animated tower beacon and
comms antenna). **Station budgets are enforced**: each station has a monthly budget (0 = no limit); its
upkeep is tracked and always paid, and a vehicle, upgrade or training that would take it over budget is
refused with a clear message; warnings at 80% and when passed; budgets reset each month; selling a
vehicle returns its cost to the station's tally; the allocation is compared with the expected monthly
funding. Station spending reconciles with the ledger (tested).

**Finance.** Salaries and maintenance (career only), monthly funding, summaries, category budgets,
bankruptcy status, emergency funding that covers the debt with a cushion (capped, costs reputation,
cooldown), performance bonuses. All money goes through `earn`/`spend`.

**Operations.** Hazmat zones, protection, contamination, decontamination and leak containment;
structural collapse with a dust-cloud animation, secondary collapse and rescue gear; evacuation with a
progress ring, marching zone outline, queued and cleared buildings, shelter line, street closures and
zone lifting; six multi-stage disasters; weather. Pulsing rings mark every open incident.

**Agencies.** Police, EMS, civil protection, utility services, coast guard: cost, response time,
cooldown and effect.

**Challenges and editor.** Eight challenges with scoring and replay on their own slot; a validated,
data-driven scenario editor.

**Audio.** Agency-specific sirens (five distinct voices), radio effects (squelch, chatter, tail click),
incident sounds (rumble, hazard alarm, evacuation whoops), a sound panel (volume and five categories)
and limits against excessive playback (per-sound cooldowns and at most six one-shots per two seconds).

## Real problems found and fixed in this pass

- **Objectives paid every second** when completed in the first shift (a falsy `0` marked them not done):
  millions of credits in one shift. Fixed; regression test.
- **Instant shift filing** gave a free "A" grade, bonus, experience and promotions. A shift must now run
  half its length, the bonus scales with time, and a shift with nothing to do cannot earn a top grade.
- **Every career shift replayed the same calls and wind.** Each shift now has its own seed; a loaded
  shift continues with fresh luck.
- A newer campaign version inside an otherwise current save could be overwritten; it is now refused.
- A new quick shift or career could silently replace a save; the previous one is now kept
  (`<slot>.replaced`, `<slot>.prev`) and can be restored from the start screen.
- Unloadable saves gave no message on the start screen; they now say why and point to recovery.
- Candidates for hire never refilled during a shift; they now top up (without allowing re-rolls).
- Station upkeep was not tracked for stations without an upgrade record; it is now.
- The start screen's mode cards overflowed a phone; fixed and checked in the emulated viewport.
- Dead exports and unused code were removed; the Headquarters panel no longer rebuilds every frame.

## Test results

`npm test`: 366 tests, 366 passing, 0 failing (the original 245 plus 121 new; the last 9 are the 0.17.1 load fix). New suites: `saves`, `integrity`, `budget`,
`audio`, `operations`, `career`, `advanced`, `scenarios`, `ui`.

**Browser testing** (in-app browser pane, desktop size and the 375x812 mobile emulation), all driven by
script and checked by reading the page and screenshots:
game start; Quick Response play, dispatch, preset ETA, save, reload and continue; career creation, hire,
train, upgrade, budget limits, vehicle purchase, shift filing refused early then accepted, next shift,
reload and continue; replacing a career after confirmation and declining; the recovery screen; corrupt
and newer saves; the earthquake disaster with collapse, EMS call-out and evacuation; a challenge to its
result screen and stored best score; the preset editor and the scenario editor with validation; the sound
panel; mobile layout of the start screen and every Headquarters tab (no horizontal overflow), tap,
Order mode and press-and-hold orders.

**Limits of that testing.** The pane did not run animation frames on its own, so the simulation was
advanced with the `window.__fireStation.step(seconds)` hook (which draws a frame and updates the HUD)
instead of being watched in real time. Touch input was simulated with pointer events in an emulated
viewport, **not on a real phone or tablet**. No sound could be heard: audio is tested against a recording
stand-in for the Web Audio API and by checking the settings, not by listening. Only one browser engine
was used. Frame cost measured in the pane: about 5 to 6.5 ms for the draw with an earthquake and 27 open
incidents, under 1 ms for the simulation tick.

## Balance review

- A scripted bot plays careers: with no skill it goes bankrupt through casualty penalties (as in Quick
  Response), a first shift handled even badly is roughly break-even, running costs are small next to
  incident rewards and penalties (about $1.8k a shift for six people and two vehicles).
- Closed money exploits: objective double pay, instant shift filing, re-rolling candidates by hiring.
  Selling a vehicle returns 60%; training and hiring cannot make money; emergency funding costs reputation
  and has a cooldown; idle time loses money (funding is slightly below running costs).
- Level 6 now needs reputation 85 (was 90): reachable only with consistently excellent shifts.
- Challenges against two bots (idle, and plain "dispatch all"): idle loses all eight; the plain bot wins
  No Water Supply and Mass Casualty and loses the rest, so those two are the gentler ones. Highway,
  Siege, Mass Casualty and Industrial were made harder (more waves, casualty limits).
- Not tuned by human play: skill and fatigue rates, training value, upgrade value. They are in
  `config.js` and were chosen to be noticeable but small (6% per skill level).

## Performance

Headless: about 0.2 to 0.3 ms per tick with sixteen vehicles, 46 people, an earthquake, an evacuation and
a forest siege (under 2% of a frame). Twelve career shifts in a row grow the heap by about 1 MB; no list
grows without a bound (events 40, report 300, one hook set per shift). The command overlays are culled to
the view and animated from the clock; the Headquarters panel is rebuilt at most four times a second while
the game runs and almost never while it is paused.

## Remaining limitations and known issues

- 0.18 M1: hospitals have no **capacity** yet, so a "full hospital" cannot divert an ambulance (milestone 3);
  the EMS service's ambulance is an abstraction (a timer from the straight-line distance, not a vehicle on the
  map); with no hospital standing, patients wait aboard indefinitely (the release order is deferred, see the decision below); the new hospital
  rules also apply in Quick Response, where they change who is taken where by a small amount (parity run: same
  fires, calls and fleet, a few patients differently treated).

- No real-device, real-time or audible testing (see above). Audio output has never been listened to.
- Station budgets are monthly spending limits with refusal of purchases, not a separate bank account:
  mandatory upkeep is always paid.
- There is no hour-by-hour shift roster; fatigue and rest cover the intent.
- Mass Casualty and No Water Supply are beatable by plain dispatching; they are the easy end of Challenge
  Mode.
- Boats cannot be used in scenarios (the dock is a separate station).
- An "incident" is one open item on the map; a block fire is one incident per burning building.
- Saves older than shift version 16 cannot be migrated. Presets are per browser and shared by modes.
- Known cosmetic issue: the sound panel's "muted" note updates on the next panel refresh.
- Balance has been reviewed with bots and arithmetic, not with many hours of human play.

## Architecture decisions

- **0.18 M1: release order for patients deferred.** If every hospital is unavailable, an ambulance keeps its
  patients aboard (they are stabilised, so there is no survival clock) and retries every few seconds, with one
  warning. A manual "release" was left out because a released patient must become a street patient again, and
  with today's data that either loses them or pays the treatment fee twice. Intended handling, with milestone 3
  (hospital capacity): a released patient returns to the street as a *stabilised* patient (`stabilised: true`,
  severity kept, no second treatment fee, a fresh clock equal to the remaining critical time), claimable by any
  ambulance with room; they count as a casualty only if that clock runs out; and the same path is used when a
  vehicle is lost with patients aboard. Until then waiting aboard is the safe behaviour: nobody disappears and
  nobody is paid twice.

- **No new engine.** New systems are modules called from `update()` in `game.js`. State is plain data.
- **Observer for the report.** `report.js` watches the map instead of being called from every incident
  site; career experience and reputation hang off its `incident:done` hook (`hooks.js`).
- **Leaf modules** (`modifiers.js`, `hooks.js`, `weather.js`) let units, fire and medical code ask for skill
  rates or emit events without importing career code. The bundler cannot handle import cycles.
- **Quick Response is untouched**: every new rule does nothing when `state.mode` is not `career`.
- **Scenarios are data**; the editor and the built-in challenges share one format and validator.
- **Dev hook** `window.__fireStation.step(seconds)` advances and draws by hand for headless browsers.

## Save migration

See README, Saves.
