# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
node tools/build.mjs                  # rebuild index.html from src/ + styles/game.css (npm run build)
npm test                              # node --test test/  (about 15 s; the city tests do real A* on a 520x384 map)
node --test test/fire.test.js         # a single test file
node --test --test-name-pattern="x" test/   # a single test by name
```

No dependencies; Node 18+ is only needed for build and tests. There is no linter.

## Git: commits and pushes

- **Never mention Claude, Anthropic or AI in anything that goes to git or GitHub.** No `Co-Authored-By: Claude …` trailer, no "Generated with Claude Code" line in commit messages or PR descriptions, and no such text in code comments or docs. Commits are authored by the repository's configured git user and read as ordinary human commits. This overrides any default attribution a tool or harness suggests.
- Work on a feature branch (`feature/<short-name>`), not on `master`. Commit with a plain imperative subject and a short body saying what changed and why; push the branch to `origin` with `git push -u origin <branch>`.
- Rebuild `index.html` (`node tools/build.mjs`) and run `npm test` before committing; commit the regenerated `index.html` with the source change.
- Keep `.claude/` out of commits (it holds local launch configs).

## Build model — read this before editing

- The shipped game is **`index.html`, a generated, self-contained file** (JS and CSS inlined) so it runs by double-click from `file://`, where ES modules don't load. It is committed; **rebuild and commit it after any change to `src/` or `styles/`**.
- Edit only `src/`, `styles/game.css`, or the markup in `index.html` *outside* the `<!-- build:css|js:start/end -->` markers. Anything between the markers is overwritten on build.
- `tools/build.mjs` is a hand-rolled bundler that understands only: `import { a, b as c } from`, `import * as ns from`, and `export function|const|let|class` / `export { list }`. Other syntax (default exports, `export * from`, dynamic import, re-export `export { x } from '...'`) throws. Imports must be at line start. Module code must not contain a literal `</script`.
- Tests import `src/` directly as real ES modules, so they do not exercise the bundle; run the build to catch bundler-incompatible syntax.
- Dev query params (`?autostart`, `?demo`, `?wildfire`, `?injured`, `?warp=45`, `?buy=ladder`, `?fleet=ambulance,ladder`, `?credits=`, etc.) are handled at the bottom of `src/main.js`; README lists them. `window.__fireStation` exposes state/cam for probes. To look at the game in a browser pane, serve the folder over http (query params are lost on `file://` snapshots).

## Architecture

Top-down emergency-services sim (Harbor City, **520×384 tile grid**, `TILE` = 32 px per tile). Fixed 60 Hz simulation (`src/core/loop.js`) drawn to a single canvas. The key separation: **the simulation never touches the DOM, and the renderer never mutates the simulation.** Audio is the same kind of observer: it reads state each frame and never changes it.

- `src/main.js` — wiring only: canvas/camera, pointer + keyboard (incl. Tab = next incident, Home = station, M = sound, P = pharmacy), overlays, localStorage save/load (`firestation.save.v3`, autosave every 30 s), audio unlock on first gesture, and the bridge to the HUD. No game rules.
- `src/systems/game.js` — the facade the UI talks to. Owns `createGame`, the **tick order** in `update()` (wind → incidents → chains → traffic → economy → patients → units → fire → wildfires → fleeing civilians → effects), selection/picking (units, patients, wildfires, buildings), the `command*` functions (the UI's only way to give orders), and `serialize` / `loadState`.
- `src/systems/*` — one module per domain: `units.js` (fleet: engines + crews, driving, parking, deploying, hydrant supply, buy/sell, and the ambulance/paramedic behaviour), `fire.js` (per-building intensity/integrity, spread), `wildfire.js` (area fires that ember into buildings), `civilians.js` (trapped/rescued/fleeing; a few evacuees and rescued people become patients), `medical.js` (injured people, survival clocks, treatment, medical kits and pharmacy restocking), `blockades.js` (road blockades edit `state.nav.drive`; also the traffic cars and the rush-hour factor), `chains.js` (crash → fuel fire, pile-up, warehouse explosion via `state.onExplosion`), `wind.js` (direction and strength; `downwindFactor` drives fire spread), `places.js` (district names for incident text), `economy.js` (**every credit change goes through `earn`/`spend`**; hourly payroll, speed bonus, value factors, donations, ledger), `incidents.js` (call cadence, a coverage radius that grows from the station over the shift, major-incident gating, rewards), `grid.js` (A* on separate road layer for vehicles and walkable layer for crews; search buffers are reused via generation stamps), `audio.js` (Web Audio synthesis, no asset files; `eventSound` maps log events to sounds), `effects.js`, `events.js` (dispatch log).
- `src/data/city.js` — the city is **generated deterministically from `CONFIG.city.seed`**; same seed → same city. The original 160×120 quarter (Station 1 at tile 50,44, its apron and bays) is kept in the north-west corner. Block kinds (downtown/market/houses/industry/park/forest/station) come from `buildBlocks`; a quarter of the non-industrial blocks get a pharmacy (`city.pharmacies`). Saves store only mutable state keyed by building id and rebuild the city from the seed, so changing generation breaks old saves — bump `SAVE_KEY` in `main.js` and `version` in `serialize` when you do.
- `src/core/config.js` — every tunable number (fire, calls, vehicle stats/prices/upkeep, the economy and budget, medical, rewards, camera, clock). Change balance here, not in systems.
- `src/render/render.js` — 2.5D painter's-order canvas renderer (culls roads, trees and buildings to the view, drops detail when zoomed out), cached minimap, day/night tint (`daylight(clock)`); `src/ui/hud.js` — plain-DOM HUD, apparatus + budget panel and screens; `styles/game.css` — all UI styles.

Per-frame transient lists on `state` (`streams`, `hoses`) are cleared at the start of each `update()`: units declare what they spray/lay this tick and fire/effects consume it. `state.ui` is UI-only scratch space (hover, minimap rect) and is not serialized.

Game rules worth knowing: there is no lose state (rating is just a score, credits may go negative); units are "engines" (apparatus of types engine/ladder/tanker/rescue/ambulance, **eight bays**) with attached "crew" units; an ambulance has `spec.medical`, no water, kits instead of a tank, and paramedic crews (`crew.medic`) that walk to patients within `medRange`; critical patients (`patient.critical`) go on `engine.cargo` and are delivered to `city.hospitals`; wrecks (`state.blockades`) close road tiles and are cleared by deployed fire crews, and `repathEngines` re-plans every moving vehicle when one appears; money comes from incident rewards (speed bonus), value-scaled knockdown fees, treatment fees and an hourly subsidy, and goes on wages, upkeep, kits and penalties. `README.md` documents gameplay, controls and economy in detail.
