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
  low: { pixelRatio: 1, shadow: 1024, samples: 0, bloom: false, rays: 0, ao: false, dust: 400 },
  medium: { pixelRatio: 1.25, shadow: 2048, samples: 2, bloom: true, rays: 32, ao: false, dust: 900 },
  high: { pixelRatio: 1.5, shadow: 4096, samples: 4, bloom: true, rays: 48, ao: false, dust: 1600 },
  // Ultra: native resolution, ground-truth ambient occlusion and dense volumetric rays.
  ultra: { pixelRatio: 2, shadow: 4096, samples: 4, bloom: true, rays: 72, ao: true, dust: 2400 },
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
    this.buildGround();
    this.buildVista();
    this.buildDust();
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
    this.materials.water.normalMap.repeat.set(4, 4);
    this.materials.linen.map.repeat.set(3, 3);
    this.materials.linen.normalMap.repeat.set(3, 3);
    this.waterMaterials.push(this.materials.water);
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

  buildGround() {
    const size = 1100;
    const seg = 160;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const uv = geo.attributes.uv;
    const perlin = new Perlin(808);
    const tile = 7; // metres per sand texture tile
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const m = Math.max(Math.abs(x), Math.abs(z));
      const mask = smooth(116, 200, m);
      const ridge = perlin.ridged(x * 0.0045 + 50, z * 0.0035 + 50, 4);
      const roll = perlin.fbm(x * 0.002 + 9, z * 0.002 + 3, 3);
      const y = (Math.pow(ridge, 2.2) * 34 + roll * 14 + 6) * mask;
      pos.setY(i, Math.max(0, y));
      uv.setXY(i, x / tile, z / tile);
      const tint = perlin.fbm(x * 0.012 + 1, z * 0.012 + 7, 3);
      const shade = 0.93 + tint * 0.1 + Math.min(y, 30) * 0.002;
      colors[i * 3] = shade * (1.0 + tint * 0.03);
      colors[i * 3 + 1] = shade * 0.98;
      colors[i * 3 + 2] = shade * (0.95 - tint * 0.04);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, this.materials.sand);
    ground.receiveShadow = true;
    this.ground = ground;
    this.scene.add(ground);
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
    // Scattered boulders on the dunes.
    const rockGeo = this.makeRockGeometry(1, 404, 1);
    const rocks = new THREE.InstancedMesh(rockGeo, this.materials.rock, 160);
    const rand = mulberry32(55);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    let n = 0;
    while (n < 160) {
      const x = (rand() - 0.5) * 900;
      const z = (rand() - 0.5) * 900;
      const mm = Math.max(Math.abs(x), Math.abs(z));
      if (mm < 125) continue;
      const sc = 0.8 + rand() * rand() * 6;
      p.set(x, this.groundHeightVisual(x, z) + sc * 0.2, z);
      q.setFromEuler(new THREE.Euler(rand() * 0.5, rand() * Math.PI * 2, rand() * 0.5));
      s.set(sc * (0.8 + rand() * 0.6), sc * (0.5 + rand() * 0.5), sc * (0.8 + rand() * 0.6));
      m4.compose(p, q, s);
      rocks.setMatrixAt(n++, m4);
    }
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    group.add(rocks);
    this.scene.add(group);
  }

  groundHeightVisual(x, z) {
    // Matches buildGround()'s displacement closely enough to seat props on dunes.
    const perlin = this._groundPerlin || (this._groundPerlin = new Perlin(808));
    const m = Math.max(Math.abs(x), Math.abs(z));
    const mask = smooth(116, 200, m);
    const ridge = perlin.ridged(x * 0.0045 + 50, z * 0.0035 + 50, 4);
    const roll = perlin.fbm(x * 0.002 + 9, z * 0.002 + 3, 3);
    return Math.max(0, (Math.pow(ridge, 2.2) * 34 + roll * 14 + 6) * mask);
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
    if (this.worldGroup) {
      this.scene.remove(this.worldGroup);
      this.worldGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      for (const f of this.fires) this.scene.remove(f.light);
    }
    this.fires = [];
    this.pulses = [];
    const g = new THREE.Group();
    this.worldGroup = g;
    this.config = config;
    const rand = mulberry32(99);

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
    const z = config.zones;
    this.addZoneRing(g, z.strength.x, z.strength.z, z.strength.r, 0xffc861);
    this.addZoneRing(g, z.shop.x, z.shop.z, z.shop.r, 0xffd27a);
    this.addZoneRing(g, z.track.x, z.track.z, z.track.r, 0x9fe0ff);
    this.addLabel(g, 'STRENGTH', z.strength.x, 5.2, z.strength.z);
    this.addLabel(g, 'SPRINT TRACK', z.track.x, 5.5, z.track.z);
    this.addLabel(g, 'BAZAAR', z.shop.x, 7.4, z.shop.z + 5.5);
    const p = config.pile;
    this.addLabel(g, 'QUARRY', (p.minX + p.maxX) / 2, 8.8, (p.minZ + p.maxZ) / 2);
    this.buildStrengthPlatform(g, z.strength);
    this.buildTrack(g, z.track);
    this.scatterRubble(g, config, rand);
    this.scene.add(g);
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

  buildQuarryRock(g, o) {
    const cx = (o.x0 + o.x1) / 2;
    const cz = (o.z0 + o.z1) / 2;
    const geo = this.makeRockGeometry(1, (o.seed || 1) * 131, 3);
    const rock = new THREE.Mesh(geo, this.materials.rock);
    const rand = mulberry32((o.seed || 1) * 97);
    rock.scale.set((o.x1 - o.x0) * 0.62, 5 + rand() * 4, (o.z1 - o.z0) * 0.62);
    rock.rotation.y = Math.PI + (rand() - 0.5) * 0.6;
    rock.position.set(cx, 0.6, cz);
    rock.castShadow = true;
    rock.receiveShadow = true;
    g.add(rock);
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

  scatterRubble(g, config, rand) {
    const geo = this.makeRockGeometry(1, 999, 1);
    const n = 90;
    const inst = new THREE.InstancedMesh(geo, this.materials.rock, n);
    const m4 = new THREE.Matrix4();
    const p = config.pile;
    let i = 0;
    while (i < n) {
      const x = (p.minX + p.maxX) / 2 + (rand() - 0.5) * 70;
      const z = 56 + rand() * 24;
      const s = 0.15 + rand() * rand() * 0.9;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      m4.compose(new THREE.Vector3(x, s * 0.3, z), q, new THREE.Vector3(s, s * 0.7, s));
      inst.setMatrixAt(i++, m4);
    }
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

  addLabel(g, text, x, y, z) {
    const s = makeTextSprite(text, { scale: 1.6 });
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
    this.buildComposer();
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
