/**
 * Dunebound - multiplayer pyramid grid.
 *
 * Mirrors the server's grid / height-field math (server/gameLogic.js) using the
 * dimensions the server sends in `welcome.config`, and renders the shared
 * pyramid, the quarry pile, the placement ghost and block-landing effects.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** Same hash as the server's blockTint(): every client tints a given block identically. */
export function blockTint(id) {
  let h = Math.imul(id, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const STONE_TINTS = [
  new THREE.Color(1.0, 0.95, 0.87),
  new THREE.Color(0.98, 0.87, 0.72),
  new THREE.Color(0.95, 0.83, 0.74),
  new THREE.Color(0.9, 0.87, 0.8),
  new THREE.Color(1.0, 0.9, 0.78),
];

export function tintColor(id, target = new THREE.Color()) {
  const t = blockTint(id) * (STONE_TINTS.length - 1);
  const i = Math.floor(t);
  return target.copy(STONE_TINTS[i]).lerp(STONE_TINTS[Math.min(STONE_TINTS.length - 1, i + 1)], t - i);
}

// ---------------------------------------------------------------------------
// Grid + height field (kept in lock-step with server/gameLogic.js)
// ---------------------------------------------------------------------------

export class PyramidGrid {
  constructor(cfg) {
    this.cfg = cfg;
    this.layers = cfg.base;
    this.offsets = new Int32Array(this.layers + 1);
    let total = 0;
    for (let k = 0; k < this.layers; k++) {
      this.offsets[k] = total;
      total += (cfg.base - k) * (cfg.base - k);
    }
    this.offsets[this.layers] = total;
    this.total = total;
    this.slots = new Int32Array(total);
    this.placed = 0;
    this.layerOf = new Uint8Array(total);
    this.iOf = new Uint8Array(total);
    this.jOf = new Uint8Array(total);
    this.cxs = new Float64Array(total);
    this.cys = new Float64Array(total);
    this.czs = new Float64Array(total);
    for (let k = 0; k < this.layers; k++) {
      const n = cfg.base - k;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const idx = this.offsets[k] + i * n + j;
          this.layerOf[idx] = k;
          this.iOf[idx] = i;
          this.jOf[idx] = j;
          this.cxs[idx] = cfg.cx + (i - (n - 1) / 2) * cfg.blockW;
          this.cys[idx] = k * cfg.blockH + cfg.blockH / 2;
          this.czs[idx] = cfg.cz + (j - (n - 1) / 2) * cfg.blockW;
        }
      }
    }
  }

  index(k, i, j) {
    const n = this.cfg.base - k;
    if (k < 0 || k >= this.layers || i < 0 || j < 0 || i >= n || j >= n) return -1;
    return this.offsets[k] + i * n + j;
  }

  box(idx, out = {}) {
    const hw = this.cfg.blockW / 2;
    const hh = this.cfg.blockH / 2;
    out.x0 = this.cxs[idx] - hw;
    out.x1 = this.cxs[idx] + hw;
    out.y0 = this.cys[idx] - hh;
    out.y1 = this.cys[idx] + hh;
    out.z0 = this.czs[idx] - hw;
    out.z1 = this.czs[idx] + hw;
    return out;
  }

  isSupported(idx) {
    const k = this.layerOf[idx];
    if (k === 0) return true;
    const i = this.iOf[idx];
    const j = this.jOf[idx];
    return (
      this.slots[this.index(k - 1, i, j)] !== 0 &&
      this.slots[this.index(k - 1, i + 1, j)] !== 0 &&
      this.slots[this.index(k - 1, i, j + 1)] !== 0 &&
      this.slots[this.index(k - 1, i + 1, j + 1)] !== 0
    );
  }

  canPlace(idx) {
    return idx >= 0 && idx < this.total && this.slots[idx] === 0 && this.isSupported(idx);
  }

  place(idx, blockId) {
    if (this.slots[idx] === 0) this.placed++;
    this.slots[idx] = blockId;
  }

  reset() {
    this.slots.fill(0);
    this.placed = 0;
  }

  load(arr) {
    this.reset();
    for (let i = 0; i < Math.min(arr.length, this.total); i++) {
      if (arr[i]) this.place(i, arr[i]);
    }
  }

  frontLayer() {
    for (let k = 0; k < this.layers; k++) {
      for (let idx = this.offsets[k]; idx < this.offsets[k + 1]; idx++) if (this.slots[idx] === 0) return k;
    }
    return this.layers;
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Dense uniform Catmull-Rom sampling of the river's control points, roughly
 * every `step` metres. Byte-for-byte copy of riverPolyline() in
 * server/gameLogic.js: keep the two identical so collision matches the water.
 */
export function riverPolyline(points, step = 2) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([points[n - 1][0], points[n - 1][1]]);
  return out;
}

/** Approximate visual height of each obstacle kind, used only to keep the camera out of props. */
const CAMERA_HEIGHTS = { pile: 5.8, obelisk: 12.5, counter: 1.3, rack: 2.9, sundial: 1.15, rock: 6.5, brazier: 1.4, parapet: 1.8 };

export class HeightField {
  constructor(config) {
    this.origin = config.nav.origin;
    this.size = config.nav.size;
    this.blocked = config.blocked;
    const n = this.size * this.size;
    this.static = new Float32Array(n);
    this.visual = new Float32Array(n);
    this.h = new Float32Array(n);
    this.speed = new Float32Array(n).fill(1); // terrain speed multiplier (fords)
    this.riverDist = new Float32Array(n).fill(Infinity); // distance to the river centre line
    this.bridges = [];
    for (const o of config.obstacles) {
      this._raster(this.static, o.x0, o.z0, o.x1, o.z1, o.h);
      this._raster(this.visual, o.x0, o.z0, o.x1, o.z1, CAMERA_HEIGHTS[o.kind] || 0);
    }
    if (config.river) this._rasterRiver(config.river, config.crossings || []);
    this.h.set(this.static);
  }

  /** Mirror of the server's river rasterisation: water blocks, bridges ramp up, fords slow you down. */
  _rasterRiver(river, crossings) {
    const line = riverPolyline(river.points);
    const reach = river.halfWidth + river.bank + 4;
    const size = this.size;
    for (let s = 0; s < line.length - 1; s++) {
      const ax = line[s][0];
      const az = line[s][1];
      const bx = line[s + 1][0];
      const bz = line[s + 1][1];
      const cx0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach - this.origin));
      const cx1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + reach - this.origin));
      const cz0 = Math.max(0, Math.floor(Math.min(az, bz) - reach - this.origin));
      const cz1 = Math.min(size - 1, Math.ceil(Math.max(az, bz) + reach - this.origin));
      if (cx0 > cx1 || cz0 > cz1) continue;
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      for (let cz = cz0; cz <= cz1; cz++) {
        const pz = cz + this.origin + 0.5;
        for (let cx = cx0; cx <= cx1; cx++) {
          const px = cx + this.origin + 0.5;
          const t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
          const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
          const i = cz * size + cx;
          if (d < this.riverDist[i]) this.riverDist[i] = d;
        }
      }
    }
    for (let i = 0; i < this.riverDist.length; i++) {
      if (this.riverDist[i] < river.halfWidth) this.static[i] = this.blocked;
    }
    this.bridges = crossings.filter((c) => c.kind === 'bridge');
    for (const c of crossings) {
      const cx0 = Math.max(0, Math.floor(c.x0 - this.origin));
      const cx1 = Math.min(size, Math.ceil(c.x1 - this.origin));
      const cz0 = Math.max(0, Math.floor(c.z0 - this.origin));
      const cz1 = Math.min(size, Math.ceil(c.z1 - this.origin));
      for (let cz = cz0; cz < cz1; cz++) {
        const pz = cz + this.origin + 0.5;
        for (let cx = cx0; cx < cx1; cx++) {
          const i = cz * size + cx;
          if (c.kind === 'bridge') {
            const ramp = Math.min(clamp((pz - c.z0) / c.ramp, 0, 1), clamp((c.z1 - pz) / c.ramp, 0, 1));
            this.static[i] = Math.round(c.deck * ramp * 100) / 100;
          } else if (c.kind === 'ford' && this.riverDist[i] < river.halfWidth) {
            this.static[i] = 0;
            this.speed[i] = c.slow;
          }
        }
      }
    }
  }

  /**
   * Height of the smooth bridge deck the engine draws at a point, or null off the bridges. The
   * field itself climbs a ramp in 1 m steps; this is for placing bodies on it, never for physics.
   */
  deckHeightAt(x, z) {
    for (const c of this.bridges) {
      if (x < c.x0 || x >= c.x1 || z < c.z0 || z >= c.z1) continue;
      return c.deck * Math.min(clamp((z - c.z0) / c.ramp, 0, 1), clamp((c.z1 - z) / c.ramp, 0, 1));
    }
    return null;
  }

  /** Terrain speed multiplier at a point (1 everywhere except fords). */
  speedAt(x, z) {
    const cx = Math.floor(x - this.origin);
    const cz = Math.floor(z - this.origin);
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return 1;
    return this.speed[cz * this.size + cx];
  }

  /** Distance from a point to the river's centre line (Infinity far from it). */
  riverDistanceAt(x, z) {
    const cx = Math.floor(x - this.origin);
    const cz = Math.floor(z - this.origin);
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return Infinity;
    return this.riverDist[cz * this.size + cx];
  }

  _raster(arr, x0, z0, x1, z1, h) {
    const cx0 = Math.max(0, Math.floor(x0 - this.origin));
    const cz0 = Math.max(0, Math.floor(z0 - this.origin));
    const cx1 = Math.min(this.size, Math.ceil(x1 - this.origin));
    const cz1 = Math.min(this.size, Math.ceil(z1 - this.origin));
    for (let cz = cz0; cz < cz1; cz++) {
      for (let cx = cx0; cx < cx1; cx++) {
        const i = cz * this.size + cx;
        if (h > arr[i]) arr[i] = h;
      }
    }
  }

  /** Raises the camera floor over impassable cells under the engine's props: [x0, z0, x1, z1, top] boxes. */
  addCameraBoxes(boxes) {
    for (const [x0, z0, x1, z1, top] of boxes) {
      const cx0 = Math.max(0, Math.floor(x0 - this.origin));
      const cz0 = Math.max(0, Math.floor(z0 - this.origin));
      const cx1 = Math.min(this.size, Math.ceil(x1 - this.origin));
      const cz1 = Math.min(this.size, Math.ceil(z1 - this.origin));
      for (let cz = cz0; cz < cz1; cz++) {
        for (let cx = cx0; cx < cx1; cx++) {
          const i = cz * this.size + cx;
          if (this.static[i] >= this.blocked && top > this.visual[i]) this.visual[i] = top;
        }
      }
    }
  }

  heightAt(x, z) {
    const cx = Math.floor(x - this.origin);
    const cz = Math.floor(z - this.origin);
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return this.blocked;
    return this.h[cz * this.size + cx];
  }

  /** Height of what the camera must stay above: placed blocks, or a prop's visual height. */
  surfaceAt(x, z) {
    const cx = Math.floor(x - this.origin);
    const cz = Math.floor(z - this.origin);
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return 0;
    const i = cz * this.size + cx;
    return this.h[i] >= this.blocked ? this.visual[i] : this.h[i];
  }

  applyBlock(b) {
    this._raster(this.h, b.x0 + 1e-3, b.z0 + 1e-3, b.x1 - 1e-3, b.z1 - 1e-3, b.y1);
  }

  rebuild(grid) {
    this.h.set(this.static);
    const b = {};
    for (let idx = 0; idx < grid.total; idx++) if (grid.slots[idx] !== 0) this.applyBlock(grid.box(idx, b));
  }
}

function aabbDistance(px, py, pz, b) {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dy = Math.max(b.y0 - py, 0, py - b.y1);
  const dz = Math.max(b.z0 - pz, 0, pz - b.z1);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const CARRY_SCALE = 0.5;

export class PyramidView {
  constructor(engine, config, grid) {
    this.engine = engine;
    this.config = config;
    this.grid = grid;
    const pc = config.pyramid;
    this.blockGeometry = new RoundedBoxGeometry(pc.blockW - 0.03, pc.blockH - 0.02, pc.blockW - 0.03, 2, 0.08);
    this.lowGeometry = new RoundedBoxGeometry(pc.blockW - 0.03, pc.blockH - 0.02, pc.blockW - 0.03, 1, 0.08);
    this.material = engine.materials.block;
    this.group = new THREE.Group();

    // Instances are packed in placement order so only placed blocks are drawn.
    this.blocks = new THREE.InstancedMesh(this.blockGeometry, this.material, grid.total);
    this.blocks.castShadow = true;
    this.blocks.receiveShadow = true;
    this.blocks.frustumCulled = false;
    const c = new THREE.Color(1, 1, 1);
    for (let i = 0; i < grid.total; i++) {
      this.blocks.setMatrixAt(i, HIDDEN);
      this.blocks.setColorAt(i, c);
    }
    this.blocks.count = 0;
    this.slotToInstance = new Int32Array(grid.total).fill(-1);
    this.group.add(this.blocks);

    const pile = config.pile;
    this.pileMesh = new THREE.InstancedMesh(this.lowGeometry, this.material, pile.maxStock);
    this.pileMesh.castShadow = true;
    this.pileMesh.receiveShadow = true;
    this.pileMesh.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const perLayer = pile.cols * pile.rows;
    for (let n = 0; n < pile.maxStock; n++) {
      const layer = Math.floor(n / perLayer);
      const w = n % perLayer;
      const ix = w % pile.cols;
      const iz = Math.floor(w / pile.cols);
      const jitter = (blockTint(n + 7) - 0.5) * 0.12;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), jitter);
      const p = new THREE.Vector3(
        pile.minX + (ix + 0.5) * pc.blockW,
        0.16 + layer * pc.blockH + pc.blockH / 2,
        pile.minZ + (iz + 0.5) * pc.blockW,
      );
      this.pileMesh.setColorAt(n, tintColor(90000 + n, c));
      m4.compose(p, q, one);
      this.pileMesh.setMatrixAt(n, m4);
    }
    this.pileMatrices = [];
    for (let n = 0; n < pile.maxStock; n++) {
      const mm = new THREE.Matrix4();
      this.pileMesh.getMatrixAt(n, mm);
      this.pileMatrices.push(mm);
    }
    this.pileMesh.count = 0;
    this.group.add(this.pileMesh);

    // Placement ghost.
    const ghostMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.2, 1.6, 0.6),
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(pc.blockW + 0.04, pc.blockH + 0.04, pc.blockW + 0.04), ghostMat);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.ghost.geometry),
      new THREE.LineBasicMaterial({ color: new THREE.Color(3, 2.2, 0.9), transparent: true, opacity: 0.9 }),
    );
    this.ghost.add(edges);
    this.ghost.visible = false;
    this.ghost.renderOrder = 5;
    this.ghost.userData.noAO = true;
    edges.userData.noAO = true;
    this.group.add(this.ghost);
    this.ghostSlot = -1;

    // Golden pyramidion shown once the capstone is set.
    const capGeo = new THREE.ConeGeometry((pc.blockW / 2) * Math.SQRT2 * 0.98, pc.blockH * 1.2, 4, 1);
    capGeo.rotateY(Math.PI / 4);
    this.capstone = new THREE.Mesh(capGeo, engine.materials.gold.clone());
    this.capstone.material.emissive.setRGB(0.9, 0.55, 0.15);
    this.capstone.material.emissiveIntensity = 0.6;
    this.capstone.castShadow = true;
    const top = grid.total - 1;
    this.capstone.position.set(grid.cxs[top], grid.cys[top] + pc.blockH / 2 + pc.blockH * 0.6, grid.czs[top]);
    this.capstone.visible = false;
    this.group.add(this.capstone);

    this.flying = [];
    this.puffs = [];
    this.puffMaterial = new THREE.SpriteMaterial({
      map: engine.tex.soft,
      color: new THREE.Color(0.95, 0.8, 0.6),
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    this.time = 0;
    this.glow = 0;
    this.onLand = null;
    this._box = {};
    engine.scene.add(this.group);
  }

  dispose() {
    this.engine.scene.remove(this.group);
    this.blockGeometry.dispose();
    this.lowGeometry.dispose();
  }

  _setInstance(slot, blockId) {
    const m4 = new THREE.Matrix4();
    const g = this.grid;
    const jitter = (blockTint(blockId + 3) - 0.5) * 0.04;
    m4.compose(
      new THREE.Vector3(g.cxs[slot], g.cys[slot], g.czs[slot]),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), jitter),
      new THREE.Vector3(1, 1, 1),
    );
    let inst = this.slotToInstance[slot];
    if (inst < 0) {
      inst = this.blocks.count++;
      this.slotToInstance[slot] = inst;
    }
    this.blocks.setMatrixAt(inst, m4);
    this.blocks.setColorAt(inst, tintColor(blockId));
    this.blocks.instanceMatrix.needsUpdate = true;
    this.blocks.instanceColor.needsUpdate = true;
  }

  /** Full rebuild from the server state (welcome / reconnect). */
  setState(slots) {
    for (const f of this.flying) this.group.remove(f.mesh);
    this.flying = [];
    this.blocks.count = 0;
    this.slotToInstance.fill(-1);
    for (let i = 0; i < this.grid.total; i++) {
      if (slots[i]) this._setInstance(i, slots[i]);
    }
    this.blocks.instanceMatrix.needsUpdate = true;
    this.capstone.visible = !!slots[this.grid.total - 1];
  }

  reset() {
    this.setState(new Array(this.grid.total).fill(0));
    this.glow = 0;
  }

  setPile(stock) {
    this.pileMesh.count = Math.max(0, Math.min(this.config.pile.maxStock, stock));
  }

  /** Top of the visible pile, used as the origin of pickup animations. */
  pileTop(target = new THREE.Vector3()) {
    const n = Math.max(0, this.pileMesh.count - 1);
    return target.setFromMatrixPosition(this.pileMatrices[n]);
  }

  /** Animates a block from a carrier to its slot; the instance appears on landing. */
  place(slot, blockId, from) {
    const g = this.grid;
    const to = new THREE.Vector3(g.cxs[slot], g.cys[slot], g.czs[slot]);
    const start = from ? from.clone() : to.clone().add(new THREE.Vector3(0, 5, 0));
    const mesh = new THREE.Mesh(this.blockGeometry, this.material.clone());
    mesh.material.color.copy(tintColor(blockId));
    mesh.castShadow = true;
    mesh.position.copy(start);
    mesh.scale.setScalar(CARRY_SCALE);
    this.group.add(mesh);
    this.flying.push({ mesh, from: start, to, t: 0, dur: 0.42, slot, blockId, spin: (blockTint(blockId) - 0.5) * 2 });
  }

  _land(f) {
    this.group.remove(f.mesh);
    f.mesh.material.dispose();
    this._setInstance(f.slot, f.blockId);
    if (f.slot === this.grid.total - 1) this.capstone.visible = true;
    this._puff(f.to);
    if (this.onLand) this.onLand(f.slot, f.to);
  }

  _puff(at) {
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(this.puffMaterial.clone());
      const a = (i / 6) * Math.PI * 2 + Math.random();
      s.position.set(at.x + Math.cos(a) * 0.9, at.y - this.config.pyramid.blockH / 2 + 0.2, at.z + Math.sin(a) * 0.9);
      s.scale.setScalar(0.6);
      s.userData = { vx: Math.cos(a) * 1.6, vz: Math.sin(a) * 1.6, life: 0, max: 0.8 + Math.random() * 0.4 };
      this.group.add(s);
      this.puffs.push(s);
    }
  }

  setGhost(slot) {
    this.ghostSlot = slot;
    if (slot < 0) {
      this.ghost.visible = false;
      return;
    }
    const g = this.grid;
    this.ghost.position.set(g.cxs[slot], g.cys[slot], g.czs[slot]);
    this.ghost.visible = true;
  }

  /**
   * Best empty, supported slot within reach of a builder, favouring the
   * direction they face. Must agree with the server's reach validation.
   */
  findTarget(px, py, pz, fx, fz, hand, reach) {
    const g = this.grid;
    const b = this._box;
    let best = -1;
    let bestScore = Infinity;
    const hy = py + hand;
    const maxLayer = Math.min(g.layers - 1, Math.floor((hy + reach) / this.config.pyramid.blockH));
    const end = g.offsets[maxLayer + 1];
    for (let idx = 0; idx < end; idx++) {
      if (g.slots[idx] !== 0) continue;
      const dxc = g.cxs[idx] - px;
      const dzc = g.czs[idx] - pz;
      if (dxc * dxc + dzc * dzc > (reach + 2) * (reach + 2)) continue;
      if (!g.isSupported(idx)) continue;
      const d = aabbDistance(px, hy, pz, g.box(idx, b));
      if (d > reach) continue;
      const len = Math.hypot(dxc, dzc) || 1;
      const facing = (dxc * fx + dzc * fz) / len;
      const score = d - facing * 0.9 + g.layerOf[idx] * 0.02;
      if (score < bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    return best;
  }

  update(dt) {
    this.time += dt;
    if (this.ghost.visible) {
      const k = Math.sin(this.time * 5) * 0.5 + 0.5;
      this.ghost.material.opacity = 0.12 + k * 0.16;
      this.ghost.children[0].material.opacity = 0.55 + k * 0.45;
    }
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt / f.dur;
      const t = Math.min(1, f.t);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += Math.sin(Math.PI * t) * 1.6;
      f.mesh.scale.setScalar(CARRY_SCALE + (1 - CARRY_SCALE) * e);
      f.mesh.rotation.y = (1 - e) * f.spin;
      if (f.t >= 1) {
        this.flying.splice(i, 1);
        this._land(f);
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const s = this.puffs[i];
      const u = s.userData;
      u.life += dt;
      const t = u.life / u.max;
      s.position.x += u.vx * dt;
      s.position.z += u.vz * dt;
      s.position.y += dt * 0.5;
      s.scale.setScalar(0.6 + t * 2.2);
      s.material.opacity = Math.sin(Math.PI * Math.min(1, t)) * 0.55;
      if (t >= 1) {
        this.group.remove(s);
        s.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
    if (this.capstone.visible) {
      this.capstone.material.emissiveIntensity = 0.5 + Math.sin(this.time * 2) * 0.15 + this.glow;
      this.glow = Math.max(0, this.glow - dt * 0.25);
    }
  }

  /** Flares the capstone when a pyramid is completed. */
  celebrate() {
    this.glow = 3;
  }
}

export { CARRY_SCALE };
