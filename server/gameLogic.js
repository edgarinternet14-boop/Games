'use strict';

/**
 * Dunebound - authoritative game rules.
 *
 * Everything in this module is pure game logic with no networking:
 *   - world configuration (zones, obstacles, pyramid dimensions)
 *   - the pyramid placement grid and its support rules
 *   - the walkable height field shared by players and pets
 *   - A* pathfinding used by server-simulated pets
 *   - stat formulas, training, shop catalog and purchase validation
 *   - input sanitisers
 *
 * The client mirrors the grid / height-field math (client/src/js/pyramid.js)
 * using the numbers sent in the `welcome` payload, so both sides always agree.
 */

const BLOCKED = 100; // height value used for impassable cells

// ---------------------------------------------------------------------------
// World configuration
// ---------------------------------------------------------------------------

const PYRAMID = Object.freeze({
  cx: 0, // centre of the pyramid footprint (must be an integer)
  cz: 0,
  base: 12, // blocks per side on the bottom layer; each layer up is one smaller
  blockW: 2, // block footprint in metres
  blockH: 1.3, // block height in metres (≈52° slope with the half-block step)
});

const PILE = Object.freeze({
  minX: -5,
  maxX: 5,
  minZ: 44,
  maxZ: 52,
  cols: 5, // blocks along x per pile layer
  rows: 4, // blocks along z per pile layer
  maxStock: 80,
  initialStock: 60,
  regenSeconds: 0.45, // quarry workers cut a new block this often
  range: 2.6, // max horizontal distance from the pile edge to lift blocks
});

const ZONES = Object.freeze({
  spawn: { x: 0, z: 30, r: 5 },
  strength: { x: -42, z: 25, r: 4.5 },
  track: { x: -42, z: 44, r: 9.5, inner: 2.2 },
  shop: { x: 42, z: 31, r: 6.5 },
});

function box(kind, x0, z0, x1, z1, extra) {
  return Object.assign({ kind, x0, z0, x1, z1, h: BLOCKED }, extra || {});
}

const OBSTACLES = Object.freeze([
  box('pile', PILE.minX, PILE.minZ, PILE.maxX, PILE.maxZ),
  box('obelisk', 16, 16, 18, 18),
  box('obelisk', -18, 16, -16, 18),
  box('obelisk', 16, -18, 18, -16),
  box('obelisk', -18, -18, -16, -16),
  box('counter', 37, 36, 47, 38),
  box('rack', -47, 18, -37, 20),
  box('sundial', -43, 43, -41, 45),
  box('pond', 50, -46, 66, -32),
  box('brazier', -8, 20, -7, 21),
  box('brazier', 7, 20, 8, 21),
  box('brazier', -8, 37, -7, 38),
  box('brazier', 7, 37, 8, 38),
  box('palm', 48, -49, 49, -48, { seed: 1 }),
  box('palm', 67, -45, 68, -44, { seed: 2 }),
  box('palm', 68, -36, 69, -35, { seed: 3 }),
  box('palm', 47, -31, 48, -30, { seed: 4 }),
  box('palm', 57, -50, 58, -49, { seed: 5 }),
  box('palm', 34, 38, 35, 39, { seed: 6 }),
  box('palm', 49, 38, 50, 39, { seed: 7 }),
  box('palm', -32, 16, -31, 17, { seed: 8 }),
  box('rock', -24, 66, -14, 74, { seed: 11 }),
  box('rock', -12, 70, -2, 78, { seed: 12 }),
  box('rock', 4, 68, 14, 76, { seed: 13 }),
  box('rock', 16, 64, 26, 72, { seed: 14 }),
  box('rock', -36, 60, -28, 68, { seed: 15 }),
  box('rock', 28, 58, 36, 66, { seed: 16 }),
]);

const CONFIG = Object.freeze({
  version: 1,
  tickRate: 20,
  maxPlayers: 32,
  worldHalf: 110, // players are clamped to [-worldHalf, worldHalf] on x/z
  nav: Object.freeze({ origin: -128, size: 256 }), // 1 m cells covering [-128, 128)
  blocked: BLOCKED,
  pyramid: PYRAMID,
  pile: PILE,
  zones: ZONES,
  obstacles: OBSTACLES,
  player: Object.freeze({
    radius: 0.35,
    stepHeight: 1.45,
    reach: 3.6,
    handHeight: 1.0,
    gravity: 24,
    jumpVelocity: 7.4,
    maxCapacity: 20,
  }),
  pet: Object.freeze({ reach: 3.0, handHeight: 0.6, maxPerPlayer: 4, maxGlobal: 64 }),
  economy: Object.freeze({ completionBonus: 500, completionBonusPerPyramid: 100, resetDelay: 12 }),
});

// ---------------------------------------------------------------------------
// Pyramid grid
// ---------------------------------------------------------------------------

/**
 * Layer k has (base - k) x (base - k) slots. Each layer is inset by half a
 * block, so slot (k, i, j) rests on the four slots (k-1, i..i+1, j..j+1).
 * Slots are flattened into a single index for compact network transfer.
 */
class PyramidGrid {
  constructor(cfg = PYRAMID) {
    this.cfg = cfg;
    this.layers = cfg.base;
    this.offsets = new Int32Array(this.layers + 1);
    let total = 0;
    for (let k = 0; k < this.layers; k++) {
      this.offsets[k] = total;
      const n = cfg.base - k;
      total += n * n;
    }
    this.offsets[this.layers] = total;
    this.total = total;
    this.slots = new Int32Array(total); // 0 = empty, otherwise the block id
    this.placed = 0;
    this.layerOf = new Uint8Array(total);
    this.iOf = new Uint8Array(total);
    this.jOf = new Uint8Array(total);
    // Precomputed slot centres so hot loops (pet targeting) never allocate.
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

  size(k) {
    return this.cfg.base - k;
  }

  index(k, i, j) {
    const n = this.size(k);
    if (k < 0 || k >= this.layers || i < 0 || j < 0 || i >= n || j >= n) return -1;
    return this.offsets[k] + i * n + j;
  }

  isValidIndex(idx) {
    return Number.isInteger(idx) && idx >= 0 && idx < this.total;
  }

  center(idx) {
    return { x: this.cxs[idx], y: this.cys[idx], z: this.czs[idx] };
  }

  box(idx) {
    const c = this.center(idx);
    const hw = this.cfg.blockW / 2;
    const hh = this.cfg.blockH / 2;
    return { x0: c.x - hw, x1: c.x + hw, y0: c.y - hh, y1: c.y + hh, z0: c.z - hw, z1: c.z + hw };
  }

  isPlaced(idx) {
    return this.slots[idx] !== 0;
  }

  isSupported(idx) {
    const k = this.layerOf[idx];
    if (k === 0) return true;
    const i = this.iOf[idx];
    const j = this.jOf[idx];
    const below = k - 1;
    return (
      this.slots[this.index(below, i, j)] !== 0 &&
      this.slots[this.index(below, i + 1, j)] !== 0 &&
      this.slots[this.index(below, i, j + 1)] !== 0 &&
      this.slots[this.index(below, i + 1, j + 1)] !== 0
    );
  }

  canPlace(idx) {
    return this.isValidIndex(idx) && this.slots[idx] === 0 && this.isSupported(idx);
  }

  place(idx, blockId) {
    this.slots[idx] = blockId;
    this.placed++;
  }

  isComplete() {
    return this.placed >= this.total;
  }

  /** Lowest layer that still has an empty slot (the "build front"). */
  frontLayer() {
    for (let k = 0; k < this.layers; k++) {
      for (let idx = this.offsets[k]; idx < this.offsets[k + 1]; idx++) {
        if (this.slots[idx] === 0) return k;
      }
    }
    return this.layers;
  }

  reset() {
    this.slots.fill(0);
    this.placed = 0;
  }

  toArray() {
    return Array.from(this.slots);
  }

  load(arr) {
    this.reset();
    if (!Array.isArray(arr)) return;
    // Re-validate support while loading so a corrupt save can never produce floating blocks.
    for (let idx = 0; idx < Math.min(arr.length, this.total); idx++) {
      const id = arr[idx] | 0;
      if (id > 0 && this.isSupported(idx)) this.place(idx, id);
    }
  }
}

// ---------------------------------------------------------------------------
// Height field (walkable surface)
// ---------------------------------------------------------------------------

/**
 * A 1 m resolution height field. Static obstacles are rasterised once; placed
 * pyramid blocks raise the cells they cover. Because the pyramid is laid out on
 * integer metre boundaries, blocks map exactly onto 2x2 cells.
 */
class HeightField {
  constructor(cfg = CONFIG) {
    this.origin = cfg.nav.origin;
    this.size = cfg.nav.size;
    this.static = new Float32Array(this.size * this.size);
    this.h = new Float32Array(this.size * this.size);
    for (const o of cfg.obstacles) this._raster(this.static, o.x0, o.z0, o.x1, o.z1, o.h);
    this.h.set(this.static);
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

  cellOf(x, z) {
    const cx = Math.floor(x - this.origin);
    const cz = Math.floor(z - this.origin);
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return -1;
    return cz * this.size + cx;
  }

  heightAt(x, z) {
    const c = this.cellOf(x, z);
    return c < 0 ? BLOCKED : this.h[c];
  }

  cellCenterX(c) {
    return (c % this.size) + this.origin + 0.5;
  }

  cellCenterZ(c) {
    return Math.floor(c / this.size) + this.origin + 0.5;
  }

  applyBlock(b) {
    this._raster(this.h, b.x0 + 1e-3, b.z0 + 1e-3, b.x1 - 1e-3, b.z1 - 1e-3, b.y1);
  }

  rebuild(grid) {
    this.h.set(this.static);
    for (let idx = 0; idx < grid.total; idx++) {
      if (grid.slots[idx] !== 0) this.applyBlock(grid.box(idx));
    }
  }

  /** Highest walkable cell under a circle footprint, ignoring cells above maxStep. */
  groundUnder(x, z, radius, feetY, step) {
    let best = 0;
    for (let dz = -1; dz <= 1; dz += 2) {
      for (let dx = -1; dx <= 1; dx += 2) {
        const hh = this.heightAt(x + dx * radius, z + dz * radius);
        if (hh < BLOCKED && hh <= feetY + step && hh > best) best = hh;
      }
    }
    const hc = this.heightAt(x, z);
    if (hc < BLOCKED && hc <= feetY + step && hc > best) best = hc;
    return best;
  }
}

// ---------------------------------------------------------------------------
// A* pathfinding over the height field
// ---------------------------------------------------------------------------

class MinHeap {
  constructor(capacity = 4096) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.length = 0;
  }

  clear() {
    this.length = 0;
  }

  push(key, val) {
    if (this.length === this.keys.length) {
      const k = new Float64Array(this.keys.length * 2);
      const v = new Int32Array(this.vals.length * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.length++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  pop() {
    const top = this.vals[0];
    const lastKey = this.keys[--this.length];
    const lastVal = this.vals[this.length];
    let i = 0;
    const half = this.length >> 1;
    while (i < half) {
      let c = 2 * i + 1;
      if (c + 1 < this.length && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastKey) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = lastKey;
    this.vals[i] = lastVal;
    return top;
  }
}

const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

class PathFinder {
  constructor(field, step = CONFIG.player.stepHeight) {
    this.field = field;
    this.step = step;
    const n = field.size * field.size;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.run = 0;
    this.heap = new MinHeap();
  }

  passable(from, to) {
    const h = this.field.h;
    const hb = h[to];
    return hb < BLOCKED && Math.abs(hb - h[from]) <= this.step;
  }

  /**
   * Multi-goal A*. `isGoal(cell)` accepts a cell, `heuristic(cell)` must not
   * overestimate the remaining distance. Returns world waypoints or null.
   */
  find(sx, sz, isGoal, heuristic, maxExpand = 24000) {
    const f = this.field;
    const size = f.size;
    let start = f.cellOf(sx, sz);
    if (start < 0) return null;
    this.run++;
    if (this.run === 0xffffffff) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.run = 1;
    }
    const run = this.run;
    const heap = this.heap;
    heap.clear();
    this.g[start] = 0;
    this.parent[start] = -1;
    this.seen[start] = run;
    heap.push(heuristic(start), start);
    let expanded = 0;
    while (heap.length > 0) {
      const cur = heap.pop();
      if (this.closed[cur] === run) continue;
      this.closed[cur] = run;
      if (isGoal(cur)) return this._reconstruct(cur);
      if (++expanded > maxExpand) return null;
      const cx = cur % size;
      const cz = (cur - cx) / size;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d][0];
        const nz = cz + DIRS[d][1];
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const nb = nz * size + nx;
        if (this.closed[nb] === run || !this.passable(cur, nb)) continue;
        if (d >= 4) {
          // No corner cutting: both orthogonal neighbours must be walkable too.
          const a = cz * size + nx;
          const b = nz * size + cx;
          if (!this.passable(cur, a) || !this.passable(cur, b)) continue;
        }
        const ng = this.g[cur] + DIRS[d][2] + 0.4 * Math.abs(f.h[nb] - f.h[cur]);
        if (this.seen[nb] !== run || ng < this.g[nb]) {
          this.seen[nb] = run;
          this.g[nb] = ng;
          this.parent[nb] = cur;
          heap.push(ng + heuristic(nb), nb);
        }
      }
    }
    return null;
  }

  _reconstruct(goal) {
    const cells = [];
    for (let c = goal; c !== -1; c = this.parent[c]) cells.push(c);
    cells.reverse();
    return this.smooth(cells).map((c) => ({ x: this.field.cellCenterX(c), z: this.field.cellCenterZ(c) }));
  }

  /** String-pulling: drop intermediate cells that have a clear walkable line of sight. */
  smooth(cells) {
    if (cells.length <= 2) return cells;
    const out = [cells[0]];
    let anchor = 0;
    for (let i = 2; i < cells.length; i++) {
      if (!this.lineWalkable(cells[anchor], cells[i])) {
        anchor = i - 1;
        out.push(cells[anchor]);
      }
    }
    out.push(cells[cells.length - 1]);
    return out;
  }

  /** Grid traversal (Amanatides & Woo) between two cell centres checking every crossed cell. */
  lineWalkable(a, b) {
    const f = this.field;
    const size = f.size;
    let x = a % size;
    let z = (a - x) / size;
    const tx = b % size;
    const tz = (b - tx) / size;
    const dx = tx - x;
    const dz = tz - z;
    const stepX = Math.sign(dx);
    const stepZ = Math.sign(dz);
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = tDeltaX * 0.5;
    let tMaxZ = tDeltaZ * 0.5;
    let prev = a;
    let guard = 0;
    while ((x !== tx || z !== tz) && guard++ < 1024) {
      if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
        // Passing exactly through a corner: both side cells must be walkable.
        const sideA = z * size + (x + stepX);
        const sideB = (z + stepZ) * size + x;
        if (!this.passable(prev, sideA) || !this.passable(prev, sideB)) return false;
        x += stepX;
        z += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      } else if (tMaxX < tMaxZ) {
        x += stepX;
        tMaxX += tDeltaX;
      } else {
        z += stepZ;
        tMaxZ += tDeltaZ;
      }
      const cur = z * size + x;
      if (!this.passable(prev, cur)) return false;
      prev = cur;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function aabbDistance(px, py, pz, b) {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dy = Math.max(b.y0 - py, 0, py - b.y1);
  const dz = Math.max(b.z0 - pz, 0, pz - b.z1);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function rectDistanceXZ(px, pz, x0, z0, x1, z1) {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dz = Math.max(z0 - pz, 0, pz - z1);
  return Math.sqrt(dx * dx + dz * dz);
}

function inZone(zone, x, z) {
  const dx = x - zone.x;
  const dz = z - zone.z;
  return dx * dx + dz * dz <= zone.r * zone.r;
}

function inTrack(x, z) {
  const t = ZONES.track;
  const d = Math.hypot(x - t.x, z - t.z);
  return d <= t.r && d >= t.inner;
}

function distanceToPile(x, z) {
  return rectDistanceXZ(x, z, PILE.minX, PILE.minZ, PILE.maxX, PILE.maxZ);
}

function canReachSlot(grid, idx, x, y, z, handHeight, reach) {
  return aabbDistance(x, y + handHeight, z, grid.box(idx)) <= reach;
}

/** True when a cell lies inside a block footprint (keeps pets from standing on their own target slot). */
function cellInBox(field, cell, b) {
  const x = field.cellCenterX(cell);
  const z = field.cellCenterZ(cell);
  return x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;
}

// ---------------------------------------------------------------------------
// Stats, training and economy
// ---------------------------------------------------------------------------

const UPGRADES = Object.freeze({
  harness: { name: 'Linen Carry Harness', desc: '+1 block carry capacity', max: 6, baseCost: 120, growth: 2.1 },
  sandals: { name: 'Reed Sandals', desc: '+6% movement speed', max: 6, baseCost: 90, growth: 1.9 },
  regimen: { name: 'Temple Regimen', desc: '+50% training gains', max: 6, baseCost: 150, growth: 2.2 },
  favor: { name: "Pharaoh's Favor", desc: '+25% gold for every block you place', max: 6, baseCost: 260, growth: 2.3 },
});

const PETS = Object.freeze({
  jackal: { name: 'Desert Jackal', desc: 'Quick and loyal. Hauls 1 block per trip.', cost: 250, speed: 6.0, capacity: 1, loadTime: 1.0 },
  camel: { name: 'Pack Camel', desc: 'Slow but sturdy. Hauls 3 blocks per trip.', cost: 900, speed: 4.5, capacity: 3, loadTime: 1.6 },
  sphinx: { name: 'Sphinx Cub', desc: 'A royal hauler. 2 blocks at a brisk pace.', cost: 2500, speed: 6.8, capacity: 2, loadTime: 1.1 },
  scarab: { name: 'Golden Scarab', desc: 'Sacred and tireless. 4 blocks per trip.', cost: 6000, speed: 7.5, capacity: 4, loadTime: 1.2 },
});

function defaultProfile() {
  return {
    name: 'Builder',
    color: '#c8553d',
    gold: 0,
    strength: 1,
    speed: 1,
    placed: 0,
    upgrades: { harness: 0, sandals: 0, regimen: 0, favor: 0 },
    pets: [],
  };
}

function carryCapacity(p) {
  const base = 1 + Math.floor(Math.sqrt(Math.max(0, p.strength) / 6));
  return Math.min(CONFIG.player.maxCapacity, base + (p.upgrades.harness | 0));
}

function moveSpeed(p) {
  const s = (5.5 + 2.4 * Math.log2(1 + Math.max(0, p.speed) / 5)) * (1 + 0.06 * (p.upgrades.sandals | 0));
  return Math.min(18, s);
}

function loadFactor(carried, capacity) {
  return 1 - 0.3 * clamp(carried / Math.max(1, capacity), 0, 1);
}

function trainingMultiplier(p) {
  return 1 + 0.5 * (p.upgrades.regimen | 0);
}

function blockReward(layer, favorLevel) {
  return Math.round((8 + 4 * layer) * (1 + 0.25 * (favorLevel | 0)));
}

function tribute(layer) {
  return 2 + Math.floor(layer / 2);
}

function upgradeCost(id, level) {
  const u = UPGRADES[id];
  return Math.round(u.baseCost * Math.pow(u.growth, level));
}

/**
 * Validates a purchase. Returns { ok, cost, kind } or { ok: false, reason }.
 * `petCountGlobal` guards the server-wide pet budget.
 */
function validatePurchase(p, itemId, petCountGlobal) {
  if (typeof itemId !== 'string') return { ok: false, reason: 'Unknown item.' };
  if (Object.prototype.hasOwnProperty.call(UPGRADES, itemId)) {
    const level = p.upgrades[itemId] | 0;
    const u = UPGRADES[itemId];
    if (level >= u.max) return { ok: false, reason: `${u.name} is already mastered.` };
    const cost = upgradeCost(itemId, level);
    if (p.gold < cost) return { ok: false, reason: `You need ${cost - p.gold} more gold.` };
    return { ok: true, kind: 'upgrade', cost };
  }
  if (Object.prototype.hasOwnProperty.call(PETS, itemId)) {
    const pet = PETS[itemId];
    if (p.pets.length >= CONFIG.pet.maxPerPlayer) {
      return { ok: false, reason: `You can command at most ${CONFIG.pet.maxPerPlayer} pets.` };
    }
    if (petCountGlobal >= CONFIG.pet.maxGlobal) return { ok: false, reason: 'The server has reached its pet limit.' };
    if (p.gold < pet.cost) return { ok: false, reason: `You need ${pet.cost - p.gold} more gold.` };
    return { ok: true, kind: 'pet', cost: pet.cost };
  }
  return { ok: false, reason: 'Unknown item.' };
}

function applyPurchase(p, itemId, result) {
  p.gold -= result.cost;
  if (result.kind === 'upgrade') p.upgrades[itemId] = (p.upgrades[itemId] | 0) + 1;
}

function petRefund(species) {
  return Math.floor(PETS[species].cost * 0.4);
}

function shopView(p) {
  return {
    upgrades: Object.keys(UPGRADES).map((id) => {
      const u = UPGRADES[id];
      const level = p.upgrades[id] | 0;
      return { id, name: u.name, desc: u.desc, level, max: u.max, cost: level >= u.max ? null : upgradeCost(id, level) };
    }),
    pets: Object.keys(PETS).map((id) => {
      const s = PETS[id];
      return { id, name: s.name, desc: s.desc, cost: s.cost, speed: s.speed, capacity: s.capacity };
    }),
  };
}

/** Strength reps: validated location and cooldown, returns the gain (0 if rejected). */
function strengthRepGain(p, x, z, now, lastRepAt) {
  if (!inZone(ZONES.strength, x, z)) return { ok: false, reason: 'Stand on the lifting platform to train.' };
  if (now - lastRepAt < 450) return { ok: false, reason: 'cooldown', silent: true };
  return { ok: true, gain: trainingMultiplier(p) };
}

/** Speed is trained by running laps on the track: every 10 m run grants a rep. */
function trackGain(p, distance) {
  return (distance / 10) * trainingMultiplier(p);
}

// ---------------------------------------------------------------------------
// Sanitisers
// ---------------------------------------------------------------------------

const PALETTE = Object.freeze(['#c8553d', '#2a9d8f', '#e9c46a', '#6d597a', '#3a86ff', '#e76f51', '#8ab17d', '#f4a1c1']);

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _\-.']/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

function sanitizeColor(raw) {
  if (typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

function sanitizeChat(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function isToken(raw) {
  return typeof raw === 'string' && /^[a-f0-9]{32,64}$/.test(raw);
}

function finite(...vals) {
  for (const v of vals) if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return true;
}

function normalizeProfile(raw) {
  const d = defaultProfile();
  if (!raw || typeof raw !== 'object') return d;
  const num = (v, lo, hi, fb) => (finite(v) ? clamp(v, lo, hi) : fb);
  d.name = sanitizeName(raw.name) || d.name;
  d.color = sanitizeColor(raw.color);
  d.gold = Math.floor(num(raw.gold, 0, 1e12, 0));
  d.strength = num(raw.strength, 1, 1e7, 1);
  d.speed = num(raw.speed, 1, 1e7, 1);
  d.placed = Math.floor(num(raw.placed, 0, 1e9, 0));
  if (raw.upgrades && typeof raw.upgrades === 'object') {
    for (const id of Object.keys(UPGRADES)) d.upgrades[id] = Math.floor(num(raw.upgrades[id], 0, UPGRADES[id].max, 0));
  }
  if (Array.isArray(raw.pets)) {
    d.pets = raw.pets.filter((s) => typeof s === 'string' && PETS[s]).slice(0, CONFIG.pet.maxPerPlayer);
  }
  return d;
}

/** Deterministic 0..1 value per block id; the client uses the same hash for stone tint. */
function blockTint(id) {
  let h = (id * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function publicConfig() {
  return {
    version: CONFIG.version,
    tickRate: CONFIG.tickRate,
    worldHalf: CONFIG.worldHalf,
    nav: CONFIG.nav,
    blocked: BLOCKED,
    pyramid: PYRAMID,
    pile: PILE,
    zones: ZONES,
    obstacles: OBSTACLES,
    player: CONFIG.player,
    pet: CONFIG.pet,
    palette: PALETTE,
  };
}

module.exports = {
  BLOCKED,
  CONFIG,
  PYRAMID,
  PILE,
  ZONES,
  OBSTACLES,
  UPGRADES,
  PETS,
  PALETTE,
  PyramidGrid,
  HeightField,
  PathFinder,
  clamp,
  aabbDistance,
  rectDistanceXZ,
  inZone,
  inTrack,
  distanceToPile,
  canReachSlot,
  cellInBox,
  defaultProfile,
  normalizeProfile,
  carryCapacity,
  moveSpeed,
  loadFactor,
  trainingMultiplier,
  blockReward,
  tribute,
  upgradeCost,
  validatePurchase,
  applyPurchase,
  petRefund,
  shopView,
  strengthRepGain,
  trackGain,
  sanitizeName,
  sanitizeColor,
  sanitizeChat,
  isToken,
  finite,
  blockTint,
  publicConfig,
};
