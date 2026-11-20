# Release status — FireStation 0.17.1

Audit date: 2026-11-20 (updated for 0.17.1, which fixes bug 1 below). This file says what is **verified**, what is only **implemented**, and what is
**unknown**. Where something was not checked, it says so. `DEVELOPMENT_PROGRESS.md` is the history of the
work; this is the current state.

## 1. Verification record

| Check | Result |
|---|---|
| Branch | `new-changes` (tracks `origin/new-changes`, no difference from the remote) |
| Commit | Audited at `d6a3aae` "Final QA pass..." and `903e80f` (audit documents); the load fix is the commit after it (0.17.1) |
| Contains the QA commit | Yes (`d6a3aae` is `HEAD`; it follows `d404995` and `0d6d2a2`) |
| Uncommitted changes | None at the start of the audit. The audit itself changes only documentation and two stale sentences (README, in-game help), listed in section 6 |
| `package.json` version | 0.17.1 |
| Full test suite (`npm test`) | **366 tests, 366 pass, 0 fail**, about 75 s (357 at the 0.17.0 audit, plus 9 for the load fix) |
| `index.html` matches the sources | Yes: `node tools/build.mjs` reproduces the committed file |
| Bundle syntax | Loads; `new Function` parse succeeds; no console errors in the last browser run except a benign `navigator.vibrate` notice from synthetic touch |

Branch point: `master` is at `4a6cd57` (merge of PR #4). The pull request for `new-changes` is for the
user to open and merge; the audit did not check its state on GitHub.

## 2. Documentation accuracy

- `README.md`, `CHANGELOG.md` and `DEVELOPMENT_PROGRESS.md` were compared with the code. Mismatches found and
  corrected: README said "thirteen kinds of apparatus" (there are fourteen, with the hazmat unit); README and
  the in-game help said vehicles cost nothing to run without saying this is Quick Response only; README's
  "Not built yet" still listed per-agency sirens, which exist.
- Known remaining drift (not fixed here, see `TECHNICAL_DEBT.md`): `CLAUDE.md` still names the save key
  `firestation.save.v5` (it is `v16`); the screenshots in `docs/` predate the new screens; a comment in
  `main.js` points at `tools/smoke.mjs`, which does not exist.
- `DEVELOPMENT_PROGRESS.md` states its test count (357) and it is correct today.

## 3. Features

### 3a. Implemented, covered by automated tests, and exercised in a real browser
(The in-app browser pane at desktop size and a 375x812 emulation, driven by script.)

- Quick Response: start, play, dispatch, save, reload, continue.
- Career: creation, saving, loading, replacing after confirmation and declining, shift filing (refused
  early, accepted later), next shift.
- Personnel: hiring, training. Station upgrades and station budgets (including the refusal when over).
- Vehicle purchase with career locks. Dispatch presets (create, reject duplicate, delete, send) and the ETA
  on the incident card. Incident intelligence card.
- Save recovery: backup list, restore, corrupt save, newer save, declined and accepted replacement.
- Earthquake disaster, collapse (drawn), EMS call-out, evacuation order.
- One challenge to its result screen with a stored best score; the scenario editor with validation.
- Sound panel (stored settings). Mobile layout of the start screen and every Headquarters tab.

### 3b. Implemented and covered by automated tests only (not seen in a browser)

- Hazmat zones, contamination, decontamination and leak containment.
- Hurricane, airport, industrial, forest-siege and multiple-fire disasters (start and stages).
- Police, civil protection, utility and coast-guard call-outs; weather.
- Monthly finance, bankruptcy and emergency funding, performance bonuses, objectives over several shifts,
  department promotion, fatigue and injury recovery, skill effects on work rates.
- Seven of the eight challenges were run only by bots, headless.
- Migration of a version-16-shaped save (see 4: no real old save was used).

### 3c. Implemented but not tested on real devices

- Touch controls (tap, Order mode, press-and-hold, pinch) and the narrow layout: only synthetic pointer
  events in an emulated phone viewport were used. No real phone, tablet or touch screen was used.
- Anything depending on real hardware: high-DPI scaling, mobile browser quirks, battery and thermal behaviour.

### 3d. Implemented but never verified at all

- **Sound output.** Nothing was ever listened to. The synthesis code runs against a recording stand-in for the
  Web Audio API, and settings and rate limits are tested, but whether the sirens, radio and alarms sound
  good, distinct or too loud is unknown.
- Real-time play: the pane did not run animation frames, so the game was advanced with
  `window.__fireStation.step()`. Frame pacing and input latency in real use are unmeasured.
- Browsers other than the pane's Chromium engine.

## 4. Known gameplay limitations

- Quick Response compatibility rests on the original 245 tests and a test that builds a version-16-shaped
  save from the current serializer. **No save file written by the real 0.9 game was available**, so migration
  of a genuine old save has not been proven.
- Balance was reviewed with bots and arithmetic, not human play. A plain "dispatch all" bot wins two of the eight
  challenges (No Water Supply, Mass Casualty); the other six defeat it; an idle player loses all eight.
- A bot that only dispatches loses many buildings and people in a 16-minute Quick or career shift with one
  or two vehicles; whether that is the intended difficulty has not been judged by a person.
- A career shift is one game day (16 minutes); there is no duty roster, no days off, no overtime.
- Station budgets are monthly spending limits, not separate accounts. Mandatory upkeep ignores them.
- Presets are stored per browser and shared by all modes.
- Scenarios cannot use boats; the scenario editor cannot place incidents on a map.
- Calls are random within seeded, cyclic difficulty: there is no memory of earlier calls, no escalation of a
  neglected call into another kind of incident, and no time-of-day or weather weighting of what happens.
- Traffic is a visual layer plus one global speed factor; roads have no congestion of their own.
- Vehicles and equipment never wear out; people have skills and fatigue but no morale or traits.

## 5. Bugs and suspicious behaviour needing investigation

Verified bug:

1. **FIXED in 0.17.1: vehicles that are driving to a call stopped where they were after a save was loaded.** What was found, verified by script:
   before saving an engine and an ambulance had paths; after `serialize` and `loadState` both had
   `path = 0` and stayed still. Engines are saved with a target but not their route, so on load they behave
   as if already arrived (the crew then report "too far to reach" or nothing happens). The same applies to the
   ambulance standing by (`standbyFor` is not saved). This predates 0.10 (the engine fields in `serialize` are
   unchanged), but it now also affects careers and challenges, and a browser refresh during a response
   triggers it. Highest-priority fix.

   **Fix and proof (0.17.1):** `serialize` now keeps each vehicle's route, goal, arrival flag, order ids, stand-by
   order, aircraft mission and status, and patients keep their claims; `restoreFleet` validates and restores
   them (older saves have no order, as before). `test/ordersave.test.js` covers a driving engine, an engine on
   scene, an ambulance with a patient claim, a stand-by ambulance, an air tanker's mission, a full multi-vehicle
   response, an old-format save, damaged order data and a career refresh; seven of the nine fail on the 0.17.0
   code. In a real page reload the engine kept its route, drove 1,100 px, deployed its crew and put the fire
   out. Not covered: a vehicle carrying patients to a hospital, or diving crews, were not given their own tests.

Suspicious, not proven to be wrong:

2. Mass Casualty is cleared very quickly with seven vehicles: a collapse with six people buried had no open
   incident left about ten seconds after it started (travel included). Rescue pace may be too fast for a collapse.
3. The shift report counts every burning building a fire spreads to as its own incident and attributes a
   death to the incident that vanished in the same scan; failures can look inflated (dozens in a bad shift).
4. Backups are shallow: `<slot>.replaced` is overwritten the next session, so a save older than two sessions
   is gone, and `.prev` holds only one replaced career. "No save is silently destroyed" holds for one step back.
5. Several saves plus their backups are around 1 to 1.5 MB of the browser's roughly 5 MB local storage; the
   failure path (a warning event) is covered by a test, but quota behaviour was not exercised in a browser.
6. Career totals and the average response come from `report.done`, which is capped at 300 entries; a very
   long shift can understate them.
7. The `?career` and `?challenge=` development parameters write the real save slots (the old save is archived).
8. The sound panel's "muted" note updates one refresh late.
9. Performance was measured with up to sixteen vehicles and one or two stations; a full career with eight
   stations and sixty people was benchmarked for simulation only, not for the Headquarters panel or the
   preset planner (which runs path searches when an incident is selected).

## 6. Changes made by this audit

Documentation only: `RELEASE_STATUS.md`, `NEXT_ROADMAP.md`, `TECHNICAL_DEBT.md` (new); README (apparatus
count, Quick-Response-only cost statement, "not built yet" list); one sentence in the in-game help text in
`index.html` (and the rebuilt bundle). No gameplay code was changed.
