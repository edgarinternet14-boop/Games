// EnemyManager spawns, moves and recycles every enemy in the arena, scales the
// waves over time, and owns the XP gems enemies drop when they die.
//
// Nothing in here allocates once play starts:
//  - Enemies and gems live in fixed-size object pools filled at scene creation.
//    Spawning takes a record off a free list, dying puts it back.
//  - A uniform spatial hash, stored as linked lists in typed arrays and rebuilt
//    every frame in O(n), answers the "what is near this point?" queries behind
//    enemy separation, bullet hits, contact damage and the player's auto-aim.
// That keeps the frame cost roughly linear in the number of enemies, so several
// hundred of them stay cheap.

const TAU = Math.PI * 2;

// Must be at least the largest enemy radius plus the largest bullet or player
// radius, so a 3x3 block of cells is guaranteed to contain every overlap.
const CELL_SIZE = 64;

const SPAWN_MARGIN = 90; // how far past the screen corners enemies appear (px)
const DESPAWN_FACTOR = 1.6; // stragglers further than spawn radius * this are moved back in
const SEPARATION = 12; // how quickly overlapping enemies push apart (1/s)
const KNOCKBACK = 230; // impulse a bullet hit gives a 1.0-knockback enemy (px/s)
const KNOCKBACK_DAMPING = 9; // exponential decay of that impulse (1/s)
const HIT_FLASH = 0.07; // seconds an enemy flashes white when hit

export const WAVE_DURATION = 30; // seconds per wave

export const ENEMY_TYPES = {
  bat: {
    texture: 'enemy-bat', hp: 6, speed: 118, radius: 11, damage: 7, xp: 1,
    knockback: 1, sway: 0.18, swayFreq: 14, color: 0xb57be8,
  },
  zombie: {
    texture: 'enemy-zombie', hp: 18, speed: 72, radius: 15, damage: 10, xp: 2,
    knockback: 0.8, sway: 0.1, swayFreq: 6, color: 0x7cc35a,
  },
  brute: {
    texture: 'enemy-brute', hp: 70, speed: 54, radius: 24, damage: 18, xp: 6,
    knockback: 0.35, sway: 0.06, swayFreq: 4, color: 0xff7043,
  },
  elite: {
    texture: 'enemy-elite', hp: 650, speed: 64, radius: 34, damage: 30, xp: 40,
    knockback: 0.05, sway: 0.04, swayFreq: 2, color: 0xffd166,
  },
};

/**
 * Difficulty curve. Every value scales with the wave number, and each new wave
 * starts by surrounding the player with a ring of enemies.
 */
export function waveConfig(wave) {
  const w = wave - 1;
  const weights = {
    bat: 5,
    zombie: wave >= 2 ? 3 + w * 0.4 : 0,
    brute: wave >= 4 ? Math.min(4, 0.8 + (wave - 4) * 0.4) : 0,
  };
  const spawnTable = Object.entries(weights).filter(([, weight]) => weight > 0);

  return {
    wave,
    spawnInterval: Math.max(0.2, 1.2 * Math.pow(0.9, w)), // seconds between bursts
    burst: 1 + Math.floor(w / 2), // enemies per burst
    maxAlive: Math.min(700, 30 + 30 * w),
    hpMultiplier: 1 + 0.22 * w + 0.015 * w * w,
    speedMultiplier: Math.min(1.45, 1 + 0.025 * w),
    damageMultiplier: 1 + 0.06 * w,
    spawnTable,
    spawnTotal: spawnTable.reduce((sum, [, weight]) => sum + weight, 0),
    ringSize: Math.min(64, 8 + 4 * w),
    ringType: wave < 6 ? 'bat' : wave < 15 ? 'zombie' : 'brute',
    elites: wave % 5 === 0 ? wave / 5 : 0,
  };
}

/**
 * Fixed-capacity object pool. Every record is created up front; acquire() and
 * release() are O(1) and never allocate. `live` is a dense array of the records
 * in use, so update loops never visit idle ones. Records keep their index in
 * `records` (poolId) for life, which is what the spatial hash stores.
 *
 * Releasing swaps the last live record into the freed slot, so loops that may
 * release the record they are visiting must iterate `live` backwards.
 */
export class Pool {
  constructor(capacity, create) {
    this.records = [];
    this.free = [];
    this.live = [];
    for (let i = 0; i < capacity; i++) {
      const record = create(i);
      record.poolId = i;
      record.liveIndex = -1;
      this.records.push(record);
    }
    // Reversed so records are handed out in creation order.
    for (let i = capacity - 1; i >= 0; i--) {
      this.free.push(this.records[i]);
    }
  }

  get size() {
    return this.live.length;
  }

  get capacity() {
    return this.records.length;
  }

  acquire() {
    const record = this.free.pop();
    if (!record) {
      return null;
    }
    record.liveIndex = this.live.length;
    this.live.push(record);
    return record;
  }

  release(record) {
    const index = record.liveIndex;
    if (index < 0) {
      return;
    }
    const last = this.live.pop();
    if (last !== record) {
      this.live[index] = last;
      last.liveIndex = index;
    }
    record.liveIndex = -1;
    this.free.push(record);
  }
}

export default class EnemyManager extends Phaser.Events.EventEmitter {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} options
   * @param {Phaser.Geom.Rectangle} options.bounds arena rectangle
   * @param {object} options.layers render layers (`enemies`, `loot`, `fx`)
   * @param {number} [options.capacity] most enemies that can exist at once
   * @param {number} [options.gemCapacity] most XP gems on the ground at once
   */
  constructor(scene, { bounds, layers, capacity = 800, gemCapacity = 500 }) {
    super();
    this.scene = scene;
    this.bounds = bounds;

    this.elapsed = 0;
    this.wave = 0;
    this.config = null;
    this.spawnTimer = 0;
    this.spawnRadius = 0;
    this.despawnDistSq = Infinity;
    this.kills = 0;
    this.nextUid = 1;
    this.spawnPoint = { x: 0, y: 0 };

    this.pool = new Pool(capacity, () => {
      const sprite = new Phaser.GameObjects.Image(scene, 0, 0, 'enemy-bat');
      sprite.setVisible(false).setActive(false);
      layers.enemies.add(sprite);
      return {
        sprite,
        uid: 0, // unique per spawn, so bullets can tell a recycled record from the enemy they hit
        alive: false,
        type: null,
        typeKey: null,
        x: 0, y: 0,
        vx: 0, vy: 0,
        kbx: 0, kby: 0,
        hp: 0, maxHp: 0,
        speed: 0, radius: 0, damage: 0, xp: 0,
        flash: 0, phase: 0,
      };
    });

    // Spatial hash: cellHead[cell] is the first enemy id in that cell and
    // cellNext[id] links to the next one; -1 ends a chain.
    this.cols = Math.ceil(bounds.width / CELL_SIZE);
    this.rows = Math.ceil(bounds.height / CELL_SIZE);
    this.cellHead = new Int32Array(this.cols * this.rows).fill(-1);
    this.cellNext = new Int32Array(capacity).fill(-1);
    this.nearby = new Int32Array(capacity);

    this.gems = new XPGemPool(scene, layers.loot, gemCapacity);

    this.deathFx = {};
    for (const [key, type] of Object.entries(ENEMY_TYPES)) {
      const big = key === 'elite';
      const emitter = scene.add.particles(0, 0, 'spark', {
        emitting: false,
        lifespan: { min: 220, max: big ? 700 : 420 },
        speed: { min: 50, max: big ? 340 : 170 },
        scale: { start: big ? 1.8 : 1, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: type.color,
        blendMode: 'ADD',
      });
      layers.fx.add(emitter);
      this.deathFx[key] = emitter;
    }
  }

  get alive() {
    return this.pool.size;
  }

  get capacity() {
    return this.pool.capacity;
  }

  /**
   * Advances spawning and enemy movement by `dt` seconds.
   * @returns {number} total contact damage per second the enemies touching
   *   `target` are dealing right now
   */
  update(dt, target) {
    this.elapsed += dt;
    this.measureSpawnRadius(target);
    this.updateDirector(dt, target);
    const contactDps = this.moveEnemies(dt, target);
    this.rebuildGrid();
    return contactDps;
  }

  // ---------------------------------------------------------------- spawning

  /**
   * The spawn ring passes just outside the farthest screen corner from the
   * player, so new enemies always appear off-screen even when the camera has
   * stopped at the arena edge and the player is off-centre.
   */
  measureSpawnRadius(target) {
    const cam = this.scene.cameras.main;
    const dx = Math.max(Math.abs(target.x - cam.scrollX), Math.abs(cam.scrollX + cam.width - target.x));
    const dy = Math.max(Math.abs(target.y - cam.scrollY), Math.abs(cam.scrollY + cam.height - target.y));
    this.spawnRadius = Math.hypot(dx, dy) + SPAWN_MARGIN;
    const despawn = this.spawnRadius * DESPAWN_FACTOR;
    this.despawnDistSq = despawn * despawn;
  }

  updateDirector(dt, target) {
    const wave = Math.floor(this.elapsed / WAVE_DURATION) + 1;
    if (wave !== this.wave) {
      this.startWave(wave, target);
    }

    const cfg = this.config;
    this.spawnTimer -= dt;
    while (this.spawnTimer <= 0) {
      this.spawnTimer += cfg.spawnInterval;
      // Each burst arrives as a loose pack from one direction.
      const heading = Math.random() * TAU;
      for (let i = 0; i < cfg.burst && this.pool.size < cfg.maxAlive; i++) {
        const angle = heading + Phaser.Math.FloatBetween(-0.45, 0.45);
        if (this.findSpawnPoint(target, angle)) {
          this.spawn(this.rollType(cfg), this.spawnPoint.x, this.spawnPoint.y);
        }
      }
    }
  }

  startWave(wave, target) {
    this.wave = wave;
    this.config = waveConfig(wave);
    const cfg = this.config;

    // Encircle the player. Points outside the arena are skipped, so the ring
    // has a gap when the player hugs a wall.
    const ringRadius = this.spawnRadius;
    for (let i = 0; i < cfg.ringSize; i++) {
      const angle = (i / cfg.ringSize) * TAU;
      const x = target.x + Math.cos(angle) * ringRadius;
      const y = target.y + Math.sin(angle) * ringRadius;
      if (this.insideArena(x, y)) {
        this.spawn(cfg.ringType, x, y);
      }
    }

    for (let i = 0; i < cfg.elites; i++) {
      if (this.findSpawnPoint(target, Math.random() * TAU)) {
        this.spawn('elite', this.spawnPoint.x, this.spawnPoint.y);
      }
    }

    this.emit('wave', wave, cfg);
  }

  rollType(cfg) {
    let roll = Math.random() * cfg.spawnTotal;
    for (const [key, weight] of cfg.spawnTable) {
      roll -= weight;
      if (roll <= 0) {
        return key;
      }
    }
    return cfg.spawnTable[cfg.spawnTable.length - 1][0];
  }

  /**
   * Finds a point on the spawn ring inside the arena, starting at `angle` and
   * fanning out if that one is outside. Writes it to `this.spawnPoint`.
   */
  findSpawnPoint(target, angle) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = attempt === 0 ? angle : Math.random() * TAU;
      const x = target.x + Math.cos(a) * this.spawnRadius;
      const y = target.y + Math.sin(a) * this.spawnRadius;
      if (this.insideArena(x, y)) {
        this.spawnPoint.x = x;
        this.spawnPoint.y = y;
        return true;
      }
    }
    return false;
  }

  insideArena(x, y) {
    const b = this.bounds;
    return x > b.x + 24 && x < b.right - 24 && y > b.y + 24 && y < b.bottom - 24;
  }

  spawn(typeKey, x, y) {
    const e = this.pool.acquire();
    if (!e) {
      return null;
    }
    const type = ENEMY_TYPES[typeKey];
    const cfg = this.config;

    e.uid = this.nextUid++;
    e.alive = true;
    e.type = type;
    e.typeKey = typeKey;
    e.x = x;
    e.y = y;
    e.vx = 0;
    e.vy = 0;
    e.kbx = 0;
    e.kby = 0;
    e.maxHp = type.hp * cfg.hpMultiplier;
    e.hp = e.maxHp;
    e.speed = type.speed * cfg.speedMultiplier * Phaser.Math.FloatBetween(0.9, 1.1);
    e.radius = type.radius;
    e.damage = type.damage * cfg.damageMultiplier;
    e.xp = type.xp;
    e.flash = 0;
    e.phase = Math.random() * TAU;

    e.sprite
      .setTexture(type.texture)
      .setPosition(x, y)
      .setRotation(0)
      .clearTint()
      .setVisible(true)
      .setActive(true);
    return e;
  }

  // ---------------------------------------------------------------- movement

  moveEnemies(dt, target) {
    const records = this.pool.records;
    const live = this.pool.live;
    const nearby = this.nearby;
    const b = this.bounds;
    const px = target.x;
    const py = target.y;
    const pr = target.radius;
    const separation = Math.min(1, SEPARATION * dt);
    const damping = Math.exp(-KNOCKBACK_DAMPING * dt);
    const time = this.elapsed;
    let contactDps = 0;

    for (let i = 0; i < live.length; i++) {
      const e = live[i];
      const sprite = e.sprite;

      let dx = px - e.x;
      let dy = py - e.y;
      let distSq = dx * dx + dy * dy;

      // The player outran this one: bring it back in on the spawn ring
      // rather than letting it trail behind forever.
      if (distSq > this.despawnDistSq && this.findSpawnPoint(target, Math.random() * TAU)) {
        e.x = this.spawnPoint.x;
        e.y = this.spawnPoint.y;
        dx = px - e.x;
        dy = py - e.y;
        distSq = dx * dx + dy * dy;
      }

      // Seek the player
      const dist = Math.sqrt(distSq) || 1;
      e.vx = (dx / dist) * e.speed;
      e.vy = (dy / dist) * e.speed;

      // Soft separation from neighbours in the surrounding cells
      let sx = 0;
      let sy = 0;
      const count = this.gatherNearby(e.x, e.y);
      for (let k = 0; k < count; k++) {
        const other = records[nearby[k]];
        if (other === e || !other.alive) {
          continue;
        }
        const ox = e.x - other.x;
        const oy = e.y - other.y;
        const reach = e.radius + other.radius;
        const odSq = ox * ox + oy * oy;
        if (odSq < reach * reach) {
          if (odSq > 0.0001) {
            const od = Math.sqrt(odSq);
            const push = (reach - od) / od * 0.5;
            sx += ox * push;
            sy += oy * push;
          } else {
            sx += Math.random() - 0.5;
            sy += Math.random() - 0.5;
          }
        }
      }

      e.kbx *= damping;
      e.kby *= damping;
      e.x += (e.vx + e.kbx) * dt + sx * separation;
      e.y += (e.vy + e.kby) * dt + sy * separation;

      // Enemies crowd around the player instead of stacking on top of them;
      // every one in contact deals its damage per second.
      const cx = e.x - px;
      const cy = e.y - py;
      const touch = pr + e.radius;
      const cdSq = cx * cx + cy * cy;
      if (cdSq < touch * touch) {
        contactDps += e.damage;
        const cd = Math.sqrt(cdSq) || 1;
        e.x = px + (cx / cd) * touch;
        e.y = py + (cy / cd) * touch;
      }

      e.x = Phaser.Math.Clamp(e.x, b.x + e.radius, b.right - e.radius);
      e.y = Phaser.Math.Clamp(e.y, b.y + e.radius, b.bottom - e.radius);

      sprite.x = e.x;
      sprite.y = e.y;
      sprite.flipX = e.vx < 0;
      sprite.rotation = Math.sin(time * e.type.swayFreq + e.phase) * e.type.sway;

      if (e.flash > 0) {
        e.flash -= dt;
        if (e.flash <= 0) {
          sprite.clearTint();
        }
      }
    }

    return contactDps;
  }

  // ------------------------------------------------------------ spatial hash

  cellX(x) {
    return Phaser.Math.Clamp(Math.floor((x - this.bounds.x) / CELL_SIZE), 0, this.cols - 1);
  }

  cellY(y) {
    return Phaser.Math.Clamp(Math.floor((y - this.bounds.y) / CELL_SIZE), 0, this.rows - 1);
  }

  rebuildGrid() {
    const head = this.cellHead;
    const next = this.cellNext;
    const live = this.pool.live;
    head.fill(-1);
    for (let i = 0; i < live.length; i++) {
      const e = live[i];
      const cell = this.cellY(e.y) * this.cols + this.cellX(e.x);
      next[e.poolId] = head[cell];
      head[cell] = e.poolId;
    }
  }

  /**
   * Copies the ids of every enemy in the 3x3 block of cells around (x, y) into
   * `this.nearby` and returns how many there are. Ids can belong to enemies
   * that died since the last rebuild, so callers check `alive`.
   */
  gatherNearby(x, y) {
    const head = this.cellHead;
    const next = this.cellNext;
    const out = this.nearby;
    const cx = this.cellX(x);
    const cy = this.cellY(y);
    const x0 = Math.max(0, cx - 1);
    const x1 = Math.min(this.cols - 1, cx + 1);
    const y0 = Math.max(0, cy - 1);
    const y1 = Math.min(this.rows - 1, cy + 1);
    let count = 0;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (let id = head[gy * this.cols + gx]; id !== -1; id = next[id]) {
          out[count++] = id;
        }
      }
    }
    return count;
  }

  /**
   * Nearest living enemy within `maxDist` of (x, y), or null. Searches square
   * rings of cells outwards and stops once no unvisited cell can be closer
   * than the best match so far.
   */
  findNearest(x, y, maxDist) {
    const head = this.cellHead;
    const next = this.cellNext;
    const records = this.pool.records;
    const cols = this.cols;
    const rows = this.rows;
    const cx = this.cellX(x);
    const cy = this.cellY(y);
    const maxRing = Math.ceil(maxDist / CELL_SIZE) + 1;
    let best = null;
    let bestDistSq = maxDist * maxDist;

    for (let ring = 0; ring <= maxRing; ring++) {
      // Everything in this ring is at least (ring - 1) cells away.
      const minDist = (ring - 1) * CELL_SIZE;
      if (minDist > 0 && minDist * minDist > bestDistSq) {
        break;
      }
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= rows) {
          continue;
        }
        // Top and bottom rows of the ring are walked in full; in between,
        // only the left and right cells belong to it.
        const edgeRow = gy === cy - ring || gy === cy + ring;
        const step = edgeRow ? 1 : 2 * ring;
        for (let gx = cx - ring; gx <= cx + ring; gx += step) {
          if (gx < 0 || gx >= cols) {
            continue;
          }
          for (let id = head[gy * cols + gx]; id !== -1; id = next[id]) {
            const e = records[id];
            if (!e.alive) {
              continue;
            }
            const dx = e.x - x;
            const dy = e.y - y;
            const dSq = dx * dx + dy * dy;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              best = e;
            }
          }
        }
      }
    }
    return best;
  }

  /**
   * First living enemy overlapping the circle (x, y, radius) whose uid is not
   * in `exclude` (the enemies a piercing bullet has already hit), or null.
   */
  findOverlap(x, y, radius, exclude) {
    const records = this.pool.records;
    const nearby = this.nearby;
    const count = this.gatherNearby(x, y);
    for (let k = 0; k < count; k++) {
      const e = records[nearby[k]];
      if (!e.alive) {
        continue;
      }
      const dx = e.x - x;
      const dy = e.y - y;
      const reach = e.radius + radius;
      if (dx * dx + dy * dy < reach * reach && !exclude.includes(e.uid)) {
        return e;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ combat

  /**
   * Applies a hit pushing the enemy along (dirX, dirY), a unit vector.
   * @returns {boolean} true if the hit killed it
   */
  damage(e, amount, dirX, dirY) {
    if (!e.alive) {
      return false;
    }
    e.hp -= amount;
    const impulse = KNOCKBACK * e.type.knockback;
    e.kbx += dirX * impulse;
    e.kby += dirY * impulse;
    e.sprite.setTintFill(0xffffff);
    e.flash = HIT_FLASH;

    if (e.hp <= 0) {
      this.kill(e);
      return true;
    }
    return false;
  }

  kill(e) {
    e.alive = false;
    e.sprite.setVisible(false).setActive(false);
    this.pool.release(e);
    this.kills++;
    this.gems.drop(e.x, e.y, e.xp);
    this.deathFx[e.typeKey].explode(e.typeKey === 'elite' ? 40 : 7, e.x, e.y);
    this.emit('kill', e);
  }
}

// ------------------------------------------------------------------- XP gems

const GEM_TIERS = [
  { min: 20, texture: 'gem-red', scale: 1.3 },
  { min: 5, texture: 'gem-green', scale: 1.1 },
  { min: 0, texture: 'gem-blue', scale: 1 },
];

const GEM_KICK = -160; // gems hop away briefly when the magnet first grabs them (px/s)
const GEM_ACCEL = 2000; // px/s^2 while being pulled in
const GEM_MAX_SPEED = 950; // px/s

/**
 * The XP gems enemies drop. Gems inside the player's pickup radius get pulled
 * in and are collected on contact. When the pool is full, new XP is folded
 * into a gem already on the ground (upgrading its colour) so none is lost.
 */
export class XPGemPool {
  constructor(scene, layer, capacity) {
    this.time = 0;
    this.pool = new Pool(capacity, () => {
      const sprite = new Phaser.GameObjects.Image(scene, 0, 0, 'gem-blue');
      sprite.setVisible(false).setActive(false);
      layer.add(sprite);
      return { sprite, x: 0, y: 0, value: 0, magnet: false, speed: 0, phase: 0 };
    });
  }

  get size() {
    return this.pool.size;
  }

  drop(x, y, value) {
    const gem = this.pool.acquire();
    if (!gem) {
      const live = this.pool.live;
      const host = live[Math.floor(Math.random() * live.length)];
      host.value += value;
      this.applyTier(host);
      return;
    }
    gem.x = x + Phaser.Math.FloatBetween(-6, 6);
    gem.y = y + Phaser.Math.FloatBetween(-6, 6);
    gem.value = value;
    gem.magnet = false;
    gem.speed = 0;
    gem.phase = Math.random() * TAU;
    gem.sprite.setPosition(gem.x, gem.y).setVisible(true).setActive(true);
    this.applyTier(gem);
  }

  applyTier(gem) {
    const tier = GEM_TIERS.find((t) => gem.value >= t.min);
    gem.sprite.setTexture(tier.texture).setScale(tier.scale);
  }

  /**
   * Pulls gems towards `player` and collects the ones it touches.
   * @returns {number} XP collected this frame
   */
  update(dt, player) {
    this.time += dt;
    const live = this.pool.live;
    const pickupSq = player.pickupRadius * player.pickupRadius;
    const collect = player.radius + 6;
    const collectSq = collect * collect;
    let xp = 0;

    // Backwards, because collecting releases the gem being visited.
    for (let i = live.length - 1; i >= 0; i--) {
      const gem = live[i];
      const dx = player.x - gem.x;
      const dy = player.y - gem.y;
      const distSq = dx * dx + dy * dy;

      if (distSq < collectSq) {
        xp += gem.value;
        gem.sprite.setVisible(false).setActive(false);
        this.pool.release(gem);
        continue;
      }

      if (!gem.magnet && distSq < pickupSq) {
        gem.magnet = true;
        gem.speed = GEM_KICK;
      }
      if (gem.magnet) {
        gem.speed = Math.min(GEM_MAX_SPEED, gem.speed + GEM_ACCEL * dt);
        const dist = Math.sqrt(distSq);
        const step = Math.min(dist, gem.speed * dt);
        gem.x += (dx / dist) * step;
        gem.y += (dy / dist) * step;
      }

      gem.sprite.x = gem.x;
      gem.sprite.y = gem.y + Math.sin(this.time * 4 + gem.phase) * 2;
    }

    return xp;
  }
}
