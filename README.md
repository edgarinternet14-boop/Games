# Dunebound

**Haul stone. Grow strong. Raise the eternal pyramid together.**

Dunebound is a multiplayer 3D desktop game. Players lift heavy limestone blocks from a shared quarry on the far bank of the Nile, haul them across the river and the desert, and set them into one giant pyramid that every player on the server builds together. You train Strength to carry more and Speed to run faster, spend the gold you earn at the Bazaar, and buy pets that haul blocks for you.

- **Authoritative Node.js server** (Express + Socket.io). It owns every player position, every block (in the pile, carried, or placed), the pyramid grid, the economy, and the pets.
- **Server-simulated pets.** Pets run a state machine with A\* pathfinding over the pyramid's height field. Every player sees the same jackal pick up the same block, climb the same steps and set it in the same slot.
- **Electron desktop client** (Three.js). It opens as a borderless fullscreen window with no menus and no developer tools. GitHub Actions builds it into a Windows `.exe` and publishes it to the Releases tab on every push.
- **Stylized realism.** `WebGLRenderer` with `PCFSoftShadowMap` and `ACESFilmicToneMapping`. The sand, limestone, rock, skin, fur, linen and beadwork textures are generated from seeded Perlin noise at startup, so the game ships no image files. Post-processing adds volumetric god rays, `UnrealBloomPass` and, on Ultra, GTAO ambient occlusion.

---

## Repository layout

```
├── .github/
│   └── workflows/
│       └── build-exe.yml     CI: server smoke test, Windows .exe build, GitHub Release
├── server/
│   ├── package.json          socket.io + express
│   ├── server.js             authoritative server: players, blocks, pile, pets, persistence
│   └── gameLogic.js          rules: world config, pyramid grid, height field, A*, stats, shop
├── client/
│   ├── package.json          electron, electron-builder, three, socket.io-client
│   ├── main.js               Electron entry: borderless fullscreen, no menus or dev tools
│   ├── build/icon.png        app icon (generated, used by electron-builder)
│   └── src/
│       ├── index.html        UI shell, CSP and import map
│       ├── css/style.css     menus, HUD, shop, stats and chat
│       └── js/
│           ├── engine.js     renderer, lighting, shadows, procedural PBR textures, post FX
│           ├── network.js    Socket.io client, clock sync, snapshot interpolation
│           ├── player.js     input, local physics and camera, skinned builder characters
│           ├── pyramid.js    shared block grid, height field, placement ghost and effects
│           ├── pets.js       rendering and interpolation of server-driven pets
│           └── game.js       bootstrap, game loop, HUD/shop/chat UI, procedural audio
└── games/                    other, unrelated browser games (see the end of this file)
```

---

## Quick start

You need **Node.js 20 or newer** (22 LTS recommended) and npm.

### 1. Run the server

```bash
cd server
npm install
npm start
```

The server listens on `http://localhost:3000` and prints the LAN addresses other players can use. `GET /health` returns live stats. The world and player profiles are saved to `server/data/` every 30 seconds and when the server shuts down.

### 2. Run the desktop client

```bash
cd client
npm install
npm start                 # borderless fullscreen
npm run start:windowed    # borderless window
npm run dev               # windowed, F12 opens dev tools (unpackaged builds only)
```

Enter a builder name, pick a sash colour, check the server address (default `http://localhost:3000`) and press **Enter the Sands**.

To test multiplayer on one machine, start extra clients with their own local profile, for example `npm start -- --windowed --profile=player2`. Without `--profile`, windows share one saved profile, and a second window signing in disconnects the first.

### 3. Optional: play in a browser

If `client/node_modules` exists, the server also serves the web build. Open `http://localhost:3000` in a recent Chrome or Edge. Set `SERVE_WEB_CLIENT=0` to turn this off.

### LAN parties

1. Start the server on the host machine and allow inbound TCP port 3000 through its firewall.
2. On each other PC, enter `http://<host-ip>:3000` as the server address. You can also launch the exe with `--server=http://<host-ip>:3000` to pre-fill it.

---

## Building the `.exe`

### Locally (Windows)

```bash
cd client
npm install
npm run dist
```

The output is written to `client/dist/`:

| File | Description |
| --- | --- |
| `Dunebound-Setup-1.0.0.exe` | NSIS installer with Start menu and desktop shortcuts |
| `Dunebound-Portable-1.0.0.exe` | Standalone executable that runs without installing |

`npm run dist:dir` produces an unpacked build for your current OS, which is handy for quick checks. Building the Windows targets from Linux or macOS needs Wine.

### Automatically (GitHub Actions)

`.github/workflows/build-exe.yml` runs on **every push to any branch**, on `v*` tags, and on manual dispatch:

1. **Server smoke test** (Ubuntu): installs the server, syntax-checks it, boots it and probes `/health`.
2. **Windows build**: runs `npm ci` and `electron-builder --win`, then uploads the installer and the portable exe as a workflow artifact.
3. **Release**: publishes both files to the **Releases** tab.
   - A branch push creates `v<version>-build.<run>`. It is marked as a pre-release unless the branch is the default branch.
   - A tag push such as `v1.2.0` creates a full release with that name.

To cut a versioned release, bump `version` in `client/package.json`, commit, then run `git tag v1.2.0 && git push origin v1.2.0`.

The builds are not code-signed, so Windows SmartScreen may warn on first launch. Choose **More info, then Run anyway**.

---

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrow keys | Move (relative to the camera) |
| Mouse | Look around (click the game to capture the mouse) |
| Mouse wheel | Camera distance |
| `Space` | Jump |
| `E` or left click | Context action: lift blocks, set block, train, open the Bazaar. Hold to repeat. |
| `Enter` / `T` | Chat |
| `C` | Character sheet: strength, speed, capacity, pace, upgrades and pets |
| `Tab` (hold) | Builders leaderboard |
| `Esc` | Pause menu (resume, settings, leave, quit) |
| `F11` / `Alt+Enter` | Toggle fullscreen (desktop app) |

The quick-menu dock at the bottom of the screen opens the same panels with the mouse. A waypoint at the edge of the view points to the quarry while your hands are empty and to the pyramid's open layer while you carry, with the distance in metres.

---

## How to play

### The map

The pyramid stands at the centre of the dig site, with the training grounds, the Bazaar and the oasis around it. The **quarry** lies about 105 m to the north, on the far bank of **the Nile**, which flows across the whole map from horizon to horizon. Its water is impassable, and the sound of the river grows as you get closer to it. There are two ways across:

| Crossing | Where | How it plays |
| --- | --- | --- |
| **Great Causeway** | x ≈ −22, on the paved road | Stone bridge with a raised deck, parapets and ramps at both ends. Full speed. |
| **Reed Ford** | x ≈ +26, at the end of a dirt trail | Shallow water you can wade through at 62 % speed. |

Hauling blocks across this distance is the core challenge. Phase 2 will add traversal tools such as gliders and grappling hooks. The movement code already reserves states and network animation codes for them, and has an extension point (`LocalPlayer.registerTraversal`) where they will plug in.

### The building loop

1. **Quarry.** Walk up to the stone pile and press `E` to lift as many blocks as your carry capacity allows. The pile is shared by everyone. Quarry workers cut a new block every 0.45 s, up to 80 in stock.
2. **Haul.** Blocks are heavy. While you carry anything, your sprint gives way to a slow, heavy walk, and your pace drops to `0.62 − 0.17 × (carried / capacity)` of normal: 62 % with a light load, 45 % with a full one. The server enforces this limit too.
3. **Set.** At the pyramid, a glowing ghost shows the open slot your camera faces. Press `E` to set the block.
   - The pyramid has 12 layers and 650 blocks. Layer *k* is *(12 − k) × (12 − k)* blocks, inset by half a block, so each block rests on the four blocks beneath it.
   - The server only accepts a slot that is **empty**, **fully supported** and **within reach** (about 3.6 m from your hands).
   - Each layer is a 1.3 m step, so you can walk up the pyramid to reach the higher layers.
4. When the capstone is set, everyone online gets a completion bonus, the gold pyramidion flares, and after 12 seconds the site is cleared for the next pyramid.

### Stats and training

| Stat | How to train | Effect |
| --- | --- | --- |
| **Strength** | Hold `E` on the lifting platform (1 rep every 0.45 s) | Carry capacity = `1 + floor(sqrt(strength / 6))` + harness level, up to 20 |
| **Speed** | Run laps on the sprint track around the sundial (+1 per 10 m) | Pace = `5.5 + 2.4 * log2(1 + speed / 5)` m/s × sandals bonus, up to 18 m/s |

### Economy

Gold is earned **globally**:

- **Placer reward:** `(8 + 4 × layer) × (1 + 25 % × Pharaoh's Favor level)`. Your pets earn this for you too.
- **Tribute:** every other player online receives `2 + floor(layer / 2)` gold whenever *anyone* sets a block.
- **Completion bonus:** `500 + 100 × (pyramids already built)` gold to everyone online.

### The Bazaar

| Upgrade | Effect per level | Levels | Base cost |
| --- | --- | --- | --- |
| Linen Carry Harness | +1 carry capacity | 6 | 120 (×2.1 per level) |
| Reed Sandals | +6 % pace | 6 | 90 (×1.9) |
| Temple Regimen | +50 % training gains | 6 | 150 (×2.2) |
| Pharaoh's Favor | +25 % gold per placed block | 6 | 260 (×2.3) |

| Pet | Cost | Pace | Blocks per trip |
| --- | --- | --- | --- |
| Desert Jackal | 250 | 6.0 m/s | 1 |
| Pack Camel | 900 | 4.5 m/s | 3 |
| Sphinx Cub | 2,500 | 6.8 m/s | 2 |
| Golden Scarab | 6,000 | 7.5 m/s | 4 |

You can own up to 4 pets (the server allows 64 in total). Releasing a pet refunds 40 % of its price. Pets return to your profile when you log off and reappear next time you join.

### Profiles

There are no accounts. On first launch the client creates a random profile token and stores it locally. The server keeps only a SHA-256 hash of that token as the key for your gold, stats, upgrades and pets. If you sign in from a second window with the same profile, the older session is disconnected.

---

## Architecture

```
 Electron / browser client                         Node.js authoritative server
 ┌───────────────────────────────┐   Socket.io   ┌──────────────────────────────────┐
 │ player.js  local prediction   │──── 'm' ─────▶│ validate speed, walls, rise rate │
 │            + collision        │◀─ correction ─│ (snap back cheaters)             │
 │ game.js    E: pickup/place/   │── requests ──▶│ gameLogic: reach, support, cost, │
 │            train/buy (acks)   │◀──── acks ────│ cooldowns, zones                 │
 │ network.js snapshot buffer,   │◀─ 's' 20 Hz ──│ tick: pile regen, pet AI + A*,   │
 │            110 ms interp.     │◀─ events ─────│ snapshots, dirty-state flush     │
 │ pyramid.js / pets.js render   │               │ persistence: data/*.json         │
 └───────────────────────────────┘               └──────────────────────────────────┘
```

- **Tick rate.** The server simulates and broadcasts at 20 Hz. Snapshots are compact arrays sent as volatile emits. Clients estimate server time with ping and pong and render remote players and pets 110 ms in the past, interpolating between snapshots.
- **Movement.** Clients predict their own movement against the same 1 m height field the server uses, including the river, the causeway deck and the ford. Both sides build it from the same river control points with byte-identical code. The server gives each player a travel budget that refills with real time at their allowed pace (including the carry-weight slowdown, with a short grace period after a pickup or placement). The pace includes the ford's wading slowdown. The budget can bank about 1.2 s of travel, so jittery packets and short network stalls pass but sustained over-speed does not, and a correction never refills it. The server also rejects moves into water, into walls taller than one step, or rising faster than a jump. It answers with a `correction`, and the correction id makes the server ignore stale in-flight moves.
- **Blocks.** Every block has an id and is always in exactly one place: the pile, a carrier (player or pet), or a pyramid slot. `carry` events tell clients which block ids each carrier holds. Block colour is a deterministic hash of the id, so a block keeps the same colour from the pile to its slot on every client.
- **Pets.** A pet cycles through `toPile → loading → toPyramid → placing`. It reserves its target slot so two pets never race for the same one. Its route comes from multi-goal A\* (8-way, no corner cutting, step-height limited, string-pulled with a grid line walk). It re-plans when a newly placed block changes the terrain, skips unreachable slots for a while, and recovers when it gets stuck. The server caps path searches per tick.
- **Abuse resistance.** All payloads are type-checked. A per-socket token bucket limits event rate, chat is limited to 4 messages per 5 s, names and messages are sanitised, messages are capped at 32 KB, and every action has a cooldown. The client renders chat with `textContent`, never HTML.

### Network events

| Direction | Event | Payload |
| --- | --- | --- |
| C→S | `join` (ack) | `{ name, color, token, protocol }` → `{ id, config, state, self }`. The server refuses a client whose `protocol` differs from its own (currently 2) and says which side needs updating. |
| C→S | `m` | `[x, y, z, ry, anim, cid]` at 20 Hz. `anim` is 0 idle, 1 run, 2 air, 3 lift, 4 place, 5 pick up; 6 and 7 are reserved for gliding and grappling. |
| C→S | `pickup` / `place` / `train` / `buy` / `release` (ack) | `{ slot }`, `{ item }`, `{ pet }` → `{ ok, reason? }` |
| C→S | `chat` / `tping` (ack) | text / client time → server time |
| S→C | `s` | `{ t, p: [[id,x,y,z,ry,anim,carry]], q: [[id,x,y,z,ry,state,carry]] }` |
| S→C | `placed`, `carry`, `pile` | block placed (slot, block, carrier, owner, reward, tribute), carried ids, pile stock |
| S→C | `pj` / `pl`, `qs` / `qr` | player joined/left, pet spawned/removed |
| S→C | `self`, `trained`, `correction` | private stats and shop, training gains, position fix |
| S→C | `chat`, `board`, `complete`, `reset`, `kicked` | social and lifecycle events |

---

## Graphics

- **Renderer:** `WebGLRenderer` with `PCFSoftShadowMap` (a texel-snapped 4096² sun shadow map that follows the player) and `ACESFilmicToneMapping` with sRGB output. three.js is pinned to **r181** on purpose: r182 deprecated `PCFSoftShadowMap` and later releases silently replace it with `PCFShadowMap`.
- **Procedural textures:** seeded, periodic (tileable) Perlin noise and fBm produce the albedo, normal and roughness maps for wind-rippled sand, weathered limestone, cliff rock, hieroglyph-carved obelisks, skin pores, fur, woven linen, faience beads, wood and striped cloth. Each pyramid block samples its own window of the stone texture (a per-instance UV offset in the shader), so no two blocks look alike.
- **Atmosphere:** a custom golden-hour sky shader (Mie glow, horizon haze, drifting clouds, HDR sun disc) drives image-based lighting through PMREM. The fog colour matches the sky's horizon, and drifting dust motes and flickering braziers fill the scene.
- **Post-processing:** RenderPass → GTAO (Ultra) → volumetric god rays (radial light scattering from the sun's screen position) → `UnrealBloomPass` → OutputPass.
- **Models:** builders and pets are built procedurally at startup. Lathe-profiled anatomy with muscle definition, a sculpted head with kohl-lined eyes, a pleated shendyt, a beaded usekh collar, a nemes headdress, jointed animal legs, fur with sheen and an iridescent scarab shell are each baked into a rigidly skinned mesh, so a fully detailed character costs one draw call per material.

| Preset | Resolution | Shadows | MSAA | Bloom | God rays | AO |
| --- | --- | --- | --- | --- | --- | --- |
| Low | 1× | 1024 | — | — | — | — |
| Medium | ≤1.25× | 2048 | 2× | ✓ | 32 samples | — |
| High | ≤1.5× | 4096 | 4× | ✓ | 48 samples | — |
| Ultra | ≤2× (native) | 4096 | 4× | ✓ | 72 samples | GTAO |

On first launch the preset is chosen from the detected GPU. You can change it under **Settings**.

---

## Configuration

**Server environment variables**

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `server/data` | Where `world.json` and `profiles.json` are saved |
| `SERVE_WEB_CLIENT` | `1` | Set to `0` to stop serving the browser build |

Gameplay constants (pyramid size, pile position and rate, the river and its crossings, carry weight, prices, pet stats, zones) live in `server/gameLogic.js`. The client receives the world layout in the `welcome` payload, so changing it there updates every client.

**Client options**

| Option | Purpose |
| --- | --- |
| `--server=http://host:3000` or `DUNEBOUND_SERVER` | Pre-fill the server address |
| `--windowed` | Start as a borderless window instead of fullscreen |
| `--profile=name` | Use a separate local profile (several players on one PC) |
| `--dev` | Allow dev tools (`F12`) in unpackaged builds |
| `?server=` / `?debug` (browser) | Pre-fill the server, or expose `window.dunebound` for debugging |

---

## Troubleshooting

- **"Could not reach …"**: check that the server is running, that the address includes the port, and that the host firewall allows TCP 3000.
- **Low FPS or a black screen**: update your GPU drivers, or choose a lower preset in Settings. The app needs WebGL 2.
- **"You signed in from another window"**: the same profile joined twice. Only the newest session stays connected.
- **A fresh world**: stop the server and delete `server/data/`.
- **Editing `index.html`**: if you change the import map, update its `sha256` hash in the Content-Security-Policy meta tag.

---

## Other games in this repository

- [`games/asteroids-clone`](games/asteroids-clone): a single-file HTML5 canvas Asteroids remake.
- [`games/survivor-clone`](games/survivor-clone): a Phaser 3 auto-shooter in the style of *Vampire Survivors*.
