# Technical debt — FireStation 0.17.0

A register of known weaknesses, each with the evidence for it, why it matters, a suggested fix and a relative
size (S a few days, M a week or two, L several weeks). It was written from an audit of the repository at commit
`d6a3aae`; items marked **verified** were reproduced, the rest are read from the code. Fix order is in
`NEXT_ROADMAP.md` (release 0.18.0 takes the first group). "Do not rewrite" notes mark systems that work and
should only be extended.

## A. Fix first (blocks the next cycle or can lose player data)

| # | Debt | Evidence | Why it matters | Fix | Size |
|---|---|---|---|---|---|
| A1 | **FIXED in 0.17.1: vehicles en route stopped after a load** (verified) | Script: before saving, an engine and an ambulance had `path` lengths 3 and 2; after `serialize` + `loadState` both were 0 and did not move in 10 s. `serialize` saves `targetId` but not the route, `standbyFor` or the packing timer. Predates 0.10 (engine fields unchanged). | A browser refresh during a response breaks it. Careers and challenges now autosave mid-shift. | Done: the route and order fields are saved and restored (validated), with nine tests. Remaining: crews' walking paths and hospital or diving trips have no dedicated test. | S |
| A2 | **Hand-written serializer** | `serialize`/`loadState` in `game.js` list engines, crews, patients, blockades, victims, wildfires field by field; the career and report extras are separate again. The 0.17.1 fix added more hand-listed fields. | A1 was the symptom. Every future field (vehicle wear, traits, traffic) can be forgotten. | Per-entity schema (`fields`, `defaults`, `version`) driving save and load, with a round-trip test that sets every field. Keep version 17 readable. | M |
| A3 | **No real legacy save fixture** | Migration tests build a version-16-shaped save from the current serializer minus the new fields. | Compatibility with a genuine 0.9 save is assumed, not shown. | Produce a real save from the 0.9 build, commit it as a fixture, test load and continue. | S |
| A4 | **Shallow backups; storage limits untested** | `<slot>.replaced` is overwritten every session; `.prev` holds one career; a career save is about 230 to 300 KB and a full set of slots and backups is 1 to 1.5 MB of roughly 5 MB. | "No save silently destroyed" holds for one step back only; a full storage fails with a warning. | Keep the last three saves per slot (rotating); show sizes; handle quota with a clear message; test in a browser. | S |
| A5 | **No automated browser test** | `main.js` mentions `tools/smoke.mjs`, which does not exist; the 0.17 browser run was manual, scripted by hand through the page. | Regressions in the UI and wiring are only caught by hand. The pane did not run animation frames. | A dependency-free smoke script (or documented checklist) driving `window.__fireStation.step()` through the flows in RELEASE_STATUS 3a; add a real-device checklist. | M |

## 0.18 notes (milestone 1)

- (Done in M2) `serialize`/`restoreFleet` hand lists are replaced by schemas and the persistence registry. Still
  open: the contracts, report, support, evacuation, disaster and scenario sections are saved as plain JSON copies with
  no field-level validation; a schema for each would finish the job. `campaign` people have no schema yet (M4).
- `engine.noHospital` and `engine.hospitalRetry` are deliberately not saved (transient: they only throttle a
  warning and a retry); the milestone-2 coverage guard must list them as transient.
- The EMS call stores `cargo`, `hospitalId`, `deliverAt`, `waiting` on the support record; saves keep them
  through `restoreSupport`'s spread, which is another unvalidated path.

- Deferred from M1: the patient release order (design in DEVELOPMENT_PROGRESS.md, "Architecture decisions").
  It needs a `stabilised` patient state so a released patient is neither dropped nor paid for twice.

## B. Structural (do when a feature touches it; do not rewrite what works)

| # | Debt | Evidence | Fix | Size |
|---|---|---|---|---|
| B1 | **`incidents.js` mixes cadence, spawning and scenes** | 577 lines: cycle phase and coverage radius, ten spawn functions, scene runner, `spawnIncidentKind`. | Split into `director.js` (when/what), `spawners.js` (how); keep `updateIncidents` as entry. Needed for dynamic incidents. | M |
| B2 | **Traffic lives in `blockades.js`** | Visual lane cars, wrecks and `state.trafficFactor` share one module; evacuation closures only delete cars. | Extract `traffic.js`; add a dynamic per-tile cost to routing. Needed for city realism. | M |
| B3 | **`units.js` is 2,350 lines** | Orders, driving, crew behaviour, hydrants, buying and selling, medical hooks. | Move fleet (buy/sell/staff) and crew behaviour out when wear or rosters need them. Add new rates through `modifiers.js`, as skills were. Do not rewrite. | M to L |
| B4 | **Dispatch ranks by straight-line distance** | `dispatch.js` `cost()` uses `dist`; presets use `eta.js`. | One ranking path using `eta.estimate` (it already caches). | S |
| B5 | **Report observer heuristics** | `report.js` scans at 4 Hz, treats each burning building as an incident, attributes deaths by counter deltas, caps `done` at 300 (career averages read from it). | Emit incident ids at creation (a `hooks` event from the spawners) and attribute outcomes explicitly; count totals separately from the capped list. | M |
| B6 | **Event text drives sound** | `eventSound` matches regular expressions on log lines; one reworded message silences or mislabels a sound. | Give events a type id; map type to sound and toast. | S |
| B7 | **Presets have two sources** | `localStorage` key and `campaign.presets`, copied at shift boundaries. | One owner (the campaign in a career, the browser store otherwise) with explicit sync. | S |
| B8 | **Module-level id counters** | `let seq` in `blockades`, `medical`, `water`, `wildfire`, `presets`, `evacuation`. Ids depend on how many games the page has run; restore code scans ids to avoid clashes. | Per-state counters saved with the game. | S |
| B9 | **Scenario format v1 is flat** | Stages are timed only; disasters are a second mechanism (`disasters.js`). | Scenario v2 with triggers; make disasters scenarios (roadmap 0.23). | M |

## C. Consistency and maintainability

| # | Debt | Evidence | Fix | Size |
|---|---|---|---|---|
| C1 | **Balance numbers outside `config.js`** | The project rule is "tunable numbers live in config", but `BONUS` (finance), `UNLOCK` and `RADIUS` (agencies), `LIMIT` (collapse, audio), `MAX_ZONES` and `MIN_ZONE_TIME` (evacuation), `MAX_BUDGET` (stations), `DUST_TIME` (overlays) are constants in code. | Move gameplay numbers into `config.js`; leave rendering constants in the renderer. | S |
| C2 | **Duplicated helpers** | `money` is defined in six places (economy, personnel, command, three times in hud); `esc` twice (hud, command); `incidentPointOf` in `command.js` duplicates `incidentPoint` in `eta.js`. | One `format.js` for money/escape; reuse `eta.incidentPoint`. | S |
| C3 | **HTML built from strings** | `hud.js` (1,170 lines) and `ui/command.js` (620) concatenate markup; rebuilds are avoided by comparing strings and by a "do not rebuild while editing" guard (`isEditing`). | A tiny element helper or keyed patching if the screens grow; until then keep the guard. | M |
| C4 | **`state.stats` is an open bag** | About twenty ad-hoc counters across systems (`dived`, `escaped`, `firefighterInjuries`, `evacuated`...). | Declare them once with defaults, so reports and saves know them. | S |
| C5 | **Dev parameters live in `main.js`** | About 350 lines at the end of `main.js`; `?career` and `?challenge=` write the real save slots. | Move to `dev.js`, loaded only for `?dev`, writing to a separate storage prefix. | S |
| C6 | **Hand-rolled bundler** | `tools/build.mjs` supports only named imports and simple exports; import cycles break silently; patch scripts must use function replacers (`$'` corrupts a file). | Keep; document (done in `CLAUDE.md`); add a cycle check to the build. | S |
| C7 | **Docs drift** | `CLAUDE.md` names `firestation.save.v5` (it is `v16`); `docs/` screenshots show the 0.9 UI; a stale comment in `main.js`. | Refresh with the 0.18 smoke run. | S |

## D. Tests

| # | Debt | Evidence | Fix | Size |
|---|---|---|---|---|
| D1 | **Slow suite** | 357 tests in about 74 s; one month-boundary test takes about 30 s. | Parameterise the month length in tests; run the slow ones in a separate group. | S |
| D2 | **Seed-fragile tests** | One original test (`world`) had to be loosened when scenes changed the call mix; several new tests pick buildings by type and distance from the station (`denseSpot`, `near`). | Build small fixed fixtures (a hand-made city) for system tests; keep seeded tests for generation only. | M |
| D3 | **No visual or audio tests** | Overlays are tested with a recording canvas and audio with a recording stand-in; neither is looked at or listened to by a test. | Screenshot comparison in the smoke run; a listening checklist. | M |
| D4 | **Balance is checked by throw-away scripts** | The 0.17 bots were scratch files. | Make them the 0.18 harness (`tools/`), with loose bounds in CI. | M |

## E. Known behaviour to investigate (see RELEASE_STATUS section 5)

Collapse rescue pace, inflated "failed" counts in the report, the capped report list, the muted-note lag, and the
unmeasured cost of the Headquarters panel and the preset planner with many vehicles and stations.

## F. Verified fine (do not spend time here)

- 60 Hz simulation tick: about 0.2 to 0.3 ms with sixteen vehicles, 46 people and a disaster; twelve career
  shifts in a row grew the heap by about 1 MB.
- Draw cost about 5 to 6.5 ms in the pane with 27 open incidents (the overlays are culled).
- No leaks found in the lists that grow (events, report, hooks, support, evacuation zones).
- No unused imports in the new modules; the dead exports found in 0.17 were removed.
- Line endings: the index and the working tree are LF (`git ls-files --eol`). `core.autocrlf=true` prints "LF will be replaced by CRLF" on every commit; there is no `.gitattributes`, so adding one would make the rule explicit (S).

## G. Suggested guard rails

- Review rule: a pull request that adds saved state must add it to the schema and a round-trip test.
- Review rule: a new rule must be a no-op outside its mode.
- Add a build step that fails on import cycles and on a missing `tools/` file referenced from code.
