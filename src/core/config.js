// Every number that decides how the shift feels lives here. The systems read
// these; none of them invents a rate of its own.

export const TILE = 32; // world pixels per tile (a tile is roughly 3 m)

export const CONFIG = {
  tickMs: 1000 / 60,
  maxFrameMs: 200,
  maxCatchUpTicks: 5,
  speeds: [1, 2, 4],

  camera: {
    minZoom: 0.28,
    maxZoom: 2.6,
    startZoom: 1.0,
    panSpeed: 950, // px/s while a pan key is held
    margin: 2, // tiles of slack around the city edge
  },

  city: { seed: 7, name: 'Harbor City' },

  // Credits pay for new apparatus. Vehicle prices live in `vehicles` above.
  economy: {
    start: 2500,
    saved: 300,
    rescued: 120,
  },

  // The fleet: each vehicle is a different tool, not a skin. Buy and sell them
  // at the station; six bays in total.
  vehicles: {
    engine: {
      label: 'Engine', cost: 1000, crew: 3, speed: 6.4, capacity: 1800,
      hoseRange: 15, turretRange: 9, turretPower: 0.035, turretWater: 42,
      refillRate: 170, rescueTime: 3.6, refund: 0.6,
    },
    ladder: {
      label: 'Ladder', cost: 1800, crew: 3, speed: 5.9, capacity: 1200,
      hoseRange: 14, turretRange: 18, turretPower: 0.055, turretWater: 34,
      refillRate: 150, rescueTime: 3.4, refund: 0.6,
    },
    tanker: {
      label: 'Tanker', cost: 1500, crew: 2, speed: 5.4, capacity: 6000,
      hoseRange: 12, turretRange: 7, turretPower: 0.028, turretWater: 55,
      refillRate: 90, rescueTime: 3.8, refund: 0.6,
    },
    rescue: {
      label: 'Rescue', cost: 1600, crew: 4, speed: 7.2, capacity: 600,
      hoseRange: 16, turretRange: 6, turretPower: 0.02, turretWater: 12,
      refillRate: 160, rescueTime: 2.2, refund: 0.6,
    },
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
  // back until the shift has been running for a while.
  incidents: {
    firstCall: 20,
    callEvery: [45, 70],
    bigAfter: 240,
    bigEvery: [300, 420],
    maxActive: 5,
    reward: { structure: 300, block: 600, rescue: 350, industrial: 1500, bigBlock: 1800, forest: 2200 },
  },

  clockStart: 7 * 60, // 07:00
  clockRate: 0.5, // game minutes per real second
  logLimit: 40,
};
