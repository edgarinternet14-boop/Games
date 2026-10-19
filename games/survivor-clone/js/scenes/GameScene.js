import Player from '../entities/Player.js';
import EnemyManager from '../entities/EnemyManager.js';
import { GROUND_TILE, GROUND_VARIANTS } from './BootScene.js';

// GameScene builds the arena, wires the player to the enemy manager, runs the
// frame loop in a fixed order, and draws the HUD and the title / pause /
// game-over screens.

const ARENA_SIZE = GROUND_TILE * 32; // 4096 px square
const MAX_FRAME_TIME = 0.05; // seconds; longer frames are clamped so nothing tunnels after a hitch
const BEST_TIME_KEY = 'survivor-clone.best-time';
const FONT = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Render order, back to front. Layers draw their children in insertion order,
// so the hundreds of pooled sprites never need depth sorting.
const LAYERS = ['world', 'loot', 'enemies', 'projectiles', 'actors', 'fx', 'hud'];

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  create() {
    this.state = 'ready'; // ready -> playing <-> paused -> over
    this.bounds = new Phaser.Geom.Rectangle(0, 0, ARENA_SIZE, ARENA_SIZE);
    this.statsTimer = 0;
    this.restartAllowedAt = 0;

    this.layers = {};
    LAYERS.forEach((name, depth) => {
      this.layers[name] = this.add.layer().setDepth(depth);
    });

    this.createArena();

    this.enemies = new EnemyManager(this, { bounds: this.bounds, layers: this.layers });
    this.player = new Player(this, this.bounds.centerX, this.bounds.centerY, {
      bounds: this.bounds,
      enemies: this.enemies,
      layers: this.layers,
    });

    const cam = this.cameras.main;
    cam.setBounds(this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height);
    cam.centerOn(this.player.x, this.player.y);
    cam.startFollow(this.player, false, 0.15, 0.15);

    this.createHud();
    this.createOverlay();
    this.bindEvents();
    this.layout();
    this.showTitle();
  }

  update(time, delta) {
    if (this.state !== 'playing') {
      return;
    }
    const dt = Math.min(delta / 1000, MAX_FRAME_TIME);
    const player = this.player;

    // Order matters: enemies chase where the player is now, and the weapon
    // aims with the spatial hash the enemy update has just rebuilt.
    player.updateMovement(dt);
    const contactDps = this.enemies.update(dt, player);
    player.takeDamage(contactDps * dt);
    if (this.state !== 'playing') {
      return; // that hit was fatal
    }
    player.updateWeapon(dt);
    player.addXp(this.enemies.gems.update(dt, player));

    this.updateHud(dt);
  }

  // ------------------------------------------------------------------ arena

  createArena() {
    const tiles = ARENA_SIZE / GROUND_TILE;
    const data = [];
    for (let y = 0; y < tiles; y++) {
      const row = [];
      for (let x = 0; x < tiles; x++) {
        // Mostly plain grass, with the busier variants sprinkled in.
        const roll = Math.random();
        row.push(roll < 0.55 ? 0 : roll < 0.8 ? 1 : roll < 0.93 ? 2 : GROUND_VARIANTS - 1);
      }
      data.push(row);
    }

    const map = this.make.tilemap({ data, tileWidth: GROUND_TILE, tileHeight: GROUND_TILE });
    const tileset = map.addTilesetImage('ground', 'ground', GROUND_TILE, GROUND_TILE, 0, 0);
    const ground = map.createLayer(0, tileset, 0, 0);
    ground.forEachTile((tile) => {
      tile.flipX = Math.random() < 0.5;
    });
    this.layers.world.add(ground);

    const wall = new Phaser.GameObjects.Graphics(this);
    wall.lineStyle(10, 0x9d0208, 0.85);
    wall.strokeRect(5, 5, ARENA_SIZE - 10, ARENA_SIZE - 10);
    wall.lineStyle(2, 0xff6b6b, 0.7);
    wall.strokeRect(12, 12, ARENA_SIZE - 24, ARENA_SIZE - 24);
    this.layers.world.add(wall);
  }

  // -------------------------------------------------------------------- HUD

  makeText(size, color = '#e8ecf2', extra = {}) {
    const text = new Phaser.GameObjects.Text(this, 0, 0, '', {
      fontFamily: FONT,
      fontSize: `${size}px`,
      fontStyle: 'bold',
      color,
      stroke: '#05070a',
      strokeThickness: Math.max(3, Math.round(size / 7)),
      ...extra,
    });
    text.setScrollFactor(0);
    this.layers.hud.add(text);
    return text;
  }

  makeRect(color, alpha = 1) {
    const rect = new Phaser.GameObjects.Rectangle(this, 0, 0, 1, 1, color, alpha);
    rect.setOrigin(0).setScrollFactor(0);
    this.layers.hud.add(rect);
    return rect;
  }

  createHud() {
    this.xpBack = this.makeRect(0x05070a, 0.75);
    this.xpFill = this.makeRect(0x4cc9f0);
    this.levelText = this.makeText(14).setOrigin(1, 0);
    this.timerText = this.makeText(30).setOrigin(0.5, 0);
    this.waveText = this.makeText(15, '#ffd166').setOrigin(0.5, 0);
    this.killText = this.makeText(16).setOrigin(0, 0);
    this.statsText = this.makeText(12, '#9aa5b1').setOrigin(0, 1);

    this.bannerTitle = this.makeText(44).setOrigin(0.5).setAlpha(0);
    this.bannerSub = this.makeText(18, '#ffd166').setOrigin(0.5).setAlpha(0);

    // Level-up callout that floats above the player in world space.
    this.levelCallout = new Phaser.GameObjects.Text(this, 0, 0, '', {
      fontFamily: FONT,
      fontSize: '22px',
      fontStyle: 'bold',
      color: '#7fdbff',
      stroke: '#05070a',
      strokeThickness: 4,
      align: 'center',
    });
    this.levelCallout.setOrigin(0.5, 1).setVisible(false);
    this.layers.fx.add(this.levelCallout);

    this.levelFx = this.add.particles(0, 0, 'spark', {
      emitting: false,
      lifespan: 600,
      speed: { min: 140, max: 280 },
      scale: { start: 1.4, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [0x7fdbff, 0x4cc9f0, 0xffffff],
      blendMode: 'ADD',
    });
    this.layers.fx.add(this.levelFx);

    this.updateHud(0);
  }

  createOverlay() {
    this.overlayShade = this.makeRect(0x05070a, 0.72);
    this.overlayTitle = this.makeText(56, '#ffffff').setOrigin(0.5, 0);
    this.overlayBody = this.makeText(18, '#cfd6df', { align: 'center', lineSpacing: 8 }).setOrigin(0.5, 0);
    this.overlayHint = this.makeText(20, '#ffd166').setOrigin(0.5, 0);
    this.tweens.add({
      targets: this.overlayHint,
      alpha: 0.35,
      duration: 750,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  updateHud(dt) {
    const p = this.player;
    const e = this.enemies;

    this.xpFill.scaleX = Math.min(1, p.xp / p.xpToNext);
    this.levelText.setText(`LV ${p.level}`);
    this.timerText.setText(formatTime(e.elapsed));
    this.waveText.setText(`WAVE ${Math.max(1, e.wave)}`);
    this.killText.setText(`KILLS ${e.kills}`);

    // The stats line exists to show the pools at work; four updates a second is plenty.
    this.statsTimer -= dt;
    if (this.statsTimer <= 0) {
      this.statsTimer = 0.25;
      const fps = Math.round(this.game.loop.actualFps);
      this.statsText.setText(
        `${e.alive}/${e.capacity} enemies · ${p.projectileCount} shots · ${e.gems.size} gems · ${fps} fps`,
      );
    }
  }

  /** Repositions everything pinned to the screen; runs on every resize. */
  layout() {
    const { width, height } = this.scale;
    const cx = width / 2;

    this.xpBack.setSize(width, 16);
    this.xpFill.setSize(width, 16);
    this.levelText.setPosition(width - 10, 0);
    this.timerText.setPosition(cx, 22);
    this.waveText.setPosition(cx, 60);
    this.killText.setPosition(12, 24);
    this.statsText.setPosition(10, height - 8);

    this.bannerTitle.setPosition(cx, height * 0.26);
    this.bannerSub.setPosition(cx, height * 0.26 + 40);

    this.overlayShade.setSize(width, height);
    this.overlayBody.setWordWrapWidth(Math.min(width - 40, 680));
    this.layoutOverlay();
  }

  /** Stacks the overlay's title, body and hint, centred as a block. */
  layoutOverlay() {
    const { width, height } = this.scale;
    const parts = [this.overlayTitle, this.overlayBody, this.overlayHint];
    const gap = Math.min(28, height * 0.04);
    const total = parts.reduce((sum, part) => sum + part.height, 0) + gap * (parts.length - 1);
    let y = Math.max(8, (height - total) / 2);
    for (const part of parts) {
      part.setPosition(width / 2, y);
      y += part.height + gap;
    }
  }

  /** Big centred announcement that fades in, holds, and fades out. */
  showBanner(title, subtitle, color) {
    const parts = [this.bannerTitle, this.bannerSub];
    this.tweens.killTweensOf(parts);
    this.bannerTitle.setText(title).setColor(color);
    this.bannerSub.setText(subtitle);
    for (const part of parts) {
      part.setAlpha(0).setScale(0.85);
    }
    this.tweens.add({
      targets: parts,
      alpha: 1,
      scale: 1,
      duration: 260,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({ targets: parts, alpha: 0, delay: 1500, duration: 500 });
      },
    });
  }

  // ----------------------------------------------------------------- events

  bindEvents() {
    const keyboard = this.input.keyboard;
    keyboard.on('keydown-P', this.togglePause, this);
    keyboard.on('keydown-ESC', this.togglePause, this);
    keyboard.on('keydown-SPACE', this.advance, this);
    keyboard.on('keydown-ENTER', this.advance, this);
    keyboard.on('keydown-R', () => {
      if (this.state === 'over') {
        this.advance();
      }
    });
    this.input.on('pointerdown', this.advance, this);

    this.player.on('levelup', this.onLevelUp, this);
    this.player.on('died', this.onPlayerDied, this);
    this.enemies.on('wave', this.onWave, this);

    // These emitters outlive the scene, so detach from them when it shuts down.
    this.scale.on('resize', this.layout, this);
    this.game.events.on(Phaser.Core.Events.BLUR, this.onBlur, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', this.layout, this);
      this.game.events.off(Phaser.Core.Events.BLUR, this.onBlur, this);
      this.enemies.removeAllListeners();
    });
  }

  /** Space / Enter / tap: start, resume or restart, depending on the state. */
  advance() {
    if (this.state === 'ready') {
      this.state = 'playing';
      this.hideOverlay();
    } else if (this.state === 'paused') {
      this.resume();
    } else if (this.state === 'over' && this.time.now >= this.restartAllowedAt) {
      this.scene.restart();
    }
  }

  togglePause() {
    if (this.state === 'playing') {
      this.pause();
    } else if (this.state === 'paused') {
      this.resume();
    }
  }

  pause() {
    this.state = 'paused';
    this.player.releaseStick();
    this.showOverlay('PAUSED', 'Take a breather. The horde will wait.', 'Press P / Esc or tap to resume');
  }

  resume() {
    this.state = 'playing';
    this.hideOverlay();
  }

  onBlur() {
    if (this.state === 'playing') {
      this.pause();
    }
  }

  onWave(wave, cfg) {
    let subtitle = 'They grow stronger...';
    if (wave === 1) {
      subtitle = 'Survive the horde';
    } else if (cfg.elites > 0) {
      subtitle = cfg.elites === 1 ? 'An elite approaches!' : `${cfg.elites} elites approach!`;
    }
    this.showBanner(`WAVE ${wave}`, subtitle, cfg.elites > 0 ? '#ffd166' : '#ffffff');
  }

  onLevelUp(level, previous, next) {
    const perks = [`Range ${Math.round(next.radius)}`];
    if (next.projectiles > previous.projectiles) {
      perks.push('+1 projectile');
    }
    if (next.pierce > previous.pierce) {
      perks.push('+1 pierce');
    }

    const p = this.player;
    this.levelFx.explode(28, p.x, p.y);

    const callout = this.levelCallout;
    this.tweens.killTweensOf(callout);
    callout
      .setText(`LEVEL ${level}!\n${perks.join(' · ')}`)
      .setPosition(p.x, p.y - 34)
      .setAlpha(1)
      .setVisible(true);
    this.tweens.add({
      targets: callout,
      y: p.y - 80,
      alpha: 0,
      delay: 500,
      duration: 900,
      ease: 'Quad.easeIn',
      onComplete: () => callout.setVisible(false),
    });
  }

  onPlayerDied() {
    this.state = 'over';
    this.restartAllowedAt = this.time.now + 900;

    const survived = this.enemies.elapsed;
    const best = Math.max(survived, readBestTime());
    writeBestTime(best);

    this.cameras.main.shake(300, 0.012);
    this.tweens.add({ targets: this.player, alpha: 0.3, angle: 90, duration: 400 });

    const p = this.player;
    this.showOverlay(
      'GAME OVER',
      `You survived ${formatTime(survived)}\n` +
        `Level ${p.level}  ·  ${this.enemies.kills} kills  ·  wave ${this.enemies.wave}\n` +
        `Best: ${formatTime(best)}${survived >= best ? '  (new record!)' : ''}`,
      'Press R / Space or tap to try again',
    );
  }

  // --------------------------------------------------------------- overlays

  showTitle() {
    const best = readBestTime();
    this.showOverlay(
      'SURVIVOR',
      'Move with WASD / arrow keys, or drag on a touch screen.\n' +
        'Your weapon fires by itself at the nearest enemy in range.\n' +
        'Collect the XP gems enemies drop to level up and widen that range.\n' +
        'A new, tougher wave arrives every 30 seconds.' +
        (best > 0 ? `\n\nBest: ${formatTime(best)}` : ''),
      'Press Space or tap to start',
    );
  }

  showOverlay(title, body, hint) {
    this.overlayTitle.setText(title);
    this.overlayBody.setText(body);
    this.overlayHint.setText(hint);
    for (const part of [this.overlayShade, this.overlayTitle, this.overlayBody, this.overlayHint]) {
      part.setVisible(true);
    }
    this.layoutOverlay();
  }

  hideOverlay() {
    for (const part of [this.overlayShade, this.overlayTitle, this.overlayBody, this.overlayHint]) {
      part.setVisible(false);
    }
  }
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// localStorage can throw (private mode, blocked storage); the best time is a nicety.
function readBestTime() {
  try {
    return Number(window.localStorage.getItem(BEST_TIME_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeBestTime(seconds) {
  try {
    window.localStorage.setItem(BEST_TIME_KEY, String(seconds));
  } catch {
    // Ignore: the run still counts, it just isn't remembered.
  }
}
