import { Pool } from './EnemyManager.js';

// The player: keyboard / touch movement, an auto-firing weapon that targets
// the nearest enemy inside its radius, pooled projectiles, XP and levelling.

const PLAYER = {
  radius: 16,
  speed: 210, // px/s
  maxHp: 100,
  pickupRadius: 110, // gems inside this distance get pulled in
  healOnLevelUp: 12,
};

const WEAPON = {
  baseRadius: 230, // targeting and projectile range at level 1 (px)
  radiusPerLevel: 22,
  maxRadius: 820,
  baseDamage: 10,
  damagePerLevel: 1.5,
  baseInterval: 0.52, // seconds between volleys at level 1
  intervalDecay: 0.95, // multiplier per level
  minInterval: 0.14,
  maxProjectiles: 5,
  projectileSpeed: 560, // px/s
  projectileRadius: 5,
  spread: 0.14, // radians between the projectiles of one volley
  poolSize: 256,
};

const JOYSTICK_RADIUS = 56; // px the thumb can travel from the base
const JOYSTICK_DEAD_ZONE = 0.15;

/**
 * Weapon stats at a given level. The radius is the headline upgrade and grows
 * every level; damage and fire rate creep up alongside it, every 4th level adds
 * a projectile and every 6th lets projectiles pierce one more enemy.
 */
export function weaponStatsForLevel(level) {
  const l = level - 1;
  return {
    radius: Math.min(WEAPON.maxRadius, WEAPON.baseRadius + l * WEAPON.radiusPerLevel),
    damage: WEAPON.baseDamage + l * WEAPON.damagePerLevel,
    interval: Math.max(WEAPON.minInterval, WEAPON.baseInterval * Math.pow(WEAPON.intervalDecay, l)),
    projectiles: Math.min(WEAPON.maxProjectiles, 1 + Math.floor(level / 4)),
    pierce: 1 + Math.floor(level / 6),
  };
}

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level) {
  return Math.round(5 + level * 5 + level * level * 0.75);
}

export default class Player extends Phaser.GameObjects.Image {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x
   * @param {number} y
   * @param {object} options
   * @param {Phaser.Geom.Rectangle} options.bounds arena the player is kept inside
   * @param {import('./EnemyManager.js').default} options.enemies auto-aim targets
   * @param {object} options.layers render layers (`world`, `projectiles`, `actors`, `hud`)
   */
  constructor(scene, x, y, { bounds, enemies, layers }) {
    super(scene, x, y, 'player');
    layers.actors.add(this);

    this.bounds = bounds;
    this.enemies = enemies;

    this.radius = PLAYER.radius;
    this.speed = PLAYER.speed;
    this.pickupRadius = PLAYER.pickupRadius;
    this.maxHp = PLAYER.maxHp;
    this.hp = this.maxHp;
    this.dead = false;

    this.level = 1;
    this.xp = 0;
    this.xpToNext = xpForLevel(1);
    this.weapon = weaponStatsForLevel(1);
    this.cooldown = 0;

    this.moveDir = new Phaser.Math.Vector2();
    this.walkTime = 0;
    this.hurtFlash = 0;
    this.hurtCooldown = 0;

    this.createProjectiles(scene, layers.projectiles);
    this.createRangeRing(scene, layers.world);
    this.createHealthBar(scene, layers.actors);
    this.createControls(scene, layers.hud);
    this.syncAttachments();
  }

  get projectileCount() {
    return this.bullets.size;
  }

  // ------------------------------------------------------------------ set-up

  createProjectiles(scene, layer) {
    this.bullets = new Pool(WEAPON.poolSize, () => {
      const sprite = new Phaser.GameObjects.Image(scene, 0, 0, 'bullet');
      sprite.setVisible(false).setActive(false).setBlendMode(Phaser.BlendModes.ADD);
      layer.add(sprite);
      return { sprite, x: 0, y: 0, vx: 0, vy: 0, traveled: 0, range: 0, damage: 0, pierce: 1, hits: [] };
    });
  }

  /** Faint circle showing the weapon radius; it swells on every level-up. */
  createRangeRing(scene, layer) {
    this.ring = { radius: this.weapon.radius };
    this.rangeRing = new Phaser.GameObjects.Graphics(scene);
    layer.add(this.rangeRing);
    this.drawRangeRing();
  }

  drawRangeRing() {
    const g = this.rangeRing;
    g.clear();
    g.fillStyle(0x7fdbff, 0.035);
    g.fillCircle(0, 0, this.ring.radius);
    g.lineStyle(2, 0x7fdbff, 0.22);
    g.strokeCircle(0, 0, this.ring.radius);
  }

  createHealthBar(scene, layer) {
    this.hpBack = new Phaser.GameObjects.Rectangle(scene, 0, 0, 40, 7, 0x000000, 0.6);
    this.hpFill = new Phaser.GameObjects.Rectangle(scene, 0, 0, 38, 5, 0xe63946);
    this.hpFill.setOrigin(0, 0.5);
    layer.add([this.hpBack, this.hpFill]);
  }

  createControls(scene, layer) {
    this.keys = scene.input.keyboard.addKeys({
      up: 'W', down: 'S', left: 'A', right: 'D',
      up2: 'UP', down2: 'DOWN', left2: 'LEFT', right2: 'RIGHT',
    });

    // Floating virtual joystick: press anywhere and drag. Works with a mouse too.
    this.stick = { pointerId: -1, x: 0, y: 0 };
    this.stickBase = new Phaser.GameObjects.Image(scene, 0, 0, 'joy-base');
    this.stickThumb = new Phaser.GameObjects.Image(scene, 0, 0, 'joy-thumb');
    for (const part of [this.stickBase, this.stickThumb]) {
      part.setScrollFactor(0).setVisible(false);
    }
    layer.add([this.stickBase, this.stickThumb]);

    scene.input.on('pointerdown', this.onPointerDown, this);
    scene.input.on('pointermove', this.onPointerMove, this);
    scene.input.on('pointerup', this.onPointerUp, this);
    scene.input.on('pointerupoutside', this.onPointerUp, this);
  }

  // ------------------------------------------------------------------- input

  onPointerDown(pointer) {
    if (this.stick.pointerId !== -1) {
      return;
    }
    this.stick.pointerId = pointer.id;
    this.stick.x = 0;
    this.stick.y = 0;
    this.stickBase.setPosition(pointer.x, pointer.y).setVisible(true);
    this.stickThumb.setPosition(pointer.x, pointer.y).setVisible(true);
  }

  onPointerMove(pointer) {
    if (pointer.id !== this.stick.pointerId) {
      return;
    }
    let dx = pointer.x - this.stickBase.x;
    let dy = pointer.y - this.stickBase.y;
    const len = Math.hypot(dx, dy);
    if (len > JOYSTICK_RADIUS) {
      dx = (dx / len) * JOYSTICK_RADIUS;
      dy = (dy / len) * JOYSTICK_RADIUS;
    }
    this.stick.x = dx;
    this.stick.y = dy;
    this.stickThumb.setPosition(this.stickBase.x + dx, this.stickBase.y + dy);
  }

  onPointerUp(pointer) {
    if (pointer.id === this.stick.pointerId) {
      this.releaseStick();
    }
  }

  releaseStick() {
    this.stick.pointerId = -1;
    this.stick.x = 0;
    this.stick.y = 0;
    this.stickBase.setVisible(false);
    this.stickThumb.setVisible(false);
  }

  /** Movement intent from keys and joystick, with length at most 1. */
  readDirection() {
    const k = this.keys;
    let x = (k.right.isDown || k.right2.isDown ? 1 : 0) - (k.left.isDown || k.left2.isDown ? 1 : 0);
    let y = (k.down.isDown || k.down2.isDown ? 1 : 0) - (k.up.isDown || k.up2.isDown ? 1 : 0);

    if (this.stick.pointerId !== -1) {
      const sx = this.stick.x / JOYSTICK_RADIUS;
      const sy = this.stick.y / JOYSTICK_RADIUS;
      const deflection = Math.hypot(sx, sy);
      if (deflection > JOYSTICK_DEAD_ZONE) {
        // Full speed from 60% deflection, so thumbs don't have to stretch.
        const strength = Math.min(1, deflection / 0.6);
        x += (sx / deflection) * strength;
        y += (sy / deflection) * strength;
      }
    }

    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return this.moveDir.set(x, y);
  }

  // ---------------------------------------------------------------- per frame

  updateMovement(dt) {
    const dir = this.readDirection();
    const b = this.bounds;
    const r = this.radius;

    if (dir.x !== 0 || dir.y !== 0) {
      this.x = Phaser.Math.Clamp(this.x + dir.x * this.speed * dt, b.x + r, b.right - r);
      this.y = Phaser.Math.Clamp(this.y + dir.y * this.speed * dt, b.y + r, b.bottom - r);
      if (dir.x < -0.05) {
        this.setFlipX(true);
      } else if (dir.x > 0.05) {
        this.setFlipX(false);
      }
      // A little squash and stretch sells the walk cycle.
      this.walkTime += dt;
      const bob = Math.sin(this.walkTime * 16) * 0.06;
      this.setScale(1 - bob, 1 + bob);
    } else {
      this.setScale(1);
    }

    if (this.hurtFlash > 0) {
      this.hurtFlash -= dt;
      if (this.hurtFlash <= 0) {
        this.clearTint();
      }
    }
    this.hurtCooldown -= dt;

    this.syncAttachments();
  }

  syncAttachments() {
    this.rangeRing.setPosition(this.x, this.y);
    this.hpBack.setPosition(this.x, this.y + 27);
    this.hpFill.setPosition(this.x - 19, this.y + 27);
    this.hpFill.scaleX = this.hp / this.maxHp;
  }

  updateWeapon(dt) {
    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      const target = this.enemies.findNearest(this.x, this.y, this.weapon.radius);
      if (target) {
        this.fireAt(target);
        this.cooldown = Math.max(0, this.cooldown + this.weapon.interval);
      } else {
        // Stay ready, so the first enemy to step inside the radius is shot at once.
        this.cooldown = 0;
      }
    }
    this.updateProjectiles(dt);
  }

  /** Fires a volley at where `target` will be when the projectiles arrive. */
  fireAt(target) {
    const w = this.weapon;
    const travelTime = Math.hypot(target.x - this.x, target.y - this.y) / WEAPON.projectileSpeed;
    const aimX = target.x + target.vx * travelTime;
    const aimY = target.y + target.vy * travelTime;
    const heading = Math.atan2(aimY - this.y, aimX - this.x);

    for (let i = 0; i < w.projectiles; i++) {
      this.spawnProjectile(heading + (i - (w.projectiles - 1) / 2) * WEAPON.spread);
    }
  }

  spawnProjectile(angle) {
    const p = this.bullets.acquire();
    if (!p) {
      return;
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    p.vx = cos * WEAPON.projectileSpeed;
    p.vy = sin * WEAPON.projectileSpeed;
    p.x = this.x + cos * 14;
    p.y = this.y + sin * 14;
    p.traveled = 0;
    // A little past the radius, so shots still connect with targets moving away.
    p.range = this.weapon.radius * 1.15;
    p.damage = this.weapon.damage;
    p.pierce = this.weapon.pierce;
    p.hits.length = 0;
    p.sprite.setPosition(p.x, p.y).setRotation(angle).setAlpha(1).setVisible(true).setActive(true);
  }

  updateProjectiles(dt) {
    const live = this.bullets.live;
    const step = WEAPON.projectileSpeed * dt;

    // Backwards, because spent projectiles are released mid-loop.
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.traveled += step;

      let spent = p.traveled >= p.range;
      if (!spent) {
        const hit = this.enemies.findOverlap(p.x, p.y, WEAPON.projectileRadius, p.hits);
        if (hit) {
          this.enemies.damage(hit, p.damage, p.vx / WEAPON.projectileSpeed, p.vy / WEAPON.projectileSpeed);
          p.hits.push(hit.uid);
          spent = p.hits.length >= p.pierce;
        }
      }

      if (spent) {
        p.sprite.setVisible(false).setActive(false);
        this.bullets.release(p);
      } else {
        p.sprite.x = p.x;
        p.sprite.y = p.y;
        p.sprite.alpha = Math.min(1, (p.range - p.traveled) / 80);
      }
    }
  }

  // ------------------------------------------------------------- progression

  addXp(amount) {
    if (this.dead || amount <= 0) {
      return;
    }
    this.xp += amount;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.levelUp();
    }
  }

  levelUp() {
    const previous = this.weapon;
    this.level++;
    this.xpToNext = xpForLevel(this.level);
    this.weapon = weaponStatsForLevel(this.level);
    this.hp = Math.min(this.maxHp, this.hp + PLAYER.healOnLevelUp);

    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.ring);
    tweens.add({
      targets: this.ring,
      radius: this.weapon.radius,
      duration: 500,
      ease: 'Back.easeOut',
      onUpdate: () => this.drawRangeRing(),
    });

    this.emit('levelup', this.level, previous, this.weapon);
  }

  takeDamage(amount) {
    if (this.dead || amount <= 0) {
      return;
    }
    this.hp = Math.max(0, this.hp - amount);

    // Contact damage arrives every frame, so the red flash is rate-limited
    // into a flicker instead of a solid tint.
    if (this.hurtCooldown <= 0) {
      this.setTint(0xff5c5c);
      this.hurtFlash = 0.1;
      this.hurtCooldown = 0.22;
    }

    if (this.hp <= 0) {
      this.dead = true;
      this.releaseStick();
      this.syncAttachments();
      this.emit('died');
    }
  }
}
