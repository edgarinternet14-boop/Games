// BootScene draws every texture the game uses onto <canvas> elements at start-up,
// so the project ships without a single image file, then hands over to GameScene.

const TAU = Math.PI * 2;

export const GROUND_TILE = 128;
export const GROUND_VARIANTS = 4;

const GEM_COLORS = {
  'gem-blue': { base: '#4cc9f0', light: '#c4f4ff', dark: '#0f4c75' },
  'gem-green': { base: '#57e389', light: '#d5ffe0', dark: '#1d6b3a' },
  'gem-red': { base: '#ff5d73', light: '#ffd3da', dark: '#7a1222' },
};

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  create() {
    // Seeded so the ground looks the same on every visit.
    this.rnd = new Phaser.Math.RandomDataGenerator(['survivor-clone']);

    this.makePlayer();
    this.makeEnemies();
    this.makeProjectile();
    this.makeGems();
    this.makeEffects();
    this.makeGround();

    this.scene.start('GameScene');
  }

  /**
   * Creates a canvas-backed texture and hands its 2D context to `draw`.
   */
  canvasTexture(key, width, height, draw) {
    if (this.textures.exists(key)) {
      this.textures.remove(key);
    }
    const texture = this.textures.createCanvas(key, width, height);
    draw(texture.context, width, height);
    texture.refresh();
  }

  makePlayer() {
    this.canvasTexture('player', 48, 48, (ctx) => {
      // Cloak
      const cloak = ctx.createRadialGradient(19, 18, 3, 24, 25, 20);
      cloak.addColorStop(0, '#a6ecff');
      cloak.addColorStop(1, '#2475d6');
      ctx.fillStyle = cloak;
      ctx.strokeStyle = '#0b2447';
      ctx.lineWidth = 3;
      circle(ctx, 24, 25, 17);
      ctx.fill();
      ctx.stroke();

      // Visor, offset to the right so the hero has a facing direction
      ctx.fillStyle = '#0b2447';
      roundRect(ctx, 21, 17, 20, 10, 5);
      ctx.fill();

      // Eyes
      ctx.fillStyle = '#ffffff';
      circle(ctx, 29, 22, 2.4);
      ctx.fill();
      circle(ctx, 36, 22, 2.4);
      ctx.fill();

      // Shine
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      circle(ctx, 15, 16, 3);
      ctx.fill();
    });
  }

  makeEnemies() {
    // Bat: small and fast
    this.canvasTexture('enemy-bat', 38, 30, (ctx) => {
      ctx.fillStyle = '#5b2a86';
      ctx.strokeStyle = '#1f0b33';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(19, 13);
        ctx.lineTo(19 + dir * 17, 6);
        ctx.lineTo(19 + dir * 13, 14);
        ctx.lineTo(19 + dir * 16, 21);
        ctx.lineTo(19, 19);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const body = ctx.createRadialGradient(17, 12, 2, 19, 16, 10);
      body.addColorStop(0, '#c58af0');
      body.addColorStop(1, '#6a2fa0');
      ctx.fillStyle = body;
      ellipse(ctx, 19, 16, 8, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ff4d6d';
      circle(ctx, 16, 14, 2);
      ctx.fill();
      circle(ctx, 22, 14, 2);
      ctx.fill();
    });

    // Zombie: the rank-and-file walker
    this.canvasTexture('enemy-zombie', 38, 38, (ctx) => {
      const body = ctx.createLinearGradient(0, 4, 0, 34);
      body.addColorStop(0, '#8fd16a');
      body.addColorStop(1, '#3f7d2c');
      ctx.fillStyle = body;
      ctx.strokeStyle = '#173312';
      ctx.lineWidth = 3;
      roundRect(ctx, 4, 4, 30, 30, 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f7e463';
      circle(ctx, 19, 16, 3.2);
      ctx.fill();
      circle(ctx, 28, 15, 3.2);
      ctx.fill();
      ctx.fillStyle = '#173312';
      circle(ctx, 20, 16, 1.4);
      ctx.fill();
      circle(ctx, 29, 15, 1.4);
      ctx.fill();
      ctx.strokeStyle = '#173312';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(17, 26);
      ctx.lineTo(21, 24);
      ctx.lineTo(24, 27);
      ctx.lineTo(29, 24);
      ctx.stroke();
    });

    // Brute: slow, tanky, worth more XP
    this.canvasTexture('enemy-brute', 60, 60, (ctx) => {
      ctx.fillStyle = '#efe3c8';
      ctx.strokeStyle = '#3a1208';
      ctx.lineWidth = 2.5;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(30 + dir * 11, 16);
        ctx.quadraticCurveTo(30 + dir * 24, 10, 30 + dir * 22, 2);
        ctx.quadraticCurveTo(30 + dir * 16, 9, 30 + dir * 5, 13);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const body = ctx.createRadialGradient(25, 26, 4, 30, 33, 26);
      body.addColorStop(0, '#ff8a5b');
      body.addColorStop(1, '#b3261e');
      ctx.fillStyle = body;
      ctx.lineWidth = 3.5;
      circle(ctx, 30, 34, 22);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffe066';
      circle(ctx, 33, 29, 3.6);
      ctx.fill();
      circle(ctx, 43, 29, 3.6);
      ctx.fill();
      ctx.strokeStyle = '#3a1208';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(28, 22);
      ctx.lineTo(37, 26);
      ctx.moveTo(48, 22);
      ctx.lineTo(40, 26);
      ctx.moveTo(30, 42);
      ctx.quadraticCurveTo(38, 38, 46, 42);
      ctx.stroke();
    });

    // Elite: a boss that arrives every fifth wave
    this.canvasTexture('enemy-elite', 88, 88, (ctx) => {
      const cx = 44;
      const cy = 44;
      ctx.beginPath();
      for (let i = 0; i < 24; i++) {
        const r = i % 2 === 0 ? 41 : 30;
        const a = (i / 24) * TAU;
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath();
      const shell = ctx.createRadialGradient(cx, cy, 8, cx, cy, 42);
      shell.addColorStop(0, '#ffe8a3');
      shell.addColorStop(1, '#d08c00');
      ctx.fillStyle = shell;
      ctx.strokeStyle = '#4a2800';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#3c1361';
      circle(ctx, cx, cy, 22);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ellipse(ctx, cx + 3, cy, 14, 10);
      ctx.fill();
      ctx.fillStyle = '#e63946';
      circle(ctx, cx + 6, cy, 6);
      ctx.fill();
      ctx.fillStyle = '#14010f';
      circle(ctx, cx + 7, cy, 2.6);
      ctx.fill();
    });
  }

  makeProjectile() {
    this.canvasTexture('bullet', 30, 16, (ctx) => {
      ctx.shadowColor = '#ffb703';
      ctx.shadowBlur = 6;
      ctx.fillStyle = 'rgba(255, 183, 3, 0.85)';
      roundRect(ctx, 4, 4, 22, 8, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff8d6';
      roundRect(ctx, 9, 6, 15, 4, 2);
      ctx.fill();
    });
  }

  makeGems() {
    for (const [key, color] of Object.entries(GEM_COLORS)) {
      this.canvasTexture(key, 18, 24, (ctx) => {
        ctx.lineJoin = 'round';
        ctx.fillStyle = color.base;
        ctx.strokeStyle = color.dark;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(9, 2);
        ctx.lineTo(16, 10);
        ctx.lineTo(9, 22);
        ctx.lineTo(2, 10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Top facet
        ctx.fillStyle = color.light;
        ctx.beginPath();
        ctx.moveTo(9, 3.5);
        ctx.lineTo(14, 10);
        ctx.lineTo(4, 10);
        ctx.closePath();
        ctx.fill();
      });
    }
  }

  makeEffects() {
    this.canvasTexture('spark', 12, 12, (ctx) => {
      const glow = ctx.createRadialGradient(6, 6, 0, 6, 6, 6);
      glow.addColorStop(0, 'rgba(255, 255, 255, 1)');
      glow.addColorStop(0.45, 'rgba(255, 255, 255, 0.7)');
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, 12, 12);
    });

    // Floating touch joystick
    this.canvasTexture('joy-base', 124, 124, (ctx) => {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 3;
      circle(ctx, 62, 62, 58);
      ctx.fill();
      ctx.stroke();
    });
    this.canvasTexture('joy-thumb', 60, 60, (ctx) => {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 2;
      circle(ctx, 30, 30, 26);
      ctx.fill();
      ctx.stroke();
    });
  }

  /**
   * A strip of grass tiles for the arena tilemap. Decorations stay clear of the
   * tile edges so neighbouring tiles always meet seamlessly.
   */
  makeGround() {
    const size = GROUND_TILE;
    const rnd = this.rnd;

    this.canvasTexture('ground', size * GROUND_VARIANTS, size, (ctx) => {
      for (let v = 0; v < GROUND_VARIANTS; v++) {
        const ox = v * size;
        ctx.fillStyle = '#1c271f';
        ctx.fillRect(ox, 0, size, size);

        // Low-contrast speckle
        for (let i = 0; i < 140; i++) {
          ctx.fillStyle = rnd.frac() < 0.5 ? 'rgba(42, 60, 45, 0.6)' : 'rgba(16, 22, 18, 0.6)';
          const s = rnd.between(2, 4);
          ctx.fillRect(ox + rnd.between(0, size - s), rnd.between(0, size - s), s, s);
        }

        // Grass tufts
        ctx.strokeStyle = '#2f4a35';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        const tufts = 3 + v * 2;
        for (let i = 0; i < tufts; i++) {
          const x = ox + rnd.between(12, size - 12);
          const y = rnd.between(14, size - 8);
          ctx.beginPath();
          ctx.moveTo(x - 4, y - 7);
          ctx.lineTo(x - 1, y);
          ctx.moveTo(x, y - 9);
          ctx.lineTo(x, y);
          ctx.moveTo(x + 4, y - 7);
          ctx.lineTo(x + 1, y);
          ctx.stroke();
        }

        // The occasional pebble or flower
        if (v >= 2) {
          ctx.fillStyle = '#3a4140';
          ellipse(ctx, ox + rnd.between(20, size - 20), rnd.between(20, size - 20), 5, 3.5);
          ctx.fill();
        }
        if (v === 3) {
          const fx = ox + rnd.between(20, size - 20);
          const fy = rnd.between(20, size - 20);
          // Kept dull so it never reads as a pickup.
          ctx.fillStyle = '#5d6b4a';
          for (let p = 0; p < 5; p++) {
            const a = (p / 5) * TAU;
            circle(ctx, fx + Math.cos(a) * 3, fy + Math.sin(a) * 3, 2);
            ctx.fill();
          }
          ctx.fillStyle = '#8c8f5c';
          circle(ctx, fx, fy, 1.6);
          ctx.fill();
        }
      }
    });
  }
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

function ellipse(ctx, x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
