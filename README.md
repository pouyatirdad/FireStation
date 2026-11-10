# Fire Station — Harbor City

A top-down firefighting management game for Windows, in the spirit of **Emergency 4**: a 160×120
city with a forest, four kinds of apparatus you buy and sell, small calls and major incidents,
forest fires, and a shift that never ends. Vanilla JavaScript, no dependencies; one self-contained
`index.html`.

![Harbor City](docs/screenshot-city.png)

> **شروع سریع:** روی `index.html` دوبار کلیک کنید. بازی بدون سرور، بدون نصب و بدون فایل exe
> اجرا می‌شود — همه‌ی کد و استایل داخل همان یک فایل HTML است.

## Running it

**Double-click `index.html`.** That is the whole game: one self-contained file with the JavaScript
and CSS inlined, so it runs straight from `file://` with no server, no Node and nothing installed.

`index.html` is generated. To change the game, edit `src/`, `styles/` or the markup between the
`build:` markers in `index.html`, then rebuild:

```powershell
node tools/build.mjs     # rebuild index.html from src/ and styles/
npm test                 # or: node --test test/
```

Node 18+ is only needed for the build and the tests; playing needs nothing but a browser.

## The shift

You command **Station 1** in Harbor City: 152 buildings, 62 hydrants, a forest in the north-east,
and **$2,500** to start. One engine and three firefighters are in quarters. Calls come in; you send
what fits, lay hose, pull people out, and spend what you earn on more apparatus.

There is **no lose state**. The city rating is a score that falls when buildings are lost and
recovers when you save them; at zero the shift still goes on. Only the clock and your wallet limit
the night.

| | |
|---|---|
| **Respond** | Select a vehicle (click it or press <kbd>1</kbd>–<kbd>6</kbd>) and right-click a fire. It takes the fastest road route and parks on the nearest street. With nothing selected, <kbd>D</kbd> sends the nearest idle vehicle. |
| **Deploy** | The crew ride along. On scene they dismount, walk to the fire and attack it on their own. <kbd>E</kbd> deploys them by hand, <kbd>R</kbd> packs them up. |
| **Rescue** | A fire leaves people trapped — a red badge on the building shows how many. A crew at the building brings one person out at a time. If it collapses first, they are lost. Small rescue jobs exist too. |
| **Apparatus** | <kbd>B</kbd> opens the apparatus panel: buy and sell engines, ladders, tankers and rescue units. Six bays. |
| **Hose** | Water only flows within the vehicle's hose range — the dashed circle around it. |
| **Hydrant** | Park within reach of a hydrant and press <kbd>G</kbd>. A supply line runs to the pump and the tank stays fed while the crew works. Drive off and it detaches. |
| **Water** | Tanks run from 600 L (rescue) to 6,000 L (tanker). The station apron refills; anywhere else you need the hydrant line. |
| **Calls** | Small jobs start arriving after 20 seconds, roughly every 45–70. **Major incidents start after four minutes** and pay far more. |
| **Save** | The shift autosaves every 30 seconds. <kbd>Ctrl</kbd>+<kbd>S</kbd> saves by hand; the apparatus panel has Save, Load and New shift. A saved shift appears as **Continue** on the start screen. |

### Apparatus and credits

| Vehicle | Crew | Water | Hose | Deck gun | Price |
|---|---|---|---|---|---|
| **Engine** | 3 | 1,800 L | 15 | 9 | $1,000 |
| **Ladder** | 3 | 1,200 L | 14 | 18 | $1,800 |
| **Tanker** | 2 | 6,000 L | 12 | 7 | $1,500 |
| **Rescue** | 4 | 600 L | 16 | 6 | $1,600 |

Selling returns 60% of the price. Knockdowns pay $300, a rescue $120 per person, and every incident
carries its own reward:

| Incident | Reward |
|---|---|
| Structure fire | $300 |
| Block fire | $600 |
| Person trapped | $350 |
| Industrial fire (major) | $1,500 |
| Major block fire | $1,800 |
| Forest fire (major) | $2,200 |

![Apparatus](docs/screenshot-station.png)

### Major incidents and the forest

After the first four minutes the city can throw a **major incident**: an industrial fire, a
multi-building block fire, or a forest fire in the north woods. Only one major incident is live at a
time, and the small calls keep coming in the background.

A forest fire is an area, not a building. It grows, throws embers into any building it reaches, and
has to be fought on foot from the tree line: park on the nearest street, deploy the crew, and let
them work the edge. The deck gun can reach from the road if you get close enough. Select the fire on
the map (or click the smoke) to see its size, intensity and reward, and press **Dispatch**.

![Forest fire](docs/screenshot-wildfire.png)

### Shortcuts are on screen

Every action button carries its key, the roster numbers the vehicles, and a strip in the bottom-left
lists the pointer controls. <kbd>F1</kbd> opens the full list.

### Controls

| Input | Action |
|---|---|
| Left click | Select a vehicle, a crew member, a building or a wildfire |
| Right click | Send the selected unit there; on a burning building or wildfire, dispatch |
| Drag / arrow keys | Pan the map |
| Scroll | Zoom around the pointer |
| <kbd>1</kbd>–<kbd>6</kbd> | Select a vehicle |
| <kbd>D</kbd> | Dispatch the selected vehicle (or the nearest idle one) |
| <kbd>E</kbd> / <kbd>R</kbd> | Deploy / recall the crew |
| <kbd>G</kbd> | Connect or detach the hydrant supply line |
| <kbd>B</kbd> | Apparatus panel |
| <kbd>H</kbd> | Send the selected vehicle back to the station |
| <kbd>C</kbd> | Center on the selection |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the shift |
| <kbd>Space</kbd> | Pause / resume |
| <kbd>F1</kbd> or <kbd>?</kbd> | Controls overlay |
| <kbd>Esc</kbd> | Close a panel, or clear the selection |

![On scene](docs/screenshot-engine.png)

## How it works

The game is a fixed 60 Hz simulation (`src/core/loop.js`) drawn to one canvas. Nothing in the
simulation knows about the DOM, and nothing in the renderer changes the simulation.

- **The city** (`src/data/city.js`) is generated from a seed: a 160×120 tile grid of districts
  between six avenues and six streets, 152 named buildings, 62 hydrants, 548 trees, 73 parked cars,
  and a forest of 1,500 tiles in the north-east. The same seed always builds the same Harbor City.
- **Navigation** (`src/systems/grid.js`) is A* on two tile layers: vehicles use roads and the apron,
  crews walk anywhere that is not a building footprint. Paths are smoothed with a grid-traversal
  line check, so a diagonal can never clip a building.
- **Fire** (`src/systems/fire.js`) is a per-building intensity and structural integrity. Intensity
  grows, water knocks it down, integrity erodes, and a hot fire rolls to spread. A building at zero
  integrity becomes rubble and costs rating.
- **People** (`src/systems/civilians.js`) are inside every building at 07:00. Most get out, a few
  are trapped and marked on the building; a firefighter brings them out one at a time, and a
  collapse takes whoever is left.
- **The fleet** (`src/systems/units.js`) drives the roads, parks, deploys, walks to the nearest job
  it can reach with hose, sprays it, drains its tank, hooks up to hydrants and packs up. Each type
  has its own crew, tank, hose and deck-gun ranges.
- **Incidents** (`src/systems/incidents.js`) generate small calls and gate the major incidents to
  the part of the shift where they belong, with rewards attached to each job.
- **Wildfires** (`src/systems/wildfire.js`) are growing areas that spread into buildings and are
  fought from the tree line.
- **Save** (`serialize` / `loadState` in `src/systems/game.js`) stores time, credits, building
  states, the fleet, fires and wildfires in `localStorage`.
- **Rendering** (`src/render/render.js`) is a shallow 2.5D: footprints, lifted roofs, south walls,
  one painter's list for buildings and units. Level-of-detail, district labels and a 248-pixel
  minimap keep the big map readable.
- **UI** (`src/ui/hud.js`) is plain DOM over the canvas: the top bar, selection card, dispatch log,
  roster, apparatus panel and overlays.

### Tuning

Every number lives in `src/core/config.js` — fire growth and spread, call cadence, vehicle stats and
prices, hydrant range, rewards, economy, camera and clock. Change one and rebuild; nothing else
needs editing.

### Development helpers

```
?autostart      skip the start screen
?warp=45        fast-forward 45 seconds before the first frame
?demo           start, light a hotel and send an engine
?burn           light three buildings
?buy=ladder     buy one vehicle of that type
?fleet=ladder,tanker,rescue   buy several
?credits=20000  override the starting credits
?station        open the apparatus panel
?hydrantpark    park Engine 1 beside a hydrant
?connect        connect that hydrant supply line
?wildfire       start a forest fire
?zoom=0.8       set the opening zoom
?select=b7      select a building by id
?help           open the controls overlay
```

`window.__fireStation` exposes the live state and camera, read-only, for headless probes.

## Project layout

```
index.html              the game — generated, self-contained, double-click to play
styles/game.css         the whole UI
src/main.js             canvas, camera, pointer, keyboard, save/load, HUD wiring
src/core/               config, maths, fixed-timestep loop
src/data/city.js        seeded Harbor City with its forest
src/systems/            navigation, fire, civilians, fleet, incidents, wildfires,
                        effects, events, game rules and save state
src/render/render.js    the 2.5D canvas renderer
src/ui/hud.js           DOM HUD, apparatus panel and screens
test/                   city, navigation, fire, rescue, fleet, incidents, save tests
tools/build.mjs         bundles src/ and the CSS into index.html
```

The distribution is the single `index.html`. Copy it to a desktop, a USB stick or a mail
attachment; it needs no other file and no network.

![Fire](docs/screenshot-fire.png)

![Hydrant supply](docs/screenshot-hydrant.png)

## Not built yet

A second station, sound, medical and police units, vehicle upgrades, weather and an isometric art
pass. The simulation was written so those can be added without rewriting the core.
