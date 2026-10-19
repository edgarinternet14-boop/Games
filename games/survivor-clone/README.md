# Survivor Clone

A small auto-shooter in the style of *Vampire Survivors*, built with [Phaser 3](https://phaser.io/) and split into ES modules. You only steer. Your weapon fires by itself at the nearest enemy in range. Enemies come in ever-larger waves and drop XP gems, and every level you gain widens your weapon radius.

There are no image or audio files. Every sprite (the hero, four enemy types, projectiles, gems, the grass tiles and the touch joystick) is drawn procedurally onto `<canvas>` textures when the game starts.

## Play

The game is made of ES modules, and browsers refuse to load those from `file://`. Serve the folder over HTTP instead:

```sh
cd games/survivor-clone
python3 -m http.server 8000   # or: npx serve .
```

Then open <http://localhost:8000>. Phaser 3.90 is loaded from the jsDelivr CDN, so the first load needs a network connection. If GitHub Pages is enabled for the repo, the game is served at `/games/survivor-clone/`.

## Controls

| Action               | Keyboard / mouse          | Touch                        |
| -------------------- | ------------------------- | ---------------------------- |
| Move                 | `WASD` or arrow keys      | Drag anywhere (joystick)     |
| Start / restart      | `Space`, `Enter` or click | Tap                          |
| Pause / resume       | `P` or `Esc`              | Leave the tab, tap to resume |
| Restart after defeat | `R`                       | Tap                          |

Firing is automatic. You can also drag with the mouse to steer, the same way as on a touch screen. The game pauses itself when the window loses focus.

## How a run works

- **Auto-fire.** Each volley targets the nearest enemy inside your **weapon radius** (the faint ring around you) and aims where it will be when the shots arrive. If nothing is in range, the weapon holds fire and shoots the moment something steps in.
- **XP and levels.** Every enemy drops an XP gem: blue for small amounts, green for 5+ and red for 20+. Gems inside your pickup radius fly to you. Each level grows the weapon radius (the ring visibly swells). It also adds a little damage and fire rate, restores 12 HP, and at set levels adds a projectile (every 4th level) or one more pierce (every 6th).
- **Waves.** A new wave starts every 30 seconds. Each one opens by surrounding you with a ring of enemies, then keeps up a stream of packs from off-screen. Enemy health, speed, damage, spawn rate and the on-screen cap all rise with the wave number. An **elite** boss joins every 5th wave (two on wave 10, and so on).
- **Damage.** Every enemy touching you deals its damage per second. At 0 HP the run ends and your time is compared with the best time stored in `localStorage`.

| Enemy  | HP  | Speed | Contact DPS | XP | Notes                             |
| ------ | --- | ----- | ----------- | -- | --------------------------------- |
| Bat    | 6   | 118   | 7           | 1  | Fast swarmer, from wave 1         |
| Zombie | 18  | 72    | 10          | 2  | Rank and file, from wave 2        |
| Brute  | 70  | 54    | 18          | 6  | Tanky, resists knockback, wave 4+ |
| Elite  | 650 | 64    | 30          | 40 | Boss, every 5th wave              |

These are base values. The wave multipliers below scale them up.

| Wave | Starts | Max alive | Enemy HP | Speed | Opening ring | Elites |
| ---- | ------ | --------- | -------- | ----- | ------------ | ------ |
| 1    | 00:00  | 30        | ×1.0     | ×1.00 | 8 bats       | –      |
| 4    | 01:30  | 120       | ×1.8     | ×1.07 | 20 bats      | –      |
| 5    | 02:00  | 150       | ×2.1     | ×1.10 | 24 bats      | 1      |
| 10   | 04:30  | 300       | ×4.2     | ×1.23 | 44 zombies   | 2      |
| 15   | 07:00  | 450       | ×7.0     | ×1.35 | 64 brutes    | 3      |
| 20   | 09:30  | 600       | ×10.6    | ×1.45 | 64 brutes    | 4      |

| Level | XP to next | Weapon radius | Damage | Volley every | Projectiles | Pierce |
| ----- | ---------- | ------------- | ------ | ------------ | ----------- | ------ |
| 1     | 11         | 230           | 10     | 0.52 s       | 1           | 1      |
| 4     | 37         | 296           | 14.5   | 0.45 s       | 2           | 1      |
| 8     | 93         | 384           | 20.5   | 0.36 s       | 3           | 2      |
| 12    | 173        | 472           | 26.5   | 0.30 s       | 4           | 3      |
| 20    | 405        | 648           | 38.5   | 0.20 s       | 5           | 4      |
| 28    | 733        | 820 (max)     | 50.5   | 0.14 s (max) | 5 (max)     | 5      |

## Project structure

```
survivor-clone/
├── index.html              Page shell: loads Phaser from the CDN, then js/main.js
├── js/
│   ├── main.js             Phaser.Game config (RESIZE scaling, no physics plugin)
│   ├── scenes/
│   │   ├── BootScene.js    Draws every texture onto canvases, then starts GameScene
│   │   └── GameScene.js    Arena, render layers, frame loop, HUD, title/pause/game-over
│   └── entities/
│       ├── Player.js       Movement (keys + joystick), auto-aim, pooled projectiles, XP/levels
│       └── EnemyManager.js Object pools, spatial hash, wave director, enemy AI, XP gems
└── README.md
```

GameScene runs each frame in a fixed order:

1. `player.updateMovement(dt)`
2. `enemies.update(dt, player)`: spawn, seek the player, separate, rebuild the spatial hash, and report contact damage
3. `player.takeDamage(contactDps * dt)`
4. `player.updateWeapon(dt)`: aim with the fresh spatial hash, move projectiles, resolve hits
5. `enemies.gems.update(dt, player)`, which feeds `player.addXp()`

Modules talk to each other through events: `Player` emits `levelup` and `died`, and `EnemyManager` emits `wave` and `kill`. GameScene uses them for the wave banners, the level-up callout and the game-over screen.

## Performance notes

The game is designed to keep hundreds of enemies on screen without frame drops or garbage-collection stalls:

- **Object pooling.** `Pool` (in `EnemyManager.js`) creates every record and sprite up front: 800 enemies, 500 gems and 256 projectiles. Spawning pops a record off a free list. Dying hides the sprite and pushes the record back. Update loops only walk a dense `live` array. Nothing is created or destroyed mid-run, so there is nothing for the garbage collector to clean up. When the gem pool is full, new XP is folded into a gem already on the ground, so no XP is lost.
- **Spatial hash instead of physics bodies.** No Arcade Physics is used. The arena is split into 64 px cells, stored as linked lists in `Int32Array`s and rebuilt in O(n) every frame. Enemy separation, bullet hits and contact damage each check only the 3×3 block of cells around a point. Auto-aim searches outward ring by ring and stops as soon as no unvisited cell could hold anything closer.
- **Render layers.** Sprites sit in fixed Phaser `Layer`s (ground → gems → enemies → projectiles → player → effects → HUD), so draw order never needs a depth sort.
- **Cheap rendering.** The ground is a tilemap (only on-screen tiles are drawn), the textures are tiny, bullets share one additive blend mode, and HUD text only re-renders when its value changes.

In headless Chromium, the whole game update (spawning, AI, separation, hashing, aiming, hits and gems) takes about 0.3–0.5 ms per frame with 300–400 enemies alive.

## Tuning

The balance values sit at the top of each module:

- `EnemyManager.js`: `ENEMY_TYPES` (base stats), `waveConfig()` (the whole difficulty curve), `WAVE_DURATION`, spawn and despawn distances, knockback and separation strength.
- `Player.js`: `PLAYER` (speed, HP, pickup radius), `WEAPON`, `weaponStatsForLevel()` and `xpForLevel()`.
- `GameScene.js`: arena size and the frame-time clamp.

`window.game` exposes the Phaser game instance, so you can inspect it from the dev-tools console, e.g. `game.scene.getScene('GameScene').player.addXp(500)`.
