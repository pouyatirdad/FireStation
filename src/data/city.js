// Harbor City: a 1660×1176 tile grid (about a hundred times the area of the
// original 160×120 town, ten times the 520×384 city it grew from) of districts
// between 55 avenues and 48 streets, with a dozen forests, parks and a
// waterfront on the southern shore. Generated from a seed, so every shift is the
// same city and the tests can point at a named building. The original town sits
// in the north-west corner with Station 1 where it always was.
//
// Layout is data, not logic: this module knows tiles and buildings, and nothing
// about fire, units or drawing.

import { TILE } from '../core/config.js';
import { Rng, clamp } from '../core/math.js';

export const CITY_W = 1660;
export const CITY_NAME = 'Harbor City';

// Avenues run north–south, streets east–west. Each is two tiles wide. They are
// not evenly spaced: between the fixed anchors (the original quarter, Station 2's
// block, the dock, the river banks and the quay) the gaps are drawn from a seeded
// stream, so blocks come in different sizes, like the streets of a real city.
function spacedLines(count, start, step, pins, min, max, seed) {
  const lines = Array.from({ length: count }, (_, i) => start + i * step);
  const rng = new Rng(seed);
  const fixed = [...pins].sort((a, b) => a - b);
  for (let p = 0; p + 1 < fixed.length; p++) {
    const i = fixed[p];
    const j = fixed[p + 1];
    const n = j - i;
    if (n < 2) continue;
    const total = lines[j] - lines[i];
    // Random gaps that still add up exactly to `total`, each within [min, max].
    let gaps = Array.from({ length: n }, () => rng.range(0.7, 1.35));
    for (let pass = 0; pass < 12; pass++) {
      const sum = gaps.reduce((s, g) => s + g, 0);
      gaps = gaps.map((g) => Math.min(max, Math.max(min, (g / sum) * total)));
    }
    const ints = gaps.map((g) => Math.round(g));
    let diff = total - ints.reduce((s, g) => s + g, 0);
    for (let k = 0; diff !== 0 && k < 400; k++) {
      const at = k % n;
      const step1 = Math.sign(diff);
      if (ints[at] + step1 >= min && ints[at] + step1 <= max) {
        ints[at] += step1;
        diff -= step1;
      }
    }
    let cur = lines[i];
    for (let k = 1; k < n; k++) {
      cur += ints[k - 1];
      lines[i + k] = cur;
    }
  }
  return lines;
}

// The first 17 avenues and 15 streets are the original city, pinned where they
// always were; the rest carry on east and south with random gaps.
export const V_ROADS = spacedLines(55, 12, 30, [0, 1, 2, 7, 8, 9, 11, 12, 16, 54], 22, 42, 4711);
export const H_ROADS = spacedLines(48, 12, 24, [0, 1, 2, 5, 6, 13, 14, 47], 20, 34, 1993);

// The sea fills everything south of the last street (the harbour quay). A river
// meanders down through the east of the city inside one column of blocks, so it
// only ever crosses the streets (as bridges) and never a street's length.
export const SEA_Y = H_ROADS[H_ROADS.length - 1] + 2;
export const CITY_H = SEA_Y + 34;
export const RIVER_HALF_WIDTH = 3.5;
export const riverCentre = (y) => 357 + 8 * Math.sin(y / 55);

// Station 1 sits in the middle of the map and opens south onto 70th Street.
const STATION = { x: 50, y: 44, w: 8, h: 6 };
export const APRON = { x0: 48, y0: 50, x1: 61, y1: 59 };

// Where bought vehicles appear: two rows of four bays under the station.
const BAYS = [
  { x: 50.2, y: 52.6 },
  { x: 53.2, y: 52.6 },
  { x: 56.2, y: 52.6 },
  { x: 59.2, y: 52.6 },
  { x: 50.2, y: 56.6 },
  { x: 53.2, y: 56.6 },
  { x: 56.2, y: 56.6 },
  { x: 59.2, y: 56.6 },
];

// Eight more bays squeezed into the gaps between those, so a station holds
// sixteen. They come after every original bay in `city.bays`, which keeps the
// bay numbers in old saves valid.
const EXTRA_BAYS = [52.6, 56.6].flatMap((y) => [51.7, 54.7, 57.7, 60.7].map((x) => ({ x, y })));

const SPEC = {
  house: { floors: [1, 2], hp: [60, 85], risk: 0.9 },
  apartment: { floors: [3, 4], hp: [80, 110], risk: 0.8 },
  shop: { floors: [1, 2], hp: [70, 95], risk: 1 },
  office: { floors: [4, 7], hp: [100, 140], risk: 0.65 },
  hotel: { floors: [5, 8], hp: [110, 150], risk: 0.6 },
  warehouse: { floors: [1, 2], hp: [85, 120], risk: 1.15 },
  pharmacy: { floors: [1, 2], hp: [75, 100], risk: 0.85 },
  hospital: { floors: [3, 5], hp: [150, 190], risk: 0.55 },
  station: { floors: [2, 2], hp: [180, 180], risk: 0.7 },
  // The very large buildings: rare, hard to fight once they have taken hold.
  villa: { floors: [2, 3], hp: [85, 110], risk: 0.85 },
  tower: { floors: [12, 24], hp: [210, 270], risk: 0.5 },
  mall: { floors: [2, 3], hp: [150, 190], risk: 0.8 },
  factory: { floors: [1, 3], hp: [140, 180], risk: 1.25 },
  school: { floors: [2, 3], hp: [110, 140], risk: 0.7 },
  tankfarm: { floors: [1, 1], hp: [160, 210], risk: 1.45 },
  // Transport: the airport, the railway and the metro.
  terminal: { floors: [2, 3], hp: [170, 210], risk: 0.6 },
  hangar: { floors: [1, 1], hp: [120, 160], risk: 1.2 },
  railstation: { floors: [2, 3], hp: [150, 190], risk: 0.6 },
  metro: { floors: [1, 2], hp: [100, 130], risk: 0.55 },
};

// Size classes by building mass (footprint x floors, the measure the fire logic
// uses): the map is meant to be about half small buildings, three in ten medium,
// one in eight large and one in twelve very large.
export const SIZE_CLASSES = [['small', 30], ['medium', 80], ['large', 200], ['huge', Infinity]];
export const buildingMass = (w, h, floors) => w * h * (0.7 + 0.15 * floors);
export const sizeClassOf = (mass) => SIZE_CLASSES.find(([, max]) => mass < max)[0];

const ROOFS = {
  house: ['#7d5a4c', '#5f6368', '#6e5348', '#74706a'],
  apartment: ['#85594a', '#8c7a68', '#6f5a4e'],
  shop: ['#8a7358', '#7a6b5e', '#8c6a52'],
  office: ['#59636d', '#646d76', '#4f5a64', '#6a6f74'],
  hotel: ['#7d6a5c', '#8a786a', '#6f5f53'],
  warehouse: ['#6a6f72', '#76796f', '#5d6569'],
  pharmacy: ['#cdd6d0', '#c4cfc8', '#d4dad4'],
  hospital: ['#d9dfe2', '#d0d8dc', '#dfe2e1'],
  station: ['#7e473d'],
  villa: ['#8a4f3f', '#7d5a4c', '#94604a', '#6f4a3e'],
  tower: ['#4a5663', '#55616d', '#434e5a'],
  mall: ['#8d8f93', '#9a9c9f', '#7f8387'],
  factory: ['#6c7276', '#797d79', '#5f676b'],
  school: ['#8f6a52', '#9b7658', '#84624d'],
  tankfarm: ['#8a8f93', '#7b8286', '#969b9e'],
  terminal: ['#8d949b', '#7f8a93', '#98a0a6'],
  hangar: ['#6d7479', '#7a8085', '#646b70'],
  railstation: ['#6f7c86', '#5f6c76', '#7b8790'],
  metro: ['#4a5a68', '#56606b', '#3f4f5c'],
};

// What is built in each kind of block (by lot style), with weights. The big
// types only fit big lots, so the mix of sizes comes from these weights and the
// lot sizes together.
const KIND_TYPES = {
  villa: [['villa', 8], ['house', 0.8], ['school', 0.15], ['apartment', 0.15]],
  suburb: [['house', 8], ['apartment', 1.6], ['school', 0.12], ['shop', 0.3]],
  flats: [['apartment', 5], ['house', 1.5], ['school', 0.4], ['shop', 0.4]],
  downtown: [['office', 3.2], ['tower', 3], ['hotel', 1.8], ['mall', 4], ['apartment', 0.7], ['shop', 0.6], ['metro', 1.6], ['railstation', 1.4]],
  industry: [['warehouse', 4], ['factory', 3.5], ['tankfarm', 1.6], ['office', 0.4]],
  market: [['shop', 4], ['apartment', 2.6], ['house', 0.6], ['hotel', 0.25], ['mall', 0.5]],
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
  pharmacy: [2, 7],
  hospital: [22, 46],
  station: [0, 0],
  villa: [2, 6],
  tower: [60, 150],
  mall: [40, 110],
  factory: [12, 40],
  school: [40, 120],
  tankfarm: [1, 4],
  terminal: [80, 200],
  hangar: [2, 10],
  railstation: [40, 120],
  metro: [20, 70],
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
    'Harbor Hardware', 'Rose & Sons Tailors', 'The Print Shop', 'Hartwell Optics',
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
  hospital: [
    'St. Anne’s Hospital', 'Harbor General Hospital', 'Mercy Medical Center', 'Northgate Infirmary',
    'University Hospital', 'Eastside Clinic & Emergency', 'South Bank Hospital', 'Riverside General',
  ],
  pharmacy: [
    'City Pharmacy', 'Healthwell Pharmacy', 'Green Cross Chemist', 'Corner Rx',
    'Harbor Apothecary', 'Wellspring Pharmacy', 'Lifeline Drugstore', 'Maple Pharmacy',
    'Northgate Chemist', 'Riverside Rx', 'Sunrise Pharmacy', 'Unity Medical Supply',
  ],
  villa: [
    'Villa Rosa', 'The Willows', 'Ashgrove Villa', 'Cypress House', 'Villa Serena', 'The Laurels',
    'Hillcrest Villa', 'Oakridge Manor', 'Villa Bianca', 'Rosewood House', 'The Cedars', 'Linden Villa',
    'Villa Aurora', 'Meadowbank House', 'Thornfield', 'Brookside Villa',
  ],
  tower: [
    'Meridian Tower', 'Halcyon Plaza', 'Pinnacle Tower', 'Cobalt Centre', 'Harbor Exchange',
    'Beacon Tower', 'Keystone Plaza', 'Ardent House Tower', 'Northgate Tower', 'Union Square Tower',
    'Granite Tower', 'Sterling Plaza', 'Vantage Tower', 'Crown Point',
  ],
  mall: [
    'Harbor Mall', 'Northgate Galleria', 'Civic Arcade', 'Eastside Centre', 'Riverside Shopping Centre',
    'Midtown Plaza', 'Old Town Arcade', 'The Pavilion',
  ],
  factory: [
    'Vulcan Steelworks', 'Kessler Chemicals', 'Atlas Foundry', 'Redline Plastics', 'Tidewater Cannery',
    'Ironbridge Engineering', 'Harbor Paint Works', 'Crane & Sons Mill', 'Southbank Refinery', 'Pier Nine Packaging',
  ],
  school: [
    'Lincoln High School', 'St. Clair Academy', 'Maple Grove School', 'Westfield Primary', 'Riverside College',
    'Holloway Secondary', 'Elmgrove School', 'Fairmount Academy',
  ],
  metro: [
    'Central Metro', 'Union Square Metro', 'Harbor Line Metro', 'Northgate Metro', 'City Hall Metro', 'Market Street Metro',
    'University Metro', 'Riverside Metro', 'Cathedral Metro', 'Exchange Metro', 'Stadium Metro', 'Park Lane Metro',
    'Kings Cross Metro', 'Mill Road Metro', 'Docks Metro', 'Old Town Metro', 'Victoria Metro', 'Albion Metro',
  ],
  railstation: [
    'Harbor Central Station', 'Northgate Rail Station', 'Eastside Junction', 'Union Terminus', 'Riverside Rail Station',
    'Midtown Station', 'Kings Cross Station', 'Grand Central Terminal', 'Southern Cross Station', 'Westgate Station',
  ],
  terminal: ['Airport Terminal'],
  hangar: ['Aircraft Hangar'],
  tankfarm: [
    'Tidewater Fuel Terminal', 'South Quay Oil Depot', 'Harbor Bulk Storage', 'Dockside Fuel Farm',
    'Ironbridge Tank Park', 'Freight Yard Fuel Depot',
  ],
  warehouse: [
    'Harbor Freight', 'Kessler Storage', 'Atlas Depot', 'Dockside Bonded',
    'Northgate Logistics', 'Crane & Sons', 'Union Cold Store', 'Pier Nine',
    'Redline Freight', 'Southbank Depot', 'Tidewater Storage', 'Vulcan Works',
  ],
};

const START_HOUR = 7;

// How many trees to scatter in a park patch: rough area, capped.
const treeCount = (w, h) => Math.min(64, Math.max(4, Math.round((w * h) / 9)));

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

// Where the big commercial centres are, as (column, row) block coordinates.
// The first is the original downtown around Station 1.
const DOWNTOWNS = [
  { col: 2, row: 2, name: 'OLD TOWN' },
  { col: 7, row: 6, name: 'CIVIC QUARTER' },
  { col: 13, row: 3, name: 'NORTHGATE' },
  { col: 3, row: 10, name: 'UNIVERSITY' },
  { col: 10, row: 11, name: 'MIDTOWN' },
  { col: 15, row: 8, name: 'EASTSIDE' },
  { col: 7, row: 14, name: 'SOUTH BANK' },
];

const MORE_DOWNTOWN_NAMES = [
  'AIRPORT CITY', 'CENTRAL STATION', 'CASTLE HILL', 'WESTGATE', 'LAKESIDE', 'BRIDGEPORT', 'MARKET CROSS', 'PARKSIDE',
  'NEW TOWN', 'ROYAL MILE', 'TECH QUARTER', 'KINGS CROSS', 'ST. MARY', 'FAIRWAY', 'HIGHBURY', 'STONEBRIDGE',
  'OAKLANDS', 'PORTSMOUTH', 'THE EXCHANGE', 'MILL ROW', 'SUNDERLAND', 'CRESCENT', 'RIVERGATE', 'VICTORIA',
  'ALBION', 'ELM CROSS', 'ASTORIA', 'GRAND CENTRAL', 'NORTH HARBOR', 'COLLEGE GREEN', 'SPRINGFIELD', 'LINCOLN PARK',
  'MONTROSE', 'ARDEN', 'BELMONT', 'CARLTON', 'DEVONPORT', 'EASTBURY', 'FOXHALL', 'GLENMORE',
];

// Big pine forests (blocks): the original one in the south-east of the old city,
// and a few more in the new country. Each is one named zone.
const BIG_FOREST_BOXES = [
  { col0: 13, col1: 17, row0: 10, row1: 14 }, // SOUTHEAST FOREST: east of the river
  { col0: 27, col1: 33, row0: 3, row1: 8 },
  { col0: 40, col1: 46, row0: 15, row1: 21 },
  { col0: 21, col1: 26, row0: 26, row1: 32 },
  { col0: 3, col1: 9, row0: 34, row1: 40 },
  { col0: 36, col1: 42, row0: 32, row1: 38 },
  { col0: 47, col1: 53, row0: 4, row1: 9 },
  { col0: 49, col1: 54, row0: 33, row1: 39 },
];
// The airports: each is a box of blocks merged into one (the streets inside are
// taken out). The first is the international airport in the east.
const AIRPORT_BOXES = [
  { col0: 44, col1: 48, row0: 23, row1: 25, name: 'Harbor City International Airport', short: 'International' },
  { col0: 16, col1: 19, row0: 20, row1: 22, name: 'Northgate Regional Airfield', short: 'Regional' },
];
const inAirport = (col, row, pad = 0) => AIRPORT_BOXES.some((b) => col >= b.col0 - pad && col <= b.col1 + pad && row >= b.row0 - pad && row <= b.row1 + pad);

// Where the regional fire stations are (as block coordinates): the nearest block
// big enough for a station, its apron and a hospital is used.
const BASE_TARGETS = [
  [22, 3], [36, 6], [50, 3], [22, 13], [34, 14], [47, 12], [10, 24], [28, 24], [37, 28], [14, 34], [30, 38], [46, 40],
];

const inBigForest = (col, row, pad = 0) => BIG_FOREST_BOXES.some((b) => col >= b.col0 - pad && col <= b.col1 + pad && row >= b.row0 - pad && row <= b.row1 + pad);

// More commercial centres across the new country, on a loose grid, clear of the
// river, the big forests and each other.
{
  const r = new Rng(8675);
  let n = 0;
  for (let row = 4; row <= 44; row += 7) {
    for (let col = 3; col <= 51; col += 8) {
      const c = col + r.int(-2, 2);
      const rw = row + r.int(-2, 2);
      if (c <= 17 && rw <= 15) continue; // the original city
      if (c > 53 || rw > 44) continue;
      if (c >= 10 && c <= 14) continue; // the river banks
      if (inBigForest(c, rw, 1) || inAirport(c, rw, 1)) continue;
      if (DOWNTOWNS.some((d) => Math.max(Math.abs(d.col - c), Math.abs(d.row - rw)) < 4)) continue;
      DOWNTOWNS.push({ col: c, row: rw, name: MORE_DOWNTOWN_NAMES[n++ % MORE_DOWNTOWN_NAMES.length] });
    }
  }
}

const FOREST_NAMES = [
  'NORTH WOODS', 'PINE RIDGE', 'GREEN HOLLOW', 'EASTWOOD', 'BIRCH FOREST', 'OLD GROWTH', 'FERN VALLEY', 'MOSSY DELL',
  'HAWTHORN WOOD', 'CEDAR BROOK', 'WOLF RUN', 'SILVER BIRCH', 'THE CHASE', 'BRACKEN HILL', 'ASHDOWN', 'DEEP HOLLOW',
  'KESTREL WOOD', 'LONG COPSE', 'HOLLY WOOD', 'STAG FOREST', 'ELDER GROVE', 'TIMBERLAND', 'MARSH WOOD', 'RAVEN WOOD',
  // The big pine forests, one name each.
  'SOUTHEAST FOREST', 'HIGHLAND FOREST', 'GREAT PINE FOREST', 'BLACK FOREST', 'KINGSWOOD', 'SHERWOOD', 'ARDEN FOREST', 'WILDERNESS',
];
const FIRST_BIG_ZONE = 24;

// Every block of a big forest is pine; its zone is its index in BIG_FOREST_BOXES
// past FIRST_BIG_ZONE.
const isBigZone = (zone) => zone >= FIRST_BIG_ZONE;

// A stable per-tile hash for decoration (tree species, forest edges), so the
// city's random stream, and with it every building, is not disturbed.
function tileHash(x, y, k = 0) {
  const n = Math.sin(x * 127.1 + y * 311.7 + k * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

// Tree species: 'conifer' (pine, spruce), 'broadleaf' (oak, maple) or 'birch'.
// Each has its own believable range of greens.
const TREE_TONES = {
  conifer: ['#24412c', '#2b4a31', '#203a2a', '#2f4f34'],
  broadleaf: ['#46683a', '#4f7339', '#3d5e32', '#587b3f'],
  birch: ['#6f8a45', '#7a9350', '#66843f'],
};

function species(x, y, pineShare, birchShare = 0.1) {
  const r = tileHash(x, y, 3);
  const kind = r < pineShare ? 'conifer' : r < pineShare + birchShare ? 'birch' : 'broadleaf';
  const tones = TREE_TONES[kind];
  return { kind, tone: tones[Math.floor(tileHash(x, y, 5) * tones.length)] };
}

// The columns the river runs through and its two banks (blocks, not tiles).
const RIVER_COLS = [11, 13];

// How big each kind of building can be, in tiles.
const TYPE_RULES = {
  house: { minW: 3, minH: 3, maxW: 5, maxH: 5 },
  apartment: { minW: 5, minH: 5, maxW: 10, maxH: 9 },
  shop: { minW: 3, minH: 3, maxW: 7, maxH: 6 },
  office: { minW: 5, minH: 5, maxW: 14, maxH: 12 },
  hotel: { minW: 6, minH: 6, maxW: 11, maxH: 10 },
  warehouse: { minW: 7, minH: 5, maxW: 24, maxH: 14 },
  pharmacy: { minW: 3, minH: 3, maxW: 6, maxH: 6 },
  villa: { minW: 6, minH: 6, maxW: 8, maxH: 7 },
  tower: { minW: 7, minH: 7, maxW: 11, maxH: 11 },
  mall: { minW: 14, minH: 10, maxW: 22, maxH: 15 },
  factory: { minW: 12, minH: 9, maxW: 24, maxH: 14 },
  school: { minW: 10, minH: 8, maxW: 16, maxH: 11 },
  tankfarm: { minW: 12, minH: 10, maxW: 20, maxH: 14 },
  terminal: { minW: 24, minH: 9, maxW: 32, maxH: 12 },
  hangar: { minW: 14, minH: 9, maxW: 20, maxH: 12 },
  railstation: { minW: 16, minH: 10, maxW: 26, maxH: 14 },
  metro: { minW: 4, minH: 4, maxW: 6, maxH: 5 },
};

// How each kind of block is cut into lots: lot sizes, the lane between lots, how
// often a lot is split further than it has to be, and how a building sits on it.
const LOT_PARAMS = {
  suburb: { minW: 3, maxW: 5, minH: 4, maxH: 6, gap: [1, 1], split: 0.2, setback: [1, 2], flush: 0.15, empty: 0.06 },
  flats: { minW: 6, maxW: 12, minH: 6, maxH: 10, gap: [1, 2], split: 0.15, setback: [1, 2], flush: 0.4, empty: 0.08 },
  villa: { minW: 7, maxW: 10, minH: 7, maxH: 9, gap: [2, 3], split: 0.15, setback: [2, 3], flush: 0.1, empty: 0.12 },
  market: { minW: 4, maxW: 7, minH: 5, maxH: 9, gap: [0, 1], split: 0.25, setback: [1, 1], flush: 0.8, empty: 0.04 },
  downtown: { minW: 8, maxW: 20, minH: 8, maxH: 15, gap: [1, 2], split: 0.2, setback: [1, 1], flush: 0.6, empty: 0.1 },
  industry: { minW: 11, maxW: 22, minH: 9, maxH: 14, gap: [2, 3], split: 0.1, setback: [1, 2], flush: 0.3, empty: 0.08 },
};

/** Cut a rectangle into lots by repeated random splits, with a lane between neighbours. */
function subdivide(rng, x0, y0, x1, y1, p, out) {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const canX = w >= 2 * p.minW + p.gap[1];
  const canY = h >= 2 * p.minH + p.gap[1];
  const tooBig = w > p.maxW || h > p.maxH;
  if ((!canX && !canY) || (!tooBig && !rng.chance(p.split))) {
    out.push({ x0, y0, x1, y1 });
    return;
  }
  const vertical = canX && canY
    ? w / p.maxW + rng.range(-0.25, 0.25) >= h / p.maxH
    : canX;
  const gap = rng.int(p.gap[0], p.gap[1]);
  if (vertical) {
    const left = rng.int(p.minW, w - gap - p.minW);
    subdivide(rng, x0, y0, x0 + left - 1, y1, p, out);
    subdivide(rng, x0 + left + gap, y0, x1, y1, p, out);
  } else {
    const top = rng.int(p.minH, h - gap - p.minH);
    subdivide(rng, x0, y0, x1, y0 + top - 1, p, out);
    subdivide(rng, x0, y0 + top + gap, x1, y1, p, out);
  }
}

// A few made-up neighbourhood names for the housing districts and industrial areas.
const HOUSING_NAMES = [
  'ROSEHILL', 'GREENFIELD', 'WILLOW BEND', 'CEDAR PARK', 'MEADOWBROOK', 'SUNNYSIDE', 'HAZELWOOD', 'PINE GROVE', 'BRIGHTON PARK', 'CHERRY LANE',
  'FOXGLOVE', 'HIGHFIELD', 'ISLINGTON', 'JUNIPER HILL', 'KENSINGTON', 'LARKSPUR', 'MAPLE GLEN', 'NEWTON', 'OAK RIDGE', 'PRIMROSE HILL',
  'QUEENSWAY', 'REDWOOD', 'STRATFORD', 'TANGLEWOOD', 'UPLANDS', 'VINE STREET', 'WINDSOR', 'YARROW', 'ZENITH PARK', 'AMBERLEY',
  'BELLEVUE', 'CLIFTON', 'DALTON', 'EDGEWATER', 'FERNDALE', 'GRANGE HILL','MAPLE HEIGHTS', 'WESTFIELD', 'LINDEN PARK', 'ORCHARD HILL', 'KINGSLEY', 'ASHFORD', 'BRIARWOOD', 'ST. CLAIR', 'ELMGROVE', 'HOLLOWAY', 'FAIRMOUNT', 'THORNBURY'];
const INDUSTRY_NAMES = [
  'RAIL YARDS', 'FOUNDRY ROW', 'WAREHOUSE DISTRICT', 'CHEMICAL MILE', 'COLD STORAGE ROW', 'STEEL WORKS', 'GASWORKS', 'SALT FLATS', 'TANNERY ROW',
'HARBOUR WORKS', 'DOCKLANDS', 'FREIGHT YARD', 'SOUTH QUAY', 'TIDEWATER ESTATE', 'IRONBRIDGE WORKS'];

// What each kind of block is for. Housing, business ("company"), industry and
// shopping streets are separate districts, the way a real city zones them.
const ZONE_OF = { downtown: 'company', market: 'commercial', houses: 'housing', industry: 'industrial' };

/**
 * The road grid, cut into blocks, with a district kind for each:
 *  - business districts (`downtown`) round the commercial centres,
 *  - shopping streets (`market`) around those,
 *  - industry on the waterfront (the quay rows in the south and the river banks),
 *  - housing everywhere else, with parks and woods between.
 * A few pairs of neighbouring blocks of the same kind are then merged into one
 * big block (the street between them is removed): an industrial estate, a
 * housing estate round a green, a market square.
 * Returns `{ blocks, removed }`; `removed` are tile rectangles of street to take out.
 */
function buildBlocks(seed = 7) {
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

  const lastRow = ys.length - 1;
  const rng = new Rng(seed * 31 + 5);
  const forestBlocks = new Map();
  forestBlocks.set('4,0', 0);
  forestBlocks.set('5,0', 0);
  forestBlocks.set('4,1', 0);
  forestBlocks.set('5,1', 0);
  BIG_FOREST_BOXES.forEach((box, i) => {
    for (let c = box.col0; c <= box.col1; c++) {
      for (let r = box.row0; r <= box.row1; r++) forestBlocks.set(`${c},${r}`, FIRST_BIG_ZONE + i);
    }
  });
  // More woods in the outskirts, each two blocks by two, clear of the old town.
  for (let zone = 1, tries = 0; zone < FIRST_BIG_ZONE && tries < 8000; tries++) {
    const col = rng.int(0, xs.length - 2);
    const row = rng.int(0, lastRow - 5); // never on the industrial waterfront
    if (col < 6 && row < 6) continue; // the original quarter and its own woods
    const cells = [[col, row], [col + 1, row], [col, row + 1], [col + 1, row + 1]];
    if (cells.some(([c, r]) => forestBlocks.has(`${c},${r}`))) continue;
    // Keep a block of town between the small woods and the big forest.
    if (cells.some(([c, r]) => inBigForest(c, r, 1) || inAirport(c, r, 1))) continue;
    if (cells.some(([c, r]) => DOWNTOWNS.some((d) => Math.abs(d.col - c) <= 1 && Math.abs(d.row - r) <= 1))) continue;
    // Nor on the river banks, where the works are.
    if (cells.some(([c]) => c >= RIVER_COLS[0] - 1 && c <= RIVER_COLS[1] + 1)) continue;
    for (const [c, r] of cells) forestBlocks.set(`${c},${r}`, zone);
    zone++;
  }
  const parks = new Set(['1,3', '3,4']);
  const grid = [];
  for (let row = 0; row < ys.length; row++) {
    for (let col = 0; col < xs.length; col++) {
      const [x0, x1] = xs[col];
      const [y0, y1] = ys[row];
      const key = `${col},${row}`;
      const near = DOWNTOWNS.reduce(
        (best, d) => Math.min(best, Math.max(Math.abs(d.col - col), Math.abs(d.row - row))),
        99,
      );
      const roll = rng.float();
      // Industry is on the sea front; the river banks are for business and shops.
      const waterfront = row >= lastRow - 3;
      const riverBank = col >= RIVER_COLS[0] && col <= RIVER_COLS[1] && row >= 1 && !waterfront;
      let kind;
      let zone;
      if (row === lastRow) kind = 'sea';
      else if (forestBlocks.has(key)) {
        kind = 'forest';
        zone = forestBlocks.get(key);
      } else if (parks.has(key)) kind = 'park';
      else if (inAirport(col, row)) kind = 'airport';
      else if ((col === 2 && row === 2) || (col === 8 && row === 6)) kind = 'station';
      else if (col === 9 && row === lastRow - 1) kind = 'dock';
      else if (near === 0) kind = roll < 0.03 ? 'park' : 'downtown';
      else if (near === 1 && !waterfront) kind = roll < 0.55 ? 'downtown' : 'market';
      else if (waterfront) kind = near === 1 ? 'downtown' : 'industry';
      else if (riverBank) kind = roll < 0.5 ? 'downtown' : 'market';
      else if (roll < 0.06) kind = 'park';
      else if (near === 2) kind = roll < 0.55 ? 'market' : 'houses';
      else if (near >= 4 && roll < 0.3) kind = 'industry'; // industrial parks out on the edge of town
      else kind = roll < 0.12 ? 'market' : 'houses';
      const woods = kind === 'forest' ? (isBigZone(zone) ? 'pine' : 'mixed') : undefined;
      // Housing west of the river is apartment blocks, east of it villas.
      const side = col <= RIVER_COLS[0] - 1 && col >= RIVER_COLS[0] - 5 ? 'west' : col >= RIVER_COLS[1] && col <= 17 ? 'east' : null;
      grid.push({ col, row, x0, y0, x1, y1, kind, zone, woods, waterfront, riverSide: side, style: Math.floor(tileHash(col, row, 31) * 3) });
    }
  }

  // Merge some neighbouring pairs into one big block.
  const cols = xs.length;
  const at = (c, r) => grid[r * cols + c];

  // Regional fire stations: the block nearest each target that is big enough.
  let baseCount = 0;
  for (const [tc, tr] of BASE_TARGETS) {
    let best = null;
    let bestD = Infinity;
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const c = tc + dc;
        const r = tr + dr;
        if (c < 0 || r < 0 || c >= cols || r >= ys.length) continue;
        const b = at(c, r);
        if (!['houses', 'market', 'downtown', 'industry'].includes(b.kind)) continue;
        if (b.x1 - b.x0 + 1 < 24 || b.y1 - b.y0 + 1 < 17) continue;
        if (c >= RIVER_COLS[0] - 1 && c <= RIVER_COLS[1] + 1) continue;
        const d = Math.hypot(dc, dr);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
    }
    if (best) {
      best.kind = 'base';
      best.baseIndex = baseCount++;
    }
  }
  const mergeable = (b) => ['houses', 'market', 'industry'].includes(b.kind)
    && !(b.col < 4 && b.row < 4) // the original quarter keeps its streets
    && !(b.col >= 6 && b.col <= 10 && b.row >= 4 && b.row <= 7) // round Station 2
    && !(b.row >= lastRow - 2 && b.col >= 7 && b.col <= 11) // round the dock
    && !(b.col >= RIVER_COLS[0] - 1 && b.col <= RIVER_COLS[1] + 1 && b.row >= 1) // the bridges
    && b.row < lastRow;
  const used = new Set();
  const removed = [];
  for (const b of grid) {
    if (!mergeable(b) || used.has(b) || !rng.chance(0.2)) continue;
    const east = b.col + 1 < cols ? at(b.col + 1, b.row) : null;
    const south = b.row + 1 < ys.length ? at(b.col, b.row + 1) : null;
    const options = [];
    if (east && east.kind === b.kind && mergeable(east) && !used.has(east)) options.push(['v', east]);
    if (south && south.kind === b.kind && mergeable(south) && !used.has(south)) options.push(['h', south]);
    if (!options.length) continue;
    const [axis, other] = rng.pick(options);
    used.add(b);
    used.add(other);
    if (axis === 'v') {
      removed.push({ x0: b.x1 + 1, y0: b.y0, x1: other.x0 - 1, y1: b.y1 });
      b.x1 = other.x1;
    } else {
      removed.push({ x0: b.x0, y0: b.y1 + 1, x1: b.x1, y1: other.y0 - 1 });
      b.y1 = other.y1;
    }
    b.merged = true;
    b.green = b.kind !== 'industry'; // a green or a square in the middle
    other.gone = true;
  }
  // The airports: one box of blocks each, merged into a single block.
  for (const box of AIRPORT_BOXES) {
    const first = at(box.col0, box.row0);
    const last = at(box.col1, box.row1);
    removed.push({ x0: first.x0, y0: first.y0, x1: last.x1, y1: last.y1 });
    for (let r = box.row0; r <= box.row1; r++) {
      for (let c = box.col0; c <= box.col1; c++) if (at(c, r) !== first) at(c, r).gone = true;
    }
    first.x1 = last.x1;
    first.y1 = last.y1;
    first.merged = true;
    first.airport = box;
  }
  return { blocks: grid.filter((b) => !b.gone), removed };
}

/**
 * Make sure every building can be reached, and nothing is a dead pocket.
 * Vehicles may drive on any open ground, so two things go wrong when buildings
 * stand shoulder to shoulder: a building can be walled in on every side, and the
 * free tile nearest a building can be an enclosed lane or yard that no street
 * joins. Here, a building with no way in loses its smallest neighbour (a gap
 * opens), and any ground left enclosed is fenced off as a walled yard.
 */
function ensureAccess({ w, h, road, apron, blocked, water, woods, buildings, seed }) {
  const open = (i) => road[i] || apron[i] || !(blocked[i] || water[i] || woods[i]);
  const main = new Uint8Array(w * h);
  const flood = () => {
    main.fill(0);
    const start = (APRON.y0 + 1) * w + APRON.x0 + 1;
    const queue = [start];
    main[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (main[ni] || !open(ni)) continue;
        main[ni] = 1;
        queue.push(ni);
      }
    }
  };
  const reachable = (b) => {
    for (let x = b.x - 1; x <= b.x + b.w; x++) {
      for (const y of [b.y - 1, b.y + b.h]) {
        if (x >= 0 && y >= 0 && x < w && y < h && main[y * w + x]) return true;
      }
    }
    for (let y = b.y; y < b.y + b.h; y++) {
      for (const x of [b.x - 1, b.x + b.w]) {
        if (x >= 0 && y >= 0 && x < w && y < h && main[y * w + x]) return true;
      }
    }
    return false;
  };
  const remove = (b) => {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) blocked[y * w + x] = 0;
    buildings.splice(buildings.indexOf(b), 1);
  };
  const mass = (b) => b.w * b.h * (0.7 + 0.15 * b.floors);
  const touching = (a, b) => a.x - 1 < b.x + b.w && b.x - 1 < a.x + a.w && a.y - 1 < b.y + b.h && b.y - 1 < a.y + a.h;

  flood();
  let removed = 0;
  for (const b of buildings.slice()) {
    if (b.type === 'station' || b.type === 'hospital' || reachable(b)) continue;
    // Open a gap: take away the smallest neighbour (never a station or hospital).
    for (let tries = 0; tries < 6 && !reachable(b); tries++) {
      const neighbours = buildings
        .filter((n) => n !== b && n.type !== 'station' && n.type !== 'hospital' && touching(b, n))
        .sort((p, q) => mass(p) - mass(q));
      if (neighbours.length === 0) break;
      remove(neighbours[0]);
      removed++;
      flood();
    }
    if (!reachable(b)) {
      remove(b);
      removed++;
      flood();
    }
  }
  // Enclosed ground nobody can drive into: fence it off as a walled yard.
  let fenced = 0;
  for (let i = 0; i < w * h; i++) {
    if (!main[i] && open(i) && !road[i] && !apron[i]) {
      blocked[i] = 1;
      fenced++;
    }
  }
  return { removed, fenced };
}

// How the buildings of a city should split by size.
export const SIZE_TARGET = { small: 0.5, medium: 0.3, large: 0.12, huge: 0.08 };

// The tallest each kind of building can be given (storeys).
const FLOOR_CAP = {
  house: 3, villa: 3, shop: 4, pharmacy: 3, apartment: 12, hotel: 14, office: 16, mall: 5,
  school: 4, warehouse: 3, factory: 5, tower: 28,
};

/**
 * Nudge the mix of sizes towards SIZE_TARGET: where a class has too few
 * buildings, the ones just below its threshold get an extra storey or two
 * (a taller block of flats, a three-storey shop, a bigger warehouse) until
 * they cross it. Nothing changes footprint, so the layout is untouched.
 */
function rebalanceSizes(buildings) {
  const list = buildings.filter((b) => b.type !== 'station' && b.type !== 'hospital');
  const N = list.length;
  const order = ['small', 'medium', 'large', 'huge'];
  const upper = Object.fromEntries(SIZE_CLASSES.map(([name, max]) => [name, max]));
  const count = (cls) => list.filter((b) => b.sizeClass === cls).length;
  const setFloors = (b, floors) => {
    b.occupants = Math.round(b.occupants * (floors / b.floors));
    b.floors = floors;
    b.elevation = 11 + floors * 5;
    b.sizeClass = sizeClassOf(buildingMass(b.w, b.h, floors));
  };
  // Promote from the class below until `to` has its share.
  for (const to of ['huge', 'large', 'medium']) {
    const from = order[order.indexOf(to) - 1];
    const want = Math.round(N * SIZE_TARGET[to]);
    const threshold = upper[from];
    const candidates = list
      .filter((b) => b.sizeClass === from && FLOOR_CAP[b.type])
      .map((b) => {
        let f = b.floors;
        while (f < FLOOR_CAP[b.type] && buildingMass(b.w, b.h, f) < threshold) f++;
        return { b, f, ok: buildingMass(b.w, b.h, f) >= threshold, extra: f - b.floors };
      })
      .filter((c) => c.ok && c.extra > 0)
      .sort((a, c) => a.extra - c.extra || buildingMass(c.b.w, c.b.h, c.b.floors) - buildingMass(a.b.w, a.b.h, a.b.floors));
    for (const c of candidates) {
      if (count(to) >= want) break;
      setFloors(c.b, c.f);
    }
  }
}

// Generating the city takes a couple of seconds. Under Node (the tests) every
// call after the first for a seed shares the first result's map arrays, trees
// and so on (nothing at run time writes to them) and gets its own copy of the
// buildings, the only part of the city a game changes. In the browser the city
// is made once per page and nothing is kept.
const cityCache = new Map();
export function createCity(seed = 7) {
  if (!globalThis.process?.versions?.node) return generateCity(seed);
  if (!cityCache.has(seed)) cityCache.set(seed, generateCity(seed));
  const c = cityCache.get(seed);
  // Everything that points at a building goes through one structuredClone so the
  // copies still point at each other.
  const mine = structuredClone({
    buildings: c.buildings,
    station: c.station,
    hospitals: c.hospitals,
    pharmacies: c.pharmacies,
    bases: c.stations.map((st) => st.building),
  });
  return {
    ...c,
    buildings: mine.buildings,
    station: mine.station,
    hospitals: mine.hospitals,
    pharmacies: mine.pharmacies,
    stations: c.stations.map((st, i) => ({ ...st, building: mine.bases[i] })),
  };
}

function generateCity(seed = 7) {
  const rng = new Rng(seed);
  const w = CITY_W;
  const h = CITY_H;
  const plan = buildBlocks(seed);
  const blocks = plan.blocks;
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

  // Streets taken out where two blocks were merged into one.
  for (const r of plan.removed) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) road[at(x, y)] = 0;
    }
  }

  // Curvy roads: winding streets through some housing and shopping blocks, from
  // one of the surrounding streets to another. They are bezier curves, stamped
  // into the road map two tiles wide, so they drive, route and park like any other
  // street; buildings are laid out round them.
  const curves = [];
  const crng = new Rng(seed * 977 + 31);
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  };
  for (const b of blocks) {
    if (b.kind !== 'houses' && b.kind !== 'market') continue;
    if (b.merged || (b.col < 4 && b.row < 4)) continue;
    if (b.col >= 6 && b.col <= 10 && b.row >= 4 && b.row <= 7) continue; // Station 2
    if (b.col >= RIVER_COLS[0] - 1 && b.col <= RIVER_COLS[1] + 1) continue; // the river
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    if (bw < 16 || bh < 16 || !crng.chance(0.4)) continue;
    // The centre lines of the four streets round the block.
    const north = b.y0 - 1;
    const south = b.y1 + 2;
    const west = b.x0 - 1;
    const east = b.x1 + 2;
    const alongX = () => b.x0 + bw * crng.range(0.25, 0.75);
    const alongY = () => b.y0 + bh * crng.range(0.25, 0.75);
    const shape = crng.pick(['ns', 'ns', 'ew', 'ew', 'arc']);
    let p0;
    let p1;
    let p2;
    let p3;
    if (shape === 'ns') {
      const swing = bw * crng.range(0.35, 0.55) * (crng.chance(0.5) ? 1 : -1);
      const ax = alongX();
      const bx = alongX();
      p0 = { x: ax, y: north };
      p3 = { x: bx, y: south };
      p1 = { x: ax + swing, y: b.y0 + bh * 0.3 };
      p2 = { x: bx - swing, y: b.y0 + bh * 0.7 };
    } else if (shape === 'ew') {
      const swing = bh * crng.range(0.35, 0.55) * (crng.chance(0.5) ? 1 : -1);
      const ay = alongY();
      const by = alongY();
      p0 = { x: west, y: ay };
      p3 = { x: east, y: by };
      p1 = { x: b.x0 + bw * 0.3, y: ay + swing };
      p2 = { x: b.x0 + bw * 0.7, y: by - swing };
    } else {
      // A bend from one street round into the next one.
      const top = crng.chance(0.5);
      const left = crng.chance(0.5);
      const ax = alongX();
      const ay = alongY();
      p0 = { x: ax, y: top ? north : south };
      p3 = { x: left ? west : east, y: ay };
      p1 = { x: ax, y: top ? b.y0 + bh * 0.5 : b.y1 - bh * 0.5 };
      p2 = { x: left ? b.x0 + bw * 0.5 : b.x1 - bw * 0.5, y: ay };
    }
    const pts = [];
    let last = null;
    for (let i = 0; i <= 600; i++) {
      const p = bez(p0, p1, p2, p3, i / 600);
      for (let ty = Math.floor(p.y - 1.1); ty <= Math.floor(p.y + 1.1); ty++) {
        for (let tx = Math.floor(p.x - 1.1); tx <= Math.floor(p.x + 1.1); tx++) {
          if (!inb(tx, ty) || apron[at(tx, ty)]) continue;
          if (Math.hypot(tx + 0.5 - p.x, ty + 0.5 - p.y) <= 1.02) road[at(tx, ty)] = 1;
        }
      }
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 1.5 || i === 600) {
        pts.push({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
        last = p;
      }
    }
    curves.push({ block: `${b.col},${b.row}`, width: 2, pts });
  }

  // Water: the sea to the south and the river. Streets stop at the quay, and a
  // street that crosses the river carries on over it as a bridge.
  const water = new Uint8Array(w * h);
  const bridge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sea = y >= SEA_Y;
      const river = !sea && Math.abs(x + 0.5 - riverCentre(y)) <= RIVER_HALF_WIDTH;
      if (sea || river) water[at(x, y)] = 1;
      if (sea) road[at(x, y)] = 0;
      else if (river && road[at(x, y)]) bridge[at(x, y)] = 1;
    }
  }
  const roadIn = (x, y, wid, hei) => {
    for (let ty = y; ty < y + hei; ty++) {
      for (let tx = x; tx < x + wid; tx++) if (inb(tx, ty) && road[at(tx, ty)]) return true;
    }
    return false;
  };
  const waterIn = (x, y, wid, hei) => {
    for (let ty = y - 1; ty <= y + hei; ty++) {
      for (let tx = x - 1; tx <= x + wid; tx++) if (inb(tx, ty) && water[at(tx, ty)]) return true;
    }
    return false;
  };

  const buildings = [];
  const parks = [];
  const trees = [];
  const hydrants = [];
  const forestAreas = [];
  const forestTiles = [];
  const forest = new Uint8Array(w * h);
  // Every tile of a forest block, its edge ring included: no parked cars or
  // street trees there, and the renderer draws the roads through it as country roads.
  const woods = new Uint8Array(w * h);
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
      zone: extra.zone ?? 'civic',
      waterfront: false,
      sizeClass: sizeClassOf(buildingMass(wid, hei, floors)),
      hazmat: type === 'tankfarm' || (type === 'factory' && rng.chance(0.5)),
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
  // The base hospital, right beside the apron: ambulances unload here and return
  // here when a job is done.
  const hospital1 = addBuilding(63, 51, 7, 8, 'hospital', { name: 'Base Hospital', floors: 3 });
  hospital1.base = 0;
  for (let ty = APRON.y0; ty <= APRON.y1; ty++) {
    for (let tx = APRON.x0; tx <= APRON.x1; tx++) apron[at(tx, ty)] = 1;
  }

  // A parking apron beside the station, and a few trees around the block, so
  // the station does not sit in the middle of an empty concrete square.
  const stationLot = { x0: 63, y0: 44, x1: 69, y1: 49 };
  for (const [tx, ty] of [[49, 40], [60, 40], [70, 39], [47, 52], [68, 57], [70, 46]]) {
    if (inb(tx, ty) && !blocked[at(tx, ty)] && !road[at(tx, ty)] && !apron[at(tx, ty)]) {
      trees.push({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, r: rng.range(11, 15), tone: rng.pick(['#46683a', '#4f7339', '#3d5e32']) });
    }
  }

  // Park trees grow in groves with open lawn between them, plus a few
  // specimen trees standing on their own.
  function scatterTrees(x0, y0, x1, y1) {
    const count = treeCount(x1 - x0 + 1, y1 - y0 + 1);
    const groves = Array.from({ length: Math.max(1, Math.round(count / 8)) }, () => [
      rng.range(x0 + 1, x1),
      rng.range(y0 + 1, y1),
    ]);
    for (let i = 0; i < count; i++) {
      let wx;
      let wy;
      if (i % 5 === 4) {
        wx = rng.range(x0, x1 + 1);
        wy = rng.range(y0, y1 + 1);
      } else {
        const [gx, gy] = groves[i % groves.length];
        const a = rng.range(0, Math.PI * 2);
        const d = rng.range(0, 2.8);
        wx = clamp(gx + Math.cos(a) * d, x0, x1 + 0.99);
        wy = clamp(gy + Math.sin(a) * d, y0, y1 + 0.99);
      }
      const tx = Math.floor(wx);
      const ty = Math.floor(wy);
      if (!inb(tx, ty)) continue;
      if (road[at(tx, ty)] || blocked[at(tx, ty)] || water[at(tx, ty)]) continue;
      trees.push({
        x: wx * TILE,
        y: wy * TILE,
        r: rng.range(14, 24),
        ...species(Math.floor(wx * 5), Math.floor(wy * 5), 0.12, 0.15),
      });
    }
  }

  // --- the airports ----------------------------------------------------------
  // A runway along the top, a taxiway and an apron below it, the terminal, the
  // hangars, the control tower and a fuel farm in a row, and a fire station of
  // its own in the corner. Paved ground counts as road (cheap to drive, no
  // trees); the renderer draws it from `airfields`.
  const airfields = [];
  const baseRequests = [];
  const pave = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (inb(x, y) && !blocked[at(x, y)] && !water[at(x, y)]) road[at(x, y)] = 1;
    }
  };
  function buildAirport(block) {
    const box = block.airport;
    const { x0: bx0, y0: by0, x1: bx1, y1: by1 } = block;
    const W = bx1 - bx0 + 1;
    const H = by1 - by0 + 1;
    if (W < 60 || H < 52) return;
    const ry0 = by0 + 6;
    const runway = { x0: bx0 + 8, y0: ry0, x1: bx1 - 8, y1: ry0 + 3 };
    const ty0 = ry0 + 8;
    const taxi = { x0: bx0 + 14, y0: ty0, x1: bx1 - 14, y1: ty0 + 1 };
    const connectors = [bx0 + 14, Math.floor((bx0 + bx1) / 2), bx1 - 15].map((x) => ({ x0: x, y0: ry0 + 4, x1: x + 1, y1: ty0 - 1 }));
    const buildY = ty0 + 9;
    const apronRect = { x0: bx0 + 24, y0: ty0 + 2, x1: bx1 - 24, y1: buildY - 1 };
    const forecourt = { x0: bx0 + 24, y0: buildY + 12, x1: bx1 - 24, y1: buildY + 13 };
    // The row of buildings, west to east.
    const tower = addBuilding(bx0 + 26, buildY + 2, 6, 6, 'tower', { name: `${box.short} Control Tower`, floors: 7, zone: 'civic' });
    const termX = bx0 + 36;
    const terminal = addBuilding(termX, buildY, 30, 10, 'terminal', { name: `${box.short} Terminal`, floors: 3, zone: 'civic' });
    let x = termX + 30 + 3;
    const hangars = [];
    for (let k = 0; k < 3 && x + 18 <= bx1 - 6; k++) {
      hangars.push(addBuilding(x, buildY, 18, 10, 'hangar', { name: `${box.short} Hangar ${k + 1}`, floors: 1, zone: 'industrial' }));
      x += 21;
    }
    let farm = null;
    if (x + 16 <= bx1 - 6) farm = addBuilding(x, buildY, 16, 10, 'tankfarm', { name: `${box.short} Fuel Farm`, floors: 1, zone: 'industrial' });
    pave(runway.x0, runway.y0, runway.x1, runway.y1);
    pave(taxi.x0, taxi.y0, taxi.x1, taxi.y1);
    for (const c of connectors) pave(c.x0, c.y0, c.x1, c.y1);
    pave(apronRect.x0, apronRect.y0, apronRect.x1, apronRect.y1);
    pave(forecourt.x0, forecourt.y0, forecourt.x1, forecourt.y1);
    // The way in: from the forecourt down to the street below the airport.
    const gate = { x0: termX + 13, y0: forecourt.y1 + 1, x1: termX + 14, y1: by1 + 1 };
    pave(gate.x0, gate.y0, gate.x1, gate.y1);
    // And a service road through the gap between the control tower and the
    // terminal, so the airside and the landside are one piece of road.
    const service = { x0: bx0 + 32, y0: buildY, x1: bx0 + 33, y1: forecourt.y0 };
    pave(service.x0, service.y0, service.x1, service.y1);
    // A fire station of its own, bottom left.
    baseRequests.push({ kind: 'airport', name: `${box.short} Airport Fire Station`, hospital: `${box.short} Airport Medical Centre`, apronX0: bx0 + 3, apronY1: by1 });
    airfields.push({
      name: box.name, x0: bx0, y0: by0, x1: bx1, y1: by1,
      runway, taxi, connectors, apron: apronRect, forecourt, gate, service,
      terminal: terminal.id, tower: tower.id, hangars: hangars.map((hg) => hg.id), farm: farm?.id ?? null,
    });
  }

  function fillBlock(block) {
    const { x0, y0, x1, y1, kind } = block;
    if (kind === 'forest') {
      const pine = block.woods === 'pine' ? 0.8 : 0.35;
      forestAreas.push({ x0, y0, x1, y1, woods: block.woods });
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) woods[at(x, y)] = block.woods === 'pine' ? 2 : 1;
      }
      for (let y = y0 + 1; y <= y1 - 1; y++) {
        for (let x = x0 + 1; x <= x1 - 1; x++) {
          if (road[at(x, y)] || blocked[at(x, y)] || water[at(x, y)]) continue;
          forest[at(x, y)] = 1;
          forestTiles.push({ x, y });
          if (rng.chance(0.16)) {
            trees.push({
              x: (x + 0.5 + rng.range(-0.3, 0.3)) * TILE,
              y: (y + 0.5 + rng.range(-0.3, 0.3)) * TILE,
              r: rng.range(14, 22),
              ...species(x, y, pine),
            });
          }
        }
      }
      // A ragged edge: big trees along the block's rim, leaning out over the
      // verge, so the forest does not end in a ruled line.
      const rim = (x, y, nx, ny) => {
        if (tileHash(x, y, 11) > 0.62) return;
        trees.push({
          x: (x + 0.5 + nx * (0.15 + tileHash(x, y, 12) * 0.35)) * TILE,
          y: (y + 0.5 + ny * (0.15 + tileHash(x, y, 13) * 0.35)) * TILE,
          r: 13 + tileHash(x, y, 14) * 9,
          ...species(x, y, pine),
        });
      };
      for (let x = x0; x <= x1; x++) {
        rim(x, y0, 0, -1);
        rim(x, y1, 0, 1);
      }
      for (let y = y0 + 1; y < y1; y++) {
        rim(x0, y, -1, 0);
        rim(x1, y, 1, 0);
      }
      return;
    }
    if (kind === 'park') {
      parks.push({ x0, y0, x1, y1 });
      scatterTrees(x0, y0, x1, y1);
      return;
    }
    if (kind === 'station' || kind === 'dock' || kind === 'sea' || kind === 'base') return;
    if (kind === 'airport') {
      buildAirport(block);
      return;
    }

    const zone = ZONE_OF[kind];
    const variant = kind === 'houses'
      ? (block.riverSide === 'east' ? 'villa' : block.riverSide === 'west' ? 'flats' : block.col <= 17 && block.row <= 14 ? (block.style === 2 ? 'flats' : 'suburb') : ['suburb', 'flats', block.col >= RIVER_COLS[1] ? 'villa' : 'flats'][block.style])
      : kind;
    const p = LOT_PARAMS[variant];
    // The pavement round the block: a different width on each side.
    const side = () => rng.int(p.setback[0], p.setback[1]);
    const ax0 = x0 + side();
    const ax1 = x1 - side();
    const ay0 = y0 + side();
    const ay1 = y1 - side();
    if (ax1 - ax0 + 1 < 3 || ay1 - ay0 + 1 < 3) {
      parks.push({ x0, y0, x1, y1 });
      scatterTrees(x0, y0, x1, y1);
      return;
    }

    const lots = [];
    subdivide(rng, ax0, ay0, ax1, ay1, p, lots);
    // A merged block keeps its biggest lot as a green or a square.
    let green = null;
    if (block.green) green = lots.reduce((best, l) => ((l.x1 - l.x0 + 1) * (l.y1 - l.y0 + 1) > (best ? (best.x1 - best.x0 + 1) * (best.y1 - best.y0 + 1) : 0) ? l : best), null);

    // A quarter of the homes and shops have a pharmacy.
    let wantsPharmacy = kind !== 'industry' && (block.col * 2 + block.row) % 4 === 0;

    for (const lot of lots) {
      const lw = lot.x1 - lot.x0 + 1;
      const lh = lot.y1 - lot.y0 + 1;
      if (lot === green || (lw >= 5 && lh >= 5 && kind !== 'industry' && rng.chance(kind === 'downtown' ? 0.1 : 0.05))) {
        parks.push({ x0: lot.x0, y0: lot.y0, x1: lot.x1, y1: lot.y1 });
        scatterTrees(lot.x0, lot.y0, lot.x1, lot.y1);
        continue;
      }
      // Which buildings fit this lot.
      let options = KIND_TYPES[variant].filter(([type]) => {
        const r = TYPE_RULES[type];
        // Fuel is stored on the quay itself, within reach of the water.
        if (type === 'tankfarm' && (!block.waterfront || lot.y1 + 1 < SEA_Y - 7)) return false;
        return lw >= r.minW && lh >= r.minH;
      });
      if (wantsPharmacy && lw >= TYPE_RULES.pharmacy.minW && lh >= TYPE_RULES.pharmacy.minH) options = [['pharmacy', 1]];
      if (options.length === 0 || rng.chance(p.empty)) {
        // An empty lot: a garden, a yard, a bit of waste ground.
        if (lw >= 3 && lh >= 3 && rng.chance(0.5)) scatterTrees(lot.x0, lot.y0, lot.x1, lot.y1);
        continue;
      }
      // Big lots favour the big building types.
      const big = lw * lh;
      options = options.map(([type, weight]) => {
        const r = TYPE_RULES[type];
        const fit = Math.min(1, (Math.min(lw, r.maxW) * Math.min(lh, r.maxH)) / Math.max(12, big));
        // The quay is where the fuel is kept: the few lots that reach it favour tank farms.
        return [type, weight * (0.3 + fit) * (type === 'tankfarm' ? 4 : 1)];
      });
      const type = weightedPick(rng, options);
      if (type === 'pharmacy') wantsPharmacy = false;
      const r = TYPE_RULES[type];
      let bwid = Math.min(lw, r.maxW);
      let bhei = Math.min(lh, r.maxH);
      // The very big types keep (nearly) the whole lot; the small ones vary.
      const shrink = ['warehouse', 'factory', 'tankfarm', 'mall', 'tower'].includes(type) ? 0.1 : 0.35;
      if (bwid > r.minW && rng.chance(shrink)) bwid -= rng.int(1, Math.min(2, bwid - r.minW));
      if (bhei > r.minH && rng.chance(shrink)) bhei -= rng.int(1, Math.min(2, bhei - r.minH));
      // Shops and offices front the street; homes sit back in their lots.
      const flush = rng.chance(p.flush);
      const bx = lot.x0 + (flush ? 0 : rng.int(0, lw - bwid));
      const by = type === 'tankfarm' ? lot.y1 + 1 - bhei : lot.y0 + (flush ? 0 : rng.int(0, lh - bhei));
      if (waterIn(bx, by, bwid, bhei) || roadIn(bx, by, bwid, bhei)) continue;
      const area = bwid * bhei;
      let floors;
      if ((type === 'office' || type === 'hotel') && area >= 70) floors = rng.int(SPEC[type].floors[1] - 1, SPEC[type].floors[1] + 2);
      else if (type === 'tower') floors = rng.int(SPEC.tower.floors[0] + 2 + Math.floor(area / 12), SPEC.tower.floors[1] + 2);
      else if (type === 'apartment' && area >= 40) floors = rng.int(3, 6);
      addBuilding(bx, by, bwid, bhei, type, { zone, floors });
    }
  }

  for (const block of blocks) fillBlock(block);

  // --- no streets in the woods --------------------------------------------
  // A road with forest on both sides is not a street: the trees grow over it.
  // Those tiles become forest, so the only way in by vehicle is a track a crew
  // cuts with a chainsaw. What is left of each avenue and street is kept as
  // runs, for the traffic and the renderer.
  const wooded = (x, y) => inb(x, y) && woods[at(x, y)] !== 0;
  const cleared = [];
  const clearRun = (x0, y0, x1, y1, type) => {
    forestAreas.push({ x0, y0, x1, y1, woods: type === 2 ? 'pine' : 'mixed', cleared: true });
  };
  for (const vx of V_ROADS) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      let inside = false;
      if (y < h && road[at(vx, y)]) {
        const hy = H_ROADS.find((r) => y >= r && y <= r + 1);
        inside = hy != null
          ? wooded(vx - 1, hy - 1) && wooded(vx + 2, hy - 1) && wooded(vx - 1, hy + 2) && wooded(vx + 2, hy + 2)
          : wooded(vx - 1, y) && wooded(vx + 2, y);
      }
      if (inside) {
        if (start < 0) start = y;
        cleared.push([vx, y, woods[at(vx - 1, y)] || woods[at(vx - 1, y - 2)]], [vx + 1, y, woods[at(vx + 2, y)] || woods[at(vx + 2, y - 2)]]);
      } else if (start >= 0) {
        clearRun(vx, start, vx + 1, y - 1, woods[at(vx - 1, start)] || woods[at(vx - 1, start - 2)]);
        start = -1;
      }
    }
  }
  for (const hy of H_ROADS) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const junction = V_ROADS.some((vx) => x >= vx && x <= vx + 1);
      const inside = x < w && !junction && road[at(x, hy)] && wooded(x, hy - 1) && wooded(x, hy + 2);
      if (inside) {
        if (start < 0) start = x;
        cleared.push([x, hy, woods[at(x, hy - 1)]], [x, hy + 1, woods[at(x, hy + 2)]]);
      } else if (start >= 0) {
        clearRun(start, hy, x - 1, hy + 1, woods[at(start, hy - 1)]);
        start = -1;
      }
    }
  }
  for (const [x, y, type] of cleared) {
    const i = at(x, y);
    road[i] = 0;
    bridge[i] = 0;
    woods[i] = type || 1;
  }
  // The cleared strips, and a forest block's rim wherever it no longer meets a
  // street, are forest like the rest.
  for (const [x, y] of cleared) {
    const i = at(x, y);
    if (forest[i] || water[i] || blocked[i]) continue;
    forest[i] = 1;
    forestTiles.push({ x, y });
    if (tileHash(x, y, 21) < 0.16) {
      trees.push({
        x: (x + 0.2 + tileHash(x, y, 22) * 0.6) * TILE,
        y: (y + 0.2 + tileHash(x, y, 23) * 0.6) * TILE,
        r: 14 + tileHash(x, y, 24) * 8,
        ...species(x, y, woods[i] === 2 ? 0.8 : 0.35),
      });
    }
  }
  for (const block of blocks) {
    if (block.kind !== 'forest') continue;
    for (let y = block.y0; y <= block.y1; y++) {
      for (let x = block.x0; x <= block.x1; x++) {
        const i = at(x, y);
        if (forest[i] || water[i] || blocked[i]) continue;
        let byRoad = false;
        for (let dy = -1; dy <= 1 && !byRoad; dy++) {
          for (let dx = -1; dx <= 1; dx++) if (inb(x + dx, y + dy) && road[at(x + dx, y + dy)]) byRoad = true;
        }
        if (byRoad) continue;
        forest[i] = 1;
        forestTiles.push({ x, y });
      }
    }
  }

  const spans = (n, test) => {
    const out = [];
    let start = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && test(i)) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        out.push([start, i - 1]);
        start = -1;
      }
    }
    return out;
  };
  const roadRuns = {
    v: V_ROADS.map((vx) => ({ line: vx, spans: spans(h, (y) => road[at(vx, y)] && road[at(vx + 1, y)]) })),
    h: H_ROADS.map((hy) => ({ line: hy, spans: spans(w, (x) => road[at(x, hy)] && road[at(x, hy + 1)]) })),
  };

  // --- Station 2: the same layout as Station 1, in the Civic Quarter. It is
  // for sale; its apron and bays only count once it has been bought. ----------
  const b2 = blocks.find((b) => b.col === 8 && b.row === 6);
  const station2 = addBuilding(b2.x0 + 6, b2.y0 + 6, STATION.w, STATION.h, 'station', {
    id: 'station2',
    name: 'Station 2',
    floors: 2,
  });
  const hospital2 = addBuilding(b2.x0 + 19, b2.y0 + 13, 7, 8, 'hospital', { name: 'Civic Base Hospital', floors: 3 });
  hospital2.base = 1;
  const apron2 = {
    x0: APRON.x0 - 44 + b2.x0,
    y0: APRON.y0 - 38 + b2.y0,
    x1: APRON.x1 - 44 + b2.x0,
    y1: APRON.y1 - 38 + b2.y0,
  };
  for (let ty = apron2.y0; ty <= apron2.y1; ty++) {
    for (let tx = apron2.x0; tx <= apron2.x1; tx++) apron[at(tx, ty)] = 1;
  }
  for (const [tx, ty] of [[b2.x0 + 5, b2.y0 + 2], [b2.x0 + 16, b2.y0 + 2], [b2.x0 + 2, b2.y0 + 10]]) {
    if (inb(tx, ty) && !blocked[at(tx, ty)] && !road[at(tx, ty)] && !apron[at(tx, ty)]) {
      trees.push({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, r: rng.range(11, 15), tone: '#46683a' });
    }
  }

  // --- parks mask --------------------------------------------------------
  const park = new Uint8Array(w * h);
  for (const p of parks) {
    for (let y = p.y0; y <= p.y1; y++) {
      for (let x = p.x0; x <= p.x1; x++) park[at(x, y)] = 1;
    }
  }

  // --- hydrants ----------------------------------------------------------
  const isHydrantSpot = (x, y) => {
    if (!inb(x, y) || blocked[at(x, y)] || road[at(x, y)] || apron[at(x, y)] || water[at(x, y)]) return false;
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
      if (road[i] || blocked[i] || apron[i] || park[i] || water[i] || woods[i]) continue;
      if (hydrantAt.has(`${tx},${ty}`)) continue;
      const kerb =
        road[at(tx + 1, ty)] || road[at(tx - 1, ty)] ||
        road[at(tx, ty + 1)] || road[at(tx, ty - 1)];
      if (!kerb || !rng.chance(0.05)) continue;
      trees.push({
        x: (tx + 0.5) * TILE,
        y: (ty + 0.5) * TILE,
        r: rng.range(10, 14),
        tone: rng.pick(['#46683a', '#4f7339', '#3d5e32']),
      });
    }
  }

  // --- parked cars -------------------------------------------------------
  const cars = [];
  const CAR_COLORS = ['#c3c6c9', '#34404f', '#6e2b27', '#d8d4c8', '#3f4a43', '#8c7440', '#55595e'];
  const nearCrossStreet = (y) => H_ROADS.some((hy) => Math.abs(y - hy) < 2);
  const nearCrossAvenue = (x) => V_ROADS.some((vx) => Math.abs(x - vx) < 2);

  const tryCar = (tx, ty, x, y, angle) => {
    if (cars.length >= 6000) return;
    if (!inb(tx, ty) || blocked[at(tx, ty)] || road[at(tx, ty)] || apron[at(tx, ty)] || park[at(tx, ty)] || water[at(tx, ty)] || woods[at(tx, ty)]) return;
    cars.push({ x, y, angle: rng.chance(0.5) ? angle : angle + Math.PI, color: rng.pick(CAR_COLORS) });
  };

  for (const vx of V_ROADS) {
    for (let y = 2; y < h - 2; y += 3) {
      if (nearCrossStreet(y) || !road[at(vx, y)] || !rng.chance(0.3)) continue;
      for (const side of [-0.42, 2.42]) {
        if (!rng.chance(0.5)) continue;
        tryCar(Math.floor(vx + side), y, (vx + side) * TILE, (y + 0.5) * TILE, -Math.PI / 2);
      }
    }
  }
  for (const hy of H_ROADS) {
    for (let x = 2; x < w - 2; x += 3) {
      if (nearCrossAvenue(x) || !road[at(x, hy)] || !rng.chance(0.24)) continue;
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

  // --- the harbour dock: a base on the quay with berths on the water -----------
  const bd = blocks.find((b) => b.kind === 'dock');
  const dockBuilding = addBuilding(bd.x0 + 12, bd.y0 + 6, 8, 5, 'station', {
    id: 'dock',
    name: 'Harbour Dock',
    floors: 2,
  });
  const apronD = { x0: bd.x0 + 2, y0: bd.y1 - 5, x1: bd.x0 + 25, y1: bd.y1 };
  for (let ty = apronD.y0; ty <= apronD.y1; ty++) {
    for (let tx = apronD.x0; tx <= apronD.x1; tx++) apron[at(tx, ty)] = 1;
  }
  // Eight berths in a row on the water, two tiles beyond the quay road.
  const berths = Array.from({ length: 8 }, (_, i) => ({
    x: (bd.x0 + 3.6 + i * 3) * TILE,
    y: (SEA_Y + 2.5) * TILE,
    station: 2,
    sea: true,
  }));

  // --- the regional fire stations and the airports' own ---------------------
  // The same layout as Station 1, bottom-aligned in its block so the apron meets
  // the street. Each has a base hospital beside it. They are for sale.
  const regional = [];
  const baseBlocks = blocks.filter((b) => b.kind === 'base').sort((a, c) => a.baseIndex - c.baseIndex);
  const districtOf = (col, row) => {
    let best = DOWNTOWNS[0];
    let bestD = Infinity;
    for (const d of DOWNTOWNS) {
      const dd = Math.hypot(d.col - col, d.row - row);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    return best.name.toLowerCase().split(' ').map((wd) => wd[0].toUpperCase() + wd.slice(1)).join(' ');
  };
  const requests = [
    ...baseBlocks.map((b) => ({ kind: 'region', apronX0: b.x0 + 1, apronY1: b.y1, district: districtOf(b.col, b.row) })),
    ...baseRequests,
  ];
  requests.forEach((rq, n) => {
    const index = 3 + n;
    const ox = rq.apronX0 - APRON.x0;
    const oy = rq.apronY1 - APRON.y1;
    const name = rq.name ?? `Station ${index} · ${rq.district}`;
    const baseStation = addBuilding(STATION.x + ox, STATION.y + oy, STATION.w, STATION.h, 'station', { id: `base${index}`, name, floors: 2 });
    baseStation.stationIndex = index;
    const baseHospital = addBuilding(63 + ox, 51 + oy, 7, 8, 'hospital', { name: rq.hospital ?? `${rq.district} Base Hospital`, floors: 3 });
    baseHospital.base = index;
    const apronR = { x0: APRON.x0 + ox, y0: APRON.y0 + oy, x1: APRON.x1 + ox, y1: APRON.y1 + oy };
    for (let ty = apronR.y0; ty <= apronR.y1; ty++) {
      for (let tx = apronR.x0; tx <= apronR.x1; tx++) {
        if (!inb(tx, ty)) continue;
        apron[at(tx, ty)] = 1;
        road[at(tx, ty)] = 0;
      }
    }
    const shift = (b, extra) => ({ x: (b.x + ox) * TILE, y: (b.y + oy) * TILE, station: index, ...(extra ? { extra: true } : {}) });
    regional.push({
      id: `base${index}`, name, kind: rq.kind, building: baseStation, apron: apronR, hospital: baseHospital,
      bays: [...BAYS.map((b) => shift(b, false)), ...EXTRA_BAYS.map((b) => shift(b, true))],
    });
  });
  station.stationIndex = 0;
  station2.stationIndex = 1;
  dockBuilding.stationIndex = 2;

  // Map labels: one per commercial centre, forest, and the harbour belts.
  const blockCentre = (col, row) => {
    const b = blocks.find((x) => x.col === col && x.row === row);
    return { x: ((b.x0 + b.x1 + 1) / 2) * TILE, y: ((b.y0 + b.y1 + 1) / 2) * TILE };
  };
  const districts = DOWNTOWNS.map((d) => ({ name: d.name, ...blockCentre(d.col, d.row) }));
  const forestZones = new Map();
  for (const b of blocks) {
    if (b.kind !== 'forest') continue;
    const zone = forestZones.get(b.zone) ?? { name: FOREST_NAMES[b.zone] ?? 'FOREST', xs: [], ys: [] };
    zone.xs.push((b.x0 + b.x1 + 1) / 2);
    zone.ys.push((b.y0 + b.y1 + 1) / 2);
    forestZones.set(b.zone, zone);
  }
  for (const zone of forestZones.values()) {
    const avg = (list) => list.reduce((s, v) => s + v, 0) / list.length;
    districts.push({ name: zone.name, x: avg(zone.xs) * TILE, y: avg(zone.ys) * TILE });
  }
  districts.push({ name: 'HARBOR BAY', x: (w / 2) * TILE, y: (SEA_Y + 20) * TILE });
  districts.push({ name: 'RIVER', x: riverCentre(120) * TILE, y: 120 * TILE });
  districts.push({ name: 'RIVER MOUTH', x: riverCentre(320) * TILE, y: 320 * TILE });

  // Buildings by the sea or the river: the waterfront, where dock accidents and
  // fuel fires happen.
  for (const b of buildings) {
    let near = false;
    for (let ty = b.y - 8; ty <= b.y + b.h + 8 && !near; ty++) {
      for (let tx = b.x - 8; tx <= b.x + b.w + 8; tx++) {
        if (inb(tx, ty) && water[at(tx, ty)]) {
          near = true;
          break;
        }
      }
    }
    b.waterfront = near;
  }

  // Map labels for the housing districts and the industrial areas: one per
  // cluster of blocks of that kind.
  const cluster = (list, size, names, firstName = 0) => {
    const groups = new Map();
    for (const b of list) {
      const key = `${Math.floor(b.col / size)},${Math.floor(b.row / size)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    let n = firstName;
    for (const group of [...groups.values()].sort((a, b) => b.length - a.length)) {
      if (group.length < 3 || n >= names.length) continue;
      const avg = (f) => group.reduce((sum, g) => sum + f(g), 0) / group.length;
      districts.push({
        name: names[n++],
        x: avg((g) => (g.x0 + g.x1 + 1) / 2) * TILE,
        y: avg((g) => (g.y0 + g.y1 + 1) / 2) * TILE,
      });
    }
  };
  cluster(blocks.filter((b) => b.kind === 'houses'), 3, HOUSING_NAMES);
  cluster(blocks.filter((b) => b.kind === 'industry'), 3, INDUSTRY_NAMES);

  ensureAccess({ w, h, road, apron, blocked, water, woods, buildings });
  rebalanceSizes(buildings);

  const bays1 = BAYS.map((b) => ({ x: b.x * TILE, y: b.y * TILE, station: 0 }));
  const bays2 = BAYS.map((b) => ({
    x: (b.x - APRON.x0 + apron2.x0) * TILE,
    y: (b.y - APRON.y0 + apron2.y0) * TILE,
    station: 1,
  }));
  const extra1 = EXTRA_BAYS.map((b) => ({ x: b.x * TILE, y: b.y * TILE, station: 0, extra: true }));
  const extra2 = EXTRA_BAYS.map((b) => ({
    x: (b.x - APRON.x0 + apron2.x0) * TILE,
    y: (b.y - APRON.y0 + apron2.y0) * TILE,
    station: 1,
    extra: true,
  }));
  // A second row of berths, a boat's length further out on the water.
  const extraBerths = berths.map((b) => ({ ...b, y: (SEA_Y + 5.8) * TILE, extra: true }));
  const stations = [
    { id: 'station', name: 'Station 1', building: station, apron: { ...APRON }, bays: [...bays1, ...extra1] },
    { id: 'station2', name: 'Station 2', building: station2, apron: apron2, bays: [...bays2, ...extra2] },
    { id: 'dock', name: 'Harbour Dock', building: dockBuilding, apron: apronD, bays: [...berths, ...extraBerths], sea: true },
    ...regional.map((r) => ({ id: r.id, name: r.name, kind: r.kind, building: r.building, apron: r.apron, bays: r.bays })),
  ];

  return {
    name: CITY_NAME,
    w,
    h,
    road,
    roadRuns,
    apron,
    blocked,
    park,
    forest,
    woods,
    water,
    bridge,
    forestAreas,
    forestTiles,
    buildings,
    station,
    hydrants,
    trees,
    parks,
    cars,
    lot: stationLot,
    // Every bay of every station. The original twenty-four keep their numbers
    // (Station 1, Station 2, the dock); the extra bays follow in the same order.
    bays: [...bays1, ...bays2, ...berths, ...extra1, ...extra2, ...extraBerths, ...regional.flatMap((r) => r.bays)],
    stations,
    districts,
    curves,
    pharmacies: buildings.filter((b) => b.type === 'pharmacy'),
    blocks: blocks.map((b) => ({ col: b.col, row: b.row, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, kind: b.kind, zone: ZONE_OF[b.kind] ?? null, merged: Boolean(b.merged) })),
    hospitals: [hospital1, hospital2, ...regional.map((r) => r.hospital)],
    airfields,
    spawn: { x: BAYS[0].x * TILE, y: BAYS[0].y * TILE, angle: Math.PI / 2 },
    startHour: START_HOUR,
  };
}
