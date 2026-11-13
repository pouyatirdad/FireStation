// Incident scenes: the stories behind a call. Each scene is data: where it can
// happen (a kind of building, a stretch of forest, a road, the water), how bad
// it starts (fire, people trapped, people hurt, chemicals, a blast) and what the
// dispatcher reads out. incidents.js picks a scene whose site exists in reach of
// a station, and `runScene` plays it with the same primitives every other call
// uses, so a scene is scored, listed and fought like any other incident.
//
// Fields:
//   id, label        list label (and the story line on the selection card)
//   site             'building' (default), 'forest', 'road' or 'water'
//   types / zones    which buildings it can happen to (building scenes)
//   waterfront       only buildings by the water
//   weight           how often it is drawn, relative to the others
//   big              a major incident (held back until the cycle is under way)
//   reward           credits for finishing it
//   fire             start the building alight at this intensity (omit: no fire)
//   trapped [a, b]   people cut off inside
//   hurt [[lo, hi, reason], ...]   injured people on the ground beside it
//   hazmat           chemicals: spreads fast, may explode
//   blast            a real explosion (neighbours, debris in the street)
//   text(ctx)        the log line; ctx = { b, n, where }

const ROAD = 'road';
const FOREST = 'forest';
const WATER = 'water';

export const SCENES = [
  // --- homes ---------------------------------------------------------------
  { id: 'chimney', label: 'Chimney fire', types: ['house', 'villa'], weight: 3, reward: 260, fire: 0.1,
    text: ({ b }) => `Chimney fire at ${b.name} — flames in the roof space` },
  { id: 'blanket', label: 'Bedroom fire', types: ['house', 'apartment'], weight: 2, reward: 320, fire: 0.18, trapped: [1, 1],
    text: ({ b }) => `Bedroom fire at ${b.name} — an electric blanket, someone is still upstairs` },
  { id: 'garage', label: 'Garage fire — gas cylinders', types: ['house', 'villa'], weight: 2, reward: 480, fire: 0.3, hazmat: true,
    hurt: [[0.3, 0.6, 'Burns victim at']],
    text: ({ b }) => `Garage fire at ${b.name} — gas cylinders inside, the neighbours are being moved back` },
  { id: 'ebike', label: 'E-bike battery fire', types: ['apartment'], weight: 2.5, reward: 560, fire: 0.25, trapped: [1, 3],
    text: ({ b, n }) => `E-bike battery fire in the hallway of ${b.name} — ${n} residents cut off by the smoke` },
  { id: 'dryer', label: 'Laundry fire', types: ['apartment'], weight: 1.5, reward: 420, fire: 0.2,
    text: ({ b }) => `Tumble dryer fire in the basement laundry of ${b.name}` },
  { id: 'monoxide', label: 'Carbon monoxide', types: ['house', 'apartment', 'villa'], weight: 2, reward: 0,
    hurt: [[0.4, 0.8, 'Carbon monoxide casualty at'], [0.35, 0.7, 'Carbon monoxide casualty at']],
    text: ({ b }) => `Carbon monoxide alarm at ${b.name} — the family is unwell, get the paramedics in` },
  { id: 'fireworks', label: 'Fireworks accident', types: ['house', 'villa'], weight: 1, reward: 380, fire: 0.2,
    hurt: [[0.5, 0.9, 'Fireworks burns at']],
    text: ({ b }) => `Fireworks went off in the shed at ${b.name} — it is alight and someone is hurt` },
  { id: 'barbecue', label: 'Barbecue fire spreads', types: ['house', 'villa'], weight: 2, reward: 280, fire: 0.12,
    text: ({ b }) => `A barbecue has set the fence and the back of ${b.name} alight` },
  { id: 'fallen', label: 'Resident fallen', types: ['house', 'apartment', 'villa'], weight: 2, reward: 360, trapped: [1, 1], rescue: true,
    text: ({ b }) => `Elderly resident fallen and cannot reach the door — ${b.name}` },
  { id: 'candle', label: 'Candle fire', types: ['house', 'apartment'], weight: 2, reward: 300, fire: 0.18, trapped: [0, 1],
    text: ({ b }) => `A candle left burning has started a fire at ${b.name}` },
  { id: 'hoarder', label: 'Hoarder house fire', types: ['house'], weight: 1, reward: 720, fire: 0.38, trapped: [1, 1],
    text: ({ b }) => `House fire at ${b.name} — the rooms are packed to the ceiling and the resident cannot get out` },
  { id: 'gasleak-flat', label: 'Gas leak', types: ['apartment'], weight: 1.5, reward: 520, hazmat: true,
    hurt: [[0.3, 0.55, 'Gas leak casualty at'], [0.3, 0.55, 'Gas leak casualty at']],
    text: ({ b }) => `Gas leak in ${b.name} — the block is being evacuated and two people are overcome` },

  // --- shops ---------------------------------------------------------------
  { id: 'grease', label: 'Restaurant kitchen fire', types: ['shop'], weight: 3, reward: 420, fire: 0.25,
    text: ({ b }) => `Grease fire in the kitchen of ${b.name} — the extraction duct is alight` },
  { id: 'oven', label: 'Bakery oven fire', types: ['shop'], weight: 1.5, reward: 380, fire: 0.2,
    text: ({ b }) => `Oven fire at ${b.name} — flames in the flue` },
  { id: 'shortcircuit', label: 'Electrical fire', types: ['shop', 'pharmacy'], weight: 2, reward: 340, fire: 0.15,
    text: ({ b }) => `Electrical fire behind the counter at ${b.name}` },
  { id: 'gasleak-shop', label: 'Gas leak', types: ['shop'], weight: 1.5, reward: 480, hazmat: true,
    hurt: [[0.3, 0.6, 'Gas leak casualty at']],
    text: ({ b }) => `Gas leak at ${b.name} — customers evacuated, one person collapsed` },
  { id: 'fryer', label: 'Fryer explosion', types: ['shop'], weight: 1, reward: 600, fire: 0.4,
    hurt: [[0.5, 0.9, 'Burns victim at']],
    text: ({ b }) => `Fryer explosion at ${b.name} — the kitchen is alight and a cook is badly burned` },
  { id: 'chemspill', label: 'Chemical spill', types: ['pharmacy'], weight: 1, reward: 520, hazmat: true,
    hurt: [[0.3, 0.5, 'Fume casualty at']],
    text: ({ b }) => `Chemical spill in the stockroom of ${b.name} — fumes in the shop` },

  // --- offices, hotels, towers ---------------------------------------------
  { id: 'serverroom', label: 'Server room fire', types: ['office'], weight: 2.5, reward: 700, fire: 0.25, trapped: [0, 2],
    text: ({ b }) => `Server room fire at ${b.name} — gas suppression has gone off and the floor is full of smoke` },
  { id: 'arson-office', label: 'Arson', types: ['office'], weight: 1, reward: 780, fire: 0.36, trapped: [2, 4],
    text: ({ b, n }) => `Arson at ${b.name} — a fire set on two floors, ${n} staff cut off above it` },
  { id: 'hotelkitchen', label: 'Hotel kitchen fire', types: ['hotel'], weight: 2, reward: 720, fire: 0.25, trapped: [1, 3],
    text: ({ b }) => `Kitchen fire at ${b.name} — the smoke is climbing the service stairs` },
  { id: 'balcony', label: 'Fall from a balcony', types: ['hotel', 'apartment'], weight: 1, reward: 0,
    hurt: [[0.7, 1, 'Fall victim at']],
    text: ({ b }) => `A guest has fallen from a balcony at ${b.name} — ambulance needed urgently` },
  { id: 'cladding', label: 'Cladding fire', types: ['tower'], weight: 1.5, big: true, reward: 2600, fire: 0.35, trapped: [4, 8],
    text: ({ b, n }) => `MAJOR INCIDENT — flames racing up the cladding of ${b.name}, ${n} people above the fire` },
  { id: 'rooftop', label: 'Rooftop plant fire', types: ['tower', 'office'], weight: 1.5, reward: 600, fire: 0.2,
    text: ({ b }) => `Air-conditioning plant on the roof of ${b.name} is alight` },
  { id: 'crane', label: 'Construction accident', types: ['office', 'tower', 'hotel'], weight: 1, reward: 700, trapped: [1, 2], rescue: true,
    hurt: [[0.7, 1, 'Construction casualty at']],
    text: ({ b }) => `A scaffold has collapsed at ${b.name} — workers trapped and hurt` },
  { id: 'cradle', label: 'Cradle failure', types: ['tower', 'hotel'], weight: 1, reward: 650, trapped: [2, 2], rescue: true,
    text: ({ b }) => `Window cleaners stranded on a failed cradle on ${b.name}` },

  // --- malls and schools ---------------------------------------------------
  { id: 'foodcourt', label: 'Food court fire', types: ['mall'], weight: 3, reward: 950, fire: 0.3, trapped: [3, 6],
    text: ({ b, n }) => `Food court fire at ${b.name} — ${n} shoppers cut off upstairs` },
  { id: 'crush', label: 'Crowd crush', types: ['mall'], weight: 1, reward: 0,
    hurt: [[0.4, 0.9, 'Crowd crush casualty at'], [0.4, 0.9, 'Crowd crush casualty at'], [0.4, 0.9, 'Crowd crush casualty at'], [0.4, 0.9, 'Crowd crush casualty at']],
    text: ({ b }) => `Panic at ${b.name} — a crowd crush at the doors, several people hurt` },
  { id: 'carpark', label: 'Car park fire', types: ['mall'], weight: 2, reward: 800, fire: 0.25, hazmat: true,
    text: ({ b }) => `Cars burning on the top deck of the car park at ${b.name}` },
  { id: 'lab', label: 'Chemistry lab fire', types: ['school'], weight: 2, reward: 800, fire: 0.3, hazmat: true, trapped: [1, 3],
    text: ({ b }) => `Chemistry lab fire at ${b.name} — the pupils are out, staff are still inside` },
  { id: 'gym', label: 'Gymnasium fire', types: ['school'], weight: 1.5, reward: 700, fire: 0.2,
    text: ({ b }) => `Electrical fire in the gymnasium roof of ${b.name}` },

  // --- industry -------------------------------------------------------------
  { id: 'racking', label: 'Racking collapse', types: ['warehouse'], weight: 2, reward: 850, trapped: [1, 2], rescue: true,
    hurt: [[0.7, 1, 'Crush victim at']],
    text: ({ b }) => `Pallet racking has collapsed at ${b.name} — workers buried under the load` },
  { id: 'toxicleak', label: 'Toxic gas leak', types: ['factory'], weight: 1.5, reward: 1300, hazmat: true,
    hurt: [[0.3, 0.8, 'Gas casualty at'], [0.3, 0.8, 'Gas casualty at'], [0.3, 0.8, 'Gas casualty at']],
    text: ({ b }) => `Toxic gas leak at ${b.name} — the works is evacuating, three people down` },
  { id: 'dust', label: 'Dust explosion', types: ['factory'], weight: 1, big: true, reward: 2000, fire: 0.5, blast: true,
    hurt: [[0.6, 1, 'Blast casualty at']],
    text: ({ b }) => `MAJOR INCIDENT — dust explosion at ${b.name}, the roof is open and the works is alight` },
  { id: 'welding', label: 'Welding fire', types: ['warehouse', 'factory'], weight: 2, reward: 700, fire: 0.3,
    text: ({ b }) => `Welding sparks have set the stock alight at ${b.name}` },
  { id: 'boiler', label: 'Boiler explosion', types: ['factory'], weight: 1, reward: 1500, fire: 0.4, blast: true,
    text: ({ b }) => `Boiler explosion at ${b.name} — fire in the boiler house and debris in the street` },
  { id: 'tankvent', label: 'Tank vent fire', types: ['tankfarm'], weight: 2, reward: 1500, fire: 0.45, hazmat: true,
    text: ({ b }) => `A vent has ignited on a fuel tank at ${b.name} — it burns hot and may spread` },
  { id: 'ammonia', label: 'Ammonia leak', types: ['warehouse'], weight: 1, reward: 1100, hazmat: true,
    hurt: [[0.3, 0.7, 'Ammonia casualty at'], [0.3, 0.7, 'Ammonia casualty at'], [0.3, 0.7, 'Ammonia casualty at']],
    text: ({ b }) => `Ammonia leak from the cold store at ${b.name} — three workers overcome` },
  { id: 'forklift', label: 'Forklift accident', types: ['warehouse', 'factory'], weight: 1.5, reward: 0,
    hurt: [[0.8, 1, 'Forklift accident casualty at']],
    text: ({ b }) => `Forklift accident at ${b.name} — a worker is pinned and badly hurt` },
  { id: 'pallets', label: 'Pallet yard fire', types: ['warehouse'], weight: 2, big: true, reward: 1900, fire: 0.5, hazmat: true,
    text: ({ b }) => `MAJOR INCIDENT — the pallet yard at ${b.name} is burning fiercely and the wind is spreading it` },
  { id: 'quay-fuel', label: 'Boat and fuel quay fire', types: ['warehouse', 'tankfarm'], waterfront: true, weight: 2, reward: 1500, fire: 0.4, hazmat: true,
    text: ({ b }) => `A fuelling boat is alight against the quay at ${b.name} — a fireboat can reach it` },

  // --- the airport ----------------------------------------------------------
  { id: 'crash-landing', label: 'Aircraft emergency', types: ['terminal', 'hangar'], weight: 1.5, big: true, reward: 3200, fire: 0.5, hazmat: true, blast: true,
    hurt: [[0.5, 1, 'Air crash casualty at'], [0.5, 1, 'Air crash casualty at'], [0.4, 0.9, 'Air crash casualty at']],
    text: ({ b }) => `MAJOR INCIDENT — an aircraft has overrun on landing at ${b.name}, fuel burning and passengers hurt` },
  { id: 'baggage', label: 'Baggage hall fire', types: ['terminal'], weight: 2, reward: 1600, fire: 0.3, trapped: [3, 6],
    text: ({ b, n }) => `Baggage hall fire at ${b.name} — ${n} staff and passengers cut off by the smoke` },
  { id: 'hangarfuel', label: 'Hangar fuel fire', types: ['hangar'], weight: 2, reward: 1700, fire: 0.45, hazmat: true,
    text: ({ b }) => `Fuel fire under an aircraft in ${b.name} — it burns hot and the hangar is filling with smoke` },

  // --- the railway -----------------------------------------------------------
  { id: 'derailment', label: 'Train derailment', types: ['railstation'], weight: 1.2, big: true, reward: 3000, fire: 0.2, trapped: [2, 4],
    hurt: [[0.5, 1, 'Derailment casualty at'], [0.4, 0.9, 'Derailment casualty at'], [0.4, 0.9, 'Derailment casualty at'], [0.4, 0.9, 'Derailment casualty at']],
    text: ({ b, n }) => `MAJOR INCIDENT — a train has derailed at ${b.name}: ${n} trapped in a carriage, many hurt` },
  { id: 'platform', label: 'Platform fire', types: ['railstation'], weight: 2, reward: 1300, fire: 0.3, trapped: [3, 6],
    text: ({ b, n }) => `Fire on the platform canopy of ${b.name} — ${n} passengers cut off in the concourse` },
  { id: 'signalbox', label: 'Signal cabin fire', types: ['railstation'], weight: 1.5, reward: 900, fire: 0.2,
    text: ({ b }) => `Signal cabin fire at ${b.name} — trains are stopped across the district` },

  // --- the metro -------------------------------------------------------------
  { id: 'tunnelsmoke', label: 'Smoke in the metro', types: ['metro'], weight: 2, big: true, reward: 2600, fire: 0.15, trapped: [4, 9],
    text: ({ b, n }) => `MAJOR INCIDENT — smoke pouring from the tunnel at ${b.name}, ${n} passengers stuck below` },
  { id: 'undertrain', label: 'Person under a train', types: ['metro'], weight: 1.2, reward: 0,
    hurt: [[0.85, 1, 'Person hit by a train at']],
    text: ({ b }) => `A passenger has fallen under a train at ${b.name} — paramedics needed on the platform` },
  { id: 'escalator', label: 'Escalator fire', types: ['metro'], weight: 2, reward: 900, fire: 0.25, trapped: [2, 4],
    text: ({ b, n }) => `Escalator motor fire at ${b.name} — ${n} people cut off on the lower level` },
  { id: 'platform-crush', label: 'Platform crush', types: ['metro'], weight: 1, reward: 0,
    hurt: [[0.4, 0.9, 'Platform crush casualty at'], [0.4, 0.9, 'Platform crush casualty at'], [0.4, 0.9, 'Platform crush casualty at']],
    text: ({ b }) => `Overcrowded platform at ${b.name} — a crush at the stairs, several people hurt` },

  // --- the woods -------------------------------------------------------------
  { id: 'campfire', label: 'Campfire spreads', site: FOREST, weight: 3, big: true, reward: 2000,
    text: ({ where }) => `MAJOR INCIDENT — a campfire left burning has caught the undergrowth in ${where}` },
  { id: 'lightning', label: 'Lightning strike', site: FOREST, weight: 2, big: true, reward: 2400,
    text: ({ where }) => `MAJOR INCIDENT — a lightning strike has set the trees alight in ${where}` },
  { id: 'arson-woods', label: 'Woodland arson', site: FOREST, weight: 1.5, big: true, reward: 2600,
    text: ({ where }) => `MAJOR INCIDENT — several fires set at once on the edge of the woods in ${where}` },
  { id: 'cigarette', label: 'Verge fire', site: FOREST, weight: 2, big: true, reward: 1800,
    text: ({ where }) => `MAJOR INCIDENT — a dry verge has caught from a thrown cigarette and is running into the woods in ${where}` },

  // --- the roads ---------------------------------------------------------------
  { id: 'bus', label: 'Bus crash', site: ROAD, weight: 2, reward: 700, hurt: [4, 7],
    text: ({ place, hurt }) => `Bus crash near ${place} — road blocked, ${hurt} injured` },
  { id: 'tanker', label: 'Tanker rollover', site: ROAD, weight: 1.2, big: true, reward: 1600, hurt: [1, 2], quickFuse: true,
    text: ({ place, hurt }) => `MAJOR INCIDENT — a fuel tanker has rolled over near ${place} and is leaking, ${hurt} hurt` },
  { id: 'truckfire', label: 'Lorry fire', site: ROAD, weight: 2, reward: 500, hurt: [0, 1], quickFuse: true,
    text: ({ place, hurt }) => `Lorry fire on the road near ${place} — the road is blocked${hurt ? `, ${hurt} hurt` : ''}` },

  // --- the water ---------------------------------------------------------------
  { id: 'kayak', label: 'Kayaker capsized', site: WATER, weight: 2, reward: 0, what: 'A kayaker has capsized' },
  { id: 'carwater', label: 'Car in the water', site: WATER, weight: 1.5, reward: 0, what: 'A car has rolled into the water' },
];

export const SCENE_COUNT = SCENES.length;

/** Scenes that start on a building. */
export const buildingScenes = () => SCENES.filter((s) => !s.site);

/** Can this scene happen to this building? */
export function sceneFits(scene, b) {
  if (scene.site) return false;
  if (!scene.types.includes(b.type)) return false;
  if (scene.waterfront && !b.waterfront) return false;
  return true;
}
