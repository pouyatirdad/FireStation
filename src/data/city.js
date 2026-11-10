// Harbor City: a 160×120 tile grid of districts between six avenues and six
// streets, with a forest in the north-east. Generated from a seed, so every
// shift is the same city and the tests can point at a named building.
//
// Layout is data, not logic: this module knows tiles and buildings, and nothing
// about fire, units or drawing.

import { TILE } from '../core/config.js';
import { Rng, clamp } from '../core/math.js';

export const CITY_W = 160;
export const CITY_H = 120;
export const CITY_NAME = 'Harbor City';

// Avenues run north–south, streets east–west. Each is two tiles wide.
export const V_ROADS = [12, 42, 72, 102, 132];
export const H_ROADS = [12, 36, 60, 84, 108];

// Station 1 sits in the middle of the map and opens south onto 70th Street.
const STATION = { x: 50, y: 44, w: 8, h: 6 };
export const APRON = { x0: 48, y0: 50, x1: 61, y1: 59 };

// Where bought vehicles appear: two rows of three bays under the station.
const BAYS = [
  { x: 50.2, y: 52.6 },
  { x: 53.2, y: 52.6 },
  { x: 56.2, y: 52.6 },
  { x: 50.2, y: 56.6 },
  { x: 53.2, y: 56.6 },
  { x: 56.2, y: 56.6 },
];

const SPEC = {
  house: { floors: [1, 2], hp: [60, 85], risk: 0.9 },
  apartment: { floors: [3, 4], hp: [80, 110], risk: 0.8 },
  shop: { floors: [1, 2], hp: [70, 95], risk: 1 },
  office: { floors: [4, 7], hp: [100, 140], risk: 0.65 },
  hotel: { floors: [5, 8], hp: [110, 150], risk: 0.6 },
  warehouse: { floors: [1, 2], hp: [85, 120], risk: 1.15 },
  station: { floors: [2, 2], hp: [180, 180], risk: 0.7 },
};

const ROOFS = {
  house: ['#9e4f3a', '#a85c40', '#8f4a38', '#a3593f'],
  apartment: ['#8f5f48', '#9c6b50', '#7f5642'],
  shop: ['#a86b3a', '#b07a45', '#9c5f38'],
  office: ['#6b7683', '#74808e', '#616c78', '#707680'],
  hotel: ['#8a6250', '#96705e', '#7d594a'],
  warehouse: ['#6d747b', '#7a7f76', '#616a70'],
  station: ['#8c4b3f'],
};

const KIND_TYPES = {
  houses: [['house', 6], ['shop', 1], ['apartment', 1]],
  downtown: [['office', 4], ['shop', 2], ['hotel', 2], ['apartment', 1]],
  industry: [['warehouse', 5], ['shop', 2], ['office', 1]],
  market: [['shop', 4], ['apartment', 2], ['house', 1]],
};

// How many people are inside at 07:00. Homes are nearly empty in the morning;
// offices, hotels and shops are not.
const OCCUPANTS = {
  house: [1, 3],
  apartment: [5, 14],
  shop: [2, 8],
  office: [8, 24],
  hotel: [12, 36],
  warehouse: [1, 5],
  station: [0, 0],
};

const NAMES = {
  house: [
    'Hartley Residence', 'Kowalski House', 'Alvarez Home', 'Bennett Residence',
    'Okafor House', 'Nakamura Residence', 'Silva Home', 'Brenner House',
    'Duarte Residence', 'Novak House', 'Fischer Home', 'Haddad Residence',
    'Larsen House', 'Moreau Residence', 'Petrov Home', 'Yilmaz House',
    'Lindqvist House', 'Rossi Home', 'Mensah Residence', 'Kaur House',
    'Delgado Home', 'Whitfield House', 'Abara Residence', 'Sorensen Home',
    'Kovacs House', 'Rahimi Residence', 'Bauer Home', 'Quinn House',
    'Salazar Residence', 'Fontaine Home',
  ],
  apartment: [
    'Maple Court', 'Sunset Flats', 'Riverside Apartments', 'The Alderman',
    'Bellview Court', 'Harbor Heights', 'Kingsway Flats', 'Greenway House',
    'Alder Court', 'Beacon Flats', 'Cedar Apartments', 'Dockside Court',
    'Elmwood House', 'Fairview Flats', 'Granite Court', 'Hazel Apartments',
  ],
  shop: [
    'Bell’s Bakery', 'Corner Market', 'Lucky Noodles', 'Second Hand Books',
    'Harbor Hardware', 'Rose & Sons Tailors', 'The Print Shop', 'City Pharmacy',
    'Kettle & Crumb', 'Anchor Outfitters', 'Marlow Meats', 'Paper Moon',
    'Tin Cup Diner', 'Ashgrove Florist', 'Blue Door Deli', 'Copper Kettle',
    'Fenwick Grocers', 'Golden Scissors', 'Hollow Tree Toys', 'Ivy Lane Cafe',
    'Juniper Records', 'King Street Barbers', 'Lantern Books', 'Maple Sweets',
    'Night Owl News', 'Oak & Iron', 'Pine Box Bakery', 'Quarry Sports',
  ],
  office: [
    'Meridian Insurance', 'Halcyon Bank', 'Civic Center', 'Nova Systems',
    'Kestrel & Co.', 'Harbor Title', 'Bluewater Trust', 'Ardent Consulting',
    'Pinnacle House', 'Cantwell Legal', 'Beacon Mutual', 'Cobalt Partners',
    'Delta Shipping', 'Everline Media', 'Fairbanks Group', 'Granite & Vale',
    'Harbor Ledger', 'Ironwood Capital', 'Junction Analytics', 'Keystone Realty',
  ],
  hotel: [
    'Hotel Belvedere', 'The Anchor', 'Grand Union', 'Hotel Meridian',
    'The Seafarer', 'Belmont Arms', 'The Regent', 'Harbor Lights',
    'The Cartographer', 'Westgate Inn',
  ],
  warehouse: [
    'Harbor Freight', 'Kessler Storage', 'Atlas Depot', 'Dockside Bonded',
    'Northgate Logistics', 'Crane & Sons', 'Union Cold Store', 'Pier Nine',
    'Redline Freight', 'Southbank Depot', 'Tidewater Storage', 'Vulcan Works',
  ],
};

const START_HOUR = 7;

// How many trees to scatter in a park patch: rough area, capped.
const treeCount = (w, h) => Math.min(36, Math.max(4, Math.round((w * h) / 10)));

function weightedPick(rng, pairs) {
  const total = pairs.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.range(0, total);
  for (const [value, weight] of pairs) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return pairs[0][0];
}

// Split an inclusive tile range into n cells separated by `gap` tiles, roughly
// equal and never smaller than 3 tiles.
function splitCells(a, b, n, gap = 1) {
  const total = b - a + 1;
  while (n > 1 && total - gap * (n - 1) < n * 3) n--;
  const usable = total - gap * (n - 1);
  const base = Math.floor(usable / n);
  let extra = usable - base * n;
  const cells = [];
  let cur = a;
  for (let i = 0; i < n; i++) {
    const width = base + (extra-- > 0 ? 1 : 0);
    cells.push([cur, cur + width - 1]);
    cur += width + gap;
  }
  return cells;
}

function makeDetails(rng) {
  const count = rng.int(2, 4);
  const list = [];
  for (let i = 0; i < count; i++) {
    const w = rng.range(0.16, 0.32);
    const h = rng.range(0.12, 0.24);
    list.push({
      u: rng.range(0.1, 0.9 - w),
      v: rng.range(0.1, 0.9 - h),
      w,
      h,
      kind: rng.pick(['ac', 'ac', 'vent', 'skylight', 'tank']),
    });
  }
  return list;
}

/** The road grid, cut into blocks, with a district kind for each. */
function buildBlocks() {
  const xs = [];
  let start = 0;
  for (const vx of V_ROADS) {
    xs.push([start, vx - 1]);
    start = vx + 2;
  }
  xs.push([start, CITY_W - 1]);

  const ys = [];
  start = 0;
  for (const hy of H_ROADS) {
    ys.push([start, hy - 1]);
    start = hy + 2;
  }
  ys.push([start, CITY_H - 1]);

  const forestBlocks = new Set(['4,0', '5,0', '4,1', '5,1']);
  const parks = new Set(['1,3', '3,4']);
  const blocks = [];
  for (let row = 0; row < ys.length; row++) {
    for (let col = 0; col < xs.length; col++) {
      const [x0, x1] = xs[col];
      const [y0, y1] = ys[row];
      let kind;
      if (row === ys.length - 1) kind = 'park'; // the waterfront band
      else if (forestBlocks.has(`${col},${row}`)) kind = 'forest';
      else if (parks.has(`${col},${row}`)) kind = 'park';
      else if (col === 2 && row === 2) kind = 'station';
      else if (row >= 4) kind = 'industry';
      else if (row >= 1 && col >= 1 && col <= 3) kind = 'downtown';
      else if (row >= 1) kind = 'market';
      else kind = 'houses';
      blocks.push({ col, row, x0, y0, x1, y1, kind });
    }
  }
  return blocks;
}

export function createCity(seed = 7) {
  const rng = new Rng(seed);
  const w = CITY_W;
  const h = CITY_H;
  const road = new Uint8Array(w * h);
  const apron = new Uint8Array(w * h);
  const blocked = new Uint8Array(w * h);
  const at = (x, y) => y * w + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

  for (const x of V_ROADS) {
    for (let y = 0; y < h; y++) {
      road[at(x, y)] = 1;
      road[at(x + 1, y)] = 1;
    }
  }
  for (const y of H_ROADS) {
    for (let x = 0; x < w; x++) {
      road[at(x, y)] = 1;
      road[at(x, y + 1)] = 1;
    }
  }

  const buildings = [];
  const parks = [];
  const trees = [];
  const hydrants = [];
  const forestAreas = [];
  const forestTiles = [];
  const forest = new Uint8Array(w * h);
  const usedNames = new Set();

  const context = { rng, w, h, road, apron, blocked, buildings, trees, parks, at, inb };

  const takeName = (type) => {
    const pool = NAMES[type] ?? NAMES.shop;
    let base = rng.pick(pool);
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let n = 2;
    while (usedNames.has(`${base} ${n}`)) n++;
    const name = `${base} ${n}`;
    usedNames.add(name);
    return name;
  };

  function addBuilding(x, y, wid, hei, type, extra = {}) {
    const spec = SPEC[type] ?? SPEC.house;
    const floors = extra.floors ?? rng.int(spec.floors[0], spec.floors[1]);
    const hp = rng.int(spec.hp[0], spec.hp[1]);
    const building = {
      id: extra.id ?? `b${buildings.length + 1}`,
      type,
      name: extra.name ?? takeName(type),
      x,
      y,
      w: wid,
      h: hei,
      floors,
      elevation: 11 + floors * 5,
      roofColor: extra.roofColor ?? rng.pick(ROOFS[type]),
      integrity: hp,
      maxIntegrity: hp,
      state: 'ok',
      fire: 0,
      spreadTimer: rng.range(2.5, 6),
      risk: spec.risk,
      occupants: rng.int(...OCCUPANTS[type]),
      trapped: 0,
      evacuated: false,
      details: type === 'station'
        ? [
          { u: 0.1, v: 0.18, w: 0.18, h: 0.24, kind: 'ac' },
          { u: 0.55, v: 0.14, w: 0.16, h: 0.2, kind: 'vent' },
          { u: 0.58, v: 0.58, w: 0.22, h: 0.24, kind: 'ac' },
          { u: 0.14, v: 0.62, w: 0.14, h: 0.16, kind: 'skylight' },
        ]
        : makeDetails(rng),
    };
    for (let ty = y; ty < y + hei; ty++) {
      for (let tx = x; tx < x + wid; tx++) blocked[at(tx, ty)] = 1;
    }
    buildings.push(building);
    return building;
  }

  // --- the station -------------------------------------------------------
  const station = addBuilding(STATION.x, STATION.y, STATION.w, STATION.h, 'station', {
    id: 'station',
    name: 'Station 1',
    floors: 2,
  });
  // The maintenance workshop in the same block, so the station yard is not a
  // bare concrete square.
  addBuilding(63, 52, 5, 4, 'warehouse', { name: 'Station Workshop', floors: 1 });
  for (let ty = APRON.y0; ty <= APRON.y1; ty++) {
    for (let tx = APRON.x0; tx <= APRON.x1; tx++) apron[at(tx, ty)] = 1;
  }

  // A parking apron beside the station, and a few trees around the block, so
  // the station does not sit in the middle of an empty concrete square.
  const stationLot = { x0: 63, y0: 44, x1: 69, y1: 49 };
  for (const [tx, ty] of [[49, 40], [60, 40], [70, 39], [47, 52], [68, 57], [70, 46]]) {
    if (inb(tx, ty) && !blocked[at(tx, ty)] && !road[at(tx, ty)] && !apron[at(tx, ty)]) {
      trees.push({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, r: rng.range(9, 13), tone: rng.pick(['#4f7a3d', '#58853f', '#456f37']) });
    }
  }

  const blocks = buildBlocks();

  function scatterTrees(x0, y0, x1, y1) {
    const count = treeCount(x1 - x0 + 1, y1 - y0 + 1);
    for (let i = 0; i < count; i++) {
      const wx = rng.range(x0, x1 + 1);
      const wy = rng.range(y0, y1 + 1);
      const tx = Math.floor(wx);
      const ty = Math.floor(wy);
      if (!inb(tx, ty)) continue;
      if (road[at(tx, ty)] || blocked[at(tx, ty)]) continue;
      trees.push({
        x: wx * TILE,
        y: wy * TILE,
        r: rng.range(8, 15),
        tone: rng.pick(['#4f7a3d', '#58853f', '#456f37', '#628c46']),
      });
    }
  }

  function fillBlock(block) {
    const { x0, y0, x1, y1, kind } = block;
    if (kind === 'forest') {
      forestAreas.push({ x0, y0, x1, y1 });
      for (let y = y0 + 1; y <= y1 - 1; y++) {
        for (let x = x0 + 1; x <= x1 - 1; x++) {
          if (road[at(x, y)] || blocked[at(x, y)]) continue;
          forest[at(x, y)] = 1;
          forestTiles.push({ x, y });
          if (rng.chance(0.16)) {
            trees.push({
              x: (x + 0.5 + rng.range(-0.3, 0.3)) * TILE,
              y: (y + 0.5 + rng.range(-0.3, 0.3)) * TILE,
              r: rng.range(9, 16),
              tone: rng.pick(['#3f6a32', '#466f36', '#385f2c']),
            });
          }
        }
      }
      return;
    }
    if (kind === 'park') {
      parks.push({ x0, y0, x1, y1 });
      scatterTrees(x0, y0, x1, y1);
      return;
    }
    if (kind === 'station') return;

    const ax0 = x0 + 1;
    const ax1 = x1 - 1;
    const ay0 = y0 + 1;
    const ay1 = y1 - 1;
    const bw = ax1 - ax0 + 1;
    const bh = ay1 - ay0 + 1;
    if (bw < 3 || bh < 3) {
      parks.push({ x0, y0, x1, y1 });
      scatterTrees(x0, y0, x1, y1);
      return;
    }

    const cols = clamp(Math.round(bw / 5), 1, 4);
    const rows = clamp(Math.round(bh / 7), 1, 2);
    const xs = splitCells(ax0, ax1, cols);
    const ys = splitCells(ay0, ay1, rows);

    for (const [cy0, cy1] of ys) {
      for (const [cx0, cx1] of xs) {
        const bx = cx0;
        const by = cy0;
        let bwid = cx1 - cx0 + 1;
        let bhei = cy1 - cy0 + 1;
        if (bwid >= 5 && rng.chance(0.4)) bwid -= 1;
        if (bhei >= 5 && rng.chance(0.4)) bhei -= 1;
        if (bwid < 3 || bhei < 3) continue;
        addBuilding(bx, by, bwid, bhei, weightedPick(rng, KIND_TYPES[kind]));
      }
    }
  }

  for (const block of blocks) fillBlock(block);

  // --- parks mask --------------------------------------------------------
  const park = new Uint8Array(w * h);
  for (const p of parks) {
    for (let y = p.y0; y <= p.y1; y++) {
      for (let x = p.x0; x <= p.x1; x++) park[at(x, y)] = 1;
    }
  }

  // --- hydrants ----------------------------------------------------------
  const isHydrantSpot = (x, y) => {
    if (!inb(x, y) || blocked[at(x, y)] || road[at(x, y)] || apron[at(x, y)]) return false;
    return (
      (inb(x + 1, y) && road[at(x + 1, y)]) ||
      (inb(x - 1, y) && road[at(x - 1, y)]) ||
      (inb(x, y + 1) && road[at(x, y + 1)]) ||
      (inb(x, y - 1) && road[at(x, y - 1)])
    );
  };

  const hydrantAt = new Set();
  for (const block of blocks) {
    const midX = Math.floor((block.x0 + block.x1) / 2);
    const midY = Math.floor((block.y0 + block.y1) / 2);
    const sides = rng.shuffle(['n', 's', 'e', 'w']);
    let placed = 0;
    for (const side of sides) {
      if (placed >= 2 || !rng.chance(0.7)) continue;
      let x = midX;
      let y = midY;
      if (side === 'n') y = block.y0;
      if (side === 's') y = block.y1;
      if (side === 'w') x = block.x0;
      if (side === 'e') x = block.x1;
      x += rng.int(-3, 3);
      y += rng.int(-3, 3);
      let spot = null;
      for (let r = 0; r <= 3 && !spot; r++) {
        for (let dy = -r; dy <= r && !spot; dy++) {
          for (let dx = -r; dx <= r && !spot; dx++) {
            if (isHydrantSpot(x + dx, y + dy)) spot = { x: x + dx, y: y + dy };
          }
        }
      }
      if (spot && !hydrantAt.has(`${spot.x},${spot.y}`)) {
        hydrantAt.add(`${spot.x},${spot.y}`);
        hydrants.push(spot);
        placed++;
      }
    }
  }

  // --- street trees ------------------------------------------------------
  for (let ty = 1; ty < h - 1; ty++) {
    for (let tx = 1; tx < w - 1; tx++) {
      const i = at(tx, ty);
      if (road[i] || blocked[i] || apron[i] || park[i]) continue;
      if (hydrantAt.has(`${tx},${ty}`)) continue;
      const kerb =
        road[at(tx + 1, ty)] || road[at(tx - 1, ty)] ||
        road[at(tx, ty + 1)] || road[at(tx, ty - 1)];
      if (!kerb || !rng.chance(0.05)) continue;
      trees.push({
        x: (tx + 0.5) * TILE,
        y: (ty + 0.5) * TILE,
        r: rng.range(7, 11),
        tone: rng.pick(['#4f7a3d', '#58853f', '#456f37']),
      });
    }
  }

  // --- parked cars -------------------------------------------------------
  const cars = [];
  const CAR_COLORS = ['#cfd3d8', '#3d4d63', '#8f2f27', '#e7e3d6', '#4c5c50', '#b98a3a', '#6b6f76'];
  const nearCrossStreet = (y) => H_ROADS.some((hy) => Math.abs(y - hy) < 2);
  const nearCrossAvenue = (x) => V_ROADS.some((vx) => Math.abs(x - vx) < 2);

  const tryCar = (tx, ty, x, y, angle) => {
    if (cars.length >= 130) return;
    if (!inb(tx, ty) || blocked[at(tx, ty)] || road[at(tx, ty)] || apron[at(tx, ty)] || park[at(tx, ty)]) return;
    cars.push({ x, y, angle: rng.chance(0.5) ? angle : angle + Math.PI, color: rng.pick(CAR_COLORS) });
  };

  for (const vx of V_ROADS) {
    for (let y = 2; y < h - 2; y += 3) {
      if (nearCrossStreet(y) || !rng.chance(0.3)) continue;
      for (const side of [-0.42, 2.42]) {
        if (!rng.chance(0.5)) continue;
        tryCar(Math.floor(vx + side), y, (vx + side) * TILE, (y + 0.5) * TILE, -Math.PI / 2);
      }
    }
  }
  for (const hy of H_ROADS) {
    for (let x = 2; x < w - 2; x += 3) {
      if (nearCrossAvenue(x) || !rng.chance(0.24)) continue;
      for (const side of [-0.42, 2.42]) {
        if (!rng.chance(0.5)) continue;
        tryCar(x, Math.floor(hy + side), (x + 0.5) * TILE, (hy + side) * TILE, 0);
      }
    }
  }

  // Three cars in the station car park.
  for (let i = 0; i < 3; i++) {
    cars.push({
      x: (stationLot.x0 + 1 + i * 1.45) * TILE,
      y: (stationLot.y0 + 3) * TILE,
      angle: 0,
      color: rng.pick(CAR_COLORS),
    });
  }

  return {
    name: CITY_NAME,
    w,
    h,
    road,
    apron,
    blocked,
    park,
    forest,
    forestAreas,
    forestTiles,
    buildings,
    station,
    hydrants,
    trees,
    parks,
    cars,
    lot: stationLot,
    bays: BAYS.map((b) => ({ x: b.x * TILE, y: b.y * TILE })),
    districts: [
      { name: 'OLD TOWN', x: 26 * TILE, y: 24 * TILE },
      { name: 'NORTHGATE', x: 118 * TILE, y: 24 * TILE },
      { name: 'FOREST', x: 118 * TILE, y: 44 * TILE },
      { name: 'MIDTOWN', x: 72 * TILE, y: 52 * TILE },
      { name: 'HARBOR', x: 30 * TILE, y: 96 * TILE },
      { name: 'WATERFRONT', x: 80 * TILE, y: 114 * TILE },
    ],
    spawn: { x: BAYS[0].x * TILE, y: BAYS[0].y * TILE, angle: Math.PI / 2 },
    startHour: START_HOUR,
  };
}
