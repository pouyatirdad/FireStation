// Ground and roof materials, generated once per name as repeating tiles and
// handed to the renderer as canvas patterns. Each one is built pixel by pixel
// from layered noise (large blotches, mid-scale wear, fine grain), the way a
// surface looks in an aerial photograph, instead of a flat colour. Under Node
// (tests) there is no canvas, and the plain base colour is returned.

const SIZE = 512;

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Smooth value noise on a lattice of `cells` × `cells` that wraps at the edge,
// so the tile repeats without a seam.
function valueNoise(cells, seed) {
  const rnd = lcg(seed);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const out = new Float32Array(SIZE * SIZE);
  const step = cells / SIZE;
  for (let y = 0; y < SIZE; y++) {
    const fy = y * step;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cells) * cells;
    const r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < SIZE; x++) {
      const fx = x * step;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cells;
      const c1 = (x0 + 1) % cells;
      const top = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * sx;
      const bot = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * sx;
      out[y * SIZE + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

// Several octaves of it, in -1..1. Kept by key: materials share the big fields.
const fields = new Map();
function fbm(seed, cells, octaves) {
  const key = `${seed}:${cells}:${octaves}`;
  let out = fields.get(key);
  if (out) return out;
  out = new Float32Array(SIZE * SIZE);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(cells << o, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / total) * 2 - 1;
  fields.set(key, out);
  return out;
}

const mix = (a, b, t) => a + (b - a) * t;

// Every material: the colour it falls back to, how many world pixels one tile
// covers (`span`), and a function that fills the RGBA of one pixel.
const RECIPES = {
  // Rolled asphalt: dark, blotchy, with pale aggregate showing through.
  asphalt: {
    base: '#3d3e41',
    span: 256,
    make() {
      const big = fbm(11, 3, 4);
      const mid = fbm(12, 24, 2);
      const rnd = lcg(901);
      return (i, px) => {
        const g = rnd();
        let v = 61 + big[i] * 9 + mid[i] * 5 + (g - 0.5) * 15;
        if (g > 0.965) v += 24;
        else if (g < 0.03) v -= 16;
        px[0] = v; px[1] = v + 1; px[2] = v + 4; px[3] = 255;
      };
    },
    after(g) {
      // A few hairline cracks and tar-sealed joints.
      const rnd = lcg(77);
      g.lineWidth = 1;
      for (let k = 0; k < 10; k++) {
        g.strokeStyle = k % 3 === 0 ? 'rgba(12,12,13,0.5)' : 'rgba(14,14,15,0.26)';
        let x = rnd() * SIZE;
        let y = rnd() * SIZE;
        g.beginPath();
        g.moveTo(x, y);
        for (let s = 0; s < 9; s++) {
          x += (rnd() - 0.5) * 34;
          y += (rnd() - 0.35) * 26;
          g.lineTo(x, y);
        }
        g.stroke();
      }
    },
  },
  // Pavement: cast concrete flags, each a slightly different grey, weathered.
  concrete: {
    base: '#a19e97',
    span: 256,
    make() {
      const big = fbm(21, 4, 4);
      const rnd = lcg(333);
      const slab = lcg(5150);
      const tone = new Float32Array(16 * 16);
      for (let k = 0; k < tone.length; k++) tone[k] = (slab() - 0.5) * 5;
      return (i, px, x, y) => {
        const sx = x & 31;
        const sy = y & 31;
        let v = 163 + big[i] * 9 + tone[(y >> 5) * 16 + (x >> 5)] + (rnd() - 0.5) * 11;
        if (sx === 0 || sy === 0) v -= 12;
        px[0] = v + 2; px[1] = v; px[2] = v - 6; px[3] = 255;
      };
    },
  },
  // Rough grass: patchy growth, darker damp hollows, pale dry ground.
  grass: {
    base: '#566340',
    span: 384,
    make() {
      const big = fbm(31, 4, 4);
      const mid = fbm(32, 14, 3);
      const fine = fbm(33, 96, 2);
      const rnd = lcg(4711);
      return (i, px) => {
        const t = big[i] * 0.5 + 0.5;
        const dry = Math.max(0, mid[i] - 0.18) * 1.6;
        const g = (rnd() - 0.5) * 20 + fine[i] * 16;
        px[0] = mix(mix(68, 98, t), 132, dry) + g * 0.8;
        px[1] = mix(mix(95, 118, t), 126, dry) + g;
        px[2] = mix(mix(48, 60, t), 78, dry) + g * 0.5;
        px[3] = 255;
      };
    },
  },
  // Garden lawn: kept greener and more even than open grass.
  lawn: {
    base: '#5f7446',
    span: 384,
    make() {
      const big = fbm(41, 5, 4);
      const mid = fbm(42, 20, 3);
      const fine = fbm(43, 110, 2);
      const rnd = lcg(1291);
      return (i, px) => {
        const t = big[i] * 0.5 + 0.5;
        const worn = Math.max(0, mid[i] - 0.3) * 1.3;
        const g = (rnd() - 0.5) * 16 + fine[i] * 13;
        px[0] = mix(mix(74, 98, t), 124, worn) + g * 0.8;
        px[1] = mix(mix(102, 122, t), 124, worn) + g;
        px[2] = mix(mix(52, 62, t), 76, worn) + g * 0.5;
        px[3] = 255;
      };
    },
  },
  // Roadside verge in the country: rank, darker grass.
  verge: {
    base: '#4b5a34',
    span: 384,
    make() {
      const big = fbm(45, 5, 4);
      const fine = fbm(46, 90, 2);
      const rnd = lcg(733);
      return (i, px) => {
        const t = big[i] * 0.5 + 0.5;
        const g = (rnd() - 0.5) * 20 + fine[i] * 16;
        px[0] = mix(58, 92, t) + g * 0.8;
        px[1] = mix(78, 100, t) + g;
        px[2] = mix(40, 54, t) + g * 0.5;
        px[3] = 255;
      };
    },
  },
  // A track cut through the woods: bare earth, ruts and stones.
  dirt: {
    base: '#6b5a43',
    span: 256,
    make() {
      const big = fbm(47, 4, 4);
      const mid = fbm(48, 22, 2);
      const rnd = lcg(1999);
      return (i, px) => {
        const g = rnd();
        let v = big[i] * 14 + mid[i] * 9 + (g - 0.5) * 22;
        if (g > 0.975) v += 30;
        px[0] = 112 + v; px[1] = 94 + v; px[2] = 70 + v * 0.8; px[3] = 255;
      };
    },
  },
  // Industrial yard: old concrete and tarmac, stained and patched.
  yard: {
    base: '#5c5d5c',
    span: 384,
    make() {
      const big = fbm(51, 3, 4);
      const mid = fbm(52, 10, 3);
      const rnd = lcg(2203);
      return (i, px) => {
        const stain = Math.max(0, mid[i] - 0.22) * 46;
        const v = 96 + big[i] * 16 - stain + (rnd() - 0.5) * 14;
        px[0] = v + 1; px[1] = v; px[2] = v - 2; px[3] = 255;
      };
    },
  },
  // Business district: large pale paving flags.
  plaza: {
    base: '#b3b1aa',
    span: 256,
    make() {
      const big = fbm(61, 4, 3);
      const rnd = lcg(719);
      const slab = lcg(88);
      const tone = new Float32Array(8 * 8);
      for (let k = 0; k < tone.length; k++) tone[k] = (slab() - 0.5) * 4;
      return (i, px, x, y) => {
        const sx = x & 63;
        const sy = y & 63;
        let v = 180 + big[i] * 8 + tone[(y >> 6) * 8 + (x >> 6)] + (rnd() - 0.5) * 9;
        if (sx === 0 || sy === 0) v -= 13;
        px[0] = v + 1; px[1] = v; px[2] = v - 5; px[3] = 255;
      };
    },
  },
  // Shopping streets: small warm block paving laid in courses.
  paving: {
    base: '#96897b',
    span: 256,
    make() {
      const big = fbm(71, 5, 3);
      const rnd = lcg(1877);
      const brick = lcg(31);
      const tone = new Float32Array(64 * 64);
      for (let k = 0; k < tone.length; k++) tone[k] = (brick() - 0.5) * 10;
      return (i, px, x, y) => {
        const row = y >> 3;
        const ox = (x + (row & 1) * 8) & 511;
        let v = big[i] * 8 + tone[(row & 63) * 64 + ((ox >> 4) & 63)] + (rnd() - 0.5) * 9;
        if ((y & 7) === 0 || (ox & 15) === 0) v -= 11;
        px[0] = 156 + v; px[1] = 143 + v; px[2] = 128 + v; px[3] = 255;
      };
    },
  },
  // The station apron: big concrete bays with sealed joints and tyre grime.
  apron: {
    base: '#7b7d7d',
    span: 512,
    make() {
      const big = fbm(81, 3, 4);
      const mid = fbm(82, 12, 3);
      const rnd = lcg(613);
      return (i, px, x, y) => {
        let v = 126 + big[i] * 10 - Math.max(0, mid[i] - 0.25) * 30 + (rnd() - 0.5) * 12;
        if ((x & 127) < 2 || (y & 127) < 2) v -= 34;
        px[0] = v; px[1] = v + 1; px[2] = v + 1; px[3] = 255;
      };
    },
  },
  // Laid over any roof colour: gravel grain, water stains and dirt.
  roofing: {
    base: 'rgba(0,0,0,0)',
    span: 256,
    make() {
      const big = fbm(91, 4, 4);
      const mid = fbm(92, 18, 2);
      const rnd = lcg(271);
      return (i, px) => {
        const g = rnd();
        const stain = Math.max(0, big[i] * 0.7 + mid[i] * 0.5 - 0.1);
        if (g > 0.5) {
          px[0] = px[1] = px[2] = 255;
          px[3] = (g - 0.5) * 2 * 40 * (1 - stain);
        } else {
          px[0] = 16; px[1] = 14; px[2] = 12;
          px[3] = (0.5 - g) * 2 * 46 + stain * 120;
        }
      };
    },
  },
  // Laid over the colour of the sea and the river: long swells, wind ripples
  // and the glitter of the sun, stretched along the wave fronts.
  water: {
    base: 'rgba(0,0,0,0)',
    span: 512,
    stretch: [1.7, 0.62],
    make() {
      const swell = fbm(111, 5, 4);
      const ripple = fbm(112, 44, 3);
      const rnd = lcg(87);
      return (i, px) => {
        const v = swell[i] * 0.55 + ripple[i] * 0.75;
        if (v > 0.2) {
          px[0] = 226; px[1] = 240; px[2] = 246;
          px[3] = Math.min(150, (v - 0.2) * 260) + (rnd() > 0.992 ? 70 : 0);
        } else {
          px[0] = 6; px[1] = 22; px[2] = 34;
          px[3] = Math.min(120, (0.2 - v) * 110);
        }
      };
    },
  },
  // Laid over the whole ground at a very large scale, so no surface repeats.
  mottle: {
    base: 'rgba(0,0,0,0)',
    span: 3072,
    make() {
      const big = fbm(101, 3, 5);
      return (i, px) => {
        const v = big[i];
        if (v > 0) { px[0] = 255; px[1] = 250; px[2] = 232; px[3] = v * 34; } else { px[0] = 8; px[1] = 12; px[2] = 18; px[3] = -v * 52; }
      };
    },
  },
};

const made = {};

/** The fill style for a material: a pattern in the browser, a colour elsewhere. */
export function material(ctx, name) {
  if (made[name] !== undefined) return made[name];
  const recipe = RECIPES[name];
  made[name] = recipe.base;
  if (typeof document === 'undefined') return made[name];
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d');
  const img = g.createImageData(SIZE, SIZE);
  const data = img.data;
  const pixel = recipe.make();
  const px = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++, i++) {
      pixel(i, px, x, y);
      const o = i * 4;
      data[o] = px[0];
      data[o + 1] = px[1];
      data[o + 2] = px[2];
      data[o + 3] = px[3];
    }
  }
  g.putImageData(img, 0, 0);
  if (recipe.after) recipe.after(g);
  const pattern = ctx.createPattern(c, 'repeat');
  if (pattern && (recipe.span !== SIZE || recipe.stretch) && typeof DOMMatrix !== 'undefined') {
    const k = recipe.span / SIZE;
    const [kx, ky] = recipe.stretch ?? [1, 1];
    pattern.setTransform(new DOMMatrix().scale(k * kx, k * ky));
  }
  made[name] = pattern ?? recipe.base;
  return made[name];
}

// Line overlays for sloping roofs: tile courses and standing seams, one tile
// per direction (`h` lines run across, `v` lines run down).
const courses = {};
export function roofLines(ctx, kind, dir) {
  const key = `${kind}:${dir}`;
  if (courses[key] !== undefined) return courses[key];
  courses[key] = 'rgba(0,0,0,0)';
  if (typeof document === 'undefined') return courses[key];
  const S = 96;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  if (dir === 'v') {
    g.translate(S, 0);
    g.rotate(Math.PI / 2);
  }
  const rnd = lcg(kind === 'tile' ? 5 : 9);
  if (kind === 'tile') {
    // Courses of tiles: a shadow line under each course, joints staggered.
    for (let y = 0; y < S; y += 6) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(0, y, S, 1.5);
      g.fillStyle = 'rgba(255,240,220,0.1)';
      g.fillRect(0, y + 1.5, S, 1.5);
      for (let x = (y / 6) % 2 ? 3 : 0; x < S; x += 6) {
        g.fillStyle = `rgba(0,0,0,${0.08 + rnd() * 0.16})`;
        g.fillRect(x, y, 1, 6);
        if (rnd() < 0.3) {
          g.fillStyle = rnd() < 0.5 ? 'rgba(255,235,210,0.12)' : 'rgba(0,0,0,0.14)';
          g.fillRect(x + 1, y + 1.5, 5, 4.5);
        }
      }
    }
  } else {
    // Sheet metal: a raised seam every eight texels, light one side, dark the other.
    for (let y = 0; y < S; y += 8) {
      g.fillStyle = 'rgba(255,255,255,0.2)';
      g.fillRect(0, y, S, 1);
      g.fillStyle = 'rgba(0,0,0,0.26)';
      g.fillRect(0, y + 1, S, 1.2);
    }
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `rgba(60,34,20,${0.04 + rnd() * 0.08})`;
      g.fillRect(rnd() * S, Math.floor(rnd() * 12) * 8 + 2, 6 + rnd() * 22, 5);
    }
  }
  const pattern = ctx.createPattern(c, 'repeat');
  if (pattern && typeof DOMMatrix !== 'undefined') pattern.setTransform(new DOMMatrix().scale(0.5));
  courses[key] = pattern ?? 'rgba(0,0,0,0)';
  return courses[key];
}
