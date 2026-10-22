/**
 * Dunebound - rendering engine.
 *
 * WebGLRenderer with PCF soft shadows and ACES filmic tone mapping, a custom
 * golden-hour sky, procedural PBR textures generated from periodic Perlin
 * noise (no image files), the desert environment, and a cinematic post stack:
 * RenderPass -> volumetric god rays -> UnrealBloomPass -> OutputPass.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { riverPolyline, tintColor } from './pyramid.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD_X = new Float32Array(8);
const GRAD_Y = new Float32Array(8);
for (let i = 0; i < 8; i++) {
  GRAD_X[i] = Math.cos((i * Math.PI) / 4);
  GRAD_Y[i] = Math.sin((i * Math.PI) / 4);
}

/** Seeded, periodic 2D improved Perlin noise. Periods must be integers <= 256. */
export class Perlin {
  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise(x, y, px = 256, py = 256) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % px) + px) % px;
    const y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const perm = this.perm;
    const h00 = perm[perm[x0] + y0] & 7;
    const h10 = perm[perm[x1] + y0] & 7;
    const h01 = perm[perm[x0] + y1] & 7;
    const h11 = perm[perm[x1] + y1] & 7;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const n00 = GRAD_X[h00] * xf + GRAD_Y[h00] * yf;
    const n10 = GRAD_X[h10] * (xf - 1) + GRAD_Y[h10] * yf;
    const n01 = GRAD_X[h01] * xf + GRAD_Y[h01] * (yf - 1);
    const n11 = GRAD_X[h11] * (xf - 1) + GRAD_Y[h11] * (yf - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.41421356;
  }

  /** Fractal Brownian motion; tileable when `period * 2^octaves <= 256`. */
  fbm(x, y, octaves, period = 256, gain = 0.5) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const p = Math.min(256, period * freq);
      sum += amp * this.noise(x * freq, y * freq, p, p);
      norm += amp;
      amp *= gain;
      freq *= 2;
    }
    return sum / norm;
  }

  /** Ridged multifractal, good for cracks and dune crests. */
  ridged(x, y, octaves, period = 256) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const p = Math.min(256, period * freq);
      const n = 1 - Math.abs(this.noise(x * freq, y * freq, p, p));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}

// ---------------------------------------------------------------------------
// Procedural PBR texture factory
// ---------------------------------------------------------------------------

function hash2(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

class TextureFactory {
  constructor(renderer) {
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  data(arr, w, h, srgb, repeat = true) {
    const t = new THREE.DataTexture(arr, w, h, THREE.RGBAFormat);
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = this.anisotropy;
    t.needsUpdate = true;
    return t;
  }

  /** Converts a wrapped height field to a tangent-space (OpenGL convention) normal map. */
  normalFromHeight(hf, w, h, strength) {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const yu = ((y + 1) % h) * w;
      const yd = ((y - 1 + h) % h) * w;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xr = (x + 1) % w;
        const xl = (x - 1 + w) % w;
        const dx = (hf[row + xr] - hf[row + xl]) * strength;
        const dy = (hf[yu + x] - hf[yd + x]) * strength;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const i = (row + x) * 4;
        out[i] = (-dx * inv * 0.5 + 0.5) * 255;
        out[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
        out[i + 2] = (inv * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  sand(size = 512) {
    const perlin = new Perlin(101);
    const hf = new Float32Array(size * size);
    const albedo = new Uint8Array(size * size * 4);
    const rough = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const warp = perlin.fbm(u * 4, v * 4, 3, 4);
        const large = perlin.fbm(u * 2 + 7.3, v * 2 + 1.1, 4, 2);
        // Wind ripples: a warped sine wave across the tile (12 ripples per tile keeps it periodic).
        const rip = Math.sin((v * 12 + warp * 0.9 + large * 0.4) * Math.PI * 2);
        const ripple = Math.pow(rip * 0.5 + 0.5, 1.6);
        const grain = hash2(x, y, 7);
        const height = ripple * 0.55 + large * 0.35 + grain * 0.08;
        hf[y * size + x] = height;
        const i = (y * size + x) * 4;
        const tone = 0.86 + large * 0.12 + ripple * 0.07 + (grain - 0.5) * 0.12;
        const speck = grain > 0.985 ? -0.25 : grain < 0.01 ? 0.18 : 0;
        albedo[i] = clamp01((0.86 + speck) * tone) * 255;
        albedo[i + 1] = clamp01((0.7 + speck) * tone) * 255;
        albedo[i + 2] = clamp01((0.49 + speck * 0.8) * tone) * 255;
        albedo[i + 3] = 255;
        const r = clamp01(0.95 - ripple * 0.12 + (grain - 0.5) * 0.1);
        rough[i] = rough[i + 1] = rough[i + 2] = r * 255;
        rough[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 3.2), size, size, false),
      roughnessMap: this.data(rough, size, size, false),
    };
  }

  /**
   * Weathered limestone: sedimentary strata, fossil-shell pits, quarry chisel
   * grooves and hairline cracks, all tileable so every block can sample a
   * different window of the same texture.
   */
  stone(size = 512, seed = 202, opts = {}) {
    const perlin = new Perlin(seed);
    const hf = new Float32Array(size * size);
    const albedo = new Uint8Array(size * size * 4);
    const rough = new Uint8Array(size * size * 4);
    const base = opts.base || [0.9, 0.81, 0.66];
    const crackAmt = opts.cracks ?? 1;
    const fossils = new Float32Array(size * size);
    const rand = mulberry32(seed * 3 + 1);
    const nFossils = Math.round((size * size) / 2600);
    for (let f = 0; f < nFossils; f++) {
      const cx = rand() * size;
      const cy = rand() * size;
      const r = 1.5 + rand() * rand() * (size / 90);
      const ring = rand() < 0.5;
      for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++) {
        for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
          const d = Math.hypot(x - cx, y - cy);
          const a = ring ? Math.max(0, 1 - Math.abs(d - r * 0.8) / 1.2) : Math.max(0, 1 - d / r);
          const i = (((y % size) + size) % size) * size + (((x % size) + size) % size);
          if (a > fossils[i]) fossils[i] = a;
        }
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const macro = perlin.fbm(u * 3, v * 3, 5, 3);
        const detail = perlin.fbm(u * 16 + 3.7, v * 16 + 9.1, 3, 16);
        const micro = perlin.noise(u * 64 + 1.1, v * 64 + 7.7, 64, 64);
        const strataWarp = perlin.fbm(u * 2 + 5.0, v * 2 + 2.0, 3, 2);
        const strata = Math.sin((v * 7 + strataWarp * 0.7) * Math.PI * 2);
        const crack = perlin.ridged(u * 4 + 11.0, v * 4 + 5.0, 4, 4);
        const crackLine = smooth(0.9, 0.985, crack) * crackAmt;
        const patch = smooth(0.15, 0.5, perlin.fbm(u * 4 + 21.0, v * 4 + 3.0, 2, 4));
        const groove = Math.sin((u * 52 + v * 20 + perlin.noise(u * 8, v * 8, 8, 8) * 1.3) * Math.PI);
        const chisel = smooth(0.7, 0.95, groove * 0.5 + 0.5) * 0.14 * patch;
        const pit = smooth(0.66, 0.78, perlin.noise(u * 40 + 1.3, v * 40 + 2.9, 40, 40)) * 0.3;
        const fos = fossils[y * size + x];
        const grain = hash2(x, y, seed);
        const height =
          macro * 0.45 + detail * 0.2 + micro * 0.05 + strata * 0.04 - crackLine * 0.45 - chisel - pit - fos * 0.3 + grain * 0.04;
        hf[y * size + x] = height;
        const i = (y * size + x) * 4;
        const stain = perlin.fbm(u * 2 + 4.4, v * 5 + 0.2, 3, 2);
        const tone =
          0.92 + macro * 0.1 + detail * 0.05 + strata * 0.025 + (grain - 0.5) * 0.05 - crackLine * 0.22 - pit * 0.18 - fos * 0.12;
        const warm = 1 + stain * 0.07;
        albedo[i] = clamp01(base[0] * tone * warm) * 255;
        albedo[i + 1] = clamp01(base[1] * tone * (1 + stain * 0.02)) * 255;
        albedo[i + 2] = clamp01(base[2] * tone * (1 - stain * 0.08)) * 255;
        albedo[i + 3] = 255;
        const r = clamp01(0.8 + crackLine * 0.12 + pit * 0.15 + fos * 0.1 - detail * 0.06 - chisel * 0.3 + (grain - 0.5) * 0.06);
        rough[i] = rough[i + 1] = rough[i + 2] = r * 255;
        rough[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, opts.normalStrength || 4), size, size, false),
      roughnessMap: this.data(rough, size, size, false),
    };
  }

  /** Fine pores and creases for skin. */
  skin(size = 256) {
    const perlin = new Perlin(1201);
    const hf = new Float32Array(size * size);
    const rough = new Uint8Array(size * size * 4);
    const albedo = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const pores = smooth(0.55, 0.8, perlin.noise(u * 96, v * 96, 96, 96) * 0.5 + 0.5);
        const crease = perlin.ridged(u * 6, v * 6, 3, 6);
        const n = perlin.fbm(u * 16, v * 16, 3, 16);
        const blotch = perlin.fbm(u * 4 + 9, v * 4 + 2, 3, 4);
        hf[y * size + x] = n * 0.3 - pores * 0.25 - smooth(0.85, 1, crease) * 0.2;
        const i = (y * size + x) * 4;
        const r = clamp01(0.5 + pores * 0.15 + n * 0.08);
        rough[i] = rough[i + 1] = rough[i + 2] = r * 255;
        rough[i + 3] = 255;
        // Subtle melanin/haemoglobin variation so skin never reads as flat plastic.
        const tone = 0.9 + blotch * 0.08 + n * 0.03 - pores * 0.03;
        albedo[i] = clamp01(tone * (1 + blotch * 0.04)) * 255;
        albedo[i + 1] = clamp01(tone) * 255;
        albedo[i + 2] = clamp01(tone * (1 - blotch * 0.03)) * 255;
        albedo[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 2.2), size, size, false),
      roughnessMap: this.data(rough, size, size, false),
    };
  }

  /** Directional fur strands (v runs along the hair). Albedo is greyscale and tinted by material colour. */
  fur(size = 256) {
    const perlin = new Perlin(1301);
    const hf = new Float32Array(size * size);
    const albedo = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const strands = perlin.fbm(u * 64, v * 8, 3, 8);
        const clumps = perlin.fbm(u * 8 + 3, v * 4 + 1, 3, 4);
        const fine = hash2(x, Math.floor(y / 6), 13);
        const h = strands * 0.6 + clumps * 0.3 + fine * 0.15;
        hf[y * size + x] = h;
        const i = (y * size + x) * 4;
        const t = clamp01(0.78 + strands * 0.18 + clumps * 0.12 + (fine - 0.5) * 0.12);
        albedo[i] = albedo[i + 1] = albedo[i + 2] = t * 255;
        albedo[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 3.5), size, size, false),
    };
  }

  /** Woven linen for kilts and blankets. */
  linen(size = 256) {
    const perlin = new Perlin(1401);
    const hf = new Float32Array(size * size);
    const albedo = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const warp = Math.sin(x * 1.6 + perlin.noise(u * 16, v * 16, 16, 16) * 0.8) * 0.5 + 0.5;
        const weft = Math.sin(y * 1.6 + perlin.noise(u * 16 + 5, v * 16 + 5, 16, 16) * 0.8) * 0.5 + 0.5;
        const over = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? warp : weft;
        const slub = perlin.fbm(u * 4, v * 32, 3, 4);
        hf[y * size + x] = over * 0.5 + slub * 0.2;
        const i = (y * size + x) * 4;
        const t = clamp01(0.88 + over * 0.07 + slub * 0.06 + (hash2(x, y, 4) - 0.5) * 0.04);
        albedo[i] = t * 255;
        albedo[i + 1] = t * 0.975 * 255;
        albedo[i + 2] = t * 0.93 * 255;
        albedo[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 1.4), size, size, false),
    };
  }

  /** Bands of faience, lapis, carnelian and gold beads for the broad usekh collar (v runs across bands). */
  beads(w = 128, h = 256) {
    const bands = [
      [0.85, 0.62, 0.2],
      [0.12, 0.28, 0.62],
      [0.85, 0.62, 0.2],
      [0.66, 0.16, 0.08],
      [0.2, 0.58, 0.55],
      [0.85, 0.62, 0.2],
      [0.12, 0.28, 0.62],
      [0.85, 0.62, 0.2],
    ];
    const albedo = new Uint8Array(w * h * 4);
    const hf = new Float32Array(w * h);
    const bandH = h / bands.length;
    for (let y = 0; y < h; y++) {
      const b = Math.floor(y / bandH);
      const fy = (y % bandH) / bandH;
      const col = bands[b];
      for (let x = 0; x < w; x++) {
        const beadsPerRow = 16;
        const fx = ((x / w) * beadsPerRow) % 1;
        const d = Math.hypot(fx - 0.5, (fy - 0.5) * 1.2);
        const bead = clamp01(1 - d * 2.1);
        hf[y * w + x] = Math.sqrt(bead);
        const i = (y * w + x) * 4;
        const shade = 0.55 + bead * 0.55;
        albedo[i] = clamp01(col[0] * shade) * 255;
        albedo[i + 1] = clamp01(col[1] * shade) * 255;
        albedo[i + 2] = clamp01(col[2] * shade) * 255;
        albedo[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, w, h, true),
      normalMap: this.data(this.normalFromHeight(hf, w, h, 3), w, h, false),
    };
  }

  /** Limestone carved with columns of procedural hieroglyphs (for obelisks). */
  glyphs(size = 512) {
    const perlin = new Perlin(303);
    const rand = mulberry32(77);
    const carve = new Float32Array(size * size);
    const cells = 8;
    const cs = size / cells;
    const stampDisc = (cx, cy, r0, r1) => {
      const x0 = Math.floor(cx - r1 - 2);
      const x1 = Math.ceil(cx + r1 + 2);
      const y0 = Math.floor(cy - r1 - 2);
      const y1 = Math.ceil(cy + r1 + 2);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy);
          const a = r0 > 0 ? smooth(r0 - 1.5, r0, d) * (1 - smooth(r1, r1 + 1.5, d)) : 1 - smooth(r1, r1 + 1.5, d);
          const idx = (((y % size) + size) % size) * size + (((x % size) + size) % size);
          if (a > carve[idx]) carve[idx] = a;
        }
      }
    };
    const stampLine = (ax, ay, bx, by, w) => {
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(2, Math.ceil(len));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        stampDisc(ax + (bx - ax) * t, ay + (by - ay) * t, 0, w);
      }
    };
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++) {
        const ox = gx * cs;
        const oy = gy * cs;
        const c = cs / 2;
        const kind = Math.floor(rand() * 7);
        const w = 2.2;
        if (kind === 0) stampDisc(ox + c, oy + c, cs * 0.22, cs * 0.28);
        else if (kind === 1) {
          // ankh
          stampDisc(ox + c, oy + c + cs * 0.18, cs * 0.1, cs * 0.15);
          stampLine(ox + c, oy + c + cs * 0.05, ox + c, oy + c - cs * 0.32, w);
          stampLine(ox + c - cs * 0.18, oy + c - 0.02 * cs, ox + c + cs * 0.18, oy + c - 0.02 * cs, w);
        } else if (kind === 2) {
          // water ripple
          for (let k = -1; k <= 1; k++) {
            let px = ox + cs * 0.15;
            let py = oy + c + k * cs * 0.16;
            for (let s = 1; s <= 12; s++) {
              const nx = ox + cs * 0.15 + (cs * 0.7 * s) / 12;
              const ny = oy + c + k * cs * 0.16 + Math.sin(s * 1.6) * cs * 0.05;
              stampLine(px, py, nx, ny, w * 0.8);
              px = nx;
              py = ny;
            }
          }
        } else if (kind === 3) {
          // eye
          for (let s = 0; s < 24; s++) {
            const a = (s / 24) * Math.PI * 2;
            stampDisc(ox + c + Math.cos(a) * cs * 0.3, oy + c + Math.sin(a) * cs * 0.14, 0, w * 0.8);
          }
          stampDisc(ox + c, oy + c, 0, cs * 0.08);
          stampLine(ox + c - cs * 0.05, oy + c - cs * 0.14, ox + c - cs * 0.15, oy + c - cs * 0.34, w);
        } else if (kind === 4) {
          // triangle (pyramid)
          const a = [ox + c, oy + c + cs * 0.3];
          const b = [ox + c - cs * 0.3, oy + c - cs * 0.25];
          const d = [ox + c + cs * 0.3, oy + c - cs * 0.25];
          stampLine(a[0], a[1], b[0], b[1], w);
          stampLine(b[0], b[1], d[0], d[1], w);
          stampLine(d[0], d[1], a[0], a[1], w);
        } else if (kind === 5) {
          // bird-ish: body + head + legs
          stampDisc(ox + c, oy + c, 0, cs * 0.16);
          stampDisc(ox + c + cs * 0.17, oy + c + cs * 0.15, 0, cs * 0.07);
          stampLine(ox + c - cs * 0.05, oy + c - cs * 0.15, ox + c - cs * 0.08, oy + c - cs * 0.34, w);
          stampLine(ox + c + cs * 0.05, oy + c - cs * 0.15, ox + c + cs * 0.06, oy + c - cs * 0.34, w);
          stampLine(ox + c - cs * 0.15, oy + c, ox + c - cs * 0.34, oy + c - cs * 0.08, w);
        } else {
          // reed / staff
          stampLine(ox + c, oy + cs * 0.15, ox + c, oy + cs * 0.85, w);
          stampDisc(ox + c, oy + cs * 0.8, 0, cs * 0.09);
        }
      }
      // Horizontal register lines between glyph rows.
      stampLine(0, gy * cs + 1, size - 1, gy * cs + 1, 1.2);
    }
    const hf = new Float32Array(size * size);
    const albedo = new Uint8Array(size * size * 4);
    const rough = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const macro = perlin.fbm(u * 3, v * 3, 5, 3);
        const grain = hash2(x, y, 9);
        const k = carve[y * size + x];
        hf[y * size + x] = macro * 0.4 + grain * 0.04 - k * 0.9;
        const i = (y * size + x) * 4;
        const tone = 0.92 + macro * 0.14 + (grain - 0.5) * 0.06;
        // Faded lapis pigment remains in the carvings.
        const r = 0.84 * tone * (1 - k) + 0.24 * k;
        const g = 0.7 * tone * (1 - k) + 0.34 * k;
        const b = 0.5 * tone * (1 - k) + 0.5 * k;
        albedo[i] = clamp01(r) * 255;
        albedo[i + 1] = clamp01(g) * 255;
        albedo[i + 2] = clamp01(b) * 255;
        albedo[i + 3] = 255;
        const ro = clamp01(0.78 + k * 0.12 + (grain - 0.5) * 0.08);
        rough[i] = rough[i + 1] = rough[i + 2] = ro * 255;
        rough[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 5), size, size, false),
      roughnessMap: this.data(rough, size, size, false),
    };
  }

  wood(size = 256) {
    const perlin = new Perlin(404);
    const hf = new Float32Array(size * size);
    const albedo = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const n = perlin.fbm(u * 4, v * 32, 4, 4);
        const rings = Math.sin((u * 24 + n * 2.5) * Math.PI * 2) * 0.5 + 0.5;
        const grain = hash2(x, y, 3);
        hf[y * size + x] = rings * 0.4 + n * 0.3 + grain * 0.05;
        const i = (y * size + x) * 4;
        const tone = 0.75 + rings * 0.25 + n * 0.15;
        albedo[i] = clamp01(0.45 * tone) * 255;
        albedo[i + 1] = clamp01(0.3 * tone) * 255;
        albedo[i + 2] = clamp01(0.18 * tone) * 255;
        albedo[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 2.5), size, size, false),
    };
  }

  cloth(size = 256) {
    const perlin = new Perlin(505);
    const albedo = new Uint8Array(size * size * 4);
    const hf = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const weave = (Math.sin(x * 1.7) * Math.sin(y * 1.7)) * 0.5 + 0.5;
        const n = perlin.fbm(u * 4, (y / size) * 4, 3, 4);
        const band = Math.floor(u * 8) % 2;
        const gold = Math.abs(((u * 8) % 1) - 0.5) > 0.46;
        let col = band ? [0.62, 0.16, 0.12] : [0.93, 0.86, 0.7];
        if (gold) col = [0.85, 0.62, 0.22];
        const tone = 0.85 + weave * 0.1 + n * 0.08;
        const i = (y * size + x) * 4;
        albedo[i] = clamp01(col[0] * tone) * 255;
        albedo[i + 1] = clamp01(col[1] * tone) * 255;
        albedo[i + 2] = clamp01(col[2] * tone) * 255;
        albedo[i + 3] = 255;
        hf[y * size + x] = weave * 0.3 + n * 0.2;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 1.5), size, size, false),
    };
  }

  /** Nemes-style stripes; multiplied by the player colour in the material. */
  stripes(size = 128) {
    const albedo = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = Math.floor((y / size) * 10) % 2;
        const i = (y * size + x) * 4;
        const val = s ? 255 : 120;
        albedo[i] = val;
        albedo[i + 1] = s ? 255 : 105;
        albedo[i + 2] = s ? 255 : 80;
        albedo[i + 3] = 255;
      }
    }
    return this.data(albedo, size, size, true);
  }

  frond(w = 128, h = 512) {
    const perlin = new Perlin(606);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const v = y / h;
      const envelope = 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.05)), 0.7);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const off = Math.abs(u - 0.5);
        const s = v * 46 - off * 9;
        const leaflet = s - Math.floor(s) < 0.62;
        const rib = off < 0.025;
        const inside = off < envelope && (leaflet || rib) && v > 0.04;
        const n = perlin.noise(u * 8, v * 32, 8, 32);
        const i = (y * w + x) * 4;
        const dry = smooth(0.75, 1, v) * 0.5 + smooth(0.3, 0.5, off) * 0.3;
        data[i] = clamp01(0.2 + dry * 0.35 + n * 0.05) * 255;
        data[i + 1] = clamp01(0.36 + dry * 0.12 + n * 0.06 - off * 0.2) * 255;
        data[i + 2] = clamp01(0.1 + n * 0.03) * 255;
        data[i + 3] = inside ? 255 : 0;
      }
    }
    const t = this.data(data, w, h, true, false);
    return t;
  }

  water(size = 256) {
    const perlin = new Perlin(707);
    const hf = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        hf[y * size + x] = perlin.fbm(x / size * 6, y / size * 6, 4, 6);
      }
    }
    return this.data(this.normalFromHeight(hf, size, size, 2.2), size, size, false);
  }

  /**
   * Flowing-river ripples: a sum of sharpened directional waves with integer
   * wave numbers (so the tile wraps) whose crests mostly run across the flow
   * (texture u = downstream). RGB = tangent-space normal, A = crest height.
   */
  riverNormal(size = 256) {
    const perlin = new Perlin(717);
    const waves = [
      [3, 1, 0.42, 0.3],
      [5, -2, 0.3, 1.9],
      [2, 3, 0.22, 4.1],
      [7, 1, 0.16, 2.6],
      [4, -5, 0.12, 0.7],
      [11, 3, 0.07, 5.3],
      [9, -6, 0.06, 3.3],
      [15, 2, 0.035, 1.2],
    ];
    const hf = new Float32Array(size * size);
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const warp = perlin.fbm(u * 4, v * 4, 3, 4) * 1.6;
        let h = 0;
        for (const [kx, ky, amp, ph] of waves) {
          const s = Math.sin((kx * u + ky * v) * Math.PI * 2 + ph + warp * (1 + kx * 0.08));
          // Sharp crests, broad troughs (a cheap trochoid).
          h += amp * (Math.pow(s * 0.5 + 0.5, 1.8) - 0.4);
        }
        h += perlin.fbm(u * 16 + 3.1, v * 16 + 7.9, 3, 16) * 0.12;
        hf[y * size + x] = h;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    const out = this.normalFromHeight(hf, size, size, 3.4);
    for (let i = 0; i < size * size; i++) out[i * 4 + 3] = ((hf[i] - lo) / (hi - lo)) * 255;
    return this.data(out, size, size, false);
  }

  /**
   * General-purpose tileable noise for shaders. R: low-frequency fbm,
   * G: mid-frequency fbm, B: bubbly foam lace (cellular), A: caustic network.
   */
  noise(size = 256) {
    const perlin = new Perlin(818);
    const cellular = (u, v, cells, seed) => {
      const gx = u * cells;
      const gy = v * cells;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      let f1 = 9;
      let f2 = 9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = ix + ox;
          const cy = iy + oy;
          const wx = ((cx % cells) + cells) % cells;
          const wy = ((cy % cells) + cells) % cells;
          const px = cx + hash2(wx, wy, seed);
          const py = cy + hash2(wx, wy, seed + 17);
          const d = Math.hypot(px - gx, py - gy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      }
      return [f1, f2];
    };
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const i = (y * size + x) * 4;
        data[i] = clamp01(perlin.fbm(u * 4, v * 4, 4, 4) * 0.5 + 0.5) * 255;
        data[i + 1] = clamp01(perlin.fbm(u * 8 + 3.1, v * 8 + 1.7, 3, 8) * 0.5 + 0.5) * 255;
        // Foam: a soft, thick bubble network with dark holes, broken up by fbm patches.
        const [a1, a2] = cellular(u, v, 12, 31);
        const [b1, b2] = cellular(u, v, 26, 57);
        const net = 1 - smooth(0.0, 0.34, a2 - a1);
        const fine = 1 - smooth(0.0, 0.24, b2 - b1);
        const holes = smooth(0.2, 0.06, b1);
        const patch = perlin.fbm(u * 8 + 5.3, v * 8 + 2.1, 3, 8) * 0.5 + 0.5;
        data[i + 2] = clamp01(net * 0.55 + fine * 0.3 + patch * 0.4 - holes * 0.45 - 0.08) * 255;
        const [c1, c2] = cellular(u, v, 7, 91);
        data[i + 3] = Math.pow(clamp01(1 - (c2 - c1) * 3.2), 3.5) * 255;
      }
    }
    return this.data(data, size, size, false);
  }

  /**
   * Dressed limestone ashlar: four courses per tile of blocks with random
   * lengths, recessed sandy joints, chipped arrises and per-block tone, used
   * for the causeway, quay and other masonry.
   */
  masonry(size = 512) {
    const perlin = new Perlin(1601);
    const courses = 4;
    const cuts = [];
    const rand = mulberry32(1607);
    for (let c = 0; c < courses; c++) {
      const n = 2 + Math.floor(rand() * 2);
      const off = rand();
      const list = [];
      for (let k = 0; k < n; k++) list.push((off + (k + 0.25 + rand() * 0.5) / n) % 1);
      cuts.push(list.sort((a, b) => a - b));
    }
    const hf = new Float32Array(size * size);
    const albedo = new Uint8Array(size * size * 4);
    const rough = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      const cv = v * courses;
      const course = Math.floor(cv);
      const fy = cv - course;
      const list = cuts[course];
      for (let x = 0; x < size; x++) {
        const u = x / size;
        // Distance to the nearest vertical joint in this course (wrapping).
        let dj = 1;
        let block = 0;
        for (let k = 0; k < list.length; k++) {
          const d = Math.abs(u - list[k]);
          dj = Math.min(dj, d, 1 - d);
          if (u >= list[k]) block = k + 1;
        }
        if (block === list.length) block = 0;
        const edge = Math.min(dj, Math.min(fy, 1 - fy) / courses);
        const wobble = perlin.noise(u * 24, v * 24, 24, 24) * 0.004;
        const joint = 1 - smooth(0.004, 0.011, edge + wobble);
        const arris = 1 - smooth(0.008, 0.03, edge + wobble * 2);
        const macro = perlin.fbm(u * 4, v * 4, 4, 4);
        const detail = perlin.fbm(u * 24 + 5.5, v * 24 + 1.3, 3, 24);
        const chip = smooth(0.25, 0.6, perlin.noise(u * 32 + 9.1, v * 32 + 2.2, 32, 32)) * arris;
        const grain = hash2(x, y, 1601);
        const bt = hash2(course * 7 + block, course, 1609);
        hf[y * size + x] = 0.6 - joint * 0.55 - arris * 0.12 - chip * 0.2 + macro * 0.12 + detail * 0.06 + grain * 0.03;
        const i = (y * size + x) * 4;
        const tone = (0.86 + bt * 0.16 + macro * 0.08 + detail * 0.04 + (grain - 0.5) * 0.05) * (1 - joint * 0.32) * (1 - chip * 0.1);
        const warm = 1 + (bt - 0.5) * 0.06;
        albedo[i] = clamp01(0.9 * tone * warm) * 255;
        albedo[i + 1] = clamp01(0.79 * tone) * 255;
        albedo[i + 2] = clamp01(0.63 * tone * (2 - warm)) * 255;
        albedo[i + 3] = 255;
        const r = clamp01(0.82 + joint * 0.12 - detail * 0.05 + (grain - 0.5) * 0.06);
        rough[i] = rough[i + 1] = rough[i + 2] = r * 255;
        rough[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, size, size, true),
      normalMap: this.data(this.normalFromHeight(hf, size, size, 5), size, size, false),
      roughnessMap: this.data(rough, size, size, false),
    };
  }

  /**
   * Processional road: staggered rows of worn limestone flags between long
   * kerb stones, drifted with sand. u runs across the road (clamped), v along
   * it (one tile = 10 m); alpha frays the edges into the desert.
   */
  pavers(w = 256, h = 512) {
    const perlin = new Perlin(1701);
    const rows = 12;
    const hf = new Float32Array(w * h);
    const albedo = new Uint8Array(w * h * 4);
    const rough = new Uint8Array(w * h * 4);
    const kerb = 0.075;
    for (let y = 0; y < h; y++) {
      const v = y / h;
      const rv = v * rows;
      const row = Math.floor(rv);
      const fy = rv - row;
      // Three to four flags across each row, offset per row (running bond).
      const n = 3 + (hash2(row, 1, 1703) > 0.5 ? 1 : 0);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        // Distances to the nearest joint, in metres (road 5 m wide, tile 10 m long).
        let edgeDist;
        let id;
        if (u < kerb || u > 1 - kerb) {
          // Kerbs: long stones, 3 per tile.
          const kv = v * 3 + (u < kerb ? 0 : 0.5);
          const fk = kv - Math.floor(kv);
          const side = u < kerb ? u / kerb : (1 - u) / kerb;
          edgeDist = Math.min(Math.min(fk, 1 - fk) * (10 / 3), Math.min(side, 1 - side) * kerb * 5);
          id = Math.floor(kv) * 13 + (u < kerb ? 1 : 2);
        } else {
          const uu = (u - kerb) / (1 - kerb * 2);
          const shift = hash2(row, 3, 1705);
          const cu = uu * n + shift;
          const fu = cu - Math.floor(cu);
          const span = (1 - kerb * 2) * 5;
          const edgeU = Math.min((Math.min(fu, 1 - fu) * span) / n, Math.min(uu, 1 - uu) * span);
          edgeDist = Math.min(edgeU, (Math.min(fy, 1 - fy) * 10) / rows);
          id = row * 31 + Math.floor(cu) + 100;
        }
        const wob = perlin.noise(u * 20, v * 40, 256, 40) * 0.015;
        const joint = 1 - smooth(0.012, 0.04, edgeDist + wob);
        const wear = 1 - smooth(0.03, 0.13, edgeDist + wob * 2);
        const macro = perlin.fbm(u * 3 + 1.7, v * 6, 4, 6);
        const fine = perlin.fbm(u * 24 + 3.3, v * 48, 3, 48);
        const grain = hash2(x, y, 1707);
        const st = hash2(id, 5, 1709);
        // Wind-blown sand: in the joints, along the kerbs and in drifts.
        const drift = smooth(0.1, 0.45, perlin.fbm(u * 2 + 9.0, v * 4, 4, 4) + Math.abs(u - 0.5) * 0.7 - 0.25);
        const sand = clamp01(Math.max(joint * 0.85, drift));
        hf[y * w + x] = 0.55 - joint * 0.5 - wear * 0.15 + macro * 0.1 + fine * 0.05 + grain * 0.03 + drift * 0.25;
        const i = (y * w + x) * 4;
        const tone = 0.8 + st * 0.18 + macro * 0.07 + fine * 0.04 + (grain - 0.5) * 0.05 - wear * 0.05;
        const sr = 0.86 * (0.92 + fine * 0.1);
        const sg = 0.7 * (0.92 + fine * 0.1);
        const sb = 0.49 * (0.92 + fine * 0.1);
        albedo[i] = clamp01(0.86 * tone * (1 - sand) + sr * sand) * 255;
        albedo[i + 1] = clamp01(0.76 * tone * (1 - sand) + sg * sand) * 255;
        albedo[i + 2] = clamp01(0.62 * tone * (1 - sand) + sb * sand) * 255;
        const fray = perlin.fbm(u * 6, v * 24 + 5.0, 3, 24) * 0.035;
        const edge = Math.min(u, 1 - u) + fray;
        albedo[i + 3] = smooth(0.0, 0.035, edge) * 255;
        const r = clamp01(0.74 + sand * 0.2 + joint * 0.05 - wear * 0.08 + (grain - 0.5) * 0.06);
        rough[i] = rough[i + 1] = rough[i + 2] = r * 255;
        rough[i + 3] = 255;
      }
    }
    return {
      map: this.data(albedo, w, h, true),
      normalMap: this.data(this.normalFromHeight(hf, w, h, 4), w, h, false),
      roughnessMap: this.data(rough, w, h, false),
    };
  }

  /** Trodden dirt track: compacted, darker sand with footpath ruts and pebbles; frayed alpha edges. */
  trail(w = 128, h = 256) {
    const perlin = new Perlin(1801);
    const hf = new Float32Array(w * h);
    const albedo = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = perlin.fbm(u * 4 + 2.0, v * 8, 4, 8);
        const fine = perlin.fbm(u * 16 + 5.0, v * 32, 3, 32);
        const meander = perlin.noise(1.5, v * 4, 256, 4) * 0.08;
        const rut = Math.max(gauss(u - 0.36 - meander, 0.055), gauss(u - 0.64 - meander, 0.055) * 0.8);
        const pebble = hash2(x, y, 1803) > 0.997 ? 0.6 : 0;
        hf[y * w + x] = -rut * 0.35 + fine * 0.15 + n * 0.1 + pebble * 0.4;
        const i = (y * w + x) * 4;
        const tone = 0.74 + n * 0.08 + fine * 0.05 - rut * 0.08 - pebble * 0.2;
        albedo[i] = clamp01(0.86 * tone) * 255;
        albedo[i + 1] = clamp01(0.67 * tone) * 255;
        albedo[i + 2] = clamp01(0.46 * tone) * 255;
        const edge = 1 - Math.abs(u - 0.5) * 2 + n * 0.35 + fine * 0.15;
        albedo[i + 3] = clamp01(smooth(0.05, 0.5, edge) * 0.85) * 255;
      }
    }
    return {
      map: this.data(albedo, w, h, true),
      normalMap: this.data(this.normalFromHeight(hf, w, h, 2.5), w, h, false),
    };
  }

  sprite(size = 64, kind = 'soft') {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size - 0.5;
        const dy = (y + 0.5) / size - 0.5;
        let a;
        if (kind === 'flame') {
          const d = Math.hypot(dx * 1.8, (dy + 0.15) * (dy < -0.15 ? 1.2 : 0.75));
          a = Math.pow(clamp01(1 - d * 2), 1.6);
        } else {
          a = Math.pow(clamp01(1 - Math.hypot(dx, dy) * 2), 2);
        }
        const i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = a * 255;
      }
    }
    return this.data(data, size, size, true, false);
  }

  grid(size = 512, cells = 12) {
    const data = new Uint8Array(size * size * 4);
    const cs = size / cells;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = Math.min(x % cs, cs - (x % cs));
        const fy = Math.min(y % cs, cs - (y % cs));
        const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
        const line = Math.max(1 - smooth(0.5, 2.5, Math.min(fx, fy)), 1 - smooth(1, 6, edge));
        const i = (y * size + x) * 4;
        data[i] = 70;
        data[i + 1] = 45;
        data[i + 2] = 25;
        data[i + 3] = line * 150;
      }
    }
    return this.data(data, size, size, true, false);
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const SkyShader = {
  uniforms: {
    sunDir: { value: new THREE.Vector3() },
    zenith: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    groundCol: { value: new THREE.Color() },
    sunColor: { value: new THREE.Color() },
    time: { value: 0 },
    discIntensity: { value: 40 },
    envMode: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = p.xyww;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sunDir;
    uniform vec3 zenith;
    uniform vec3 horizon;
    uniform vec3 groundCol;
    uniform vec3 sunColor;
    uniform float time;
    uniform float discIntensity;
    uniform float envMode;
    varying vec3 vDir;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float vnoise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float s = 0.0; float a = 0.5;
      for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
      return s;
    }

    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      float sd = max(dot(d, sunDir), 0.0);
      vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
      // Mie forward scattering around the sun.
      col += sunColor * (pow(sd, 6.0) * 0.16 + pow(sd, 48.0) * 0.45 + pow(sd, 500.0) * 2.0);
      // Thick warm haze just above the horizon.
      float haze = exp(-max(h, 0.0) * 14.0);
      col = mix(col, horizon + sunColor * pow(sd, 3.0) * 0.25, haze * 0.55);
      // Wispy high clouds lit by the low sun.
      if (h > 0.0) {
        vec2 uv = d.xz / (h + 0.14) * 0.85 + vec2(time * 0.0035, time * 0.0012);
        float c = fbm(uv * 1.4);
        c = smoothstep(0.55, 0.9, c) * smoothstep(0.0, 0.22, h);
        vec3 cloudCol = mix(vec3(1.0, 0.86, 0.72), sunColor * 1.6, pow(sd, 3.0));
        col = mix(col, cloudCol * (0.75 + 0.6 * pow(sd, 6.0)), c * 0.5);
      }
      if (envMode > 0.5) {
        col = mix(col, groundCol, smoothstep(0.02, -0.12, h));
      } else {
        col = mix(col, horizon, smoothstep(0.0, -0.1, h));
      }
      float disc = smoothstep(0.99955, 0.9998, dot(d, sunDir));
      col += sunColor * disc * discIntensity;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null },
    sunPos: { value: new THREE.Vector2(0.5, 0.5) },
    aspect: { value: 1 },
    visibility: { value: 1 },
    density: { value: 0.92 },
    decay: { value: 0.958 },
    exposure: { value: 0.38 },
    threshold: { value: 2.2 },
    rayColor: { value: new THREE.Color(1.0, 0.8, 0.58) },
  },
  defines: { SAMPLES: 48 },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 sunPos;
    uniform float aspect;
    uniform float visibility;
    uniform float density;
    uniform float decay;
    uniform float exposure;
    uniform float threshold;
    uniform vec3 rayColor;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (visibility < 0.002) { gl_FragColor = base; return; }
      vec2 delta = (vUv - sunPos) * (density / float(SAMPLES));
      float jitter = fract(sin(dot(vUv * 913.0, vec2(12.9898, 78.233))) * 43758.5453);
      vec2 uv = vUv - delta * jitter;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
        s = min(s, vec3(6.0)) * smoothstep(threshold, threshold * 2.2, l);
        acc += s * illum;
        illum *= decay;
      }
      float dist = length((vUv - sunPos) * vec2(aspect, 1.0));
      float fall = 1.0 - smoothstep(0.1, 1.25, dist);
      vec3 rays = acc / float(SAMPLES) * rayColor * exposure * visibility * fall;
      gl_FragColor = vec4(base.rgb + rays, base.a);
    }`,
};

const DustShader = {
  uniforms: {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uMap: { value: null },
    uColor: { value: new THREE.Color(1.6, 1.25, 0.9) },
    uSize: { value: 90 },
    uBox: { value: 120 },
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uCam;
    uniform float uSize;
    uniform float uBox;
    attribute float aSeed;
    varying float vAlpha;
    void main() {
      vec3 p = position;
      p.x += uTime * (1.6 + aSeed * 1.2) + sin(uTime * 0.7 + aSeed * 40.0) * 0.6;
      p.z += uTime * 0.6 + cos(uTime * 0.5 + aSeed * 23.0) * 0.6;
      p.y += sin(uTime * 0.9 + aSeed * 17.0) * 0.4;
      float hb = uBox * 0.5;
      p.xz = mod(p.xz - uCam.xz + hb, uBox) - hb + uCam.xz;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      float dist = -mv.z;
      vAlpha = smoothstep(2.0, 8.0, dist) * (1.0 - smoothstep(30.0, 60.0, dist)) * (0.35 + 0.65 * aSeed);
      gl_PointSize = uSize * (0.35 + aSeed * 0.65) / max(dist, 0.1);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform vec3 uColor;
    varying float vAlpha;
    void main() {
      float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
      if (a < 0.01) discard;
      gl_FragColor = vec4(uColor * a, a);
    }`,
};

// ---------------------------------------------------------------------------
// Helpers shared with the other modules
// ---------------------------------------------------------------------------

/** Canvas-text sprite used for zone labels and name tags. */
export function makeTextSprite(text, opts = {}) {
  const font = opts.font || '600 64px "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';
  const pad = 24;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = opts.height || 96;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (opts.background) {
    ctx.fillStyle = opts.background;
    const r = h / 2.4;
    ctx.beginPath();
    ctx.roundRect(4, 8, w - 8, h - 16, r);
    ctx.fill();
  }
  ctx.lineWidth = opts.outlineWidth || 8;
  ctx.strokeStyle = opts.outline || 'rgba(30, 16, 6, 0.85)';
  ctx.strokeText(text, w / 2, h / 2 + 2);
  ctx.fillStyle = opts.color || '#f6dfa4';
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, fog: false, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  const scale = opts.scale || 1;
  sprite.scale.set((w / h) * scale, scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export const QUALITY = {
  low: { pixelRatio: 1, shadow: 1024, samples: 0, bloom: false, rays: 0, ao: false, dust: 400, foliage: 0.45 },
  medium: { pixelRatio: 1.25, shadow: 2048, samples: 2, bloom: true, rays: 32, ao: false, dust: 900, foliage: 0.7 },
  high: { pixelRatio: 1.5, shadow: 4096, samples: 4, bloom: true, rays: 48, ao: false, dust: 1600, foliage: 1 },
  // Ultra: native resolution, ground-truth ambient occlusion and dense volumetric rays.
  ultra: { pixelRatio: 2, shadow: 4096, samples: 4, bloom: true, rays: 72, ao: true, dust: 2400, foliage: 1 },
};

// ---------------------------------------------------------------------------
// Procedural sculpting + rigid-skinned rig builder (characters and pets)
// ---------------------------------------------------------------------------

export const gauss = (x, s) => Math.exp(-(x * x) / (2 * s * s));

/** LatheGeometry from [radius, y] pairs listed bottom-to-top; the seam faces -z (backwards). */
export function lathe(profile, segments = 24) {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
    Math.PI,
    Math.PI * 2,
  );
}

/** Lathe whose axis runs along +z (profile [radius, z] from rear to front), used for animal bodies. */
export function latheZ(profile, segments = 24) {
  return lathe(profile, segments).rotateX(Math.PI / 2);
}

/** Recomputes normals and welds them across coincident vertices (lathe / sphere seams and poles). */
export function smoothSeams(geo) {
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const groups = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(i);
  }
  const n = new THREE.Vector3();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    n.set(0, 0, 0);
    for (const i of list) n.set(n.x + nor.getX(i), n.y + nor.getY(i), n.z + nor.getZ(i));
    n.normalize();
    for (const i of list) nor.setXYZ(i, n.x, n.y, n.z);
  }
  return geo;
}

/** Applies `fn(vertex)` to every vertex, then re-smooths normals. */
export function sculpt(geo, fn) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return smoothSeams(geo);
}

/** Tapered tube along a curve; `radius(t)` gives the radius at curve parameter t. */
export function taperedTube(points, radius, tubular = 20, radial = 12) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const geo = new THREE.TubeGeometry(curve, tubular, 1, radial, false);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const t = uv.getX(i);
    curve.getPointAt(Math.min(1, t), c);
    const r = radius(t);
    pos.setXYZ(i, c.x + (pos.getX(i) - c.x) * r, c.y + (pos.getY(i) - c.y) * r, c.z + (pos.getZ(i) - c.z) * r);
  }
  return smoothSeams(geo);
}

/** Creates the bone hierarchy described by `rig` ([name, parent, [x, y, z]] entries). */
export function makeBones(rig) {
  const map = {};
  const list = [];
  for (const [name, parent, p] of rig) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(p[0], p[1], p[2]);
    if (parent) map[parent].add(b);
    map[name] = b;
    list.push(b);
  }
  return { map, list };
}

/**
 * Collects procedural parts attached to bones, bakes them into the bind pose and
 * merges them into one geometry with a draw group per material slot.
 */
export class RigBuilder {
  constructor(rig, slots) {
    this.rig = rig;
    this.slots = slots;
    const { map } = makeBones(rig);
    map[rig[0][0]].updateMatrixWorld(true);
    this.bones = map;
    this.index = Object.fromEntries(rig.map(([n], i) => [n, i]));
    this.parts = Object.fromEntries(slots.map((k) => [k, []]));
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
  }

  /** o: { p: [x,y,z], r: [x,y,z], s: number|[x,y,z], color: [r,g,b] } relative to the bone. */
  add(slot, geo, bone, o = {}) {
    const g = geo.clone();
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const p = o.p || [0, 0, 0];
    const r = o.r || [0, 0, 0];
    const s = typeof o.s === 'number' ? [o.s, o.s, o.s] : o.s || [1, 1, 1];
    this._m4.compose(new THREE.Vector3(p[0], p[1], p[2]), this._q.setFromEuler(this._e.set(r[0], r[1], r[2])), new THREE.Vector3(s[0], s[1], s[2]));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(this.bones[bone].matrixWorld, this._m4));
    const n = g.attributes.position.count;
    const color = new Float32Array(n * 3);
    const c = o.color || [1, 1, 1];
    for (let i = 0; i < n; i++) color.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const bi = this.index[bone];
    for (let i = 0; i < n; i++) {
      si[i * 4] = bi;
      sw[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    this.parts[slot].push(g);
  }

  build() {
    const empty = () => {
      const g = new THREE.BoxGeometry(0, 0, 0);
      this.add(this.slots[0], g, this.rig[0][0]);
      return this.parts[this.slots[0]].pop();
    };
    const geos = this.slots.map((k) => (this.parts[k].length ? mergeGeometries(this.parts[k], false) : empty()));
    const geo = mergeGeometries(geos, true);
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Instantiates a rigged mesh from shared bind-pose geometry with its own skeleton. */
export function createRigged(geometry, rig, materials) {
  const { map, list } = makeBones(rig);
  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.add(map[rig[0][0]]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(list));
  return { mesh, bones: map };
}

// ---------------------------------------------------------------------------
// Static-geometry helpers (merged props)
// ---------------------------------------------------------------------------

/** BoxGeometry with UVs measured in `tile`-metre tiles on every face (masonry, rock). */
function metricBox(w, h, d, tile = 2.4) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile, (uv.getY(i) * dims[f][1]) / tile);
    }
  }
  return geo;
}

/** Multiplies a geometry's UVs in place. */
function scaleUv(geo, ku, kv = ku) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ku, uv.getY(i) * kv);
  return geo;
}

/** Non-indexed copy with only position / normal / uv, so mixed primitives can be merged. */
function plainGeometry(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  g.clearGroups();
  return g;
}

/** Merges a list of geometries into one (null when empty). */
function mergePlain(list) {
  if (!list.length) return null;
  const geo = mergeGeometries(list.map(plainGeometry), false);
  geo.computeBoundingSphere();
  return geo;
}

const _up = new THREE.Vector3(0, 1, 0);

/** Tapered cylinder spanning from point a to point b ([x, y, z] arrays). */
function rodGeometry(a, b, r0, r1 = r0, seg = 8) {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const len = va.distanceTo(vb);
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  const dir = vb.clone().sub(va).normalize();
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, dir));
  geo.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  scaleUv(geo, 1, len / 2);
  return geo;
}

/** A sagging rope between two points. */
function ropeGeometry(a, b, sag, r = 0.025) {
  const pa = new THREE.Vector3(a[0], a[1], a[2]);
  const pb = new THREE.Vector3(b[0], b[1], b[2]);
  const mid = pa.clone().add(pb).multiplyScalar(0.5);
  mid.y -= sag;
  const curve = new THREE.QuadraticBezierCurve3(pa, mid, pb);
  return new THREE.TubeGeometry(curve, 10, r, 5, false);
}

/**
 * Plank-built Nile boat hull. Local +x is the bow; the gunwale sweeps up into
 * tall papyriform posts at both ends. Returns { hull, deck, deckY, halfBeamAt }.
 */
function makeHullGeometry(L, B, o) {
  const nu = 44;
  const nv = 14;
  const pos = [];
  const uv = [];
  const idx = [];
  const sheerAt = (u) => o.freeboard + (u > 0 ? o.bowRise : o.sternRise) * Math.pow(Math.abs(u), 5);
  const keelAt = (u) => -o.draft * (1 - u * u) + (sheerAt(u) - 0.22) * Math.pow(Math.abs(u), 7);
  const beamAt = (u) => (B / 2) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), 2.3)), 0.5);
  for (let i = 0; i <= nu; i++) {
    const u = -1 + (2 * i) / nu;
    const hb = beamAt(u);
    const sheer = sheerAt(u);
    const keel = keelAt(u);
    for (let j = 0; j <= nv; j++) {
      const phi = -Math.PI / 2 + (Math.PI * j) / nv;
      pos.push((u * L) / 2, keel + (sheer - keel) * (1 - Math.cos(phi)), hb * Math.sin(phi));
      uv.push((j / nv) * 5, (u * L) / 3);
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j;
      const b = a + nv + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hull.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  hull.setIndex(idx);
  hull.computeVertexNormals();
  // Deck: a planked floor wherever the hull is wide enough at deck height.
  const deckY = o.freeboard - 0.08;
  const halfBeamAt = (u) => {
    const sheer = sheerAt(u);
    const keel = keelAt(u);
    const c = 1 - (deckY - keel) / Math.max(1e-3, sheer - keel);
    return beamAt(u) * Math.sqrt(Math.max(0, 1 - c * c)) * 0.97;
  };
  const dp = [];
  const duv = [];
  const di = [];
  const nd = 24;
  for (let i = 0; i <= nd; i++) {
    const u = -0.8 + (1.6 * i) / nd;
    const w = halfBeamAt(u);
    dp.push((u * L) / 2, deckY, -w, (u * L) / 2, deckY, w);
    duv.push(-w / 1.2, (u * L) / 2.4, w / 1.2, (u * L) / 2.4);
    if (i < nd) {
      const a = i * 2;
      di.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const deck = new THREE.BufferGeometry();
  deck.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
  deck.setAttribute('uv', new THREE.Float32BufferAttribute(duv, 2));
  deck.setIndex(di);
  deck.computeVertexNormals();
  return { hull, deck, deckY, halfBeamAt, sheerAt };
}

/** Vertex-coloured foliage clump: `blades` curved strips (and optional papyrus umbels). */
function makeFoliageGeometry(seed, o) {
  const rand = mulberry32(seed);
  const pos = [];
  const col = [];
  const nor = [];
  const quad = (p0, p1, p2, p3, c0, c1, n) => {
    for (const [p, c] of [
      [p0, c0],
      [p1, c0],
      [p2, c1],
      [p1, c0],
      [p3, c1],
      [p2, c1],
    ]) {
      pos.push(p[0], p[1], p[2]);
      col.push(c[0], c[1], c[2]);
      nor.push(n[0], n[1], n[2]);
    }
  };
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let k = 0; k < o.blades; k++) {
    const ang = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * o.spread;
    const bx = Math.cos(ang) * rr;
    const bz = Math.sin(ang) * rr;
    const h = o.h0 + rand() * (o.h1 - o.h0);
    const lean = (o.lean || 0.25) * (0.4 + rand());
    const dirA = ang + (rand() - 0.5) * 1.2;
    const dx = Math.cos(dirA);
    const dz = Math.sin(dirA);
    const w = o.width * (0.7 + rand() * 0.6);
    const seg = o.segments || 4;
    // Ribbon facing roughly across its lean direction.
    const sx = -dz;
    const sz = dx;
    const n = [dx * 0.35, 0.94, dz * 0.35];
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg;
      const t1 = (i + 1) / seg;
      const at = (t) => [bx + dx * lean * h * t * t, h * t - lean * h * t * t * 0.25, bz + dz * lean * h * t * t];
      const a = at(t0);
      const b = at(t1);
      const w0 = w * (1 - t0 * (o.taper ?? 0.9));
      const w1 = w * (1 - t1 * (o.taper ?? 0.9));
      const c0 = mix3(o.base, o.tip, Math.pow(t0, 1.3));
      const c1 = mix3(o.base, o.tip, Math.pow(t1, 1.3));
      quad([a[0] - sx * w0, a[1], a[2] - sz * w0], [a[0] + sx * w0, a[1], a[2] + sz * w0], [b[0] - sx * w1, b[1], b[2] - sz * w1], [b[0] + sx * w1, b[1], b[2] + sz * w1], c0, c1, n);
    }
    if (o.umbel) {
      // Papyrus head: a spray of fine rays drooping from the top of the stem.
      const top = [bx + dx * lean * h, h - lean * h * 0.25, bz + dz * lean * h];
      const rays = o.rays || 14;
      const rw = o.rayWidth || 0.03;
      for (let q = 0; q < rays; q++) {
        const ra = (q / rays) * Math.PI * 2 + rand() * 0.4;
        const len = o.umbel * (0.6 + rand() * 0.55);
        const up = rand();
        // A fountain of rays: some arch up, most splay out and droop.
        const ex = top[0] + Math.cos(ra) * len * (1 - up * 0.45);
        const ez = top[2] + Math.sin(ra) * len * (1 - up * 0.45);
        const ey = top[1] + len * (up * 0.75 - 0.3);
        const px = -Math.sin(ra) * rw;
        const pz = Math.cos(ra) * rw;
        quad(
          [top[0] - px * 0.3, top[1], top[2] - pz * 0.3],
          [top[0] + px * 0.3, top[1], top[2] + pz * 0.3],
          [ex - px, ey, ez - pz],
          [ex + px, ey, ez + pz],
          o.umbelBase,
          o.umbelTip,
          [Math.cos(ra) * 0.3, 0.95, Math.sin(ra) * 0.3],
        );
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** Writes shuffled transforms into a new InstancedMesh (shuffled so quality presets can drop a uniform subset). */
function instancesFrom(geo, mat, list, rand, colors) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const c = new THREE.Color();
  list.forEach((it, i) => {
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    p.set(it.x, it.y, it.z);
    sc.set(it.sx ?? it.s, it.sy ?? it.s, it.sz ?? it.s);
    mesh.setMatrixAt(i, m4.compose(p, q.setFromEuler(e), sc));
    if (colors) mesh.setColorAt(i, c.setRGB(it.c[0], it.c[1], it.c[2]));
  });
  mesh.count = list.length;
  mesh.computeBoundingSphere();
  return mesh;
}

// ---------------------------------------------------------------------------
// The Nile
// ---------------------------------------------------------------------------

const TERRAIN_SIZE = 1600; // metres; the desert floor spans [-800, 800]
const TERRAIN_FLAT = 176; // the play area (worldHalf 170) is perfectly flat
const RIVER_EXTEND = 260; // straight runs added past both river ends so it meets the horizon
const WATER_Y = 0.06; // resting height of the water surface (the ground is y = 0)
const TERRAIN_REACH = 180; // river distance beyond which the valley no longer shapes the terrain

/**
 * The river's centre line — the very polyline the collision is rasterised
 * from (riverPolyline in pyramid.js / gameLogic.js) — with arc lengths,
 * tangents and fast nearest-point queries. The line runs monotonically along
 * +x, so a query binary-searches its x and scans outwards only while a nearer
 * segment is still possible. `extend` appends straight visual-only runs past
 * both ends (they lie far outside the play area).
 */
export class RiverPath {
  constructor(river, extend = 0) {
    const line = riverPolyline(river.points);
    if (extend > 0) {
      const lead = [];
      const tail = [];
      const [ax, az] = line[0];
      const [bx, bz] = line[1];
      const la = Math.hypot(bx - ax, bz - az);
      const [cx, cz] = line[line.length - 2];
      const [dx, dz] = line[line.length - 1];
      const lb = Math.hypot(dx - cx, dz - cz);
      const step = 8;
      for (let d = extend; d > 0; d -= step) lead.push([ax - ((bx - ax) / la) * d, az - ((bz - az) / la) * d]);
      for (let d = step; d <= extend; d += step) tail.push([dx + ((dx - cx) / lb) * d, dz + ((dz - cz) / lb) * d]);
      line.unshift(...lead);
      line.push(...tail);
    }
    const n = line.length;
    this.n = n;
    this.x = new Float64Array(n);
    this.z = new Float64Array(n);
    this.s = new Float64Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = line[i][0];
      this.z[i] = line[i][1];
      if (i > 0) this.s[i] = this.s[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const ddx = this.x[b] - this.x[a];
      const ddz = this.z[b] - this.z[a];
      const l = Math.hypot(ddx, ddz) || 1;
      this.tx[i] = ddx / l;
      this.tz[i] = ddz / l;
    }
    this.length = this.s[n - 1];
    this.halfWidth = river.halfWidth;
    this.bank = river.bank;
    this.flow = river.flow;
    this._p = { d: 0, s: 0, a: 0, x: 0, z: 0 };
  }

  /** Index of the segment whose start is the last vertex with x <= px. */
  _seek(px) {
    let lo = 0;
    let hi = this.n - 2;
    if (px <= this.x[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.x[mid] <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Nearest point on the centre line: `d` distance, `s` arc length, `a` signed
   * offset across the river (+ = left of the flow, i.e. the north bank).
   */
  project(px, pz, out = this._p) {
    const X = this.x;
    const Z = this.z;
    let best = Infinity;
    let bi = 0;
    let bt = 0;
    const test = (i) => {
      const dx = X[i + 1] - X[i];
      const dz = Z[i + 1] - Z[i];
      const l2 = dx * dx + dz * dz || 1;
      let t = ((px - X[i]) * dx + (pz - Z[i]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (X[i] + dx * t), pz - (Z[i] + dz * t));
      if (d < best) {
        best = d;
        bi = i;
        bt = t;
      }
    };
    const i0 = this._seek(px);
    for (let i = i0; i < this.n - 1 && X[i] - px < best; i++) test(i);
    for (let i = i0 - 1; i >= 0 && px - X[i + 1] < best; i--) test(i);
    const dx = X[bi + 1] - X[bi];
    const dz = Z[bi + 1] - Z[bi];
    const l = Math.hypot(dx, dz) || 1;
    const qx = X[bi] + dx * bt;
    const qz = Z[bi] + dz * bt;
    out.d = best;
    out.s = this.s[bi] + l * bt;
    out.a = (-(px - qx) * dz + (pz - qz) * dx) / l;
    out.x = qx;
    out.z = qz;
    return out;
  }

  /** Distance to the centre line; anything farther than `cap` metres reports `cap` (and is found faster). */
  distance(px, pz, cap = Infinity) {
    const X = this.x;
    const Z = this.z;
    let best = cap;
    const test = (i) => {
      const dx = X[i + 1] - X[i];
      const dz = Z[i + 1] - Z[i];
      const l2 = dx * dx + dz * dz || 1;
      let t = ((px - X[i]) * dx + (pz - Z[i]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (X[i] + dx * t), pz - (Z[i] + dz * t));
      if (d < best) best = d;
    };
    const i0 = this._seek(px);
    for (let i = i0; i < this.n - 1 && X[i] - px < best; i++) test(i);
    for (let i = i0 - 1; i >= 0 && px - X[i + 1] < best; i--) test(i);
    return best;
  }

  /** Centre-line point and unit tangent at arc length s: { x, z, tx, tz }. */
  at(s, out = {}) {
    const S = this.s;
    let lo = 0;
    let hi = this.n - 2;
    const sc = s < 0 ? 0 : s > this.length ? this.length : s;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid] <= sc) lo = mid;
      else hi = mid - 1;
    }
    const t = (sc - S[lo]) / (S[lo + 1] - S[lo] || 1);
    out.x = this.x[lo] + (this.x[lo + 1] - this.x[lo]) * t;
    out.z = this.z[lo] + (this.z[lo + 1] - this.z[lo]) * t;
    const tx = this.tx[lo] + (this.tx[lo + 1] - this.tx[lo]) * t;
    const tz = this.tz[lo] + (this.tz[lo + 1] - this.tz[lo]) * t;
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l;
    out.tz = tz / l;
    return out;
  }

  /** World position at arc length s and signed across offset a (+ = north bank). */
  point(s, a, out = {}) {
    this.at(s, out);
    out.x += -out.tz * a;
    out.z += out.tx * a;
    return out;
  }

  /** Centre-line z at a given x. */
  centreZ(px) {
    const i = this._seek(px);
    const t = Math.max(0, Math.min(1, (px - this.x[i]) / (this.x[i + 1] - this.x[i] || 1)));
    return this.z[i] + (this.z[i + 1] - this.z[i]) * t;
  }

  /** Arc length of the centre line at a given x. */
  sAtX(px) {
    const i = this._seek(px);
    const t = Math.max(0, Math.min(1, (px - this.x[i]) / (this.x[i + 1] - this.x[i] || 1)));
    return this.s[i] + (this.s[i + 1] - this.s[i]) * t;
  }
}

/** Shared GLSL helpers for the water and wet-bank shaders. */
const WATER_COMMON = /* glsl */ `
  uniform float uTime;
  uniform float uHalfWidth;
  uniform float uBank;
  uniform vec4 uScroll;
  uniform sampler2D uRiverNormal;
  uniform sampler2D uNoise;
  uniform sampler2D uSandMap;
  uniform vec4 uShoals[MAX_SHOALS];
  uniform int uShoalCount;
  uniform vec4 uFoamBodies[MAX_FOAM];
  uniform int uFoamCount;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  varying vec2 vRiver;
  varying vec2 vFlowDir;
  varying vec3 vWaterWorld;
  // 1 inside a ford's walkable lane, fading out over its margins. lane: 1 m soft edge; wide: broad shoal.
  float rectMask(vec2 p, vec4 r, float inner, float outer) {
    float dx = min(p.x - r.x, r.z - p.x);
    float dz = min(p.y - r.y, r.w - p.y);
    return smoothstep(-outer, inner, dx) * smoothstep(-outer, inner, dz);
  }
`;

/** Per-world river uniforms, shared by the water, bank and foliage materials. */
function makeRiverUniforms(tex) {
  return {
    uTime: { value: 0 },
    uHalfWidth: { value: 13 },
    uBank: { value: 6 },
    uScroll: { value: new THREE.Vector4() },
    uRiverNormal: { value: tex.river },
    uNoise: { value: tex.noise },
    uSandMap: { value: tex.sand.map },
    uShoals: { value: Array.from({ length: 4 }, () => new THREE.Vector4(1e5, 1e5, 1e5, 1e5)) },
    uShoalCount: { value: 0 },
    uFoamBodies: { value: Array.from({ length: 24 }, () => new THREE.Vector4(1e5, 1e5, 1, 1)) },
    uFoamCount: { value: 0 },
    uSunDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color() },
    uDeep: { value: new THREE.Color(0.006, 0.05, 0.068) },
    uMid: { value: new THREE.Color(0.02, 0.15, 0.15) },
    uShallow: { value: new THREE.Color(0.1, 0.33, 0.25) },
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2400);
    this.camera.position.set(0, 6, 40);
    this.clockTime = 0;
    this.quality = 'high';
    this.fires = [];
    this.pulses = [];
    this.worldGroup = null;
    this.waterMaterials = [];
    this.terrain = null;
    this.river = null; // RiverPath of the current world (null before the first config)
    this.riverUniforms = null;
    this.windTime = { value: 0 }; // shared by every wind-swayed foliage material
    this.foliage = []; // instanced foliage whose drawn count follows the quality preset
    this.boats = [];
    this.puffs = null;
    this.sunDir = new THREE.Vector3(-0.62, 0.33, -0.71).normalize();

    this.colors = {
      zenith: new THREE.Color(0.075, 0.2, 0.45),
      horizon: new THREE.Color(0.96, 0.6, 0.33),
      ground: new THREE.Color(0.55, 0.38, 0.22),
      sun: new THREE.Color(1.0, 0.72, 0.45),
    };
    this._tmpV = new THREE.Vector3();
    this._lightView = new THREE.Matrix4();
    this._lightViewInv = new THREE.Matrix4();
  }

  /** Generates every procedural texture and builds the static desert. */
  async init(onProgress = () => {}) {
    const tf = new TextureFactory(this.renderer);
    this.factory = tf;
    const steps = [
      ['sand', () => tf.sand(512)],
      ['stone', () => tf.stone(512, 202)],
      ['rock', () => tf.stone(256, 909, { base: [0.7, 0.55, 0.4], cracks: 2.2, normalStrength: 6 })],
      ['skin', () => tf.skin(256)],
      ['fur', () => tf.fur(256)],
      ['linen', () => tf.linen(256)],
      ['beads', () => tf.beads(128, 256)],
      ['glyphs', () => tf.glyphs(512)],
      ['wood', () => tf.wood(256)],
      ['cloth', () => tf.cloth(256)],
      ['stripes', () => tf.stripes(128)],
      ['frond', () => tf.frond()],
      ['water', () => tf.water(256)],
      ['river', () => tf.riverNormal(256)],
      ['noise', () => tf.noise(256)],
      ['masonry', () => tf.masonry(512)],
      ['pavers', () => tf.pavers(256, 512)],
      ['trail', () => tf.trail(128, 256)],
      ['soft', () => tf.sprite(64, 'soft')],
      ['flame', () => tf.sprite(64, 'flame')],
      ['grid', () => tf.grid(512, 12)],
    ];
    this.tex = {};
    for (let i = 0; i < steps.length; i++) {
      onProgress(i / steps.length, `Carving ${steps[i][0]} textures`);
      await nextFrame();
      this.tex[steps[i][0]] = steps[i][1]();
    }
    onProgress(0.95, 'Raising the desert');
    await nextFrame();
    this.buildMaterials();
    this.buildSky();
    this.buildLights();
    this.buildTerrain(null);
    this.buildVista();
    this.buildDust();
    this.buildPuffs();
    this.setQuality(this.quality);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    onProgress(1, 'Ready');
  }

  buildMaterials() {
    const t = this.tex;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    this.materials = {
      block: std({ map: t.stone.map, normalMap: t.stone.normalMap, roughnessMap: t.stone.roughnessMap, roughness: 1, metalness: 0 }),
      sand: std({
        map: t.sand.map,
        normalMap: t.sand.normalMap,
        roughnessMap: t.sand.roughnessMap,
        roughness: 1,
        metalness: 0,
        vertexColors: true,
      }),
      rock: std({ map: t.rock.map, normalMap: t.rock.normalMap, roughnessMap: t.rock.roughnessMap, roughness: 1 }),
      sandstone: std({ map: t.stone.map, normalMap: t.stone.normalMap, roughnessMap: t.stone.roughnessMap, color: 0xf0d6b0 }),
      glyph: std({ map: t.glyphs.map, normalMap: t.glyphs.normalMap, roughnessMap: t.glyphs.roughnessMap }),
      wood: std({ map: t.wood.map, normalMap: t.wood.normalMap, roughness: 0.85 }),
      cloth: std({ map: t.cloth.map, normalMap: t.cloth.normalMap, roughness: 0.9, side: THREE.DoubleSide }),
      gold: new THREE.MeshPhysicalMaterial({
        color: 0xe8b64a,
        metalness: 1,
        roughness: 0.24,
        clearcoat: 0.6,
        clearcoatRoughness: 0.2,
        emissive: 0x2a1600,
        emissiveIntensity: 0.35,
      }),
      bronze: std({ color: 0x8a5a2b, metalness: 0.85, roughness: 0.42 }),
      linen: new THREE.MeshPhysicalMaterial({
        color: 0xf4eddf,
        map: t.linen.map,
        normalMap: t.linen.normalMap,
        roughness: 0.86,
        sheen: 0.7,
        sheenRoughness: 0.75,
        sheenColor: new THREE.Color(0.9, 0.86, 0.78),
        side: THREE.DoubleSide,
      }),
      leather: std({ color: 0x5e3a1e, roughness: 0.62, normalMap: t.wood.normalMap }),
      lapis: std({ color: 0x1f4f9a, roughness: 0.35, metalness: 0.1 }),
      clay: std({ color: 0xb4643a, roughness: 0.8 }),
      frond: std({ map: t.frond, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75 }),
      trunk: std({ map: t.wood.map, normalMap: t.wood.normalMap, color: 0xb59a7a, roughness: 0.95 }),
      water: std({
        color: 0x1d5d63,
        roughness: 0.06,
        metalness: 0.15,
        normalMap: t.water,
        normalScale: new THREE.Vector2(0.35, 0.35),
        transparent: true,
        opacity: 0.92,
      }),
      ember: std({ color: 0x1e0e06, roughness: 0.9, emissive: new THREE.Color(1.0, 0.32, 0.06), emissiveIntensity: 2.2 }),
    };
    this.materials.block.normalScale.set(1.1, 1.1);
    // Every instanced block samples its own window of the tileable stone texture,
    // so no two blocks in the pyramid share the same surface pattern.
    this.materials.block.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_INSTANCING
          vec3 blockSeed = instanceMatrix[3].xyz;
          vec2 blockOff = fract(sin(vec2(dot(blockSeed, vec3(12.9898, 78.233, 37.719)), dot(blockSeed, vec3(39.346, 11.135, 83.155)))) * 43758.5453);
          #ifdef USE_MAP
            vMapUv += blockOff;
          #endif
          #ifdef USE_NORMALMAP
            vNormalMapUv += blockOff;
          #endif
          #ifdef USE_ROUGHNESSMAP
            vRoughnessMapUv += blockOff;
          #endif
        #endif`,
      );
    };
    this.materials.block.customProgramCacheKey = () => 'dunebound-block';
    // Shared masonry and road surfaces (UVs are authored in metres / tile).
    Object.assign(this.materials, {
      masonry: std({ map: t.masonry.map, normalMap: t.masonry.normalMap, roughnessMap: t.masonry.roughnessMap, roughness: 1, color: 0xf6e6cf }),
      paving: std({
        color: 0xf7e7cf,
        map: t.pavers.map,
        normalMap: t.pavers.normalMap,
        roughnessMap: t.pavers.roughnessMap,
        roughness: 1,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
      trail: std({
        map: t.trail.map,
        normalMap: t.trail.normalMap,
        roughness: 0.98,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1.5,
        polygonOffsetUnits: -3,
      }),
      wetRock: std({ map: t.rock.map, normalMap: t.rock.normalMap, color: 0x6d6a62, roughness: 0.38, metalness: 0 }),
      rope: std({ color: 0xa88a5c, roughness: 0.92, map: t.linen.map }),
    });
    this.materials.paving.normalScale.set(0.9, 0.9);
    this.materials.water.normalMap.repeat.set(4, 4);
    this.materials.linen.map.repeat.set(3, 3);
    this.materials.linen.normalMap.repeat.set(3, 3);
    this.waterMaterials.push(this.materials.water);
    // Textures owned by the engine; per-world materials may reference them but never dispose them.
    this.sharedTextures = new Set();
    for (const v of Object.values(this.tex)) {
      if (v && v.isTexture) this.sharedTextures.add(v);
      else if (v) for (const tx of Object.values(v)) this.sharedTextures.add(tx);
    }
    this.sharedMaterials = new Set(Object.values(this.materials));
  }

  /**
   * MeshStandardMaterial whose vertices bend in a coherent world-space breeze;
   * the bend grows with the square of the height above the instance's root.
   */
  makeSwayMaterial(opts, amp) {
    const m = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.78 }, opts));
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = this.windTime;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWindTime;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            mat3 swayM = mat3(instanceMatrix);
            vec3 swayRoot = instanceMatrix[3].xyz;
          #else
            mat3 swayM = mat3(1.0);
            vec3 swayRoot = vec3(0.0);
          #endif
          vec3 swayS2 = vec3(dot(swayM[0], swayM[0]), dot(swayM[1], swayM[1]), dot(swayM[2], swayM[2]));
          float swayH = max(position.y, 0.0) * sqrt(swayS2.y);
          float swayPh = dot(swayRoot.xz, vec2(0.23, 0.17));
          float gust = sin(uWindTime * 0.45 + swayRoot.x * 0.03 - swayRoot.z * 0.01) * 0.5 + 0.5;
          float sway = (sin(uWindTime * 1.7 + swayPh) * 0.6 + sin(uWindTime * 2.9 + swayPh * 1.7) * 0.4) * (0.35 + gust * 0.9) + gust * 0.6;
          vec3 swayW = vec3(0.85, 0.0, 0.5) * (sway * swayH * swayH * ${amp.toFixed(4)});
          transformed += (transpose(swayM) * swayW) / swayS2;
        }`,
      );
    };
    m.customProgramCacheKey = () => `dunebound-sway-${amp.toFixed(4)}`;
    return m;
  }

  buildSky() {
    const u = THREE.UniformsUtils.clone(SkyShader.uniforms);
    u.sunDir.value.copy(this.sunDir);
    u.zenith.value.copy(this.colors.zenith);
    u.horizon.value.copy(this.colors.horizon);
    u.groundCol.value.copy(this.colors.ground);
    u.sunColor.value.copy(this.colors.sun);
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 48, 24), this.skyMaterial);
    this.sky.renderOrder = -10;
    this.sky.userData.noAO = true;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.fog = new THREE.FogExp2(this.colors.horizon.clone(), 0.0023);
    this.scene.background = null;

    // Image based lighting from the same sky (sun disc suppressed, sand below the horizon).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.skyMaterial.clone());
    envSky.material.uniforms.discIntensity.value = 0;
    envSky.material.uniforms.envMode.value = 1;
    envScene.add(envSky);
    this.envMap = pmrem.fromScene(envScene, 0.02, 0.1, 500).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    envSky.geometry.dispose();
  }

  buildLights() {
    const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.82, 0.62), 3.4);
    sun.castShadow = true;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 420;
    const r = 62;
    sun.shadow.camera.left = -r;
    sun.shadow.camera.right = r;
    sun.shadow.camera.top = r;
    sun.shadow.camera.bottom = -r;
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.035;
    this.shadowRange = r;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);
    const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.68, 0.95), new THREE.Color(0.62, 0.45, 0.3), 0.35);
    this.scene.add(hemi);
  }

  /**
   * The desert floor and the boulders on its dunes. Called once at start-up
   * without a config (menu-background desert) and again from buildWorld():
   * with a river the dunes give way to a broad, flat, green-tinged Nile valley
   * that runs from horizon to horizon. The play area itself stays flat (y = 0).
   */
  buildTerrain(config) {
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
    this.river = config && config.river ? new RiverPath(config.river, RIVER_EXTEND) : null;
    const river = this.river;
    const group = new THREE.Group();
    const size = TERRAIN_SIZE;
    const seg = 224;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const uv = geo.attributes.uv;
    const tile = 7; // metres per sand texture tile
    const bankOut = river ? river.halfWidth + river.bank : 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const d = river ? river.distance(x, z, TERRAIN_REACH) : Infinity;
      const y = this._terrainHeight(x, z, d);
      pos.setY(i, y);
      uv.setXY(i, x / tile, z / tile);
      const [r, g, b] = this._groundTint(x, z, d, y);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, this.materials.sand);
    ground.receiveShadow = true;
    this.ground = ground;
    group.add(ground);

    // Scattered boulders on the dunes (never in the valley).
    const rockGeo = this.makeRockGeometry(1, 404, 1);
    const count = 160;
    const rocks = new THREE.InstancedMesh(rockGeo, this.materials.rock, count);
    const rand = mulberry32(55);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc3 = new THREE.Vector3();
    const p = new THREE.Vector3();
    let n = 0;
    for (let tries = 0; n < count && tries < 20000; tries++) {
      const x = (rand() - 0.5) * 900;
      const z = (rand() - 0.5) * 900;
      const sc = 0.8 + rand() * rand() * 6;
      e.set(rand() * 0.5, rand() * Math.PI * 2, rand() * 0.5);
      const sx = 0.8 + rand() * 0.6;
      const sy = 0.5 + rand() * 0.5;
      const sz = 0.8 + rand() * 0.6;
      if (Math.max(Math.abs(x), Math.abs(z)) < TERRAIN_FLAT + 10) continue;
      if (river && river.distance(x, z, bankOut + 41) < bankOut + 40) continue;
      p.set(x, this.groundHeightVisual(x, z) + sc * 0.2, z);
      sc3.set(sc * sx, sc * sy, sc * sz);
      m4.compose(p, q.setFromEuler(e), sc3);
      rocks.setMatrixAt(n++, m4);
    }
    rocks.count = n;
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    group.add(rocks);
    this.terrain = group;
    this.scene.add(group);
  }

  /** Distant monuments that sell the scale of the world. */
  buildVista() {
    const group = new THREE.Group();
    const mat = this.materials.sandstone.clone();
    mat.map = this.tex.stone.map.clone();
    mat.map.repeat.set(10, 10);
    mat.map.needsUpdate = true;
    mat.normalMap = this.tex.stone.normalMap.clone();
    mat.normalMap.repeat.set(10, 10);
    mat.normalMap.needsUpdate = true;
    const monuments = [
      [-300, -460, 120, 150],
      [230, -560, 90, 110],
      [-620, -240, 70, 82],
      [520, -330, 50, 58],
    ];
    for (const [x, z, r, h] of monuments) {
      const geo = new THREE.ConeGeometry(r, h, 4, 1);
      geo.rotateY(Math.PI / 4);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, h / 2 - 2, z);
      group.add(m);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.06, h * 0.06, 4, 1).rotateY(Math.PI / 4), this.materials.gold);
      cap.position.set(x, h - 2 - h * 0.03 + 0.5, z);
      group.add(cap);
    }
    this.scene.add(group);
  }

  /** Dune displacement shared by buildTerrain() and groundHeightVisual(); `d` = distance to the river. */
  _terrainHeight(x, z, d) {
    const perlin = this._groundPerlin || (this._groundPerlin = new Perlin(808));
    const m = Math.max(Math.abs(x), Math.abs(z));
    let mask = smooth(TERRAIN_FLAT, TERRAIN_FLAT + 95, m);
    if (mask <= 0) return 0;
    if (this.river) mask *= smooth(this.river.halfWidth + this.river.bank + 22, this.river.halfWidth + this.river.bank + 125, d);
    if (mask <= 0) return 0;
    const ridge = perlin.ridged(x * 0.0045 + 50, z * 0.0035 + 50, 4);
    const roll = perlin.fbm(x * 0.002 + 9, z * 0.002 + 3, 3);
    return Math.max(0, (Math.pow(ridge, 2.2) * 34 + roll * 14 + 6) * mask);
  }

  /** Height of the rendered desert floor (matches buildTerrain()'s displacement), used to seat props. */
  groundHeightVisual(x, z) {
    const m = Math.max(Math.abs(x), Math.abs(z));
    if (m <= TERRAIN_FLAT) return 0;
    return this._terrainHeight(x, z, this.river ? this.river.distance(x, z, TERRAIN_REACH) : Infinity);
  }

  buildDust() {
    this.dustUniforms = THREE.UniformsUtils.clone(DustShader.uniforms);
    this.dustUniforms.uMap.value = this.tex.soft;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      vertexShader: DustShader.vertexShader,
      fragmentShader: DustShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const max = QUALITY.ultra.dust;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const seed = new Float32Array(max);
    const rand = mulberry32(31);
    const box = this.dustUniforms.uBox.value;
    for (let i = 0; i < max; i++) {
      pos[i * 3] = (rand() - 0.5) * box;
      pos[i * 3 + 1] = 0.2 + Math.pow(rand(), 1.8) * 16;
      pos[i * 3 + 2] = (rand() - 0.5) * box;
      seed[i] = rand();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  /**
   * Pooled footstep puffs: one Points draw call, a ring buffer of particles
   * integrated on the CPU. Sand-coloured dust on land, white spray in water.
   */
  buildPuffs() {
    const max = 160;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const life = new Float32Array(max).fill(1);
    const size = new Float32Array(max);
    const alpha = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uScale: { value: 300 } }]);
    uniforms.uMap.value = this.tex.soft;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uScale;
        attribute vec3 aColor;
        attribute float aLife;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float t = clamp(aLife, 0.0, 1.0);
          vColor = aColor;
          vAlpha = aLife < 1.0 ? aAlpha * pow(1.0 - t, 1.4) * smoothstep(0.0, 0.08, t) : 0.0;
          gl_PointSize = aLife < 1.0 ? uScale * aSize * (0.45 + t * 1.4) / max(-mvPosition.z, 0.1) : 0.0;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        #include <fog_pars_fragment>
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor, a);
          #include <fog_fragment>
        }`,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 6;
    this.scene.add(points);
    this.puffs = {
      points,
      max,
      next: 0,
      alive: 0,
      vel: new Float32Array(max * 3),
      age: new Float32Array(max),
      dur: new Float32Array(max).fill(1),
      water: new Uint8Array(max),
      dirty: false,
    };
  }

  /**
   * A short-lived puff where a foot lands (x, y, z), `strength` 0..1.5 (heavy
   * steps kick up more). Cheap and pooled; safe to call at any time, even
   * before init() or buildWorld() (it is then a no-op or plain sand dust).
   */
  spawnDust(x, y, z, strength = 1) {
    const P = this.puffs;
    if (!P || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const k = Math.max(0, Math.min(1.5, strength));
    if (k <= 0) return;
    const r = this.river;
    const inWater = !!r && y < 0.3 && r.distance(x, z, r.halfWidth + 1) < r.halfWidth + 0.2;
    const geo = P.points.geometry;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.aColor.array;
    const life = geo.attributes.aLife.array;
    const size = geo.attributes.aSize.array;
    const alpha = geo.attributes.aAlpha.array;
    const n = Math.round(3 + k * 4);
    for (let i = 0; i < n; i++) {
      const id = P.next;
      P.next = (P.next + 1) % P.max;
      const ang = Math.random() * Math.PI * 2;
      const sp = (0.35 + Math.random() * 0.75) * (0.55 + k * 0.5);
      pos[id * 3] = x + Math.cos(ang) * 0.1;
      pos[id * 3 + 1] = y + (inWater ? WATER_Y + 0.02 : 0.05);
      pos[id * 3 + 2] = z + Math.sin(ang) * 0.1;
      P.vel[id * 3] = Math.cos(ang) * sp;
      P.vel[id * 3 + 1] = inWater ? 1.6 + Math.random() * 1.4 * k : 0.25 + Math.random() * 0.45 * k;
      P.vel[id * 3 + 2] = Math.sin(ang) * sp;
      P.age[id] = 0;
      P.water[id] = inWater ? 1 : 0;
      P.dur[id] = inWater ? 0.45 + Math.random() * 0.3 : (0.75 + Math.random() * 0.6) * (0.8 + k * 0.25);
      life[id] = 0;
      const tone = 0.9 + Math.random() * 0.2;
      if (inWater) {
        col[id * 3] = 1.25 * tone;
        col[id * 3 + 1] = 1.32 * tone;
        col[id * 3 + 2] = 1.35 * tone;
        size[id] = (0.12 + Math.random() * 0.12) * (0.7 + k * 0.4);
        alpha[id] = 0.55;
      } else {
        col[id * 3] = 0.64 * tone;
        col[id * 3 + 1] = 0.49 * tone;
        col[id * 3 + 2] = 0.31 * tone;
        size[id] = (0.42 + Math.random() * 0.35) * (0.65 + k * 0.45);
        alpha[id] = 0.2 + 0.18 * Math.min(1, k);
      }
    }
    P.alive = P.max;
    P.dirty = true;
  }

  updatePuffs(dt) {
    const P = this.puffs;
    if (!P || !P.dirty) return;
    const geo = P.points.geometry;
    const pos = geo.attributes.position.array;
    const life = geo.attributes.aLife.array;
    let alive = 0;
    const drag = Math.exp(-dt * 3.2);
    for (let i = 0; i < P.max; i++) {
      if (life[i] >= 1) continue;
      P.age[i] += dt;
      life[i] = Math.min(1, P.age[i] / P.dur[i]);
      if (life[i] >= 1) continue;
      alive++;
      const w = P.water[i];
      P.vel[i * 3] *= drag;
      P.vel[i * 3 + 2] *= drag;
      P.vel[i * 3 + 1] = w ? P.vel[i * 3 + 1] - 9.8 * dt : P.vel[i * 3 + 1] * drag - 0.35 * dt;
      pos[i * 3] += P.vel[i * 3] * dt;
      pos[i * 3 + 1] = Math.max(w ? WATER_Y : 0.02, pos[i * 3 + 1] + P.vel[i * 3 + 1] * dt);
      pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
    }
    for (const name of ['position', 'aLife', 'aColor', 'aSize', 'aAlpha']) geo.attributes[name].needsUpdate = true;
    P.dirty = alive > 0;
    P.points.material.uniforms.uScale.value = (window.innerHeight || 720) * this.renderer.getPixelRatio() * 0.55;
  }

  /**
   * A flat-topped limestone outcrop: steep weathered sides broken into
   * horizontal bedding ledges (unit size, flat base at y = -0.35).
   */
  makeCliffGeometry(seed) {
    const geo = new THREE.IcosahedronGeometry(1, 3);
    const perlin = new Perlin(seed);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    const bed = 0.13;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = perlin.fbm(v.x * 1.1 + 5, v.z * 1.1 + v.y * 0.6 + 5, 4);
      const ridge = perlin.ridged(v.x * 1.8 + 2, v.z * 1.8 + v.y * 1.4 + 7, 3);
      v.multiplyScalar(1 + n * 0.26 + ridge * 0.14);
      // Steep sides and a flattened, slightly domed top.
      const side = Math.hypot(v.x, v.z);
      if (v.y > 0.1) {
        const k = 1 + (v.y - 0.1) * 0.9;
        v.x *= Math.min(1.25, k);
        v.z *= Math.min(1.25, k);
      }
      if (v.y > 0.5) v.y = 0.5 + (v.y - 0.5) * 0.22 + (1 - side) * 0.04;
      // Bedding planes: snap heights towards strata and recess alternate beds.
      const q = Math.round(v.y / bed);
      v.y += (q * bed - v.y) * 0.6;
      const recess = (q & 1 ? 0.94 : 1) - perlin.noise(v.x * 3 + q, v.z * 3, 256, 256) * 0.03;
      v.x *= recess;
      v.z *= recess;
      if (v.y < -0.35) v.y = -0.35;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      uv.setXY(i, (Math.atan2(v.x, v.z) / Math.PI + 1) * 2, v.y * 1.2);
    }
    return geo;
  }

  makeRockGeometry(radius, seed, detail = 2) {
    const geo = new THREE.IcosahedronGeometry(radius, detail);
    const perlin = new Perlin(seed);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = perlin.fbm(v.x * 1.3 + 5, v.z * 1.3 + v.y * 0.7 + 5, 4);
      const strata = Math.sin(v.y * 9 + n * 2) * 0.03;
      v.multiplyScalar(1 + n * 0.35 + strata);
      if (v.y < -0.35 * radius) v.y = -0.35 * radius;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    // Cylindrical UVs; the seam faces away from the play area for quarry walls.
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      uv.setXY(i, (Math.atan2(v.x, v.z) / Math.PI + 1) * 2, v.y * 1.2);
    }
    return geo;
  }

  // ----- config-driven world props ------------------------------------------

  /** Builds every gameplay prop from the server's world configuration. */
  buildWorld(config) {
    this._disposeWorld();
    this.fires = [];
    this.pulses = [];
    this.boats = [];
    this.foliage = [];
    this.riverUniforms = null;
    /** Tall props standing on impassable cells, [x0, z0, x1, z1, top]; the camera keeps above them. */
    this.cameraBoxes = [];
    const g = new THREE.Group();
    this.worldGroup = g;
    this.config = config;
    const rand = mulberry32(99);

    // The desert floor is re-carved for this world's river valley.
    this.buildTerrain(config);
    this.roads = this._planRoads(config);
    this._planKeepOut(config);

    this.buildFoundation(g, config.pyramid);
    for (const o of config.obstacles) {
      const cx = (o.x0 + o.x1) / 2;
      const cz = (o.z0 + o.z1) / 2;
      switch (o.kind) {
        case 'obelisk':
          this.buildObelisk(g, cx, cz);
          break;
        case 'counter':
          this.buildBazaar(g, o);
          break;
        case 'rack':
          this.buildRack(g, o);
          break;
        case 'sundial':
          this.buildSundial(g, cx, cz);
          break;
        case 'pond':
          this.buildPond(g, o);
          break;
        case 'palm':
          this.buildPalm(g, cx, cz, o.seed || 1);
          break;
        case 'rock':
          this.buildQuarryRock(g, o);
          break;
        case 'brazier':
          this.buildBrazier(g, cx, 0, cz);
          break;
        case 'pile':
          this.buildPileBase(g, o);
          break;
        default:
          break;
      }
    }
    this._flushCliffs(g);
    const z = config.zones;
    this.addZoneRing(g, z.strength.x, z.strength.z, z.strength.r, 0xffc861);
    this.addZoneRing(g, z.shop.x, z.shop.z, z.shop.r, 0xffd27a);
    this.addZoneRing(g, z.track.x, z.track.z, z.track.r, 0x9fe0ff);
    this.addLabel(g, 'STRENGTH', z.strength.x, 5.2, z.strength.z);
    this.addLabel(g, 'SPRINT TRACK', z.track.x, 5.5, z.track.z);
    this.addLabel(g, 'BAZAAR', z.shop.x, 7.4, z.shop.z + 5.5);
    const p = config.pile;
    this.quarryLabel = this.addLabel(g, 'QUARRY', (p.minX + p.maxX) / 2, 8.8, (p.minZ + p.maxZ) / 2);
    this.buildStrengthPlatform(g, z.strength);
    this.buildTrack(g, z.track);
    if (this.river) {
      this.buildRiver(g, config);
      for (const c of config.crossings || []) {
        if (c.kind === 'bridge') this.buildCauseway(g, c);
        else if (c.kind === 'ford') this.buildFord(g, c);
      }
      this.buildQuay(g, config);
      this.buildRiverLife(g, config);
      this.buildBoats(g);
      const r = this.river;
      // The river's name stands upstream over its southern bank, off the line of the crossing labels.
      const nileX = -Math.min(72, config.worldHalf * 0.45);
      this.addLabel(g, 'THE NILE', nileX, 7.5, r.centreZ(nileX) - r.halfWidth - 2, 2.6);
      // Crossing names hover over the water just downstream, clear of the walkway itself.
      for (const c of config.crossings || []) {
        const lx = c.x1 + (c.kind === 'bridge' ? 6.5 : 5.5);
        const label = (c.name || (c.kind === 'bridge' ? 'Causeway' : 'Ford')).toUpperCase();
        this.addLabel(g, label, lx, c.kind === 'bridge' ? 4.6 : 3.6, r.centreZ(lx));
      }
      this._updateFoamUniforms();
    }
    this.buildQuarryBackdrop(g, config);
    this.buildRoads(g);
    this.scatterRubble(g, config, rand);
    this.applyFoliageQuality();
    this.scene.add(g);
  }

  /** Removes the previous world and frees everything it owned (shared materials/textures are kept). */
  _disposeWorld() {
    if (!this.worldGroup) return;
    this.scene.remove(this.worldGroup);
    const keys = ['map', 'normalMap', 'roughnessMap', 'alphaMap', 'emissiveMap', 'metalnessMap'];
    const seen = new Set();
    this.worldGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (this.sharedMaterials.has(m) || seen.has(m)) continue;
        seen.add(m);
        for (const k of keys) {
          const t = m[k];
          if (t && t.isTexture && !this.sharedTextures.has(t)) t.dispose();
        }
        m.dispose();
      }
    });
    this.worldGroup = null;
  }

  // ----- the Nile ---------------------------------------------------------------

  /**
   * The roads of the long haul, derived from the config: a paved processional
   * way from the pyramid's north face to the Great Causeway and on to the
   * quarry, and a fainter dirt trail through the Reed Ford.
   * Each road: { kind: 'paved'|'trail', pts: [[x, z, width], ...] } (Catmull-Rom control points).
   */
  _planRoads(config) {
    const roads = [];
    const pc = config.pyramid;
    const p = config.pile;
    const face = pc.cz + (pc.base * pc.blockW) / 2;
    const pcx = (p.minX + p.maxX) / 2;
    const front = p.minZ - 2;
    const crossings = (this.river && config.crossings) || [];
    const bridge = crossings.find((c) => c.kind === 'bridge');
    const ford = crossings.find((c) => c.kind === 'ford');
    const r = this.river;
    if (bridge) {
      const bx = (bridge.x0 + bridge.x1) / 2;
      const bw = bridge.x1 - bridge.x0;
      const avenue = Math.min(46, bridge.z0 - 20);
      roads.push({
        kind: 'paved',
        pts: [
          [pc.cx, face + 0.2, 6.4],
          [pc.cx, face + 14, 5.2],
          [pc.cx, avenue, 5.2],
          [pc.cx + (bx - pc.cx) * 0.4, avenue + (bridge.z0 - avenue) * 0.45, 5.2],
          [bx, bridge.z0 - 7, 6.2],
          [bx, bridge.z0 + 0.5, bw],
        ],
      });
      // Run straight out between the torches flanking the causeway's end before turning for the quarry.
      const side = Math.sign(pcx - bx) || 1;
      roads.push({
        kind: 'paved',
        pts: [
          [bx, bridge.z1 - 0.5, bw],
          [bx, bridge.z1 + 3.5, 6.2],
          [bx + side * 4, bridge.z1 + 6.8, 5.4],
          [pcx - side * 8, front + 1.6, 5.2],
          [pcx, front + 0.3, 6],
        ],
      });
    }
    if (ford && r) {
      const fx = (ford.x0 + ford.x1) / 2;
      const south = r.centreZ(fx) - r.halfWidth;
      const north = r.centreZ(fx) + r.halfWidth;
      const branch = Math.min(40, south - 30);
      roads.push({
        kind: 'trail',
        pts: [
          [pc.cx + 1.5, branch, 2.6],
          [pc.cx + (fx - pc.cx) * 0.4, branch + (south - branch) * 0.35, 3.2],
          [fx - 1.5, south - 14, 3.4],
          [fx, south - 4, 3.6],
          [fx, south + 0.9, 3.8],
        ],
      });
      const side = Math.sign(pcx - fx) || -1;
      roads.push({
        kind: 'trail',
        pts: [
          [fx, north - 0.9, 3.8],
          [fx, north + 3.5, 3.6],
          [fx + side * 8, front - 0.5, 3.2],
          [(side < 0 ? p.maxX : p.minX) + side * -1.2, front + 0.8, 2.8],
        ],
      });
    }
    // Dense samples (x, z, tangent, width) for the ribbons and the keep-out tests.
    for (const road of roads) {
      const curve = new THREE.CatmullRomCurve3(road.pts.map(([x, zz, w]) => new THREE.Vector3(x, w, zz)), false, 'centripetal');
      const len = curve.getLength();
      const n = Math.max(2, Math.ceil(len / 1.25));
      road.samples = [];
      road.length = len;
      const v = new THREE.Vector3();
      const tg = new THREE.Vector3();
      for (let i = 0; i <= n; i++) {
        curve.getPointAt(i / n, v);
        curve.getTangentAt(i / n, tg);
        const l = Math.hypot(tg.x, tg.z) || 1;
        road.samples.push({ x: v.x, z: v.z, w: v.y, tx: tg.x / l, tz: tg.z / l, s: (i / n) * len });
      }
    }
    return roads;
  }

  /** Areas the river dressing (reeds, rocks, grass) must leave clear. */
  _planKeepOut(config) {
    const boxes = [];
    for (const o of config.obstacles) boxes.push([o.x0 - 0.8, o.z0 - 0.8, o.x1 + 0.8, o.z1 + 0.8]);
    const pc = config.pyramid;
    const half = (pc.base * pc.blockW) / 2 + 2;
    boxes.push([pc.cx - half, pc.cz - half, pc.cx + half, pc.cz + half]);
    for (const c of config.crossings || []) {
      const pad = c.kind === 'bridge' ? 3.2 : 0.9;
      boxes.push([c.x0 - pad, c.z0 - 1, c.x1 + pad, c.z1 + 1]);
    }
    for (const zn of Object.values(config.zones)) boxes.push([zn.x - zn.r - 1, zn.z - zn.r - 1, zn.x + zn.r + 1, zn.z + zn.r + 1]);
    this.keepOut = boxes;
  }

  /** True if (x, z) lies within `pad` metres of a road or inside a keep-out box. */
  _isKept(x, z, pad = 0) {
    for (const b of this.keepOut) if (x > b[0] - pad && x < b[2] + pad && z > b[1] - pad && z < b[3] + pad) return true;
    return this._onRoad(x, z, pad);
  }

  /** True if (x, z) lies on (or within `pad` metres of) a road. */
  _onRoad(x, z, pad = 0) {
    for (const road of this.roads) {
      for (const sm of road.samples) {
        const lim = sm.w / 2 + pad + 0.4;
        const dx = x - sm.x;
        const dz = z - sm.z;
        if (dx * dx + dz * dz < lim * lim) return true;
      }
    }
    return false;
  }

  /** Registers an ellipse the water foams around (piers, hulls, quay faces). */
  _addFoam(x, z, rx, rz) {
    if (!this.riverUniforms) return;
    const list = this._foamList || (this._foamList = []);
    if (list.length < this.riverUniforms.uFoamBodies.value.length) list.push([x, z, rx, rz]);
  }

  _updateFoamUniforms() {
    const u = this.riverUniforms;
    const list = this._foamList || [];
    u.uFoamBodies.value.forEach((v, i) => (list[i] ? v.set(list[i][0], list[i][1], list[i][2], list[i][3]) : v.set(1e5, 1e5, 1, 1)));
    u.uFoamCount.value = list.length;
    this._foamList = [];
  }

  /**
   * The Nile itself: a ribbon of animated water along the collision centre
   * line (UV.x = arc length, UV.y = signed distance across), the wet sand of
   * both banks, and the shader uniforms everything on the river shares.
   */
  buildRiver(g, config) {
    const r = this.river;
    const hw = r.halfWidth;
    const u = makeRiverUniforms(this.tex);
    u.uHalfWidth.value = hw;
    u.uBank.value = r.bank;
    u.uSunDir.value.copy(this.sunDir);
    u.uSunColor.value.copy(this.colors.sun);
    const shoals = (config.crossings || []).filter((c) => c.kind === 'ford');
    shoals.slice(0, u.uShoals.value.length).forEach((c, i) => u.uShoals.value[i].set(c.x0, c.z0, c.x1, c.z1));
    u.uShoalCount.value = Math.min(shoals.length, u.uShoals.value.length);
    this.riverUniforms = u;
    this.riverFlow = r.flow || 1;
    this._foamList = [];

    // Water ribbon: slightly wider than the impassable band so it tucks under the banks.
    const overlap = 0.9;
    const across = 16;
    const n = r.n;
    const vcount = n * (across + 1);
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const ruv = new Float32Array(vcount * 2);
    const flow = new Float32Array(vcount * 2);
    for (let i = 0; i < n; i++) {
      const nx = -r.tz[i];
      const nz = r.tx[i];
      for (let j = 0; j <= across; j++) {
        const a = -(hw + overlap) + ((hw + overlap) * 2 * j) / across;
        const k = i * (across + 1) + j;
        pos[k * 3] = r.x[i] + nx * a;
        pos[k * 3 + 1] = WATER_Y;
        pos[k * 3 + 2] = r.z[i] + nz * a;
        nor[k * 3 + 1] = 1;
        ruv[k * 2] = r.s[i];
        ruv[k * 2 + 1] = a;
        flow[k * 2] = r.tx[i];
        flow[k * 2 + 1] = r.tz[i];
      }
    }
    const index = [];
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < across; j++) {
        const a = i * (across + 1) + j;
        const b = a + across + 1;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('riverUv', new THREE.BufferAttribute(ruv, 2));
    geo.setAttribute('flowDir', new THREE.BufferAttribute(flow, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    const water = new THREE.Mesh(geo, this.makeRiverMaterial(u));
    water.receiveShadow = true;
    water.renderOrder = 3;
    water.frustumCulled = false;
    this.riverMesh = water;
    g.add(water);

    // Wet sand along both banks; vertex colours continue the floodplain tint so the strip melts into the ground.
    const inner = hw - overlap - 0.3;
    const outer = hw + r.bank + 1.5;
    const cols = 6;
    const bank = { pos: [], uv: [], col: [], t: [], idx: [] };
    for (const side of [-1, 1]) {
      const base = bank.pos.length / 3;
      for (let i = 0; i < n; i++) {
        const nx = -r.tz[i];
        const nz = r.tx[i];
        for (let j = 0; j <= cols; j++) {
          const a = side * (inner + ((outer - inner) * j) / cols);
          const x = r.x[i] + nx * a;
          const zz = r.z[i] + nz * a;
          bank.pos.push(x, 0.012, zz);
          bank.uv.push(x / 7, zz / 7);
          const d = Math.abs(a);
          const tint = this._groundTint(x, zz, d, 0);
          bank.col.push(tint[0], tint[1], tint[2]);
          bank.t.push(clamp01((d - hw) / (outer - hw)));
        }
      }
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < cols; j++) {
          const a = base + i * (cols + 1) + j;
          const b = a + cols + 1;
          if (side > 0) bank.idx.push(a, a + 1, b, a + 1, b + 1, b);
          else bank.idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute('position', new THREE.Float32BufferAttribute(bank.pos, 3));
    bgeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(bank.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    bgeo.setAttribute('uv', new THREE.Float32BufferAttribute(bank.uv, 2));
    bgeo.setAttribute('color', new THREE.Float32BufferAttribute(bank.col, 3));
    bgeo.setAttribute('bankT', new THREE.Float32BufferAttribute(bank.t, 1));
    bgeo.setIndex(bank.idx);
    bgeo.computeBoundingSphere();
    const banks = new THREE.Mesh(bgeo, this.makeBankMaterial(u));
    banks.receiveShadow = true;
    banks.renderOrder = 1;
    banks.frustumCulled = false;
    banks.userData.noAO = true;
    g.add(banks);
  }

  /**
   * Flowing Nile water: a MeshStandardMaterial (so shadows, fog, IBL and the
   * sun's GGX highlight all come from three.js) with the surface, colour and
   * foam generated in onBeforeCompile:
   *  - three ripple layers of a directional-wave normal map scrolling
   *    downstream at the river's flow speed (UVs follow the current),
   *  - a depth profile across the channel (jade shallows to deep teal) over a
   *    caustic-lit sandy bed, much shallower at fords,
   *  - fresnel sky reflection from the PMREM environment + bloom-ready glints,
   *  - lapping shoreline foam, foam rings and wakes around registered bodies,
   *  - a gentle vertex swell mid-channel that calms in the shallows.
   */
  makeRiverMaterial(u) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      envMap: this.envMap,
      envMapIntensity: 1.25,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    mat.defines = { MAX_SHOALS: u.uShoals.value.length, MAX_FOAM: u.uFoamBodies.value.length };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          ${WATER_COMMON}
          attribute vec2 riverUv;
          attribute vec2 flowDir;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vRiver = riverUv;
          vFlowDir = flowDir;
          vec3 wpos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          float shoalV = 0.0;
          for (int i = 0; i < MAX_SHOALS; i++) {
            if (i >= uShoalCount) break;
            shoalV = max(shoalV, rectMask(wpos.xz, uShoals[i], 3.0, 9.0));
          }
          float swellAmt = (1.0 - smoothstep(0.2, 0.75, abs(riverUv.y) / uHalfWidth)) * (1.0 - shoalV);
          float swell = sin(dot(wpos.xz, vec2(0.093, 0.051)) - uTime * 0.85) * 0.6
                      + sin(dot(wpos.xz, vec2(-0.041, 0.112)) - uTime * 0.63 + 1.7) * 0.4;
          transformed.y += swell * 0.045 * swellAmt;
          vWaterWorld = wpos + vec3(0.0, transformed.y - position.y, 0.0);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          ${WATER_COMMON}
          uniform vec3 uDeep;
          uniform vec3 uMid;
          uniform vec3 uShallow;`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `
          vec2 wT = normalize(vFlowDir);
          vec2 wB = vec2(-wT.y, wT.x);
          float along = vRiver.x;
          float across = vRiver.y;
          vec2 wp = vWaterWorld.xz;
          float camDist = length(cameraPosition - vWaterWorld);
          float lane = 0.0;
          float shoal = 0.0;
          float wob = (texture2D(uNoise, wp * 0.05).g - 0.5) * 1.6;
          for (int i = 0; i < MAX_SHOALS; i++) {
            if (i >= uShoalCount) break;
            lane = max(lane, rectMask(wp, uShoals[i] + vec4(-wob, 0.0, wob, 0.0), 0.7, 1.6));
            shoal = max(shoal, rectMask(wp, uShoals[i], 3.0, 9.0));
          }
          // Ripples: three layers carried downstream by the current (u = along the flow).
          vec4 r1 = texture2D(uRiverNormal, vec2(along / 9.0 - uScroll.x, across / 9.0));
          vec4 r2 = texture2D(uRiverNormal, vec2(along / 3.7 - uScroll.y, -across / 3.7 + 0.37));
          vec4 r3 = texture2D(uRiverNormal, vec2(along / 23.0 - uScroll.w, across / 23.0 + 0.61));
          vec2 n1 = r1.xy * 2.0 - 1.0;
          vec2 n2 = (r2.xy * 2.0 - 1.0) * vec2(1.0, -1.0);
          vec2 n3 = r3.xy * 2.0 - 1.0;
          float rippleK = mix(1.0, 0.4, smoothstep(25.0, 260.0, camDist));
          vec2 slope = (n1 * 0.3 + n2 * (0.22 + lane * 0.4) + n3 * 0.2) * rippleK;
          vec3 nT = normalize(vec3(slope, 1.0));
          vec3 nW = normalize(vec3(wT.x, 0.0, wT.y) * nT.x + vec3(wB.x, 0.0, wB.y) * nT.y + vec3(0.0, nT.z, 0.0));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          float crest = r1.a * 0.6 + r2.a * 0.4;

          // Depth across the channel, shallow over sand bars and at fords.
          float aAbs = abs(across);
          float edgeDist = uHalfWidth - aAbs;
          float aN = clamp(aAbs / uHalfWidth, 0.0, 1.0);
          vec4 nzA = texture2D(uNoise, wp * 0.011);
          vec4 nzB = texture2D(uNoise, wp * 0.043 + 0.31);
          float depth = (1.0 - aN * aN) * (0.78 + nzA.r * 0.44) - (nzB.g - 0.5) * 0.1;
          // Sand bars and shallows creep in from the banks here and there.
          float bar = smoothstep(0.55, 0.8, texture2D(uNoise, wp * 0.0065 + 0.13).r) * smoothstep(0.45, 0.8, aN);
          depth *= 1.0 - bar * 0.65;
          depth = clamp(depth, 0.0, 1.2);
          depth = mix(depth, depth * 0.3, shoal);
          depth = mix(depth, 0.03 + nzB.g * 0.06, lane);
          // Sandy bed seen through the water, wobbling with the ripples and lit by caustics.
          vec3 bed = texture2D(uSandMap, wp / 7.0 + nT.xy * 0.05).rgb * vec3(0.56, 0.52, 0.42) * (1.0 + lane * 0.5 + bar * 0.2);
          vec2 cuv = wp * 0.17;
          float c1 = texture2D(uNoise, cuv + vec2(uTime * 0.023, uTime * 0.011)).a;
          float c2 = texture2D(uNoise, cuv * 1.31 + vec2(-uTime * 0.015, uTime * 0.021) + 0.47).a;
          float caustic = smoothstep(0.2, 0.9, min(c1, c2) * 1.7);
          float clarity = exp(-depth * 6.5);
          bed += vec3(1.0, 0.93, 0.72) * caustic * clarity * 0.55;
          vec3 body = mix(uShallow, uMid, smoothstep(0.02, 0.4, depth));
          body = mix(body, uDeep, smoothstep(0.32, 1.0, depth));
          body *= 0.92 + nzA.g * 0.16;
          vec3 waterCol = mix(body, bed, clarity * 0.9);

          // Foam: lapping at the shore, rings and wakes around bodies, rippling over the ford.
          float lap = sin(uTime * 1.15 + along * 0.19 + nzA.r * 7.0) * 0.5 + 0.5;
          float shorePatch = smoothstep(0.3, 0.75, texture2D(uNoise, vec2(along * 0.006 + uTime * 0.004, across * 0.02)).g);
          float shore = (1.0 - smoothstep(0.0, 0.35 + lap * 0.6 + nzB.r * 0.6, edgeDist)) * (0.35 + 0.5 * shorePatch);
          float ring = 0.0;
          float wake = 0.0;
          for (int i = 0; i < MAX_FOAM; i++) {
            if (i >= uFoamCount) break;
            vec4 fb = uFoamBodies[i];
            vec2 q = wp - fb.xy;
            float ds0 = dot(q, wT);
            if (ds0 < -fb.z - 2.0 || ds0 > fb.z + 30.0 || abs(dot(q, wB)) > fb.w + 6.0) continue;
            float d = (length(q / fb.zw) - 1.0) * min(fb.z, fb.w);
            float rw = clamp(min(fb.z, fb.w) * 1.4, 0.3, 1.1);
            ring = max(ring, (1.0 - smoothstep(0.0, rw * (1.0 + lap * 0.4), d)) * step(-0.25, d));
            float ds = ds0 - fb.z * 0.6;
            float dl = abs(dot(q, wB));
            wake = max(wake, step(0.0, ds) * (1.0 - smoothstep(fb.w * 0.5, fb.w * 1.3 + ds * 0.12, dl)) * exp(-ds / min(2.0 + fb.z * 2.2, 9.0)));
          }
          float foamAmt = max(max(shore, ring), wake * 0.75);
          foamAmt = max(foamAmt, lane * (0.13 + 0.09 * sin(uTime * 2.1 + along * 0.7 + across * 0.9)) + shoal * 0.05);
          vec2 fuv = vec2(along / 9.0 - uScroll.z, across / 9.0);
          float lace = max(texture2D(uNoise, fuv).b, texture2D(uNoise, fuv * 0.55 + vec2(0.21, 0.67)).b * 0.85);
          float foam = smoothstep(1.0 - foamAmt, 1.18 - foamAmt, lace) * sqrt(foamAmt);
          foam = max(foam, smoothstep(0.82, 0.95, crest) * lane * 0.6);
          foam *= 1.0 - smoothstep(45.0, 220.0, camDist) * (1.0 - lane * 0.7);
          waterCol = mix(waterCol, vec3(0.9, 0.88, 0.82), foam);
          diffuseColor.rgb = waterCol;
          roughnessFactor = mix(0.085 + lane * 0.06, 0.62, foam);
          // Soft waterline: fully opaque a hand's width in from the bank, gone just under it.
          float waterAlpha = smoothstep(-0.55, 0.2, edgeDist);
          diffuseColor.a = waterAlpha;
          `,
        )
        .replace(
          '#include <lights_fragment_begin>',
          // Tone the mirror down where the bed should read through (shallows, the ford lane).
          `material.specularF90 = mix(0.72, 0.3, max(lane, clarity * 0.6));
          material.specularColor *= mix(1.0, 0.5, lane);
          ` +
          // The braziers stand on land, out of reach of the water: skip point lights here.
          THREE.ShaderChunk.lights_fragment_begin.replace('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )', '#if 0') +
            `
          #if NUM_DIR_LIGHTS > 0
            float waterSun = clamp(dot(directLight.color, vec3(1.0)) / max(dot(directionalLights[0].color, vec3(1.0)), 1e-4), 0.0, 1.0);
          #else
            float waterSun = 1.0;
          #endif`,
        )
        .replace(
          '#include <aomap_fragment>',
          // Tame the broad GGX sun lobe on rippled water (it would blow the whole glitter path
          // out to white); the sparkle comes from the explicit glints below instead.
          `reflectedLight.directSpecular *= 0.3;
          #include <aomap_fragment>`,
        )
        .replace(
          '#include <opaque_fragment>',
          `{
            // Sharp sun glints on wave crests (HDR, so they bloom) and a soft sun path.
            vec3 wV = normalize(cameraPosition - vWaterWorld);
            vec3 wR = reflect(-wV, nW);
            float sd = max(dot(wR, uSunDir), 0.0);
            float glint = pow(sd, 1800.0) * (8.0 + crest * 42.0) * smoothstep(0.45, 0.8, crest) + pow(sd, 220.0) * 0.12;
            outgoingLight += uSunColor * glint * waterSun * (1.0 - foam) * waterAlpha;
          }
          #include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => 'dunebound-river';
    return mat;
  }

  /** Wet, darker, glossier sand along the banks; frays into the dry floodplain with noise. */
  makeBankMaterial(u) {
    const t = this.tex.sand;
    const mat = new THREE.MeshStandardMaterial({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      envMap: this.envMap,
      envMapIntensity: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    mat.normalScale.set(0.6, 0.6);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uNoise = u.uNoise;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float bankT;\nvarying float vBankT;\nvarying vec2 vBankWorld;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvBankT = bankT;\nvBankWorld = (modelMatrix * vec4(transformed, 1.0)).xz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform sampler2D uNoise;\nvarying float vBankT;\nvarying vec2 vBankWorld;')
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          float bn = texture2D(uNoise, vBankWorld * 0.045).r + texture2D(uNoise, vBankWorld * 0.19).g * 0.6 - 0.8;
          float bt = vBankT + bn * 0.3;
          // A thin band right at the waterline stays freshly wet as wavelets run up the sand.
          float run = sin(uTime * 1.15 + dot(vBankWorld, vec2(0.19, 0.05)) + bn * 6.0) * 0.5 + 0.5;
          float wet = 1.0 - smoothstep(0.18, 0.78, bt);
          float sheen = 1.0 - smoothstep(0.02, 0.07 + run * 0.06, bt);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.5, 0.47, 0.41), wet);
          diffuseColor.rgb *= 1.0 - sheen * 0.12;
          roughnessFactor = mix(roughnessFactor, 0.34, wet * 0.8);
          roughnessFactor = mix(roughnessFactor, 0.22, sheen);
          diffuseColor.a *= 1.0 - smoothstep(0.66, 0.98, bt);`,
        );
    };
    mat.customProgramCacheKey = () => 'dunebound-bank';
    return mat;
  }

  /**
   * The Great Causeway: a stone viaduct whose walkable deck is exactly the
   * height-field profile (0 -> deck over `ramp` metres at both ends, flat over
   * the water), carried on low segmental arches and cutwater piers, with
   * parapets, gate pillars and a pair of small obelisks at mid-span.
   */
  buildCauseway(g, c) {
    const r = this.river;
    const hw = r.halfWidth;
    const W = c.x1 - c.x0;
    const cx = (c.x0 + c.x1) / 2;
    const edge = 0.55; // deck overhang that carries the parapets, outside the walkable cells
    const deck = c.deck;
    const ramp = c.ramp;
    const h = (zz) => deck * Math.min(clamp01((zz - c.z0) / ramp), clamp01((c.z1 - zz) / ramp));
    const zS = Math.min(r.centreZ(c.x0), r.centreZ(c.x1)) - hw;
    const zN = Math.max(r.centreZ(c.x0), r.centreZ(c.x1)) + hw;
    const span0 = Math.max(zS + 0.35, c.z0 + ramp + 0.2);
    const span1 = Math.min(zN - 0.35, c.z1 - ramp - 0.2);
    const nArch = Math.max(3, Math.round((span1 - span0) / 3.9));
    const pier = 1.15;
    const open = (span1 - span0 - (nArch - 1) * pier) / nArch;
    const spring = 0.06;
    const crown = deck - 0.2;
    const T = 2.4;
    const stone = [];
    const gold = [];
    const glyph = [];

    // Deck: the side elevation (world z, y) extruded across the flow, arch openings cut as holes.
    const shape = new THREE.Shape();
    shape.moveTo(c.z0 - 0.3, -0.7);
    shape.lineTo(c.z1 + 0.3, -0.7);
    shape.lineTo(c.z1 + 0.3, 0.0);
    shape.lineTo(c.z1, 0.0);
    shape.lineTo(c.z1 - ramp, deck);
    shape.lineTo(c.z0 + ramp, deck);
    shape.lineTo(c.z0, 0.0);
    shape.lineTo(c.z0 - 0.3, 0.0);
    const arches = [];
    for (let k = 0; k < nArch; k++) {
      const za = span0 + k * (open + pier);
      const zb = za + open;
      arches.push([za, zb]);
      const hole = new THREE.Path();
      hole.moveTo(za, -0.6);
      hole.lineTo(zb, -0.6);
      hole.lineTo(zb, spring);
      for (let i = 1; i <= 12; i++) {
        const th = (i / 12) * Math.PI;
        hole.lineTo((za + zb) / 2 + Math.cos(th) * (open / 2), spring + Math.sin(th) * (crown - spring));
      }
      shape.holes.push(hole);
    }
    const extrudeAcross = (sh, x0, x1) => {
      const geo = new THREE.ExtrudeGeometry(sh, { depth: x1 - x0, bevelEnabled: false, curveSegments: 1 });
      geo.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world -x
      geo.translate(x1, 0, 0);
      return scaleUv(geo, 1 / T);
    };
    stone.push(extrudeAcross(shape, c.x0 - edge, c.x1 + edge));

    // Cutwater piers, pointed both upstream and downstream.
    const nose = 1.7;
    for (let k = 0; k < nArch - 1; k++) {
      const zp = arches[k][1] + pier / 2;
      for (const side of [-1, 1]) {
        const xf = side < 0 ? c.x0 - edge : c.x1 + edge;
        const pts = [
          [xf - side * 0.3, zp - pier / 2],
          [xf, zp - pier / 2],
          [xf + side * nose, zp],
          [xf, zp + pier / 2],
          [xf - side * 0.3, zp + pier / 2],
        ];
        if (side > 0) pts.reverse();
        const sh = new THREE.Shape();
        sh.moveTo(pts[0][0], -pts[0][1]);
        for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], -pts[i][1]);
        const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.95, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.07, bevelSegments: 1, curveSegments: 1 });
        geo.rotateX(-Math.PI / 2); // extrusion -> world +y, shape y -> world -z
        geo.translate(0, -0.6, 0);
        stone.push(scaleUv(geo, 1 / T));
      }
      this._addFoam(cx, zp, W / 2 + edge + nose * 0.75, pier / 2 + 0.12);
    }
    // Projecting arch rings (archivolts) so the low arches read from afar.
    for (const [za, zb] of arches) {
      for (const xFace of [c.x0 - edge - 0.03, c.x1 + edge + 0.03]) {
        const ring = new THREE.TorusGeometry(1, 0.075, 5, 18, Math.PI);
        ring.scale(open / 2 + 0.09, crown - spring + 0.08, 1);
        ring.rotateY(Math.PI / 2);
        ring.translate(xFace, spring, (za + zb) / 2);
        stone.push(scaleUv(ring, 0.5));
      }
    }
    // Buttresses where the causeway meets each bank. Each stands wholly in the water cells of
    // the land column it overhangs (the river curves, so the banks differ per side), never on
    // ground a builder can walk.
    for (const side of [-1, 1]) {
      const xb = side < 0 ? c.x0 - edge - 0.45 : c.x1 + edge + 0.45;
      const xc = side < 0 ? Math.floor(xb - 0.5) + 0.5 : Math.floor(xb + 0.5) + 0.5;
      let zs = Math.floor(r.centreZ(xc) - hw);
      while (r.distance(xc, zs + 0.5) >= hw) zs++;
      let zn = Math.ceil(r.centreZ(xc) + hw);
      while (r.distance(xc, zn - 0.5) >= hw) zn--;
      for (const zb of [zs + 0.85, zn - 0.85]) {
        const b = metricBox(1.0, 1.3, 1.7, T);
        b.translate(xb, 0.0, zb);
        stone.push(b);
      }
    }

    // Parapets with a projecting coping, following the deck over the ramps.
    const zA = c.z0 + 0.45;
    const zB = c.z1 - 0.45;
    const band = (lift, height) => {
      const sh = new THREE.Shape();
      sh.moveTo(zA, h(zA) + lift - 0.03);
      sh.lineTo(c.z0 + ramp, deck + lift - 0.03);
      sh.lineTo(c.z1 - ramp, deck + lift - 0.03);
      sh.lineTo(zB, h(zB) + lift - 0.03);
      sh.lineTo(zB, h(zB) + lift + height);
      sh.lineTo(c.z1 - ramp, deck + lift + height);
      sh.lineTo(c.z0 + ramp, deck + lift + height);
      sh.lineTo(zA, h(zA) + lift + height);
      return sh;
    };
    const ph = 0.95;
    // A moulded string course along both faces at deck level.
    stone.push(extrudeAcross(band(-0.16, 0.12), c.x0 - edge - 0.08, c.x1 + edge + 0.08));
    for (const side of [-1, 1]) {
      const xin = side < 0 ? c.x0 - 0.04 : c.x1 + 0.04;
      const xout = side < 0 ? c.x0 - edge : c.x1 + edge;
      stone.push(extrudeAcross(band(0, ph), Math.min(xin, xout), Math.max(xin, xout)));
      stone.push(extrudeAcross(band(ph, 0.12), Math.min(xin, xout) - 0.08, Math.max(xin, xout) + 0.08));
      const xm = (xin + xout) / 2 + side * 0.12;
      // Gate pillars with cavetto caps and gilded pyramidia at both ends, each filling the end
      // cell of its parapet's collision box so no builder can stand inside one.
      const xp = side < 0 ? c.x0 - 0.5 : c.x1 + 0.5;
      for (const zz of [c.z0 + 0.5, c.z1 - 0.5]) {
        const pil = metricBox(1.0, 3.6, 1.0, T);
        pil.translate(xp, 1.8, zz);
        const neck = metricBox(1.1, 0.12, 1.1, T);
        neck.translate(xp, 3.5, zz);
        const cap = metricBox(1.28, 0.24, 1.28, T);
        cap.translate(xp, 3.72, zz);
        stone.push(pil, neck, cap);
        const tip = new THREE.ConeGeometry(0.62, 0.78, 4, 1).rotateY(Math.PI / 4);
        tip.translate(xp, 4.23, zz);
        gold.push(tip);
        this.cameraBoxes.push([xp - 0.64, zz - 0.64, xp + 0.64, zz + 0.64, 4.62]);
      }
      // Small obelisks on the parapets at mid-span.
      const zm = (c.z0 + c.z1) / 2;
      const top = deck + ph + 0.12;
      const ped = metricBox(0.7, 0.36, 0.7, T);
      ped.translate(xm, top + 0.18, zm);
      stone.push(ped);
      const shaft = new THREE.CylinderGeometry(0.17, 0.27, 2.5, 4, 1, true).rotateY(Math.PI / 4);
      scaleUv(shaft, 1.4, 1.2);
      shaft.translate(xm, top + 0.36 + 1.25, zm);
      glyph.push(shaft);
      const ot = new THREE.ConeGeometry(0.17 * Math.SQRT2 * 0.72, 0.36, 4, 1).rotateY(Math.PI / 4);
      ot.translate(xm, top + 0.36 + 2.5 + 0.18, zm);
      gold.push(ot);
      this.cameraBoxes.push([xm - 0.35, zm - 0.35, xm + 0.35, zm + 0.35, top + 3.22]);
    }
    const add = (list, mat, shadow = true) => {
      const geo = mergePlain(list);
      if (!geo) return null;
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    add(stone, this.materials.masonry);
    add(gold, this.materials.gold);
    add(glyph, this.materials.glyph);
  }

  /**
   * Reed Ford dressing: the shader already turns the lane shallow and sandy;
   * stepping stones and reed-bundle marker posts with red pennants frame it.
   */
  buildFord(g, c) {
    const r = this.river;
    const hw = r.halfWidth;
    const fx = (c.x0 + c.x1) / 2;
    const south = Math.max(c.z0, r.centreZ(fx) - hw);
    const north = Math.min(c.z1, r.centreZ(fx) + hw);
    const rand = mulberry32(4242);
    const stones = [];
    for (let zz = south + 1.4; zz < north - 1.0; zz += 1.9 + rand() * 0.9) {
      const sc = 0.42 + rand() * 0.3;
      stones.push({ x: fx + Math.sin(zz * 0.42) * 1.7 + (rand() - 0.5) * 0.7, y: -0.02, z: zz, sx: sc * 1.25, sy: 0.17, sz: sc, ry: rand() * 3 });
    }
    const stoneGeo = this.makeRockGeometry(1, 515, 1);
    const st = instancesFrom(stoneGeo, this.materials.wetRock, stones, rand);
    st.castShadow = true;
    st.receiveShadow = true;
    g.add(st);
    const wood = [];
    const reed = [];
    const flags = [];
    for (const xp of [c.x0 - 0.75, c.x1 + 0.75]) {
      const n = Math.max(2, Math.round((north - south) / 4.4));
      for (let i = 0; i <= n; i++) {
        const zz = south + 0.6 + ((north - south - 1.2) * i) / n;
        const tilt = (rand() - 0.5) * 0.12;
        const top = [xp + tilt, 1.62, zz + (rand() - 0.5) * 0.1];
        wood.push(rodGeometry([xp, -0.4, zz], top, 0.085, 0.06, 6));
        const bundle = new THREE.CylinderGeometry(0.06, 0.13, 0.85, 8, 1, false);
        bundle.translate(top[0], top[1] + 0.3, top[2]);
        reed.push(bundle);
        const tie = new THREE.TorusGeometry(0.1, 0.022, 4, 10).rotateX(Math.PI / 2);
        tie.translate(top[0], top[1] + 0.12, top[2]);
        reed.push(tie);
        const flag = new THREE.PlaneGeometry(0.55, 0.26, 3, 1);
        const fp = flag.attributes.position;
        for (let k = 0; k < fp.count; k++) fp.setZ(k, Math.sin((fp.getX(k) + 0.275) * 5) * 0.05);
        flag.translate(0.3, 0, 0);
        flag.rotateY(xp < fx ? Math.PI : 0);
        flag.translate(top[0], top[1] - 0.12, top[2]);
        flags.push(flag);
        this._addFoam(xp, zz, 0.22, 0.22);
      }
    }
    const reedMat = new THREE.MeshStandardMaterial({ color: 0xcaa766, map: this.tex.linen.map, roughness: 0.9 });
    for (const [list, mat] of [
      [wood, this.materials.wood],
      [reed, reedMat],
      [flags, this.materials.cloth],
    ]) {
      const m = new THREE.Mesh(mergePlain(list), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
  }

  /**
   * A stone quay on the quarry's river bank with a moored cedar cargo barge
   * loaded with limestone, a lifting derrick and mooring lines. The barge and
   * the quay's river face sit in impassable water, so they are visual only.
   */
  buildQuay(g, config) {
    const r = this.river;
    const hw = r.halfWidth;
    const p = config.pile;
    const pc = config.pyramid;
    const qx0 = p.maxX + 0.5;
    const qx1 = qx0 + 10;
    const qcx = (qx0 + qx1) / 2;
    const north = r.centreZ(qcx) > (p.minZ + p.maxZ) / 2 ? -1 : 1; // which bank the quarry is on
    const edge = r.centreZ(qcx) + north * hw; // waterline at the quay
    const out = 5.4; // how far the quay projects into the river
    const zf = edge - north * out; // river face of the quay
    const stone = [];
    const T = 2.4;
    // The slab stops at the waterline: the bank behind it is walkable ground at y = 0.
    const quay = metricBox(qx1 - qx0, 0.92, out, T);
    quay.translate(qcx, -0.22, edge - north * (out / 2));
    const pave = metricBox(qx1 - qx0 + 2, 0.06, 3.6, T);
    pave.translate(qcx, 0.0, edge + north * 1.8);
    stone.push(quay, pave);
    // Steps down into the water at the downstream end.
    for (let k = 0; k < 2; k++) {
      const stp = metricBox(0.62, 0.3 - k * 0.09, out - 1.4, T);
      stp.translate(qx1 + 0.31 + k * 0.62, -0.13 - k * 0.045, edge - north * (out / 2 + 0.2));
      stone.push(stp);
    }
    // Mooring bollards along the river face.
    const bollards = [qx0 + 1.0, qcx, qx1 - 1.0].map((x) => [x, 0.24, zf + north * 0.45]);
    for (const [x, y, zz] of bollards) {
      const b = new THREE.CylinderGeometry(0.19, 0.25, 0.62, 10);
      b.translate(x, y + 0.31, zz);
      const capG = new THREE.SphereGeometry(0.23, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      capG.translate(x, y + 0.62, zz);
      stone.push(b, capG);
    }
    const qm = new THREE.Mesh(mergePlain(stone), this.materials.masonry);
    qm.castShadow = true;
    qm.receiveShadow = true;
    g.add(qm);
    this._addFoam(qcx, edge - north * (out / 2), (qx1 - qx0) / 2 + 0.25, out / 2 + 0.1);

    // Blocks waiting on the quay.
    const bw = pc.blockW * 0.9;
    const bh = pc.blockH * 0.9;
    const blockGeo = new RoundedBoxGeometry(bw, bh, bw, 2, 0.07);
    const waiting = [
      [qx0 + 2.2, 0.24 + bh / 2, edge - north * 1.6, 0.05],
      [qx0 + 2.3, 0.24 + bh * 1.5, edge - north * 1.65, -0.08],
      [qx0 + 4.4, 0.24 + bh / 2, edge - north * 1.5, 0.12],
    ];
    for (const [x, y, zz] of waiting) this.cameraBoxes.push([x - bw / 2, zz - bw / 2, x + bw / 2, zz + bw / 2, y + bh / 2]);
    // Every dressed block here (quay, derrick, barge) is one instanced draw.
    const blocks = [];
    const blockM = new THREE.Matrix4();
    const blockQ = new THREE.Quaternion();
    const blockS = new THREE.Vector3(1, 1, 1);
    const addBlock = (x, y, zz, ry, parent) => {
      blockM.compose(new THREE.Vector3(x, y, zz), blockQ.setFromAxisAngle(_up, ry), blockS);
      blocks.push(parent ? new THREE.Matrix4().multiplyMatrices(parent, blockM) : blockM.clone());
    };
    for (const [x, y, zz, ry] of waiting) addBlock(x, y, zz, ry);

    // Lifting derrick (a counterweighted swing beam) at the upstream end of the quay.
    const wood = [];
    const rope = [];
    const dx = qx0 + 1.1;
    const dz = edge - north * 1.2;
    wood.push(rodGeometry([dx, 0.24, dz], [dx, 5.4, dz], 0.16, 0.11, 8));
    for (const s of [-1, 1]) wood.push(rodGeometry([dx + s * 1.1, 0.24, dz + north * 0.6], [dx, 4.2, dz], 0.06, 0.05, 6));
    const boomEnd = [dx + 0.3, 6.2, zf - north * 2.6];
    const counter = [dx - 0.1, 4.0, dz + north * 2.8];
    wood.push(rodGeometry(counter, boomEnd, 0.1, 0.07, 8));
    const weight = this.makeRockGeometry(0.55, 616, 1);
    weight.translate(counter[0], counter[1] - 0.55, counter[2]);
    rope.push(rodGeometry(counter, [counter[0], counter[1] - 0.3, counter[2]], 0.025, 0.025, 4));
    rope.push(rodGeometry(boomEnd, [boomEnd[0], 2.35, boomEnd[2]], 0.025, 0.025, 4));
    addBlock(boomEnd[0], 2.35 - bh / 2 - 0.05, boomEnd[2], 0.3);
    const wm = new THREE.Mesh(weight, this.materials.rock);
    wm.castShadow = true;
    g.add(wm);

    // The barge, moored alongside the river face, bow upstream.
    const L = 15;
    const B = 4.4;
    const bxc = qcx + 0.2;
    const tan = r.at(r.sAtX(bxc));
    const bzc = zf - north * (B / 2 + 0.3);
    const yaw = Math.atan2(-tan.tz, tan.tx) + Math.PI;
    const hullData = makeHullGeometry(L, B, { freeboard: 0.68, draft: 0.8, bowRise: 1.75, sternRise: 2.35 });
    const xf = new THREE.Matrix4().compose(
      new THREE.Vector3(bxc, WATER_Y - 0.04, bzc),
      new THREE.Quaternion().setFromAxisAngle(_up, yaw),
      new THREE.Vector3(1, 1, 1),
    );
    const local = { wood: [], linen: [], gold: [], rope: [], cloth: [] };
    const dy = hullData.deckY;
    local.wood.push(hullData.deck);
    // Gunwale rails.
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 20; i++) {
        const u = -0.86 + (1.72 * i) / 20;
        pts.push(new THREE.Vector3((u * L) / 2, hullData.sheerAt(u) + 0.02, side * hullData.halfBeamAt(u) * 1.03 + side * 0.04));
      }
      local.wood.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.07, 5, false));
    }
    // Papyriform finials on the stem and stern posts.
    for (const [u, sc] of [
      [1, 0.85],
      [-1, 1],
    ]) {
      const tipY = hullData.sheerAt(u);
      const fin = new THREE.CylinderGeometry(0.34 * sc, 0.07, 0.55 * sc, 12, 1, true);
      fin.translate((u * L) / 2, tipY + 0.24 * sc, 0);
      local.gold.push(fin);
      const band = new THREE.TorusGeometry(0.09, 0.03, 5, 10).rotateX(Math.PI / 2);
      band.translate((u * L) / 2, tipY - 0.05, 0);
      local.gold.push(band);
    }
    // Mast with the sail furled on its yard, and stays.
    const mx = L * 0.14;
    const mastTop = dy + 6.4;
    local.wood.push(rodGeometry([mx, dy, 0], [mx, mastTop, 0], 0.12, 0.07, 8));
    local.wood.push(rodGeometry([mx + 0.1, mastTop - 0.5, -2.7], [mx + 0.1, mastTop - 0.5, 2.7], 0.06, 0.06, 6));
    local.linen.push(rodGeometry([mx + 0.18, mastTop - 0.68, -2.45], [mx + 0.18, mastTop - 0.68, 2.45], 0.17, 0.17, 10));
    local.rope.push(rodGeometry([mx, mastTop, 0], [L / 2 - 0.4, hullData.sheerAt(0.95), 0], 0.018, 0.018, 4));
    local.rope.push(rodGeometry([mx, mastTop, 0], [-L / 2 + 0.6, hullData.sheerAt(-0.92), 0], 0.018, 0.018, 4));
    for (const side of [-1, 1]) local.rope.push(rodGeometry([mx, mastTop - 0.3, 0], [mx - 0.4, dy + 0.1, side * (B / 2 - 0.2)], 0.015, 0.015, 4));
    // Twin steering oars on their stanchions at the stern.
    for (const side of [-1, 1]) {
      local.wood.push(rodGeometry([-L * 0.36, dy, side * 1.2], [-L * 0.38, dy + 1.5, side * 1.35], 0.07, 0.06, 6));
      local.wood.push(rodGeometry([-L * 0.33, dy + 1.65, side * 1.3], [-L * 0.55, -0.5, side * 2.1], 0.055, 0.05, 6));
    }
    // Deckhouse canopy aft of the cargo.
    const kx = -L * 0.27;
    for (const [px, pz] of [
      [-0.9, -0.85],
      [0.9, -0.85],
      [-0.9, 0.85],
      [0.9, 0.85],
    ]) {
      local.wood.push(rodGeometry([kx + px, dy, pz], [kx + px, dy + 1.85, pz], 0.05, 0.045, 6));
    }
    const roof = new THREE.PlaneGeometry(2.3, 2.1, 4, 1).rotateX(-Math.PI / 2);
    const rp = roof.attributes.position;
    for (let k = 0; k < rp.count; k++) rp.setY(k, -Math.abs(rp.getZ(k)) * 0.12);
    roof.translate(kx, dy + 1.9, 0);
    local.cloth.push(roof);
    // Cargo: two rows of dressed blocks lashed amidships.
    const cargo = [];
    for (let i = 0; i < 3; i++) {
      for (const side of [-1, 1]) cargo.push([L * 0.0 + (i - 1) * (bw + 0.12) - 0.4, dy + bh / 2 + 0.02, side * (bw / 2 + 0.06)]);
    }
    cargo.push([-0.4, dy + bh * 1.5 + 0.04, bw / 2 + 0.06]);
    const hullMat = this.materials.wood.clone();
    hullMat.side = THREE.DoubleSide;
    hullMat.color.setRGB(0.78, 0.62, 0.48);
    const hullMesh = new THREE.Mesh(hullData.hull.applyMatrix4(xf), hullMat);
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    g.add(hullMesh);
    for (const [x, y, zz] of cargo) addBlock(x, y, zz, (hash2(Math.round(x * 10), Math.round(zz * 10), 5) - 0.5) * 0.08, xf);
    const blockMesh = new THREE.InstancedMesh(blockGeo, this.materials.block, blocks.length);
    const tint = new THREE.Color();
    blocks.forEach((m, i) => {
      blockMesh.setMatrixAt(i, m);
      blockMesh.setColorAt(i, tintColor(70000 + i * 7, tint));
    });
    blockMesh.castShadow = true;
    blockMesh.receiveShadow = true;
    blockMesh.computeBoundingSphere();
    g.add(blockMesh);
    // Gangplank from the deck to the quay and mooring lines to the bollards.
    const toWorld = (v) => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(xf);
    const sideA = toWorld([3.0, dy + 0.04, B / 2 - 0.55]);
    const sideB = toWorld([3.0, dy + 0.04, -(B / 2 - 0.55)]);
    const plankA = Math.abs(sideA.z - zf) < Math.abs(sideB.z - zf) ? sideA : sideB;
    const plankB = new THREE.Vector3(plankA.x, 0.28, zf + north * 1.1);
    const plank = metricBox(0.8, 0.07, plankA.distanceTo(plankB), 1.2);
    plank.lookAt(plankB.clone().sub(plankA));
    plank.translate((plankA.x + plankB.x) / 2, (plankA.y + plankB.y) / 2 + 0.03, (plankA.z + plankB.z) / 2);
    const world = { wood: [plank], rope };
    const bow = toWorld([L / 2 - 1.2, hullData.sheerAt(0.84), 0]);
    const stern = toWorld([-L / 2 + 1.4, hullData.sheerAt(-0.81), 0]);
    world.rope.push(ropeGeometry([bollards[0][0], 0.78, bollards[0][2]], [bow.x, bow.y, bow.z], 0.35));
    world.rope.push(ropeGeometry([bollards[2][0], 0.78, bollards[2][2]], [stern.x, stern.y, stern.z], 0.4));
    const mats = { wood: this.materials.wood, linen: this.materials.linen, gold: this.materials.gold, rope: this.materials.rope, cloth: this.materials.cloth };
    for (const key of Object.keys(mats)) {
      const list = local[key].map((geo) => geo.applyMatrix4(xf)).concat(world[key] || []);
      if (!list.length) continue;
      const m = new THREE.Mesh(mergePlain(list), mats[key]);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    const derrick = new THREE.Mesh(mergePlain(wood), this.materials.wood);
    derrick.castShadow = true;
    g.add(derrick);
    this._addFoam(bxc, bzc, L / 2 + 0.15, B / 2 + 0.2);
    // Keep the shore dressing off the quay and barge.
    const far = bzc - north * (B / 2 + 1.5);
    this.keepOut.push([Math.min(qx0, bxc - L / 2) - 1.5, Math.min(edge, far) - 1, Math.max(qx1, bxc + L / 2) + 1.5, Math.max(edge, far) + 4]);
    this.quayBox = [qx0 - 1, Math.min(edge + north * 3.7, zf), qx1 + 1, Math.max(edge + north * 3.7, zf)];
    // The quay's river face, the derrick and the barge (deckhouse roof) all stand in the water.
    const ex = (Math.abs(Math.cos(yaw)) * L + Math.abs(Math.sin(yaw)) * B) / 2;
    const ez = (Math.abs(Math.sin(yaw)) * L + Math.abs(Math.cos(yaw)) * B) / 2;
    this.cameraBoxes.push(
      [qx0, Math.min(edge, zf), qx1, Math.max(edge, zf), 0.3],
      [dx - 0.3, dz - 0.3, dx + 0.3, dz + 0.3, 6.3],
      [bxc - ex, bzc - ez, bxc + ex, bzc + ez, WATER_Y + dy + 1.9],
    );
  }

  /**
   * Life along the river: papyrus stands and sedge at the waterline (denser
   * flanking the ford), wet rocks, lily pads and blue lotus in the calm
   * shallows, and floodplain grass, all instanced and gently swaying.
   */
  buildRiverLife(g, config) {
    const r = this.river;
    const hw = r.halfWidth;
    const rand = mulberry32(7331);
    const reach = Math.min(330, config.worldHalf * 2);
    const s0 = r.sAtX(-reach);
    const s1 = r.sAtX(reach);
    const pt = {};
    const pj = {};
    const papyrus = [];
    const sedge = [];
    const rocks = [];
    const grass = [];
    const lilies = [];
    const lotus = [];
    const near = (x) => 1 - smooth(60, reach, Math.abs(x));
    const fords = (config.crossings || []).filter((c) => c.kind === 'ford');
    const inLane = (x, z) => fords.some((c) => x > c.x0 - 1.4 && x < c.x1 + 1.4 && z > c.z0 && z < c.z1);
    const green = (k) => [0.85 + k * 0.25, 0.9 + k * 0.15, 0.8 + k * 0.1];
    for (const side of [-1, 1]) {
      for (let s = s0; s < s1; s += 3.2 + rand() * 4.5) {
        const a = side * (hw - 2.6 + rand() * 3.9);
        r.point(s, a, pt);
        if (rand() > 0.45 + near(pt.x) * 0.5) continue;
        if (this._isKept(pt.x, pt.z, 0.6) || inLane(pt.x, pt.z)) continue;
        const wet = Math.abs(a) < hw - 0.3;
        papyrus.push({ x: pt.x, y: wet ? -0.25 : -0.05, z: pt.z, s: 0.75 + rand() * 0.6, ry: rand() * 6.28, c: green(rand() - 0.5) });
      }
      for (let s = s0; s < s1; s += 1.8 + rand() * 3.2) {
        const a = side * (hw - 1.4 + rand() * 4.6);
        r.point(s, a, pt);
        if (rand() > 0.5 + near(pt.x) * 0.5) continue;
        if (this._isKept(pt.x, pt.z, 0.3) || inLane(pt.x, pt.z)) continue;
        sedge.push({ x: pt.x, y: Math.abs(a) < hw ? -0.15 : -0.02, z: pt.z, s: 0.7 + rand() * 0.7, ry: rand() * 6.28, c: green(rand() - 0.5) });
      }
      for (let s = s0; s < s1; s += 4 + rand() * 9) {
        const a = side * (hw - 2.2 + rand() * 3.4);
        r.point(s, a, pt);
        if (this._isKept(pt.x, pt.z, 0.5)) continue;
        const sc = 0.25 + rand() * rand() * 1.3;
        rocks.push({ x: pt.x, y: -sc * 0.3, z: pt.z, sx: sc * (0.9 + rand() * 0.5), sy: sc * (0.45 + rand() * 0.35), sz: sc * (0.9 + rand() * 0.5), ry: rand() * 6.28, rx: (rand() - 0.5) * 0.4 });
      }
    }
    // Reeds crowd both flanks of every ford: the lane between them is the way across.
    for (const c of fords) {
      for (let i = 0; i < 46; i++) {
        const left = rand() < 0.5;
        const x = left ? c.x0 - 1.3 - rand() * 6.5 : c.x1 + 1.3 + rand() * 6.5;
        const zc = r.centreZ(x);
        const zz = zc + (rand() - 0.5) * 2 * (hw + 1);
        if (zz < c.z0 || zz > c.z1 || this._isKept(x, zz, 0.2)) continue;
        const inWater = Math.abs(zz - zc) < hw - 0.3;
        const item = { x, y: inWater ? -0.2 : -0.03, z: zz, s: 0.75 + rand() * 0.55, ry: rand() * 6.28, c: green(rand() - 0.5) };
        (rand() < 0.45 ? papyrus : sedge).push(item);
      }
    }
    // Lily pads and lotus in the still shallows, away from the crossings and the quay.
    for (let k = 0; k < 22; k++) {
      const s = s0 + rand() * (s1 - s0) * 0.999;
      const side = rand() < 0.5 ? -1 : 1;
      r.point(s, side * (hw - 2.2), pt);
      if (Math.abs(pt.x) > 260 || this._isKept(pt.x, pt.z, 4)) continue;
      const count = 6 + Math.floor(rand() * 10);
      for (let i = 0; i < count; i++) {
        const x = pt.x + (rand() - 0.5) * 5.5;
        const zz = pt.z + (rand() - 0.5) * 3.5;
        r.project(x, zz, pj);
        const depthIn = hw - Math.abs(pj.a);
        if (depthIn < 0.7 || depthIn > 3.6) continue;
        const sc = 0.6 + rand() * 0.6;
        const tone = rand();
        lilies.push({ x, y: WATER_Y + 0.022 + rand() * 0.006, z: zz, s: sc, ry: rand() * 6.28, c: [0.26 + tone * 0.18, 0.42 + tone * 0.12, 0.13 + tone * 0.05] });
        if (rand() < 0.2) {
          const blue = rand() < 0.55;
          lotus.push({ x: x + 0.12, y: WATER_Y + 0.05, z: zz - 0.08, s: 0.8 + rand() * 0.4, ry: rand() * 6.28, c: blue ? [0.55, 0.68, 1.15] : [1.15, 1.05, 1.0] });
        }
      }
    }
    // Floodplain grass, thickest near the water.
    const gs0 = r.sAtX(-Math.min(200, config.worldHalf + 30));
    const gs1 = r.sAtX(Math.min(200, config.worldHalf + 30));
    for (let i = 0; i < 2600 && grass.length < 1400; i++) {
      const s = gs0 + rand() * (gs1 - gs0);
      const side = rand() < 0.5 ? -1 : 1;
      const a = side * (hw + 0.8 + Math.pow(rand(), 1.7) * (r.bank + 26));
      r.point(s, a, pt);
      if (this._isKept(pt.x, pt.z, 0.3) || this.groundHeightVisual(pt.x, pt.z) > 0.05) continue;
      const k = rand();
      grass.push({ x: pt.x, y: 0, z: pt.z, s: 0.7 + rand() * 0.7, ry: rand() * 6.28, c: [0.85 + k * 0.35, 0.9 + k * 0.2, 0.8 + k * 0.1] });
    }

    const papyrusGeo = makeFoliageGeometry(91, {
      blades: 7,
      spread: 0.42,
      h0: 1.7,
      h1: 2.9,
      width: 0.034,
      taper: 0.45,
      lean: 0.1,
      segments: 4,
      base: [0.15, 0.25, 0.07],
      tip: [0.3, 0.44, 0.12],
      umbel: 0.62,
      rays: 22,
      rayWidth: 0.055,
      umbelBase: [0.3, 0.45, 0.1],
      umbelTip: [0.62, 0.68, 0.24],
    });
    const sedgeGeo = makeFoliageGeometry(92, {
      blades: 26,
      spread: 0.45,
      h0: 0.6,
      h1: 1.45,
      width: 0.045,
      lean: 0.45,
      segments: 4,
      base: [0.13, 0.21, 0.06],
      tip: [0.5, 0.5, 0.22],
    });
    const grassGeo = makeFoliageGeometry(93, {
      blades: 10,
      spread: 0.22,
      h0: 0.18,
      h1: 0.48,
      width: 0.03,
      lean: 0.5,
      segments: 2,
      base: [0.2, 0.3, 0.08],
      tip: [0.55, 0.56, 0.24],
    });
    const tall = this.makeSwayMaterial({}, 0.028);
    const low = this.makeSwayMaterial({}, 0.12);
    const add = (mesh, max, shadow) => {
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      g.add(mesh);
      if (max) this.foliage.push({ mesh, max });
      return mesh;
    };
    add(instancesFrom(papyrusGeo, tall, papyrus, rand, true), papyrus.length, true);
    add(instancesFrom(sedgeGeo, tall, sedge, rand, true), sedge.length, true);
    add(instancesFrom(grassGeo, low, grass, rand, true), grass.length, false);
    add(instancesFrom(this.makeRockGeometry(1, 727, 1), this.materials.wetRock, rocks, rand), 0, true);
    const padGeo = new THREE.CircleGeometry(0.42, 18, 0.3, Math.PI * 2 - 0.6).rotateX(-Math.PI / 2);
    const padMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, side: THREE.DoubleSide, envMap: this.envMap, envMapIntensity: 0.6 });
    const pads = add(instancesFrom(padGeo, padMat, lilies, rand, true), 0, false);
    pads.userData.noAO = true;
    // Blue lotus: two rings of upturned petals around a golden heart.
    const petals = [];
    for (let ring = 0; ring < 2; ring++) {
      for (let i = 0; i < 8; i++) {
        const pg = new THREE.ConeGeometry(0.045, 0.2, 4, 1);
        pg.translate(0, 0.1, 0);
        pg.rotateX(0.55 + ring * 0.45);
        pg.rotateY((i / 8) * Math.PI * 2 + ring * 0.39);
        petals.push(pg);
      }
    }
    const heart = new THREE.SphereGeometry(0.05, 8, 6);
    heart.translate(0, 0.05, 0);
    petals.push(heart);
    const lotusMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, emissive: 0x221a30, emissiveIntensity: 0.4 });
    const flowers = add(instancesFrom(mergePlain(petals), lotusMat, lotus, rand, true), 0, false);
    flowers.userData.noAO = true;
  }

  /** Feluccas and cargo boats sailing the Nile far beyond the play area. */
  buildBoats(g) {
    const r = this.river;
    const hull = makeHullGeometry(7, 1.9, { freeboard: 0.42, draft: 0.4, bowRise: 0.55, sternRise: 0.45 });
    const woodParts = [hull.hull, hull.deck];
    woodParts.push(rodGeometry([0.9, hull.deckY, 0], [0.9, hull.deckY + 5.2, 0], 0.07, 0.045, 6));
    woodParts.push(rodGeometry([-2.9, hull.deckY + 0.5, 0], [3.4, hull.deckY + 7.6, 0], 0.045, 0.03, 5));
    // Lateen sail hanging from the slanted yard, bellied by the wind.
    const sail = new THREE.BufferGeometry();
    const A = [3.3, hull.deckY + 7.45, 0];
    const Bp = [-2.75, hull.deckY + 0.62, 0];
    const C = [1.7, hull.deckY + 0.55, 0];
    const sp = [];
    const sn = [];
    const su = [];
    const steps = 6;
    const P = (i, j) => {
      const u = i / steps;
      const v = j / steps;
      const x = A[0] + (Bp[0] - A[0]) * u + (C[0] - A[0]) * v;
      const y = A[1] + (Bp[1] - A[1]) * u + (C[1] - A[1]) * v;
      const belly = Math.sin(Math.PI * Math.min(1, u + v)) * Math.sin(Math.PI * Math.min(1, v * 1.4)) * 0.55;
      return [x, y, belly];
    };
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps - i; j++) {
        const tri = [P(i, j), P(i + 1, j), P(i, j + 1)];
        if (j < steps - i - 1) tri.push(P(i + 1, j), P(i + 1, j + 1), P(i, j + 1));
        for (const v of tri) {
          sp.push(v[0], v[1], v[2]);
          sn.push(0, 0, 1);
          su.push(v[0] / 3, v[1] / 3);
        }
      }
    }
    sail.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sail.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
    sail.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
    sail.computeVertexNormals();
    const hullMat = this.materials.wood.clone();
    hullMat.side = THREE.DoubleSide;
    const defs = [
      { s: r.sAtX(250), from: 230, to: 640, v: 2.1, a: -4 },
      { s: r.sAtX(520), from: 230, to: 640, v: -1.2, a: 5 },
      { s: r.sAtX(-330), from: -640, to: -230, v: 1.8, a: 3 },
      { s: r.sAtX(-560), from: -640, to: -230, v: -1.0, a: -5.5 },
    ];
    const hulls = new THREE.InstancedMesh(mergePlain(woodParts), hullMat, defs.length);
    const sails = new THREE.InstancedMesh(sail, this.materials.linen, defs.length);
    for (const m of [hulls, sails]) {
      m.castShadow = false;
      m.receiveShadow = true;
      m.frustumCulled = false;
      g.add(m);
    }
    this.boats = defs.map((d, i) => ({
      s: d.s,
      v: d.v,
      a: d.a,
      s0: r.sAtX(d.from),
      s1: r.sAtX(d.to),
      phase: i * 1.7,
      hulls,
      sails,
      index: i,
    }));
    this._boatTmp = { p: {}, m4: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'YXZ'), v: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) };
    this.updateBoats(0);
  }

  updateBoats(dt) {
    if (!this.boats.length || !this.river) return;
    const tmp = this._boatTmp;
    const t = this.clockTime;
    for (const b of this.boats) {
      b.s += b.v * dt;
      if (b.s > b.s1) b.s = b.s0;
      if (b.s < b.s0) b.s = b.s1;
      const p = this.river.point(b.s, b.a, tmp.p);
      const yaw = Math.atan2(-p.tz, p.tx) + (b.v < 0 ? Math.PI : 0);
      tmp.e.set(Math.sin(t * 0.9 + b.phase) * 0.025, yaw, Math.sin(t * 0.7 + b.phase) * 0.04 + 0.05);
      tmp.v.set(p.x, WATER_Y - 0.03 + Math.sin(t * 1.3 + b.phase) * 0.04, p.z);
      tmp.m4.compose(tmp.v, tmp.q.setFromEuler(tmp.e), tmp.one);
      b.hulls.setMatrixAt(b.index, tmp.m4);
      b.sails.setMatrixAt(b.index, tmp.m4);
    }
    this.boats[0].hulls.instanceMatrix.needsUpdate = true;
    this.boats[0].sails.instanceMatrix.needsUpdate = true;
  }

  /**
   * A limestone escarpment just outside the play area behind the quarry: one
   * continuous terraced cliff (quarried benches, strata, weathered noise) so
   * the cut cliffs in front read as the face of a single wall, with talus
   * heaped at its foot.
   */
  buildQuarryBackdrop(g, config) {
    const p = config.pile;
    const pcx = (p.minX + p.maxX) / 2;
    const pcz = (p.minZ + p.maxZ) / 2;
    const rocks = config.obstacles.filter((o) => o.kind === 'rock');
    const dir = this.river && this.river.centreZ(pcx) > pcz ? -1 : 1; // away from the river
    const back = rocks.length ? (dir > 0 ? Math.max(...rocks.map((o) => o.z1)) : Math.min(...rocks.map((o) => o.z0))) : pcz + dir * 22;
    const front = dir > 0 ? Math.max(back + 10, config.worldHalf + 5) : Math.min(back - 10, -config.worldHalf - 5);
    const perlin = new Perlin(3301);
    const span = 180;
    const nx = 144;
    const nd = 34;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= nx; i++) {
      const x = pcx - span + (2 * span * i) / nx;
      const env = smooth(0, 55, x - (pcx - span)) * smooth(0, 55, pcx + span - x);
      const H = (14 + 9 * perlin.fbm(x * 0.011 + 3, 1.7, 3) + 7 * gauss(x - pcx, 45)) * (0.25 + 0.75 * env);
      const faceD = 9 + 4 * perlin.fbm(x * 0.03 + 1, 6.1, 2);
      const z0 = front + dir * (2.5 + perlin.fbm(x * 0.018 + 9, 4.4, 3) * 4);
      for (let k = 0; k <= nd; k++) {
        const d = 70 * Math.pow(k / nd, 1.7);
        let y;
        if (d < faceD) {
          // Three quarried benches climbing the face.
          const v = d / faceD;
          const tiers = 3;
          const f = v * tiers;
          y = H * ((Math.floor(f) + smooth(0.55, 0.95, f - Math.floor(f))) / tiers);
        } else {
          const back2 = smooth(40, 70, d);
          y = H * (1 - back2 * 0.85) + perlin.fbm(x * 0.03, d * 0.05, 3) * 2.5 * (1 - back2);
        }
        const rough = perlin.ridged(x * 0.09 + 2, y * 0.12 + d * 0.05, 3) * 1.6;
        const zz = z0 + dir * (d + (d < faceD + 2 ? rough - 0.8 : 0));
        const yy = Math.max(0, y + (d > 0.5 ? rough * 0.35 : 0)) + this.groundHeightVisual(x, zz) * smooth(faceD, faceD + 20, d);
        pos.push(x, k === 0 ? -0.4 : yy, zz);
        uv.push(x / 7, (yy + d * 0.25) / 6);
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nd; k++) {
        const a = i * (nd + 1) + k;
        const b = a + nd + 1;
        if (dir > 0) idx.push(a, a + 1, b, a + 1, b + 1, b);
        else idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const cliff = new THREE.Mesh(geo, this.materials.rock);
    cliff.castShadow = true;
    cliff.receiveShadow = true;
    g.add(cliff);
    // Talus at the foot of the face.
    const rand = mulberry32(2025);
    const talus = [];
    for (let i = 0; i < 70; i++) {
      const x = pcx - span * 0.8 + rand() * span * 1.6;
      const sc = 0.5 + rand() * rand() * 3.2;
      const zz = front + dir * (1 + rand() * 4 + sc * 0.4);
      talus.push({ x, y: sc * 0.15, z: zz, sx: sc * (1 + rand() * 0.5), sy: sc * (0.5 + rand() * 0.4), sz: sc, ry: rand() * 6.28, rx: (rand() - 0.5) * 0.5 });
    }
    const t = instancesFrom(this.makeRockGeometry(1, 3031, 1), this.materials.rock, talus, rand);
    t.castShadow = true;
    t.receiveShadow = true;
    g.add(t);
  }

  /** Paved processional way and dirt trails as decal ribbons laid on the sand. */
  buildRoads(g) {
    for (const kind of ['trail', 'paved']) {
      const pos = [];
      const uv = [];
      const idx = [];
      for (const road of this.roads) {
        if (road.kind !== kind) continue;
        const base = pos.length / 3;
        const tileLen = kind === 'paved' ? 10 : 8;
        const y = kind === 'paved' ? 0.024 : 0.018;
        for (const sm of road.samples) {
          const nx = -sm.tz;
          const nz = sm.tx;
          const hwid = sm.w / 2;
          pos.push(sm.x - nx * hwid, y, sm.z - nz * hwid, sm.x + nx * hwid, y, sm.z + nz * hwid);
          uv.push(0, sm.s / tileLen, 1, sm.s / tileLen);
        }
        for (let i = 0; i < road.samples.length - 1; i++) {
          const a = base + i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, kind === 'paved' ? this.materials.paving : this.materials.trail);
      mesh.receiveShadow = true;
      mesh.renderOrder = kind === 'paved' ? 3 : 2;
      mesh.userData.noAO = true;
      g.add(mesh);
    }
  }

  /** Floodplain colour multiplier for the ground at (x, z), `d` metres from the river's centre line. */
  _groundTint(x, z, d, y) {
    const perlin = this._groundPerlin || (this._groundPerlin = new Perlin(808));
    const tint = perlin.fbm(x * 0.012 + 1, z * 0.012 + 7, 3);
    const shade = 0.93 + tint * 0.1 + Math.min(y, 30) * 0.002;
    let r = shade * (1.0 + tint * 0.03);
    let g = shade * 0.98;
    let b = shade * (0.95 - tint * 0.04);
    if (this.river && d < Infinity) {
      const bankOut = this.river.halfWidth + this.river.bank;
      // Fertile floodplain: olive fields and grass fading into the desert, dark silt by the water.
      const patch = perlin.fbm(x * 0.03 + 4, z * 0.03 + 11, 3);
      const fert = (1 - smooth(bankOut - 2, bankOut + 38 + patch * 20, d)) * (0.86 + patch * 0.14);
      const hue = smooth(-0.3, 0.4, perlin.fbm(x * 0.05 + 2, z * 0.05 + 5, 2));
      r += (0.42 + hue * 0.22 - r) * fert;
      g += (0.62 + hue * 0.1 - g) * fert;
      b += (0.3 + hue * 0.06 - b) * fert;
      const silt = 1 - smooth(this.river.halfWidth, bankOut + 7, d);
      r *= 1 - silt * 0.3;
      g *= 1 - silt * 0.26;
      b *= 1 - silt * 0.22;
    }
    return [r, g, b];
  }

  buildFoundation(g, pc) {
    const size = pc.base * pc.blockW;
    const mat = new THREE.MeshStandardMaterial({ map: this.tex.grid, transparent: true, depthWrite: false, roughness: 1 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(pc.cx, 0.015, pc.cz);
    plane.receiveShadow = true;
    plane.renderOrder = 1;
    plane.userData.noAO = true;
    g.add(plane);
    // Corner stones marking the sacred footprint.
    const geo = new RoundedBoxGeometry(0.8, 0.5, 0.8, 2, 0.08);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const m = new THREE.Mesh(geo, this.materials.sandstone);
        m.position.set(pc.cx + sx * (size / 2 + 0.9), 0.25, pc.cz + sz * (size / 2 + 0.9));
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
    }
  }

  buildObelisk(g, x, z) {
    const ped = new THREE.Mesh(new RoundedBoxGeometry(2.1, 0.7, 2.1, 2, 0.06), this.materials.sandstone);
    ped.position.set(x, 0.35, z);
    const shaftH = 11;
    const shaftGeo = new THREE.CylinderGeometry(0.5, 0.82, shaftH, 4, 1, true);
    shaftGeo.rotateY(Math.PI / 4);
    const uv = shaftGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 4, uv.getY(i) * 5);
    const shaftMat = this.materials.glyph.clone();
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.set(x, 0.7 + shaftH / 2, z);
    const tipGeo = new THREE.ConeGeometry(0.5, 1.1, 4, 1);
    tipGeo.rotateY(Math.PI / 4);
    const tip = new THREE.Mesh(tipGeo, this.materials.gold);
    tip.position.set(x, 0.7 + shaftH + 0.55, z);
    for (const m of [ped, shaft, tip]) {
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
  }

  buildBazaar(g, o) {
    const cx = (o.x0 + o.x1) / 2;
    const cz = (o.z0 + o.z1) / 2;
    const w = o.x1 - o.x0;
    const d = o.z1 - o.z0;
    const counter = new THREE.Mesh(new RoundedBoxGeometry(w, 1.1, d, 2, 0.05), this.materials.wood);
    counter.position.set(cx, 0.55, cz);
    const top = new THREE.Mesh(new RoundedBoxGeometry(w + 0.3, 0.12, d + 0.3, 2, 0.04), this.materials.sandstone);
    top.position.set(cx, 1.16, cz);
    g.add(counter, top);
    // Poles and a striped awning sloping toward the customers.
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 4.6, 10);
    const poles = [
      [o.x0 + 0.25, o.z0 + 0.25, 3.6],
      [o.x1 - 0.25, o.z0 + 0.25, 3.6],
      [o.x0 + 0.25, o.z1 - 0.25, 4.6],
      [o.x1 - 0.25, o.z1 - 0.25, 4.6],
    ];
    for (const [x, z, h] of poles) {
      const p = new THREE.Mesh(poleGeo, this.materials.wood);
      p.scale.y = h / 4.6;
      p.position.set(x, h / 2, z);
      g.add(p);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), this.materials.gold);
      knob.position.set(x, h + 0.08, z);
      g.add(knob);
    }
    const awningGeo = new THREE.PlaneGeometry(w + 1.4, 6.2, 12, 8);
    const pos = awningGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const sag = Math.sin(((pos.getX(i) + (w + 1.4) / 2) / (w + 1.4)) * Math.PI * 6) * 0.04;
      pos.setZ(i, -Math.pow(Math.abs(y) / 3.1, 2) * 0.12 + sag);
    }
    awningGeo.computeVertexNormals();
    const awning = new THREE.Mesh(awningGeo, this.materials.cloth);
    awning.rotation.x = -Math.PI / 2 + 0.22;
    awning.position.set(cx, 4.05, cz - 1.6);
    awning.castShadow = true;
    awning.receiveShadow = true;
    g.add(awning);
    // Valance with scalloped edge.
    const val = new THREE.Mesh(new THREE.PlaneGeometry(w + 1.4, 0.5, 12, 1), this.materials.cloth);
    val.position.set(cx, 3.15, cz - 4.62);
    g.add(val);
    // Wares: amphorae, gold, crates.
    const amphora = this.makeAmphoraGeometry();
    const rand = mulberry32(17);
    for (let i = 0; i < 6; i++) {
      const a = new THREE.Mesh(amphora, i % 2 ? this.materials.clay : this.materials.lapis);
      const s = 0.35 + rand() * 0.15;
      a.scale.setScalar(s);
      a.position.set(o.x0 + 0.8 + i * 1.6, 1.22, cz + (rand() - 0.5) * 0.6);
      a.castShadow = true;
      g.add(a);
    }
    const coinGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.015, 12);
    for (let i = 0; i < 40; i++) {
      const c = new THREE.Mesh(coinGeo, this.materials.gold);
      const ang = rand() * Math.PI * 2;
      const r = rand() * 0.35;
      c.position.set(cx + 0.8 + Math.cos(ang) * r, 1.23 + rand() * 0.12, cz + Math.sin(ang) * r);
      c.rotation.set(rand() * 0.6, 0, rand() * 0.6);
      g.add(c);
    }
    for (let i = 0; i < 3; i++) {
      const crate = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.9, 0.9, 2, 0.04), this.materials.wood);
      crate.position.set(o.x1 + 0.6, 0.45 + (i === 2 ? 0.9 : 0), cz + 1.4 - (i % 2) * 1.0);
      crate.rotation.y = rand() * 0.4;
      crate.castShadow = true;
      g.add(crate);
    }
    for (const m of [counter, top]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.buildBrazier(g, o.x0 + 0.4, 1.22, cz, 0.55);
    this.buildBrazier(g, o.x1 - 0.4, 1.22, cz, 0.55);
    this.bazaar = { x: cx, z: cz + 1.4 };
  }

  makeAmphoraGeometry() {
    const pts = [];
    const prof = [
      [0.0, 0.0],
      [0.18, 0.02],
      [0.32, 0.25],
      [0.42, 0.65],
      [0.38, 1.0],
      [0.2, 1.25],
      [0.14, 1.45],
      [0.2, 1.55],
      [0.16, 1.58],
    ];
    for (const [x, y] of prof) pts.push(new THREE.Vector2(x, y));
    return new THREE.LatheGeometry(pts, 20);
  }

  buildRack(g, o) {
    const cx = (o.x0 + o.x1) / 2;
    const cz = (o.z0 + o.z1) / 2;
    const w = o.x1 - o.x0;
    const base = new THREE.Mesh(new RoundedBoxGeometry(w, 0.5, o.z1 - o.z0, 2, 0.06), this.materials.sandstone);
    base.position.set(cx, 0.25, cz);
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);
    for (const sx of [o.x0 + 0.4, o.x1 - 0.4]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.4, 0.25), this.materials.wood);
      post.position.set(sx, 1.7, cz);
      post.castShadow = true;
      g.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, w - 0.6, 10), this.materials.bronze);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(cx, 2.65, cz);
    g.add(bar);
    // Lifting stones of increasing size.
    const sizes = [0.35, 0.45, 0.55, 0.65, 0.75];
    sizes.forEach((r, i) => {
      const stone = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), this.materials.rock);
      stone.scale.y = 0.8;
      stone.position.set(o.x0 + 1.2 + i * 1.9, 0.5 + r * 0.8, cz);
      stone.castShadow = true;
      g.add(stone);
    });
    this.buildBrazier(g, o.x0 + 0.4, 0.5, cz + 0.6, 0.6);
    this.buildBrazier(g, o.x1 - 0.4, 0.5, cz + 0.6, 0.6);
  }

  buildStrengthPlatform(g, zone) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(zone.r - 0.3, zone.r, 0.12, 48), this.materials.sandstone);
    disc.position.set(zone.x, 0.03, zone.z);
    disc.receiveShadow = true;
    g.add(disc);
  }

  buildSundial(g, x, z) {
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 1.0, 24), this.materials.sandstone);
    ped.position.set(x, 0.5, z);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.08, 32), this.materials.gold);
    face.position.set(x, 1.04, z);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.85, 0);
    shape.lineTo(0, 0.9);
    shape.closePath();
    const gnomon = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false }), this.materials.bronze);
    gnomon.position.set(x - 0.42, 1.08, z - 0.03);
    for (const m of [ped, face, gnomon]) {
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
  }

  buildTrack(g, zone) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(zone.inner + 1.2, zone.r, 96, 1), this.materials.sandstone.clone());
    ring.material.color.setHex(0xd9b58a);
    ring.material.map = this.tex.stone.map.clone();
    ring.material.map.repeat.set(6, 1);
    ring.material.map.needsUpdate = true;
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(zone.x, 0.02, zone.z);
    ring.receiveShadow = true;
    g.add(ring);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf6e7c5 });
    for (const r of [zone.inner + 3.6, zone.inner + 5.4]) {
      const l = new THREE.Mesh(new THREE.RingGeometry(r - 0.05, r + 0.05, 128, 1), lineMat);
      l.rotation.x = -Math.PI / 2;
      l.position.set(zone.x, 0.03, zone.z);
      g.add(l);
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.3, 8), this.materials.sandstone);
      post.position.set(zone.x + Math.cos(a) * (zone.r + 0.5), 0.65, zone.z + Math.sin(a) * (zone.r + 0.5));
      post.castShadow = true;
      g.add(post);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), this.materials.gold);
      cap.position.copy(post.position).y += 0.72;
      g.add(cap);
    }
  }

  buildPond(g, o) {
    const cx = (o.x0 + o.x1) / 2;
    const cz = (o.z0 + o.z1) / 2;
    const rx = (o.x1 - o.x0) / 2 + 0.8;
    const rz = (o.z1 - o.z0) / 2 + 0.8;
    const bankMat = this.materials.sand.clone();
    bankMat.vertexColors = false;
    bankMat.color.setRGB(0.62, 0.48, 0.32);
    const bank = new THREE.Mesh(new THREE.CircleGeometry(1, 48), bankMat);
    bank.scale.set(rx + 1.6, rz + 1.6, 1);
    bank.rotation.x = -Math.PI / 2;
    bank.position.set(cx, 0.012, cz);
    bank.receiveShadow = true;
    const water = new THREE.Mesh(new THREE.CircleGeometry(1, 48), this.materials.water);
    water.scale.set(rx, rz, 1);
    water.rotation.x = -Math.PI / 2;
    water.position.set(cx, 0.06, cz);
    water.receiveShadow = true;
    g.add(bank, water);
    // Reeds.
    const reedGeo = new THREE.ConeGeometry(0.03, 1.4, 4, 1);
    const reedMat = new THREE.MeshStandardMaterial({ color: 0x5c6b2e, roughness: 0.8 });
    const reeds = new THREE.InstancedMesh(reedGeo, reedMat, 140);
    const rand = mulberry32(5);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 140; i++) {
      const a = rand() * Math.PI * 2;
      const r = 0.92 + rand() * 0.12;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.3, 0, (rand() - 0.5) * 0.3));
      const s = 0.6 + rand() * 0.8;
      m4.compose(new THREE.Vector3(cx + Math.cos(a) * rx * r, 0.6 * s, cz + Math.sin(a) * rz * r), q, new THREE.Vector3(1, s, 1));
      reeds.setMatrixAt(i, m4);
    }
    reeds.castShadow = true;
    g.add(reeds);
  }

  buildPalm(g, x, z, seed) {
    const rand = mulberry32(seed * 7919);
    const height = 7 + rand() * 3.5;
    const lean = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5).normalize().multiplyScalar(0.8 + rand() * 1.6);
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push(new THREE.Vector3(x + lean.x * t * t, height * t, z + lean.z * t * t));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const trunkGeo = new THREE.TubeGeometry(curve, 24, 0.22, 10, false);
    const pos = trunkGeo.attributes.position;
    const uv = trunkGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      // Ringed bark bulges and a slight taper.
      const u = uv.getX(i);
      const ring = 1 + Math.max(0, Math.sin(u * Math.PI * 48)) * 0.08;
      const taper = 1.25 - u * 0.45;
      const c = curve.getPointAt(Math.min(1, u));
      const dx = pos.getX(i) - c.x;
      const dy = pos.getY(i) - c.y;
      const dz = pos.getZ(i) - c.z;
      pos.setXYZ(i, c.x + dx * ring * taper, c.y + dy * ring * taper, c.z + dz * ring * taper);
      uv.setXY(i, uv.getY(i), u * 12);
    }
    trunkGeo.computeVertexNormals();
    const trunk = new THREE.Mesh(trunkGeo, this.materials.trunk);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    g.add(trunk);
    const top = curve.getPointAt(1);
    const count = 10;
    for (let i = 0; i < count; i++) {
      const len = 3.6 + rand() * 1.4;
      const geo = new THREE.PlaneGeometry(1.1, len, 1, 10);
      geo.translate(0, len / 2, 0);
      const p = geo.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const y = Math.max(0, p.getY(k));
        const t = y / len;
        // Droop: arc the frond downward toward the tip and fold the leaflets.
        p.setZ(k, -Math.pow(t, 1.8) * len * 0.75 + Math.abs(p.getX(k)) * 0.35);
        p.setY(k, y * (1 - t * 0.25));
      }
      geo.computeVertexNormals();
      const frond = new THREE.Mesh(geo, this.materials.frond);
      frond.position.copy(top);
      frond.rotation.order = 'YXZ';
      frond.rotation.y = (i / count) * Math.PI * 2 + rand() * 0.3;
      frond.rotation.x = -0.9 - rand() * 0.5;
      frond.castShadow = true;
      g.add(frond);
    }
    const nutGeo = new THREE.SphereGeometry(0.16, 10, 8);
    const nutMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.7 });
    for (let i = 0; i < 4; i++) {
      const nut = new THREE.Mesh(nutGeo, nutMat);
      const a = rand() * Math.PI * 2;
      nut.position.set(top.x + Math.cos(a) * 0.25, top.y - 0.25, top.z + Math.sin(a) * 0.25);
      g.add(nut);
    }
  }

  /** A cliff of the quarry face: a weathered rock mass with quarried benches cut into its working side. */
  buildQuarryRock(g, o) {
    const cx = (o.x0 + o.x1) / 2;
    const cz = (o.z0 + o.z1) / 2;
    const geo = this.makeCliffGeometry((o.seed || 1) * 131);
    const rand = mulberry32((o.seed || 1) * 97);
    const tall = 8 + rand() * 4;
    geo.scale((o.x1 - o.x0) * 0.62, tall, (o.z1 - o.z0) * 0.62);
    geo.rotateY(Math.PI + (rand() - 0.5) * 0.6);
    geo.translate(cx, 0.6, cz);
    const parts = this._cliffParts || (this._cliffParts = []);
    parts.push(geo);
    // Stepped benches where blocks were split off, facing the stone pile.
    const pile = this.config && this.config.pile;
    const face = pile && (pile.minZ + pile.maxZ) / 2 > cz ? 1 : -1;
    const z0 = face > 0 ? o.z1 : o.z0;
    const w = o.x1 - o.x0;
    for (let k = 0; k < 3; k++) {
      const bh = 1.0 + k * 1.15 + rand() * 0.3;
      const bw = w * (0.78 - k * 0.14);
      const b = metricBox(bw, bh, 1.25, 3);
      b.translate(cx + (rand() - 0.5) * 0.8, bh / 2, z0 - face * (0.7 + k * 1.05));
      parts.push(b);
    }
  }

  /** Merges every quarry cliff built by buildQuarryRock() into one mesh. */
  _flushCliffs(g) {
    const parts = this._cliffParts || [];
    this._cliffParts = [];
    if (!parts.length) return;
    const m = new THREE.Mesh(mergePlain(parts), this.materials.rock);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }

  buildPileBase(g, o) {
    const slab = new THREE.Mesh(new RoundedBoxGeometry(o.x1 - o.x0 + 0.8, 0.16, o.z1 - o.z0 + 0.8, 2, 0.05), this.materials.wood);
    slab.position.set((o.x0 + o.x1) / 2, 0.08, (o.z0 + o.z1) / 2);
    slab.receiveShadow = true;
    g.add(slab);
    // Wooden sledges used to drag blocks, left beside the pile.
    for (const sx of [-1, 1]) {
      const sledge = new THREE.Group();
      for (const off of [-0.5, 0.5]) {
        const runner = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 3.2), this.materials.wood);
        runner.position.set(off, 0.08, 0);
        sledge.add(runner);
      }
      for (let i = 0; i < 4; i++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.3), this.materials.wood);
        plank.position.set(0, 0.2, -1.2 + i * 0.8);
        sledge.add(plank);
      }
      sledge.position.set((o.x0 + o.x1) / 2 + sx * ((o.x1 - o.x0) / 2 + 1.6), 0, (o.z0 + o.z1) / 2 + 1);
      sledge.rotation.y = sx * 0.25;
      sledge.traverse((m) => {
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      g.add(sledge);
    }
  }

  /** Quarry debris around the stone pile: chips, spalls and broken blocks, kept off the roads and out of the river. */
  scatterRubble(g, config, rand) {
    const geo = this.makeRockGeometry(1, 999, 1);
    const p = config.pile;
    const pcx = (p.minX + p.maxX) / 2;
    const pcz = (p.minZ + p.maxZ) / 2;
    const r = this.river;
    const away = r && r.centreZ(pcx) > pcz ? -1 : 1; // the cliffs lie on the far side from the river
    const list = [];
    const qb = this.quayBox;
    for (let tries = 0; list.length < 110 && tries < 5000; tries++) {
      const x = pcx + (rand() - 0.5) * 76;
      const z = pcz + away * (-10 + rand() * 32);
      const sc = 0.15 + rand() * rand() * 0.9;
      const rx = rand() * 3;
      const ry = rand() * 3;
      const rz = rand() * 3;
      if (r && r.distance(x, z, r.halfWidth + 3) < r.halfWidth + 1.2 + sc) continue;
      if (x > p.minX - 1.5 && x < p.maxX + 1.5 && z > p.minZ - 1.5 && z < p.maxZ + 1.5) continue;
      if (qb && x > qb[0] && x < qb[2] && z > qb[1] && z < qb[3]) continue;
      if (this.roads && this._onRoad(x, z, 0.3)) continue;
      list.push({ x, y: sc * 0.3, z, sx: sc, sy: sc * 0.7, sz: sc, rx, ry, rz });
    }
    const inst = instancesFrom(geo, this.materials.rock, list, rand);
    inst.castShadow = true;
    inst.receiveShadow = true;
    g.add(inst);
  }

  buildBrazier(g, x, y, z, scale = 1) {
    const grp = new THREE.Group();
    const legGeo = new THREE.CylinderGeometry(0.04, 0.05, 1.1, 6);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(legGeo, this.materials.bronze);
      leg.position.set(Math.cos(a) * 0.22, 0.55, Math.sin(a) * 0.22);
      leg.rotation.set(Math.sin(a) * 0.18, 0, -Math.cos(a) * 0.18);
      grp.add(leg);
    }
    const bowlPts = [
      new THREE.Vector2(0.05, 0),
      new THREE.Vector2(0.3, 0.05),
      new THREE.Vector2(0.45, 0.22),
      new THREE.Vector2(0.5, 0.32),
      new THREE.Vector2(0.46, 0.34),
    ];
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(bowlPts, 20), this.materials.bronze);
    bowl.position.y = 1.05;
    grp.add(bowl);
    const coals = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), this.materials.ember);
    coals.scale.y = 0.35;
    coals.position.y = 1.22;
    grp.add(coals);
    const flames = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.tex.flame,
        color: new THREE.Color(2.6, 0.95 - i * 0.15, 0.22),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const f = new THREE.Sprite(mat);
      f.position.set((i - 1) * 0.12, 1.65, 0);
      f.scale.set(0.6, 0.9, 1);
      grp.add(f);
      flames.push(f);
    }
    grp.traverse((m) => {
      if (m.isMesh) m.castShadow = true;
    });
    grp.scale.setScalar(scale);
    grp.position.set(x, y, z);
    g.add(grp);
    const light = new THREE.PointLight(new THREE.Color(1, 0.55, 0.22), 9 * scale, 11 * scale, 2);
    light.position.set(x, y + 1.7 * scale, z);
    g.add(light);
    this.fires.push({ flames, light, base: 9 * scale, seed: Math.random() * 100 });
  }

  addZoneRing(g, x, z, r, color) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(1.6),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.12, r, 96, 1), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.05, z);
    ring.renderOrder = 2;
    ring.userData.noAO = true;
    g.add(ring);
    this.pulses.push({ mat, phase: Math.random() * 6 });
  }

  addLabel(g, text, x, y, z, scale = 1.6) {
    const s = makeTextSprite(text, { scale });
    s.position.set(x, y, z);
    g.add(s);
    return s;
  }

  // ----- quality / post-processing -----------------------------------------

  setQuality(name) {
    const q = QUALITY[name] || QUALITY.high;
    this.quality = QUALITY[name] ? name : 'high';
    this.renderer.toneMappingExposure = 0.95;
    this.q = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    if (this.sun.shadow.mapSize.x !== q.shadow) {
      this.sun.shadow.mapSize.set(q.shadow, q.shadow);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.dust.geometry.setDrawRange(0, q.dust);
    this.applyFoliageQuality();
    this.buildComposer();
  }

  /** Thins the instanced reeds and grass on lower presets (instances are pre-shuffled). */
  applyFoliageQuality() {
    const k = this.q ? this.q.foliage ?? 1 : 1;
    for (const f of this.foliage) f.mesh.count = Math.max(0, Math.round(f.max * k));
  }

  buildComposer() {
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.q.samples });
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.raysPass = null;
    this.bloomPass = null;
    this.aoPass = null;
    if (this.q.ao) {
      const ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.5, scale: 1.1, samples: 16, distanceFallOff: 1 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      ao.blendIntensity = 0.9;
      // GTAOPass (three r181) hides points/lines during its normal pre-pass; also hide sprites,
      // the sky dome and flagged overlays so they never cast occlusion halos.
      ao._overrideVisibility = function overrideVisibility() {
        const cache = this._visibilityCache;
        this.scene.traverse((o) => {
          if (o.visible && (o.isPoints || o.isLine || o.isSprite || o.userData.noAO)) {
            o.visible = false;
            cache.push(o);
          }
        });
      };
      this.aoPass = ao;
      composer.addPass(ao);
    }
    if (this.q.rays) {
      this.raysPass = new ShaderPass(GodRaysShader);
      this.raysPass.material.defines.SAMPLES = this.q.rays;
      composer.addPass(this.raysPass);
    }
    if (this.q.bloom) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.55, 1.25);
      composer.addPass(this.bloomPass);
    }
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    if (this.raysPass) this.raysPass.uniforms.aspect.value = w / h;
  }

  // ----- frame update ---------------------------------------------------------

  update(dt, focus) {
    this.clockTime += dt;
    const t = this.clockTime;
    this.sky.position.copy(this.camera.position);
    this.skyMaterial.uniforms.time.value = t;
    this.dustUniforms.uTime.value = t;
    this.dustUniforms.uCam.value.copy(this.camera.position);
    this.dustUniforms.uSize.value = 90 * this.renderer.getPixelRatio();

    // Shadow frustum follows the focus point, snapped to shadow texels to avoid shimmering.
    const f = focus || this.camera.position;
    const texel = (this.shadowRange * 2) / this.sun.shadow.mapSize.x;
    this._lightView.lookAt(new THREE.Vector3(0, 0, 0), this.sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    this._lightViewInv.copy(this._lightView).invert();
    const ls = this._tmpV.copy(f).applyMatrix4(this._lightViewInv);
    ls.x = Math.round(ls.x / texel) * texel;
    ls.y = Math.round(ls.y / texel) * texel;
    ls.applyMatrix4(this._lightView);
    this.sun.target.position.copy(ls);
    this.sun.position.copy(ls).addScaledVector(this.sunDir, 200);
    this.sun.target.updateMatrixWorld();

    for (const fire of this.fires) {
      const n = Math.sin(t * 13 + fire.seed) * 0.5 + Math.sin(t * 7.3 + fire.seed * 2) * 0.35 + Math.sin(t * 23 + fire.seed * 3) * 0.15;
      fire.light.intensity = fire.base * (0.85 + n * 0.18);
      fire.flames.forEach((s, i) => {
        const k = Math.sin(t * (9 + i * 3) + fire.seed + i) * 0.5 + 0.5;
        s.scale.set(0.5 + k * 0.18, 0.75 + k * 0.4, 1);
        s.position.y = 1.6 + k * 0.08;
        s.material.opacity = 0.75 + k * 0.25;
      });
    }
    for (const p of this.pulses) p.mat.opacity = 0.32 + Math.sin(t * 2.2 + p.phase) * 0.16;
    for (const m of this.waterMaterials) {
      m.normalMap.offset.set(t * 0.012, t * 0.008);
    }
    this.windTime.value = t;
    if (this.riverUniforms) {
      // Scroll offsets are wrapped on the CPU (double precision) so the shader never loses precision.
      const u = this.riverUniforms;
      const f = this.riverFlow;
      u.uTime.value = t;
      u.uScroll.value.set(((t * f) / 9) % 1, ((t * f * 1.35) / 3.7) % 1, ((t * f * 1.1) / 9) % 1, ((t * f * 0.6) / 23) % 1);
    }
    this.updateBoats(dt);
    this.updatePuffs(dt);

    if (this.raysPass) {
      const sp = this._tmpV.copy(this.camera.position).addScaledVector(this.sunDir, 1000).project(this.camera);
      const camDir = this.camera.getWorldDirection(new THREE.Vector3());
      const facing = camDir.dot(this.sunDir);
      const u = this.raysPass.uniforms;
      u.sunPos.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
      const edge = Math.max(Math.abs(sp.x), Math.abs(sp.y));
      u.visibility.value = THREE.MathUtils.smoothstep(facing, 0.05, 0.45) * (1 - THREE.MathUtils.smoothstep(edge, 1.1, 1.9));
    }
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

export { RoundedBoxGeometry };
