import * as THREE from 'three';

// Procedural PBR material factory.
//
// Nothing in the game is loaded from an image file. Every albedo, normal,
// roughness, metalness and ambient-occlusion map is synthesised here at
// startup: tileable Perlin noise and Worley (cellular) noise build a height
// field and a set of masks (puddles, rust, chipped paint, cracks...), the
// masks drive the albedo and roughness, and a Sobel filter turns the height
// field into a tangent-space normal map. The pixels are written into HTML5
// canvases, which become THREE.CanvasTextures.
//
// AO, roughness and metalness are packed into one "ORM" texture (R = AO,
// G = roughness, B = metalness), which is exactly the channel layout
// MeshStandardMaterial reads from aoMap / roughnessMap / metalnessMap.

/* -------------------------------------------------------------------------- */
/* Random numbers and noise                                                   */
/* -------------------------------------------------------------------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer lattice hash -> [0, 1).
export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 16 evenly spaced unit gradients give a more isotropic result than the
// classic 8 axis/diagonal gradients.
const GRAD2 = new Float32Array(32);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2 + 0.1963;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}

/**
 * Improved Perlin noise with optional periodicity. When `px`/`py` are
 * integers the lattice wraps, so `noise2(u * p, v * p, p, p)` tiles
 * seamlessly over u, v in [0, 1). Output is roughly in [-1, 1].
 */
export class PerlinNoise {
  constructor(seed = 1) {
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise2(x, y, px = 256, py = 256) {
    const fx0 = Math.floor(x);
    const fy0 = Math.floor(y);
    const fx = x - fx0;
    const fy = y - fy0;

    let x0 = fx0 % px;
    if (x0 < 0) x0 += px;
    let y0 = fy0 % py;
    if (y0 < 0) y0 += py;
    let x1 = x0 + 1;
    if (x1 >= px) x1 = 0;
    let y1 = y0 + 1;
    if (y1 >= py) y1 = 0;

    const p = this.perm;
    const a0 = p[x0 & 255];
    const a1 = p[x1 & 255];
    const g00 = (p[a0 + (y0 & 255)] & 15) << 1;
    const g10 = (p[a1 + (y0 & 255)] & 15) << 1;
    const g01 = (p[a0 + (y1 & 255)] & 15) << 1;
    const g11 = (p[a1 + (y1 & 255)] & 15) << 1;

    const n00 = GRAD2[g00] * fx + GRAD2[g00 + 1] * fy;
    const n10 = GRAD2[g10] * (fx - 1) + GRAD2[g10 + 1] * fy;
    const n01 = GRAD2[g01] * fx + GRAD2[g01 + 1] * (fy - 1);
    const n11 = GRAD2[g11] * (fx - 1) + GRAD2[g11 + 1] * (fy - 1);

    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.41421356;
  }

  /** Smooth 1D noise, used for camera shake and light flicker. */
  noise1(t, channel = 0) {
    return this.noise2(t, channel * 17.31 + 0.5);
  }

  /**
   * Fractal Brownian motion. `period` is the lattice period of the first
   * octave; with lacunarity 2 every octave stays an integer period, so the
   * sum still tiles. Pass `period = 0` for non-periodic noise, and
   * `periodY` for a different period along y (stretched noise).
   */
  fbm(x, y, octaves, period = 0, gain = 0.5, periodY = period) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      const px = period > 0 ? period * freq : 256;
      const py = periodY > 0 ? periodY * freq : 256;
      sum += amp * this.noise2(x * freq, y * freq, px, py);
      norm += amp;
      amp *= gain;
      freq *= 2;
    }
    return sum / norm;
  }

  /** Ridged multifractal-style noise: sharp creases where the fbm crosses 0. */
  ridged(x, y, octaves, period = 0) {
    return 1 - Math.abs(this.fbm(x, y, octaves, period));
  }
}

const _worley = { f1: 0, f2: 0, id: 0 };

/**
 * Tileable Worley noise. Returns a shared object with the distance to the
 * nearest (f1) and second-nearest (f2) feature point, in cell units, and a
 * stable random id in [0, 1) for the nearest cell.
 */
export function worley(u, v, cells, seed) {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      let wx = cx % cells;
      if (wx < 0) wx += cells;
      let wy = cy % cells;
      if (wy < 0) wy += cells;
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 7919);
      const ddx = px - x;
      const ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 104729);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  _worley.f1 = f1;
  _worley.f2 = f2;
  _worley.id = id;
  return _worley;
}

/* -------------------------------------------------------------------------- */
/* Small math helpers                                                         */
/* -------------------------------------------------------------------------- */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Computes a low-resolution scalar field; sample it back with sampleField. */
function lowField(size, fn) {
  const f = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) f[y * size + x] = fn(x / size, v);
  }
  return { data: f, size };
}

/** Bilinear, wrapping lookup into a field produced by lowField. */
function sampleField(field, u, v) {
  const s = field.size;
  const x = u * s - 0.5;
  const y = v * s - 0.5;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  x0 = ((x0 % s) + s) % s;
  y0 = ((y0 % s) + s) % s;
  const x1 = (x0 + 1) % s;
  const y1 = (y0 + 1) % s;
  const d = field.data;
  const a = d[y0 * s + x0];
  const b = d[y0 * s + x1];
  const c = d[y1 * s + x0];
  const e = d[y1 * s + x1];
  return lerp(lerp(a, b, tx), lerp(c, e, tx), ty);
}

/** Separable box blur with wrap-around edges (keeps tileable maps tileable). */
function blurWrap(src, size, radius) {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const win = radius * 2 + 1;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += src[row + ((k + size) % size)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc / win;
      acc += src[row + ((x + radius + 1) % size)] - src[row + ((x - radius + size) % size)];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += tmp[((k + size) % size) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc / win;
      acc += tmp[((y + radius + 1) % size) * size + x] - tmp[((y - radius + size) % size) * size + x];
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Canvas / texture plumbing                                                  */
/* -------------------------------------------------------------------------- */

function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let maxAnisotropy = 8;

function canvasTexture(canvas, { srgb = false, wrap = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function imageTexture(width, height, fill, opts) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  fill(img.data);
  ctx.putImageData(img, 0, 0);
  return canvasTexture(canvas, opts);
}

/** Albedo stored as linear floats [0..1] -> sRGB canvas texture. */
function albedoTexture(albedo, size) {
  return imageTexture(size, size, (d) => {
    for (let i = 0, j = 0; i < size * size; i++, j += 3) {
      d[i * 4] = linearToSrgb8(albedo[j]);
      d[i * 4 + 1] = linearToSrgb8(albedo[j + 1]);
      d[i * 4 + 2] = linearToSrgb8(albedo[j + 2]);
      d[i * 4 + 3] = 255;
    }
  }, { srgb: true });
}

function linearToSrgb8(c) {
  c = clamp01(c);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Sobel filter over a wrapping height field -> tangent-space normal map
 * (OpenGL convention, +Y = +V, which is what three.js expects).
 */
function normalTexture(height, size, strength) {
  return imageTexture(size, size, (d) => {
    const k = strength * size / 256;
    for (let y = 0; y < size; y++) {
      const ym = ((y - 1 + size) % size) * size;
      const y0 = y * size;
      const yp = ((y + 1) % size) * size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;
        const tl = height[ym + xm], t = height[ym + x], tr = height[ym + xp];
        const l = height[y0 + xm], r = height[y0 + xp];
        const bl = height[yp + xm], b = height[yp + x], br = height[yp + xp];
        // dH/du (to the right) and dH/dv (canvas up, because textures are flipped on upload)
        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (tl + 2 * t + tr) - (bl + 2 * b + br);
        let nx = -dx * k;
        let ny = -dy * k;
        let nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv;
        ny *= inv;
        nz *= inv;
        const i = (y0 + x) * 4;
        d[i] = Math.round((nx * 0.5 + 0.5) * 255);
        d[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        d[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        d[i + 3] = 255;
      }
    }
  });
}

/** Cavity-based ambient occlusion: pixels below their blurred neighbourhood get darker. */
function cavityAO(height, size, radius, strength, floor = 0.35) {
  const blurred = blurWrap(height, size, radius);
  const ao = new Float32Array(size * size);
  for (let i = 0; i < ao.length; i++) {
    const cavity = blurred[i] - height[i];
    ao[i] = Math.max(floor, 1 - Math.max(0, cavity) * strength);
  }
  return ao;
}

function ormTexture(ao, rough, metal, size) {
  return imageTexture(size, size, (d) => {
    for (let i = 0; i < size * size; i++) {
      d[i * 4] = Math.round(clamp01(ao ? ao[i] : 1) * 255);
      d[i * 4 + 1] = Math.round(clamp01(rough[i]) * 255);
      d[i * 4 + 2] = Math.round(clamp01(metal ? metal[i] : 0) * 255);
      d[i * 4 + 3] = 255;
    }
  });
}

function pbrMaterial({ albedo, normal, orm }, params = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: normal,
    roughnessMap: orm,
    metalnessMap: orm,
    aoMap: orm,
    aoMapIntensity: 1,
    roughness: 1,
    metalness: 1,
    ...params,
  });
  return mat;
}

/** Draws random thin scratches on a canvas and returns them as a [0..1] mask. */
function scratchMask(size, count, seed, maxLen = 0.12) {
  const rng = mulberry32(seed);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const ang = (rng() < 0.6 ? 0.15 : 1) * (rng() - 0.5) * Math.PI + (rng() < 0.5 ? 0 : Math.PI / 2) * (rng() < 0.3 ? 1 : 0);
    const len = (0.015 + rng() * maxLen) * size;
    const bend = (rng() - 0.5) * 0.4;
    const a = 0.15 + rng() * 0.55;
    ctx.strokeStyle = `rgba(255,255,255,${a})`;
    ctx.lineWidth = 0.4 + rng() * 1.3;
    // Draw with 3x3 offsets so scratches crossing an edge wrap around.
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const bx = x + ox * size;
        const by = y + oy * size;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(
          bx + Math.cos(ang + bend) * len * 0.5,
          by + Math.sin(ang + bend) * len * 0.5,
          bx + Math.cos(ang) * len,
          by + Math.sin(ang) * len,
        );
        ctx.stroke();
      }
    }
  }
  const px = ctx.getImageData(0, 0, size, size).data;
  const mask = new Float32Array(size * size);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4] / 255;
  return mask;
}

/* -------------------------------------------------------------------------- */
/* Surface generators                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Wet concrete slab: aggregate stones, hairline cracks, oil stains and
 * puddles. Puddles are where the magic happens under the flashlight: the
 * height field is clamped to a flat "water level" there (so the normal map is
 * mirror-flat), the albedo darkens and the roughness drops to ~0.03.
 */
function generateWetConcrete(S, seed) {
  const n = new PerlinNoise(seed);
  const n2 = new PerlinNoise(seed + 11);
  const n3 = new PerlinNoise(seed + 23);
  const L = S >> 2;

  const large = lowField(L, (u, v) => n.fbm(u * 2, v * 2, 5, 2));
  const puddles = lowField(L, (u, v) => {
    const wu = n3.fbm(u * 4, v * 4, 2, 4) * 0.08;
    const wv = n3.fbm(u * 4 + 5.2, v * 4 + 1.3, 2, 4) * 0.08;
    return n2.fbm((u + wu) * 3, (v + wv) * 3, 5, 3);
  });
  const stains = lowField(L, (u, v) => {
    const w = n.fbm(u * 3 + 9.1, v * 3 + 2.7, 3, 3) * 0.6;
    return n3.fbm(u * 4 + w, v * 4 - w, 5, 4);
  });
  const crackZone = lowField(L, (u, v) => n2.fbm(u * 2 + 3.3, v * 2 + 7.7, 3, 2));

  const height = new Float32Array(S * S);
  const albedo = new Float32Array(S * S * 3);
  const rough = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;

      const lg = sampleField(large, u, v);
      const pd = sampleField(puddles, u, v);
      const st = sampleField(stains, u, v);
      const cz = sampleField(crackZone, u, v);

      const mid = n.fbm(u * 16, v * 16, 4, 16);
      const fine = n3.noise2(u * 128, v * 128, 128, 128) * 0.6 + n2.noise2(u * 256, v * 256, 256, 256) * 0.4;

      // Aggregate: exposed stones in worn areas.
      const w = worley(u, v, 56, seed + 3);
      const stone = smoothstep(0.48, 0.18, w.f1) * smoothstep(-0.1, 0.35, mid + lg * 0.5);
      const stoneTone = 0.75 + w.id * 0.5;

      // Hairline cracks, only inside some zones.
      const ridge = n.ridged(u * 5 + 1.7, v * 5 + 4.1, 5, 5);
      const crack = smoothstep(0.975, 0.995, ridge) * smoothstep(0.15, 0.4, cz);

      const puddle = smoothstep(0.2, 0.26, pd);
      const damp = smoothstep(0.0, 0.2, pd);
      const stain = smoothstep(0.15, 0.55, st);

      let h = 0.5 + lg * 0.12 + mid * 0.1 + fine * 0.035 + stone * 0.07 - crack * 0.3;
      h = lerp(h, 0.6, puddle); // water fills the low spots: perfectly flat

      const tone = 0.8 + lg * 0.22 + mid * 0.1 + fine * 0.05;
      let r = 0.27 * tone;
      let g = 0.25 * tone;
      let b = 0.215 * tone;
      // stones
      r = lerp(r, r * stoneTone * 1.05, stone * 0.8);
      g = lerp(g, g * stoneTone, stone * 0.8);
      b = lerp(b, b * stoneTone * 0.95, stone * 0.8);
      // oil and rust stains (brownish)
      r *= 1 - stain * 0.38;
      g *= 1 - stain * 0.45;
      b *= 1 - stain * 0.52;
      // cracks hold dirt
      const ck = 1 - crack * 0.5;
      r *= ck;
      g *= ck;
      b *= ck;
      // wet concrete is darker
      const dk = 1 - damp * 0.42;
      r *= dk;
      g *= dk;
      b *= dk;
      // standing water: dark, slightly cold
      r = lerp(r, r * 0.5 + 0.004, puddle);
      g = lerp(g, g * 0.52 + 0.006, puddle);
      b = lerp(b, b * 0.56 + 0.01, puddle);

      let ro = 0.86 + fine * 0.06 + mid * 0.05 - stain * 0.18 - stone * 0.08;
      ro = lerp(ro, 0.42, damp);
      ro = lerp(ro, 0.035, puddle);

      height[i] = h;
      albedo[i * 3] = r;
      albedo[i * 3 + 1] = g;
      albedo[i * 3 + 2] = b;
      rough[i] = ro;
    }
  }

  const ao = cavityAO(height, S, 6, 4.5);
  return {
    albedo: albedoTexture(albedo, S),
    normal: normalTexture(height, S, 3.2),
    orm: ormTexture(ao, rough, null, S),
  };
}

/**
 * Board-formed concrete wall (one tile = 4 x 4 m): 2 x 4 form panels with
 * chamfered seams, tie holes, rust streaks bleeding down from the ties,
 * rain streaks, pores and per-panel tone variation.
 */
function generateConcreteWall(S, seed) {
  const n = new PerlinNoise(seed);
  const n2 = new PerlinNoise(seed + 5);
  const L = S >> 2;
  const large = lowField(L, (u, v) => n.fbm(u * 2, v * 2, 5, 2));
  const streakLow = lowField(L, (u, v) => n2.fbm(u * 24, v * 2, 4, 24, 0.5, 2) * 0.5 + n2.fbm(u * 3, v * 3, 3, 3) * 0.5);

  const height = new Float32Array(S * S);
  const albedo = new Float32Array(S * S * 3);
  const rough = new Float32Array(S * S);

  const panelsX = 2;
  const panelsY = 4;
  const holeR = 0.011;
  const holes = [];
  for (let py = 0; py < panelsY; py++) {
    for (let px = 0; px < panelsX; px++) {
      for (let k = 0; k < 2; k++) {
        holes.push({ x: (px + 0.25 + k * 0.5) / panelsX, y: (py + 0.5) / panelsY, seed: hash2(px * 2 + k, py, seed) });
      }
    }
  }

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;

      const lg = sampleField(large, u, v);
      const mid = n.fbm(u * 12, v * 12, 4, 12);
      const fine = n2.noise2(u * 160, v * 160, 160, 160);

      // Panel seams (chamfered grooves) with noisy chipped edges.
      const pu = u * panelsX;
      const pv = v * panelsY;
      const panelId = hash2(Math.floor(pu), Math.floor(pv), seed + 1);
      const du = Math.abs(pu - Math.round(pu)) / panelsX;
      const dv = Math.abs(pv - Math.round(pv)) / panelsY;
      const chip = mid * 0.0025;
      const seam = Math.max(smoothstep(0.0035 + chip, 0.001, du), smoothstep(0.0035 + chip, 0.001, dv));

      // Tie holes + rust streaks below them (canvas y grows downward = down the wall).
      let hole = 0;
      let rust = 0;
      for (let k = 0; k < holes.length; k++) {
        const hx = holes[k].x;
        const hy = holes[k].y;
        let dx = u - hx;
        dx -= Math.round(dx);
        let dy = v - hy;
        dy -= Math.round(dy);
        const d = Math.sqrt(dx * dx + dy * dy);
        hole = Math.max(hole, smoothstep(holeR, holeR * 0.55, d));
        if (dy > 0 && dy < 0.22) {
          const width = holeR * (0.7 + dy * 3.5) * (0.8 + holes[k].seed * 0.6);
          const wob = n.noise2(dy * 40 + k * 3.1, k * 1.7) * width * 0.6;
          const lateral = smoothstep(width, width * 0.2, Math.abs(dx + wob));
          rust = Math.max(rust, lateral * Math.pow(1 - dy / 0.22, 1.6) * (0.4 + holes[k].seed * 0.6));
        }
      }

      // Water streaks running down the wall.
      const sl = sampleField(streakLow, u, v);
      const streak = smoothstep(0.08, 0.4, sl + n2.noise2(u * 90, v * 6, 90, 6) * 0.15);

      // Pores / air bubbles.
      const w = worley(u, v, 90, seed + 9);
      const pore = smoothstep(0.11, 0.03, w.f1) * (w.id > 0.86 ? 1 : 0);

      let h = 0.55 + lg * 0.06 + mid * 0.05 + fine * 0.02 - seam * 0.35 - hole * 0.5 - pore * 0.12;

      const tone = 0.86 + lg * 0.16 + mid * 0.07 + fine * 0.035 + (panelId - 0.5) * 0.1;
      let r = 0.44 * tone;
      let g = 0.43 * tone;
      let b = 0.4 * tone;
      const grime = 1 - streak * 0.35 - seam * 0.4 - pore * 0.35;
      r *= grime;
      g *= grime;
      b *= grime;
      // tie holes are dark, rust streaks orange-brown
      r = lerp(r, 0.03, hole * 0.9);
      g = lerp(g, 0.025, hole * 0.9);
      b = lerp(b, 0.02, hole * 0.9);
      r = lerp(r, 0.26, rust * 0.75);
      g = lerp(g, 0.12, rust * 0.75);
      b = lerp(b, 0.05, rust * 0.75);

      const ro = clamp01(0.9 + fine * 0.05 - streak * 0.22 - rust * 0.1);

      height[i] = h;
      albedo[i * 3] = r;
      albedo[i * 3 + 1] = g;
      albedo[i * 3 + 2] = b;
      rough[i] = ro;
    }
  }

  const ao = cavityAO(height, S, 5, 5);
  return {
    albedo: albedoTexture(albedo, S),
    normal: normalTexture(height, S, 2.6),
    orm: ormTexture(ao, rough, null, S),
  };
}

/**
 * Riveted steel plates eaten by rust (one tile = 2 x 2 m, 2 x 2 plates).
 * Bare steel is metallic and fairly glossy with brushed streaks and
 * scratches; rust is non-metallic, rough, raised and flaky.
 */
function generateRustedMetal(S, seed) {
  const n = new PerlinNoise(seed);
  const n2 = new PerlinNoise(seed + 3);
  const L = S >> 2;
  const rustLow = lowField(L, (u, v) => {
    const w = n2.fbm(u * 3, v * 3, 3, 3) * 0.12;
    return n.fbm((u + w) * 4, (v - w) * 4, 5, 4);
  });
  const scratches = scratchMask(S, 420, seed + 17, 0.08);

  const height = new Float32Array(S * S);
  const albedo = new Float32Array(S * S * 3);
  const rough = new Float32Array(S * S);
  const metal = new Float32Array(S * S);

  const plates = 2;
  const rivetSpacing = 1 / 24;
  const rivetInset = 0.022;
  const rivetR = 0.0085;

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;

      const pu = u * plates;
      const pv = v * plates;
      const du = Math.abs(pu - Math.round(pu)) / plates;
      const dv = Math.abs(pv - Math.round(pv)) / plates;
      const seam = Math.max(smoothstep(0.0022, 0.0006, du), smoothstep(0.0022, 0.0006, dv));
      const seamNear = Math.max(smoothstep(0.05, 0.0, du), smoothstep(0.05, 0.0, dv));
      const plateId = hash2(Math.floor(pu), Math.floor(pv), seed);

      // Rivets: rows parallel to every seam, inset by rivetInset.
      let rivet = 0;
      {
        const ru = Math.abs(du - rivetInset);
        const rv = Math.abs(dv - rivetInset);
        const alongV = Math.abs((v / rivetSpacing) - Math.round(v / rivetSpacing)) * rivetSpacing;
        const alongU = Math.abs((u / rivetSpacing) - Math.round(u / rivetSpacing)) * rivetSpacing;
        const d1 = Math.sqrt(ru * ru + alongV * alongV);
        const d2 = Math.sqrt(rv * rv + alongU * alongU);
        const d = Math.min(d1, d2);
        if (d < rivetR) {
          const t = d / rivetR;
          rivet = Math.sqrt(1 - t * t);
        }
      }

      const brushed = n2.noise2(u * 6, v * 220, 6, 220) * 0.5 + n.noise2(u * 3, v * 90, 3, 90) * 0.5;
      const fine = n.noise2(u * 200, v * 200, 200, 200);
      const flakes = n2.fbm(u * 64, v * 64, 3, 64);

      const rl = sampleField(rustLow, u, v);
      let rustAmt = smoothstep(-0.08, 0.22, rl + seamNear * 0.35 + rivet * 0.3 + flakes * 0.12);
      rustAmt = clamp01(rustAmt);
      const heavyRust = smoothstep(0.25, 0.55, rl + flakes * 0.2);

      const sc = scratches[i] * (1 - rustAmt);

      let h = 0.5 - seam * 0.4 + rivet * 0.45 + rustAmt * 0.08 + heavyRust * flakes * 0.12 + brushed * 0.008 - sc * 0.03;

      // steel
      const st = 0.52 + brushed * 0.05 + (plateId - 0.5) * 0.08 + fine * 0.02 + sc * 0.2;
      let r = st * 0.98;
      let g = st;
      let b = st * 1.02;
      // rust colour: dark brown -> orange depending on fine variation
      const rv = clamp01(0.5 + flakes * 0.9 + fine * 0.2);
      const rr = lerp(0.12, 0.42, rv) * (1 - heavyRust * 0.35);
      const rg = lerp(0.05, 0.17, rv) * (1 - heavyRust * 0.4);
      const rb = lerp(0.025, 0.06, rv);
      r = lerp(r, rr, rustAmt);
      g = lerp(g, rg, rustAmt);
      b = lerp(b, rb, rustAmt);
      const sd = 1 - seam * 0.6;
      r *= sd;
      g *= sd;
      b *= sd;

      const steelRough = 0.34 + Math.abs(brushed) * 0.12 + fine * 0.04 - sc * 0.15;
      const rustRough = 0.82 + flakes * 0.1;
      height[i] = h;
      albedo[i * 3] = r;
      albedo[i * 3 + 1] = g;
      albedo[i * 3 + 2] = b;
      rough[i] = lerp(steelRough, rustRough, rustAmt);
      metal[i] = 1 - smoothstep(0.15, 0.6, rustAmt);
    }
  }

  const ao = cavityAO(height, S, 4, 4);
  return {
    albedo: albedoTexture(albedo, S),
    normal: normalTexture(height, S, 3.4),
    orm: ormTexture(ao, rough, metal, S),
  };
}

/**
 * Painted sheet metal with chipped paint revealing rusty steel. Options add
 * container corrugation (trapezoidal ribs along U), drum ribs (bumps at
 * given V positions) or diagonal hazard stripes.
 */
function generatePaintedMetal(S, seed, { color, corrugations = 0, ribs = null, stripes = 0, chipAmount = 0.5, tileable = true }) {
  const n = new PerlinNoise(seed);
  const n2 = new PerlinNoise(seed + 9);
  const L = S >> 2;
  const P = tileable ? 1 : 0; // period multiplier: 0 disables wrapping
  const low = lowField(L, (u, v) => n.fbm(u * 3, v * 3, 5, 3 * P));
  const scratches = scratchMask(S, 160, seed + 4, 0.06);

  const height = new Float32Array(S * S);
  const albedo = new Float32Array(S * S * 3);
  const rough = new Float32Array(S * S);
  const metal = new Float32Array(S * S);

  const black = [0.018, 0.018, 0.02];

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;

      const lg = sampleField(low, u, v);
      const mid = n2.fbm(u * 10, v * 10, 4, 10 * P);
      const fine = n.noise2(u * 180, v * 180, 180, 180);

      let geo = 0;
      if (corrugations > 0) {
        // trapezoid wave: flat crests and troughs with sloped sides
        const t = u * corrugations;
        const tri = 1 - 4 * Math.abs(t - Math.floor(t) - 0.5); // -1..1
        geo = Math.max(-1, Math.min(1, tri * 1.7));
      }
      if (ribs) {
        for (let k = 0; k < ribs.length; k++) {
          const d = (v - ribs[k]) / 0.012;
          geo += Math.exp(-d * d) * 1.4;
        }
      }

      // Chips cluster on corrugation crests and at low-frequency hot spots.
      const chipField = mid * 0.7 + lg * 0.5 + fine * 0.08 + (corrugations > 0 ? Math.max(0, geo) * 0.12 : 0);
      const chip = smoothstep(0.62 - chipAmount * 0.5, 0.66 - chipAmount * 0.5, chipField);
      const chipEdge = smoothstep(0.5 - chipAmount * 0.5, 0.62 - chipAmount * 0.5, chipField) * (1 - chip);
      const sc = scratches[i];

      let pr = color[0];
      let pg = color[1];
      let pb = color[2];
      if (stripes > 0) {
        const s = (u + v) * stripes;
        const band = s - Math.floor(s) < 0.5 ? 1 : 0;
        if (!band) {
          pr = black[0];
          pg = black[1];
          pb = black[2];
        }
      }
      // fading / dirt
      const fade = 0.85 + lg * 0.18 + mid * 0.06 + fine * 0.03;
      const dirt = smoothstep(-0.2, 0.5, lg) * 0.25;
      pr = pr * fade * (1 - dirt);
      pg = pg * fade * (1 - dirt);
      pb = pb * fade * (1 - dirt);
      // scratches through the paint expose primer
      pr = lerp(pr, 0.32, sc * 0.5);
      pg = lerp(pg, 0.3, sc * 0.5);
      pb = lerp(pb, 0.28, sc * 0.5);

      // underlying rusty steel
      const rv = clamp01(0.5 + fine * 0.5 + mid * 0.5);
      const ur = lerp(0.14, 0.38, rv);
      const ug = lerp(0.07, 0.16, rv);
      const ub = lerp(0.04, 0.07, rv);

      let r = lerp(pr, ur, chip);
      let g = lerp(pg, ug, chip);
      let b = lerp(pb, ub, chip);
      // dark rim around chips (paint edge)
      r *= 1 - chipEdge * 0.25;
      g *= 1 - chipEdge * 0.25;
      b *= 1 - chipEdge * 0.25;

      height[i] = 0.5 + geo * 0.35 - chip * 0.06 + fine * 0.01 + mid * 0.02;
      albedo[i * 3] = r;
      albedo[i * 3 + 1] = g;
      albedo[i * 3 + 2] = b;
      rough[i] = lerp(0.5 + fine * 0.06 + dirt * 0.3 - sc * 0.1, 0.85, chip);
      metal[i] = chip * 0.35;
    }
  }

  const ao = cavityAO(height, S, 3, 3.5, 0.5);
  return {
    albedo: albedoTexture(albedo, S),
    normal: normalTexture(height, S, corrugations > 0 ? 2.2 : 2.6),
    orm: ormTexture(ao, rough, metal, S),
  };
}

/**
 * Weathered wooden crate face (not tileable, mapped 0..1 per box face):
 * frame boards around the border, horizontal planks and a diagonal brace,
 * each with its own grain, plus nails and a worn stencil.
 */
function generateCrate(S, seed, stencil) {
  const n = new PerlinNoise(seed);
  const n2 = new PerlinNoise(seed + 1);
  const rng = mulberry32(seed);

  // Stencil text rendered with canvas 2D, read back as a mask.
  const stencilCanvas = createCanvas(S, S);
  const sctx = stencilCanvas.getContext('2d');
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, S, S);
  sctx.fillStyle = '#fff';
  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';
  sctx.font = `bold ${Math.round(S * 0.11)}px "Bahnschrift", "Arial Narrow", Impact, sans-serif`;
  sctx.fillText(stencil[0], S * 0.5, S * 0.42);
  sctx.font = `bold ${Math.round(S * 0.06)}px "Bahnschrift", "Arial Narrow", Impact, sans-serif`;
  sctx.fillText(stencil[1], S * 0.5, S * 0.58);
  const stencilPx = sctx.getImageData(0, 0, S, S).data;

  const fw = 0.13; // frame board width
  const boards = [];
  const addBoard = (cx, cy, ax, ay, hl, hw, z) => {
    const len = Math.hypot(ax, ay);
    boards.push({ cx, cy, ax: ax / len, ay: ay / len, hl, hw, z, tint: 0.82 + rng() * 0.3, grain: rng() * 100 });
  };
  // planks (bottom layer)
  const planks = 4;
  for (let k = 0; k < planks; k++) {
    const h = (1 - fw * 2) / planks;
    addBoard(0.5, fw + h * (k + 0.5), 1, 0, 0.5, h * 0.5 - 0.004, 0);
  }
  // diagonal brace
  addBoard(0.5, 0.5, 1, 1, 0.5, 0.06, 1);
  // frame (top layer)
  addBoard(0.5, fw * 0.5, 1, 0, 0.5, fw * 0.5, 2);
  addBoard(0.5, 1 - fw * 0.5, 1, 0, 0.5, fw * 0.5, 2);
  addBoard(fw * 0.5, 0.5, 0, 1, 0.5 - fw, fw * 0.5, 3);
  addBoard(1 - fw * 0.5, 0.5, 0, 1, 0.5 - fw, fw * 0.5, 3);
  boards.sort((a, b) => b.z - a.z);

  const nails = [];
  for (const b of boards) {
    if (b.z < 2) continue;
    for (let k = -1; k <= 1; k += 2) {
      nails.push({ x: b.cx + b.ax * b.hl * 0.85 * k, y: b.cy + b.ay * b.hl * 0.85 * k });
    }
  }

  const height = new Float32Array(S * S);
  const albedo = new Float32Array(S * S * 3);
  const rough = new Float32Array(S * S);
  const metal = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;

      let board = null;
      let along = 0;
      let across = 0;
      for (let k = 0; k < boards.length; k++) {
        const b = boards[k];
        const dx = u - b.cx;
        const dy = v - b.cy;
        const al = dx * b.ax + dy * b.ay;
        const ac = -dx * b.ay + dy * b.ax;
        if (Math.abs(al) <= b.hl && Math.abs(ac) <= b.hw) {
          board = b;
          along = al;
          across = ac;
          break;
        }
      }

      let h;
      let r;
      let g;
      let bl;
      let ro;
      if (board) {
        const edge = Math.min(board.hw - Math.abs(across), board.hl - Math.abs(along));
        const bevel = smoothstep(0, 0.012, edge);
        const warp = n.fbm(along * 3 + board.grain, across * 14, 3) * 1.6;
        const rings = across * 60 + warp * 4;
        const ring = Math.pow(0.5 + 0.5 * Math.sin(rings * Math.PI), 3);
        const fiber = n2.noise2(along * 6 + board.grain, across * 260) * 0.5 + 0.5;
        const tone = board.tint * (0.85 + ring * 0.12 + fiber * 0.1) * (0.92 + n.fbm(u * 4, v * 4, 3) * 0.12);
        r = 0.36 * tone;
        g = 0.24 * tone;
        bl = 0.14 * tone;
        h = 0.55 + board.z * 0.06 + bevel * 0.2 + ring * 0.02 + fiber * 0.02;
        ro = 0.78 + fiber * 0.12;
        // shadowing at board edges
        const ed = 0.75 + 0.25 * bevel;
        r *= ed;
        g *= ed;
        bl *= ed;
      } else {
        // gap between boards
        h = 0.2;
        r = 0.03;
        g = 0.022;
        bl = 0.015;
        ro = 0.95;
      }

      // nails
      let nail = 0;
      for (let k = 0; k < nails.length; k++) {
        const d = Math.hypot(u - nails[k].x, v - nails[k].y);
        if (d < 0.009) nail = Math.max(nail, 1 - d / 0.009);
      }
      if (nail > 0) {
        const t = smoothstep(0, 0.3, nail);
        r = lerp(r, 0.2, t);
        g = lerp(g, 0.12, t);
        bl = lerp(bl, 0.08, t);
        h += nail * 0.05;
        ro = lerp(ro, 0.6, t);
        metal[i] = t * 0.6;
      }

      // worn stencil paint
      const sm = (stencilPx[i * 4] / 255) * smoothstep(-0.15, 0.25, n.fbm(u * 18, v * 18, 4) + 0.15);
      r = lerp(r, 0.03, sm * 0.85);
      g = lerp(g, 0.03, sm * 0.85);
      bl = lerp(bl, 0.032, sm * 0.85);
      ro = lerp(ro, 0.6, sm);

      // grime along the outer border
      const border = Math.min(u, v, 1 - u, 1 - v);
      const grime = 1 - smoothstep(0.06, 0.0, border) * 0.35;

      height[i] = h;
      albedo[i * 3] = r * grime;
      albedo[i * 3 + 1] = g * grime;
      albedo[i * 3 + 2] = bl * grime;
      rough[i] = ro;
    }
  }

  const ao = cavityAO(height, S, 3, 3, 0.4);
  return {
    albedo: albedoTexture(albedo, S),
    normal: normalTexture(height, S, 2.4),
    orm: ormTexture(ao, rough, metal, S),
  };
}

/** Fine-grained gunmetal / polymer for the weapon viewmodel. */
function generateGunSurface(S, seed, { polymer }) {
  const n = new PerlinNoise(seed);
  const scratches = polymer ? null : scratchMask(S, 90, seed + 2, 0.05);
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);
  const metal = new Float32Array(S * S);
  const albedo = new Float32Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;
      const fine = n.noise2(u * 96, v * 96, 96, 96);
      const wear = n.fbm(u * 6, v * 6, 4, 6);
      if (polymer) {
        const stipple = n.noise2(u * 220, v * 220, 220, 220);
        height[i] = 0.5 + stipple * 0.3 + fine * 0.1;
        rough[i] = 0.68 + stipple * 0.1;
        metal[i] = 0;
        const t = 0.045 + fine * 0.005;
        albedo[i * 3] = t;
        albedo[i * 3 + 1] = t;
        albedo[i * 3 + 2] = t * 1.06;
      } else {
        const sc = scratches[i];
        const edgeWear = smoothstep(0.35, 0.6, wear);
        height[i] = 0.5 + fine * 0.05 - sc * 0.05;
        rough[i] = 0.42 + fine * 0.06 - sc * 0.15 - edgeWear * 0.12;
        metal[i] = 0.7;
        const t = 0.13 + edgeWear * 0.14 + sc * 0.25;
        albedo[i * 3] = t;
        albedo[i * 3 + 1] = t * 1.02;
        albedo[i * 3 + 2] = t * 1.05;
      }
    }
  }
  return {
    albedo: albedoTexture(albedo, S),
    normal: normalTexture(height, S, polymer ? 1.6 : 0.8),
    orm: ormTexture(null, rough, metal, S),
  };
}

/* -------------------------------------------------------------------------- */
/* Special-purpose textures (light cookie, decals, FX)                         */
/* -------------------------------------------------------------------------- */

/**
 * Flashlight "cookie" projected by SpotLight.map: a hot center, a softer
 * spill, faint reflector rings and lens grime, like a real torch beam.
 */
export function createFlashlightCookie(size = 256) {
  const n = new PerlinNoise(77);
  return imageTexture(size, size, (d) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size * 2 - 1;
        const dy = (y + 0.5) / size * 2 - 1;
        const r = Math.sqrt(dx * dx + dy * dy);
        const hot = Math.exp(-Math.pow(r / 0.22, 2)) * 0.9;
        const spill = smoothstep(1.0, 0.45, r) * 0.42;
        const ring1 = Math.exp(-Math.pow((r - 0.3) / 0.035, 2)) * 0.1;
        const ring2 = Math.exp(-Math.pow((r - 0.6) / 0.05, 2)) * 0.08;
        const darkRing = Math.exp(-Math.pow((r - 0.45) / 0.06, 2)) * 0.06;
        const grime = 0.93 + n.fbm(dx * 3 + 5, dy * 3 + 5, 4) * 0.12;
        let I = (hot + spill + ring1 + ring2 - darkRing) * grime;
        I = clamp01(I * smoothstep(1.0, 0.92, r));
        const warm = smoothstep(0.2, 0.9, r);
        const i = (y * size + x) * 4;
        d[i] = linearToSrgb8(I);
        d[i + 1] = linearToSrgb8(I * (1 - warm * 0.07));
        d[i + 2] = linearToSrgb8(I * (1 - warm * 0.18));
        d[i + 3] = 255;
      }
    }
  }, { srgb: true, wrap: false });
}

/** Bullet hole decal: albedo+alpha and a matching crater normal map. */
export function createBulletHole(size = 128) {
  const n = new PerlinNoise(31);
  const height = new Float32Array(size * size);
  const alpha = new Float32Array(size * size);
  const shade = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const jag = n.noise2(Math.cos(ang) * 3 + 10, Math.sin(ang) * 3 + 10) * 0.12;
      const holeR = 0.16 + jag * 0.5;
      const craterR = 0.48 + jag;
      const hole = smoothstep(holeR + 0.03, holeR - 0.02, r);
      const crater = smoothstep(craterR, craterR - 0.12, r);
      const cracks = Math.pow(Math.max(0, n.noise2(Math.cos(ang) * 6, Math.sin(ang) * 6) * 0.5 + 0.5), 6) * smoothstep(1, 0.4, r);
      const soot = smoothstep(0.95, 0.3, r) * 0.45;
      const i = y * size + x;
      height[i] = -hole * 0.9 - crater * (1 - r) * 0.5 + (smoothstep(craterR + 0.1, craterR, r) - crater) * 0.25;
      alpha[i] = clamp01(Math.max(hole, crater * 0.9, cracks * 0.8, soot));
      shade[i] = lerp(lerp(0.28, 0.12, crater), 0.015, hole);
    }
  }
  const map = imageTexture(size, size, (d) => {
    for (let i = 0; i < size * size; i++) {
      const s = linearToSrgb8(shade[i]);
      d[i * 4] = s;
      d[i * 4 + 1] = s;
      d[i * 4 + 2] = s;
      d[i * 4 + 3] = Math.round(alpha[i] * 255);
    }
  }, { srgb: true, wrap: false });
  const normal = normalTexture(height, size, 5);
  normal.wrapS = normal.wrapT = THREE.ClampToEdgeWrapping;
  return { map, normal };
}

/** Star-shaped muzzle flash (front) and an elongated side-view flame. */
export function createMuzzleFlashTextures() {
  const n = new PerlinNoise(911);
  const S = 256;
  const front = imageTexture(S, S, (d) => {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x + 0.5) / S * 2 - 1;
        const dy = (y + 0.5) / S * 2 - 1;
        const r = Math.sqrt(dx * dx + dy * dy);
        const a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
        const spikes = Math.pow(Math.abs(Math.cos(a * Math.PI * 7)), 6) * (0.6 + 0.4 * n.noise2(a * 24, 0.5, 24, 24));
        const len = 0.18 + spikes * 0.75 + n.noise2(a * 48, 3.3, 48, 48) * 0.06;
        const I = clamp01(Math.exp(-Math.pow(r / Math.max(0.05, len), 2) * 3) * 1.2 + Math.exp(-Math.pow(r / 0.12, 2)));
        const core = Math.exp(-Math.pow(r / 0.18, 2));
        const i = (y * S + x) * 4;
        d[i] = 255;
        d[i + 1] = Math.round(lerp(150, 245, core) * clamp01(I * 1.3));
        d[i + 2] = Math.round(lerp(40, 210, core) * clamp01(I * 1.1));
        d[i + 3] = Math.round(I * 255);
      }
    }
  }, { srgb: true, wrap: false });
  const W = 256;
  const H = 128;
  const side = imageTexture(W, H, (d) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = x / W; // 0 at muzzle, 1 at tip
        const c = (y + 0.5) / H * 2 - 1;
        const width = (0.25 + 0.55 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.85)) * (1 - t * 0.85) + n.noise2(t * 10, 1.7) * 0.08;
        const body = smoothstep(width, width * 0.25, Math.abs(c));
        const fade = Math.pow(1 - t, 1.4) * smoothstep(0, 0.05, t);
        const flick = 0.75 + 0.25 * n.noise2(t * 18, c * 4);
        const I = clamp01(body * fade * flick * 1.4);
        const core = smoothstep(0.35, 0.0, Math.abs(c) / Math.max(0.01, width)) * (1 - t);
        const i = (y * W + x) * 4;
        d[i] = 255;
        d[i + 1] = Math.round(lerp(130, 235, core) * clamp01(I * 1.4));
        d[i + 2] = Math.round(lerp(30, 190, core) * I);
        d[i + 3] = Math.round(I * 255);
      }
    }
  }, { srgb: true, wrap: false });
  return { front, side };
}

/** Soft round sprite used by spark and dust particles. */
export function createSoftParticle(size = 64) {
  return imageTexture(size, size, (d) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size * 2 - 1;
        const dy = (y + 0.5) / size * 2 - 1;
        const r = Math.sqrt(dx * dx + dy * dy);
        const a = clamp01(Math.exp(-r * r * 4.5) * smoothstep(1, 0.8, r));
        const i = (y * size + x) * 4;
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = Math.round(a * 255);
      }
    }
  }, { srgb: false, wrap: false });
}

/** Illuminated EXIT sign face (used as both map and emissiveMap). */
export function createExitSign() {
  const W = 256;
  const H = 96;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0d0b';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1b2a1f';
  ctx.fillRect(6, 6, W - 12, H - 12);
  ctx.fillStyle = '#49ff8a';
  ctx.font = `bold 60px "Bahnschrift", "Arial Narrow", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EXIT', W * 0.43, H * 0.54);
  // arrow
  ctx.beginPath();
  ctx.moveTo(W * 0.8, H * 0.3);
  ctx.lineTo(W * 0.92, H * 0.5);
  ctx.lineTo(W * 0.8, H * 0.7);
  ctx.closePath();
  ctx.fill();
  return canvasTexture(canvas, { srgb: true, wrap: false });
}

/** Large worn stencil lettering for walls (alpha-masked decal). */
export function createWallStencil(text, { color = '#d8c9a6', width = 1024, height = 256, seed = 5 } = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(height * 0.72)}px "Bahnschrift", "Arial Narrow", Impact, sans-serif`;
  ctx.fillText(text, width / 2, height / 2 + height * 0.04);
  const img = ctx.getImageData(0, 0, width, height);
  const n = new PerlinNoise(seed);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (d[i + 3] === 0) continue;
      const wear = n.fbm(x / 90, y / 90, 5) + n.noise2(x / 6, y / 6) * 0.2;
      const keep = smoothstep(-0.25, 0.1, wear);
      d[i + 3] = Math.round(d[i + 3] * keep * 0.85);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(canvas, { srgb: true, wrap: false });
}

/** Worn yellow floor-marking paint, tileable along U. */
export function createFloorMarking() {
  const W = 512;
  const H = 32;
  const n = new PerlinNoise(404);
  return imageTexture(W, H, (d) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const v = y / H;
        const wear = n.fbm(u * 16, v * 1, 5, 16) + n.noise2(u * 128, v * 8, 128, 8) * 0.25;
        const edge = smoothstep(0.0, 0.12, v) * smoothstep(1.0, 0.88, v);
        const a = clamp01(smoothstep(-0.35, 0.05, wear) * edge);
        const i = (y * W + x) * 4;
        d[i] = linearToSrgb8(0.62);
        d[i + 1] = linearToSrgb8(0.42);
        d[i + 2] = linearToSrgb8(0.03);
        d[i + 3] = Math.round(a * 235);
      }
    }
  }, { srgb: true });
}

/* -------------------------------------------------------------------------- */
/* UV helpers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Re-projects a box's UVs into world-scaled planar coordinates so that a
 * tileable texture keeps the same texel density on every face, and so that
 * adjacent boxes line up. `tile` is the world size of one texture repeat.
 */
export function applyWorldUVs(geometry, tile, offset = new THREE.Vector3()) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x;
    const y = pos.getY(i) + offset.y;
    const z = pos.getZ(i) + offset.z;
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let u;
    let v;
    if (ax >= ay && ax >= az) {
      u = nrm.getX(i) > 0 ? -z : z;
      v = y;
    } else if (ay >= az) {
      u = x;
      v = nrm.getY(i) > 0 ? -z : z;
    } else {
      u = nrm.getZ(i) > 0 ? x : -x;
      v = y;
    }
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
  return geometry;
}

/** Scales a cylinder's default UVs to world units (circumference x length). */
export function applyCylinderUVs(geometry, radius, length, tile) {
  const uv = geometry.attributes.uv;
  const cu = (Math.PI * 2 * radius) / tile;
  const cv = length / tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * cu, uv.getY(i) * cv);
  uv.needsUpdate = true;
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

const nextFrame = () =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 32);
  });

/**
 * Generates every material in the game. Generation runs on the main thread
 * but yields between surfaces so the loading screen can repaint.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {(progress: number, label: string) => void} onProgress
 * @param {{ textureSize?: number }} options
 */
export async function generateMaterials(renderer, onProgress = () => {}, { textureSize = 1024 } = {}) {
  maxAnisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const big = textureSize;
  const med = Math.max(256, textureSize >> 1);

  const tasks = [
    ['concreteFloor', 'Pouring wet concrete', () => generateWetConcrete(big, 101)],
    ['concreteWall', 'Casting wall panels', () => generateConcreteWall(big, 202)],
    ['rustedMetal', 'Oxidising steel plates', () => generateRustedMetal(big, 303)],
    ['containerPaint', 'Painting containers', () => generatePaintedMetal(med, 404, { color: [0.05, 0.16, 0.17], corrugations: 16, chipAmount: 0.45 })],
    ['drumRed', 'Painting oil drums', () => generatePaintedMetal(med, 505, { color: [0.32, 0.03, 0.02], ribs: [0.33, 0.67], chipAmount: 0.6, tileable: false })],
    ['drumBlue', 'Painting oil drums', () => generatePaintedMetal(med, 606, { color: [0.03, 0.08, 0.26], ribs: [0.33, 0.67], chipAmount: 0.55, tileable: false })],
    ['hazard', 'Striping hazard paint', () => generatePaintedMetal(med, 707, { color: [0.68, 0.46, 0.02], stripes: 6, chipAmount: 0.7 })],
    ['crateA', 'Nailing crates', () => generateCrate(med, 808, ['UFP-07', 'HANDLE WITH CARE'])],
    ['crateB', 'Nailing crates', () => generateCrate(med, 909, ['B2 // 114', 'THIS SIDE UP'])],
    ['gunMetal', 'Machining receiver', () => generateGunSurface(256, 1001, { polymer: false })],
    ['gunPolymer', 'Moulding polymer', () => generateGunSurface(256, 1002, { polymer: true })],
  ];

  const maps = {};
  for (let k = 0; k < tasks.length; k++) {
    const [key, label, fn] = tasks[k];
    onProgress(k / tasks.length, label);
    await nextFrame();
    maps[key] = fn();
  }
  onProgress(1, 'Assembling materials');
  await nextFrame();

  const m = {};
  m.concreteFloor = pbrMaterial(maps.concreteFloor, { envMapIntensity: 0.6 });
  m.concreteWall = pbrMaterial(maps.concreteWall);
  m.ceiling = pbrMaterial(maps.concreteWall, { color: new THREE.Color(0.45, 0.45, 0.47) });
  m.rustedMetal = pbrMaterial(maps.rustedMetal);
  m.containerPaint = pbrMaterial(maps.containerPaint);
  m.drumRed = pbrMaterial(maps.drumRed);
  m.drumBlue = pbrMaterial(maps.drumBlue);
  m.hazard = pbrMaterial(maps.hazard);
  m.crateA = pbrMaterial(maps.crateA);
  m.crateB = pbrMaterial(maps.crateB);
  m.gunMetal = pbrMaterial(maps.gunMetal);
  m.gunPolymer = pbrMaterial(maps.gunPolymer);
  m.gunAccent = pbrMaterial(maps.gunMetal, { color: new THREE.Color(0.55, 0.5, 0.42) });

  const hole = createBulletHole();
  m.bulletHole = new THREE.MeshStandardMaterial({
    map: hole.map,
    normalMap: hole.normal,
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  const textures = {
    flashlightCookie: createFlashlightCookie(),
    muzzle: createMuzzleFlashTextures(),
    softParticle: createSoftParticle(),
    exitSign: createExitSign(),
    floorMarking: createFloorMarking(),
    stencilSector: createWallStencil('SECTOR 7', { seed: 3 }),
    stencilNoEntry: createWallStencil('NO ENTRY', { color: '#c9452f', seed: 8 }),
  };

  return { materials: m, textures };
}
