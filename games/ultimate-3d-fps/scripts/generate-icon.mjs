// Generates build/icon.png (512x512) for electron-builder, procedurally, with
// no image assets and no dependencies: an amber "7" inside a broken
// crosshair ring on a dark rounded tile. Rendered with 4x4 supersampling and
// written as a PNG using only node:zlib.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const SS = 4;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'icon.png');

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function roundedRect(x, y, half, r) {
  const qx = Math.abs(x) - half + r;
  const qy = Math.abs(y) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function segment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Returns [r, g, b, a] in 0..1 for a point in icon space (-1..1). */
function shade(x, y) {
  const tile = roundedRect(x, y, 0.94, 0.2);
  if (tile > 0) return [0, 0, 0, 0];
  const glow = Math.exp(-(x * x + y * y) * 2.2);
  // linear-light values; the writer below gamma-encodes them
  let r = 0.004 + glow * 0.022;
  let g = 0.005 + glow * 0.016;
  let b = 0.008 + glow * 0.01;

  // broken crosshair ring
  const d = Math.hypot(x, y);
  const ang = Math.atan2(y, x);
  const gap = Math.abs(Math.sin(ang * 2)) > 0.22;
  const ring = Math.abs(d - 0.7) < 0.035 && gap;
  if (ring) {
    r = 0.55;
    g = 0.52;
    b = 0.47;
  }
  // tick marks
  for (const [ax, ay, bx, by] of [[0, -0.92, 0, -0.78], [0, 0.78, 0, 0.92], [-0.92, 0, -0.78, 0], [0.78, 0, 0.92, 0]]) {
    if (segment(x, y, ax, ay, bx, by) < 0.03) {
      r = 0.55;
      g = 0.52;
      b = 0.47;
    }
  }

  // the "7"
  const seven = Math.min(
    segment(x, y, -0.3, -0.36, 0.3, -0.36) - 0.085,
    segment(x, y, 0.27, -0.36, -0.08, 0.42) - 0.085,
  );
  if (seven < 0) {
    const t = clamp01((y + 0.45) / 0.9);
    r = 0.98;
    g = 0.68 - t * 0.12;
    b = 0.22 - t * 0.1;
  } else if (seven < 0.08) {
    const k = (1 - seven / 0.08) ** 2 * 0.35;
    r += 0.95 * k;
    g += 0.55 * k;
    b += 0.15 * k;
  }

  // edge bevel
  const bevel = clamp01(1 + tile / 0.03);
  return [r * (0.75 + 0.25 * (1 - bevel)), g * (0.75 + 0.25 * (1 - bevel)), b * (0.75 + 0.25 * (1 - bevel)), 1];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let py = 0; py < SIZE; py++) {
  raw[py * (SIZE * 4 + 1)] = 0; // filter: none
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = ((px + (sx + 0.5) / SS) / SIZE) * 2 - 1;
        const y = ((py + (sy + 0.5) / SS) / SIZE) * 2 - 1;
        const c = shade(x, y);
        r += c[0] * c[3];
        g += c[1] * c[3];
        b += c[2] * c[3];
        a += c[3];
      }
    }
    const n = SS * SS;
    const o = py * (SIZE * 4 + 1) + 1 + px * 4;
    const inv = a > 0 ? 1 / a : 0;
    raw[o] = Math.round(clamp01(r * inv) ** (1 / 2.2) * 255);
    raw[o + 1] = Math.round(clamp01(g * inv) ** (1 / 2.2) * 255);
    raw[o + 2] = Math.round(clamp01(b * inv) ** (1 / 2.2) * 255);
    raw[o + 3] = Math.round((a / n) * 255);
  }
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`icon written: ${out} (${png.length} bytes)`);
