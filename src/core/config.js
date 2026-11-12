// Every number that decides how the shift feels lives here. The systems read
// these; none of them invents a rate of its own.

export const TILE = 32; // world pixels per tile (a tile is roughly 3 m)

export const CONFIG = {
  tickMs: 1000 / 60,
  maxFrameMs: 200,
  maxCatchUpTicks: 5,
  speeds: [1, 2, 4],

  camera: {
    minZoom: 0.07,
    maxZoom: 2.6,
    startZoom: 1.0,
    panSpeed: 950, // px/s while a pan key is held
    margin: 2, // tiles of slack around the city edge
    edgePad: 240, // screen pixels of slack at the edge, so a panel never hides the map's rim
  },

  city: { seed: 7, name: 'Harbor City' },

  // The money model. Income is incident rewards, a knockdown fee, treatment fees
  // and an hourly city subsidy that shrinks as the rating falls. Costs are crew
  // vehicle upkeep, medical kits and the penalties for losing buildings
  // or people. Fees and penalties are scaled by the building's `value` factor.
  economy: {
    start: 3000,
    saved: 260, // knockdown fee
    rescued: 120,
    treated: 160, // paid by the city for each patient an ambulance stabilises
    lossPenalty: 350, // a destroyed building
    casualtyPenalty: 700, // per person lost
    speedBonus: { fast: 60, slow: 240, max: 0.5 }, // seconds since ignition; bonus on incident rewards
    value: {
      house: 0.8, apartment: 1.2, shop: 1, pharmacy: 1.1, office: 1.6,
      hotel: 1.8, warehouse: 1.3, hospital: 2.2, station: 2,
    },
    budget: {
      hourEvery: 120, // real seconds per game hour (60 / clockRate)
      subsidy: 260, // per game hour at full rating
      subsidyFloor: 0.4, // share of the subsidy paid at rating 0
    },
    kitPrice: 12, // per medical kit bought at a pharmacy
    donation: { every: [420, 700], min: 300, max: 900, minRating: 60 },
    // Very rarely a volunteers' foundation makes a big gift: only after a long
    // run of successful missions, only while the city is in good shape, and even
    // then only sometimes. A miss pushes the next chance a few missions on.
    grant: { after: [10, 20], chance: 0.4, retry: [3, 7], min: 20000, max: 50000, minRating: 85 },

    // Finance: borrowing, insurance, training and sponsor contracts.
    loan: { max: 30000, step: 5000, rate: 0.03 }, // interest per game hour on what is owed
    insurance: { premium: 70, lossShare: 0.4 }, // per game hour; share of a building loss you still pay
    training: {
      cost: [900, 1800, 3000],
      fire: 0.12, // extra spray power per level
      medic: 0.15, // faster treatment per level
      rescue: 0.12, // faster rescue per level
    },
    contracts: { every: [300, 480], maxOffers: 3, maxActive: 2, failPenalty: 0.25 },
    stationPrice: 9000, // buying Station 2
    dockPrice: 6500, // buying the Harbour Dock (berths for boats)
  },

  command: { aura: 0.2, range: 26 }, // tiles; extra spray power for crews near a parked command car

  // Equipment a firefighter takes from their own vehicle, one item at a time.
  // Diving needs no special vehicle: engines and rescue units carry the gear.
  tools: {
    hose: { label: 'Hose', key: 'F' },
    chainsaw: { label: 'Chainsaw', key: 'X', cutTime: 1.7 }, // seconds per step of a track (two tiles)
    diving: { label: 'Diving gear', key: 'V', range: 24 }, // tiles a diver swims from the vehicle
    cutter: { label: 'Rescue cutter', key: 'T', bonus: 1.8 }, // how much faster a wreck is cleared
  },
  fetchTime: 1.4, // seconds to take a tool from the locker (or put on a dive suit)

  // The fleet: each vehicle is a different tool, not a skin. Buy and sell them
  // at the station; eight bays in total.
  // `tools` is the equipment in the lockers: how many of each its crew can take
  // out at once. Every fire vehicle with a pump also carries hose for everyone.
  vehicles: {
    engine: {
      label: 'Engine', cost: 1000, crew: 3, speed: 8.2, capacity: 1800, upkeep: 24,
      hoseRange: 15, turretRange: 9, turretPower: 0.035, turretWater: 42,
      refillRate: 170, rescueTime: 3.6, refund: 0.6,
      tools: { chainsaw: 1, diving: 2 },
    },
    ladder: {
      label: 'Ladder', cost: 1800, crew: 3, speed: 7.6, capacity: 1200, upkeep: 36,
      hoseRange: 14, turretRange: 18, turretPower: 0.055, turretWater: 34,
      refillRate: 150, rescueTime: 3.4, refund: 0.6,
      tools: { chainsaw: 1 },
    },
    tanker: {
      label: 'Tanker', cost: 1500, crew: 2, speed: 7.0, capacity: 6000, upkeep: 26,
      hoseRange: 12, turretRange: 7, turretPower: 0.028, turretWater: 55,
      refillRate: 90, rescueTime: 3.8, refund: 0.6,
    },
    rescue: {
      label: 'Rescue', cost: 1600, crew: 4, speed: 9.2, capacity: 600, upkeep: 30,
      hoseRange: 16, turretRange: 6, turretPower: 0.02, turretWater: 12,
      refillRate: 160, rescueTime: 2.2, refund: 0.6,
      tools: { chainsaw: 2, cutter: 2, diving: 2 },
    },
    // Medical: no water and no deck gun. The paramedics walk out to injured
    // people and use one kit per patient; kits are restocked at the station or
    // at a pharmacy.
    ambulance: {
      label: 'Ambulance', cost: 1400, crew: 2, speed: 10, capacity: 0, upkeep: 22,
      hoseRange: 0, turretRange: 0, turretPower: 0, turretWater: 0,
      refillRate: 0, rescueTime: 3, refund: 0.6,
      medical: true, kits: 8, treatTime: 4, medRange: 22, carry: 2,
    },
    // A small, fast medic car: one paramedic, four kits, one stretcher. Gets to a
    // call sooner than an ambulance but cannot carry much.
    medcar: {
      label: 'Paramedic car', cost: 750, crew: 1, speed: 12.5, capacity: 0, upkeep: 12,
      hoseRange: 0, turretRange: 0, turretPower: 0, turretWater: 0,
      refillRate: 0, rescueTime: 3, refund: 0.6,
      medical: true, kits: 4, treatTime: 3.2, medRange: 18, carry: 1,
    },
    // A bus fitted out for mass casualties: eight stretchers, sixteen kits, four
    // paramedics, and slow.
    ambubus: {
      label: 'Ambulance bus', cost: 3400, crew: 4, speed: 6.8, capacity: 0, upkeep: 48,
      hoseRange: 0, turretRange: 0, turretPower: 0, turretWater: 0,
      refillRate: 0, rescueTime: 3, refund: 0.6,
      medical: true, kits: 16, treatTime: 3.6, medRange: 24, carry: 8,
    },
    // Divers by water: sails to the casualty and puts them over the side.
    rescueboat: {
      label: 'Rescue boat', cost: 2800, crew: 2, speed: 11, capacity: 0, upkeep: 34,
      hoseRange: 0, turretRange: 0, turretPower: 0, turretWater: 0,
      refillRate: 0, rescueTime: 4.2, refund: 0.6,
      diver: true, diveRange: 20, boat: true,
    },
    // A fireboat pumps river or sea water without limit, from up to 18 tiles
    // out, but can only work buildings and forests close to the water.
    fireboat: {
      label: 'Fireboat', cost: 6200, crew: 0, speed: 9, capacity: 100000, upkeep: 70,
      hoseRange: 0, turretRange: 18, turretPower: 0.06, turretWater: 80,
      refillRate: 100000, rescueTime: 3, refund: 0.55,
      boat: true,
    },
    // A scooping air tanker: very fast, circles the target dropping water, and
    // skims the sea to refill. Strong, but it needs a fire to circle.
    airtanker: {
      label: 'Air tanker', cost: 11000, crew: 0, speed: 30, capacity: 5000, upkeep: 140,
      hoseRange: 0, turretRange: 8, turretPower: 0.07, turretWater: 110,
      refillRate: 1200, rescueTime: 3, refund: 0.55,
      flying: true, plane: true,
    },
    // The chief's car: no hose, no water. Parked, it boosts every crew within
    // range (spray power +20%), so it earns its place on a big fire.
    command: {
      label: 'Command', cost: 2600, crew: 2, speed: 9.4, capacity: 0, upkeep: 40,
      hoseRange: 0, turretRange: 0, turretPower: 0, turretWater: 0,
      refillRate: 0, rescueTime: 3.2, refund: 0.6,
      command: true,
    },
    // A water-bombing helicopter: no crew, flies straight over roads, wrecks and
    // traffic, and drops water on whatever it hovers over, forest fires included.
    // It refills at a station helipad or by dipping in the harbour (the south
    // waterfront band), which is why it is fast but never close to the water.
    helicopter: {
      label: 'Helicopter', cost: 8000, crew: 0, speed: 17, capacity: 2600, upkeep: 95,
      hoseRange: 0, turretRange: 11, turretPower: 0.05, turretWater: 70,
      refillRate: 300, rescueTime: 3, refund: 0.55,
      flying: true,
    },
  },

  // People in the river or the sea: a clock, and divers to bring them out.
  water: {
    survive: [80, 130], // seconds a person lasts in the water
    reward: 420, // per person brought out
    maxVictims: 6,
  },

  // Roads blocked by wrecks and debris, and the traffic that queues behind them.
  blockade: {
    clearTime: 26, // crew-seconds of work to open a road
    quickBonus: 120, // paid if the wreck is cleared before its fuel catches
    fuelDelay: [45, 80], // seconds before a wreck's fuel ignites a neighbour
    fuelReach: 9, // tiles
    minStationDist: 14, // crashes do not seal the station in
    pileSpacing: 8, // tiles between the wrecks of a pile-up
  },
  traffic: {
    cars: 1100,
    speed: [3.2, 6.4], // tiles per second
    rushFactor: 0.8, // emergency vehicles' speed in rush hour
    rush: [[7, 9], [16.5, 18.5]], // game hours
  },

  // Injured civilians and medical supplies.
  medical: {
    stationRestock: 0.5, // kits per second on the station apron
    pharmacyRestock: 1.6, // kits per second beside a pharmacy (costs money)
    pharmacyRange: 3.2, // tiles from the pharmacy footprint
    injuredChance: 0.1, // per person who gets out of a burning building
    rescuedInjuredChance: 0.45, // per person carried out by a firefighter
    maxPerFire: 3,
    survive: [130, 210], // seconds an untreated patient lasts
    criticalAt: 0.7, // severity at which a patient must go to a hospital
    transportFee: 260, // paid when a critical patient reaches a hospital
    hospitalRange: 4, // tiles from the hospital footprint to unload
  },

  refillRange: 2.8, // tiles from a hydrant/station a vehicle can hook up

  crew: {
    count: 3,
    speed: 2.5, // tiles/s on foot
    sprayRange: 3.2, // tiles from the burning footprint
    sprayPower: 0.045, // fire knocked down per second, per stream
    sprayWater: 9.5, // L/s
    engageRange: 26, // tiles a crew will walk to a fire on its own
    rescueTime: 3.6, // fallback if a vehicle spec does not override it
  },

  fire: {
    growth: 0.03, // fire units per second
    damage: 0.9, // integrity per second at full fire
    wetDamage: 0.45, // damage multiplier while water is hitting it
    spreadEvery: 5.5, // seconds between spread rolls
    spreadChance: 0.06,
    spreadRange: 2.2, // tile gap between footprints that can catch
    outAt: 0.02,
    firstAlarm: 18, // seconds of calm before the first call
    alarmBase: 50, // seconds between calls at the start
    alarmMin: 28,
    alarmRamp: 0.06, // seconds shaved off the interval per elapsed second
    maxActive: 5, // no new call while this many structures are already alight
  },

  rating: { start: 100, perLost: 12 },

  // Calls for service. Small jobs start immediately; major incidents are held
  // back until a while into each cycle. The build-up is a cycle, not a ramp
  // that never ends: calls get closer together, reach further and more of them
  // may be open at once as the cycle goes on, and after `cycle` seconds it all
  // drops back to the quiet start (after a short breather).
  incidents: {
    firstCall: 20,
    callEvery: [38, 60],
    callScale: 0.75, // call gaps shrink to this share by the end of a cycle
    bigAfter: 240, // seconds into a cycle before a major incident can start
    bigFirst: [40, 160], // after a reset, seconds of that window before the first one
    bigEvery: [300, 420],
    cycle: 900, // seconds of build-up before the reset
    breather: 50, // seconds without a new call right after a reset
    maxOpen: [2, 5], // incidents open at once: at the start of a cycle, at its end
    // The map is huge: calls start near the station and the covered district
    // grows through the cycle (and shrinks back at the reset).
    radius: { start: 90, growPerSecond: 0.18 }, // tiles
    medicalCall: 0.2, // share of small calls that are a medical emergency
    reward: {
      structure: 300, block: 600, rescue: 350, industrial: 1500, bigBlock: 1800, forest: 2200,
      crash: 250, chain: 700, pileup: 1800,
    },
    crashCall: 0.16, // share of small calls that are a traffic accident
    drownCall: 0.1, // share of small calls that are someone in the water
  },

  clockStart: 7 * 60, // 07:00
  clockRate: 0.5, // game minutes per real second
  logLimit: 40,
};
