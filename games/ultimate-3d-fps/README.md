# Ultimate 3D FPS: Sector 7

A first-person prototype set in a flooded, half-lit underground storage hall. It's built with [Three.js](https://threejs.org/) r181, [cannon-es](https://github.com/pmndrs/cannon-es) physics and the [pmndrs postprocessing](https://github.com/pmndrs/postprocessing) library, and wrapped in [Electron](https://www.electronjs.org/) so it ships as a portable Windows `.exe`. A GitHub Action builds that `.exe` automatically.

There are no image, model or audio files in this project. Every texture (albedo, normal, roughness, metalness and AO maps), the flashlight's light cookie, the bullet-hole decal, the muzzle flash, the EXIT sign, every sound effect and even the app icon are generated procedurally when the game starts or when it is built.

## Download

Every push that touches `games/ultimate-3d-fps/` (or the workflow) runs [`.github/workflows/build-exe.yml`](../../.github/workflows/build-exe.yml). Each run:

1. installs dependencies and runs `npm run build` on a `windows-latest` runner,
2. uploads `UltimateFPS-<version>-portable.exe` as a workflow artifact (kept for 30 days),
3. publishes it as a GitHub Release asset tagged `ultimate-3d-fps-v<version>-build.<run>`. Builds from the default branch are marked as the latest release. Builds from any other branch are published as pre-releases.

Grab the `.exe` from the repository's **Releases** page and double-click it. Nothing gets installed. The portable build unpacks itself to a temp folder and runs. The build is not code-signed, so Windows SmartScreen may warn you the first time: choose **More info → Run anyway**.

## Run from source

Requires Node.js 22.12 or newer (Electron 44's minimum).

```sh
cd games/ultimate-3d-fps
npm install
npm start          # bundle + launch in Electron (fullscreen, borderless)
npm run dev        # bundle in watch mode and serve src/ at http://localhost:8000
npm run build      # produce dist/UltimateFPS-<version>-portable.exe
npm run build:dir  # unpacked app for the current OS (quick packaging check)
```

`npm start -- --devtools` allows DevTools (F12) in development. Packaged builds never expose them. The portable Windows target also builds on Linux (electron-builder ships its own NSIS), which is handy for checking packaging without a Windows machine.

## Controls

| Action                 | Input                     |
| ---------------------- | ------------------------- |
| Move                   | `W` `A` `S` `D` / arrows  |
| Look                   | Mouse (raw input when the platform supports it) |
| Sprint                 | `Shift` (hold, forward only) |
| Jump                   | `Space`                   |
| Crouch                 | `Ctrl` (hold) or `C` (toggle) |
| Fire (full auto)       | Left mouse                |
| Aim down sights        | Right mouse               |
| Reload                 | `R`                       |
| Flashlight on/off      | `F`                       |
| FPS counter            | `F3`                      |
| Pause / settings       | `Esc`                     |
| Fullscreen ↔ window    | `F11` or `Alt+Enter` (desktop app) |

The pause menu switches graphics presets and sets mouse sensitivity, field of view, volume and Y inversion. Settings persist in `localStorage`.

## What's in it

### Rendering (`engine.js`)

- `WebGLRenderer` with `antialias: true`, `shadowMap.enabled = true`, `shadowMap.type = THREE.PCFSoftShadowMap`, `toneMapping = THREE.ACESFilmicToneMapping`, sRGB output.
- A dark, cold `AmbientLight` + `HemisphereLight` base, so silhouettes read but nothing is flat-lit.
- Image-based lighting from a tiny procedural "industrial hall" (strip lights, a warm door glow) rendered into a PMREM cube, so metal and wet floors have something to reflect without an HDR file.
- **Flashlight**: a physically based `SpotLight` (candela, `decay = 2`) mounted on the camera, slightly below and to the right of the eye so its soft shadows are visible. It projects a procedural cookie (hot spot, reflector rings, lens grime), lags behind fast mouse movement on a spring, and flickers when switched on. A raycast along the beam drives two cheap tricks:
  - intensity eases down when the beam is on a surface within about 6 m, like eye adaptation, so walls at arm's length don't blow out;
  - a warm ambient "bounce" term fakes the light a torch throws back from nearby walls.
- Shadow maps are refreshed exactly once per frame (`shadowMap.autoUpdate = false`). Without that, the post stack's extra scene renders (SSAO normals, viewmodel) would redraw them several times per frame.
- The weapon is drawn on its own layer by a second camera with a fixed FOV and a cleared depth buffer. It never clips into walls and doesn't stretch when the world FOV changes. All lights are enabled on both layers, plus a weapon-only key light.

### Procedural PBR materials (`materials.js`)

- Seeded, **tileable** improved Perlin noise (16 gradients, periodic lattice), fBm, ridged noise, tileable Worley noise, domain warping.
- Each surface builds a height field and masks per pixel, writes albedo/normal/ORM data into HTML5 canvases (`ImageData`, plus 2D canvas drawing for scratches and stencil text) and turns them into `CanvasTexture`s. A wrapping Sobel filter derives the normal map; a cavity filter on the blurred height derives AO. AO, roughness and metalness are packed into one ORM texture, the exact layout `MeshStandardMaterial` reads.
- Surfaces:
  - **wet concrete floor**: aggregate stones, hairline cracks, oil stains, damp patches and puddles. Puddles get a perfectly flat water level and roughness ≈ 0.035, so the flashlight and the shutter glow reflect in them.
  - **board-formed concrete walls**: form-panel seams, tie holes with rust bleeding down from them, rain streaks, pores.
  - **riveted rusted steel**: brushed metal, scratches, flaking non-metallic rust.
  - **chipped painted metal** in four variants: corrugated container paint, red and blue oil drums with rolling hoops, hazard stripes.
  - **wooden crates** with planks, a brace, nails and a worn stencil.
  - **gunmetal and polymer** for the rifle.
- UV helpers re-project box UVs to world scale so tiling stays seamless across walls, pillars and floor.

### Post-processing (`postprocessing.js`)

Cinematic preset: three.js `EffectComposer` on half-float targets with 4× MSAA.

| Pass | What it does |
| --- | --- |
| `RenderPass` | the world |
| `SSAOPass` | contact shadows in corners. Runs at 0.6× resolution, has an intensity control, and skips decals, light cones and particles. |
| `RenderPass` | the weapon, over the world, with depth cleared |
| `UnrealBloomPass` | glow on fluorescent tubes, the hanging bulb, sparks, muzzle flash and the red dot. The threshold sits above lit-surface brightness so only emitters bloom. |
| `OutputPass` | ACES Filmic tone mapping + sRGB |
| **Cinematic pass** (custom shader) | lift/gamma/gain grading (teal shadows, warm highlights), filmic S-curve, desaturation, radial chromatic aberration (kicked by gunshots and hard landings), vignette, animated luminance-weighted film grain, and dithering against banding |

Performance preset: a pmndrs `postprocessing` pipeline that merges mipmap bloom, ACES tone mapping, hue/saturation, contrast, vignette and noise into a single `EffectPass`, with no SSAO. It also caps the pixel ratio at 1 and uses a 1024² flashlight shadow map.

### Physics (`physics.js`)

- cannon-es world with SAP broadphase, sleeping bodies, and contact materials (frictionless player, bouncy brass casings).
- Fixed 120 Hz step with an accumulator and render interpolation, so it behaves the same at any frame rate.
- The character controller runs **before** every sub-step. cannon-es's own `preStep` event fires after the contact solver, which would let the controller push the player into walls for a step.
- Dynamic crates (box) and oil drums (cylinder) start asleep so stacks stand still until disturbed. They make impact sounds and take bullet impulses at the hit point.
- The hanging lamp is a rigid pendulum on a `PointToPointConstraint`, kept alive by a noise-driven draught. Shoot it and the light and shadows swing.

### FPS controller (`player.js`)

- Capsule collider made of three stacked spheres.
- Five-ray ground probe that measures the gap perpendicular to the slope.
- Slope-aware acceleration, and gravity is cancelled while grounded, so you don't creep down ramps.
- Snap-down onto steps; coyote time and jump buffering.
- **Smooth crouch**: the collider shrinks instantly, while the eye height follows on a critically damped spring. Standing back up first checks headroom: try it under the low duct in the north-west corner.
- **Head bob**: sine waves driven by distance walked (not time), with stride length that changes for walk, sprint and crouch. It has vertical, lateral, roll and nod components, footstep events on each heel strike, and fades out when you aim.
- **Camera shake**: trauma-based (shake = trauma²), sampled from Perlin noise, from jumping, landing (scaled by impact speed) and firing. On top of that:
  - landing dip and jump lift springs;
  - recoil springs that partly climb the aim;
  - strafe roll;
  - sprint FOV kick and aim-down-sights zoom;
  - idle breathing.

### Weapon (`weapon.js`)

- Procedural rifle viewmodel with a red-dot sight that lines up exactly when aiming down sights.
- Gun movement:
  - sway from mouse velocity;
  - bob synced to the head bob;
  - sprint pose;
  - recoil springs.
- Reload choreography: the magazine drops out and the new one goes in. Empty reloads also work the charging handle, and tactical reloads keep one round in the chamber.
- Hitscan with spread that grows with movement, airtime and sustained fire, and shrinks when crouching or aiming.
- `DecalGeometry` bullet holes projected onto whatever mesh was hit. Holes on moving props follow the prop.
- Effects per surface:
  - sparks on metal;
  - dust puffs and chips on concrete;
  - splinters on wood;
  - tracers.
- Muzzle flash from crossed additive sprites plus a point light that sits inside the player's collider, so it never shines through walls.
- Brass casings are real physics bodies that tink when they land.

### Audio (`audio.js`)

Web Audio only. Every sound is built from filtered noise and oscillators:

- gunshot layers: crack, blast, thump and mechanism;
- surface-dependent footsteps;
- landing thuds;
- impacts;
- hollow oil-drum clangs;
- casing tinks;
- reload clicks.

They go through a convolution reverb whose impulse response is generated from decaying noise.

The ambience is an industrial drone, air-handler rumble, a fluorescent ballast hum that follows the flicker, and random drips and metal creaks.

## Project structure

```
games/ultimate-3d-fps/
├── package.json            three, cannon-es, postprocessing, electron, electron-builder, esbuild
├── main.js                 Electron main process: fullscreen borderless window, no menu, locked down
├── scripts/
│   └── generate-icon.mjs   procedural app icon (PNG encoder using only node:zlib)
├── src/
│   ├── index.html          canvas, HUD, loading/title/pause/error screens, CSP
│   ├── css/style.css
│   └── js/
│       ├── main.js         boot sequence, UI, state machine, game loop
│       ├── engine.js       renderer config, cameras/layers, lighting, environment, flashlight
│       ├── postprocessing.js  cinematic (three.js) and performance (pmndrs) stacks
│       ├── materials.js    noise library + procedural PBR texture generators
│       ├── physics.js      cannon-es world, fixed step, interpolation, character capsule
│       ├── player.js       input, FPS controller, head bob, crouch, camera shake
│       ├── weapon.js       viewmodel, firing, recoil, reload, decals, particles, casings
│       ├── level.js        Sector 7 geometry, props, lights, pendulum lamp, dust motes
│       └── audio.js        procedural Web Audio
└── README.md
```

The workflow file is at the repository root (`.github/workflows/build-exe.yml`) because GitHub only picks up workflows from there. It sets `working-directory: games/ultimate-3d-fps` and only runs when this folder or the workflow changes.

Each frame (while playing) runs in this order:

1. `weapon.preUpdate`
2. `player.handleInput`
3. `physics.step`
4. `player.updateCamera`
5. `weapon.update`
6. `level.update`
7. `engine.render`

Input is read before physics and the camera is built from the freshly interpolated body, so the view never lags the simulation by a frame.

## Design notes

- **three.js is pinned to r181.** The spec calls for `THREE.PCFSoftShadowMap`. From r182 that constant is deprecated: three.js logs a warning and silently switches to `PCFShadowMap`. r181 is the last release where soft PCF actually runs. It is also inside the peer range of `postprocessing` 6.39.
- **The game is bundled with esbuild into one IIFE script** (`src/bundle/game.js`, about 1.1 MB minified). That loads from `file://` in Electron with a strict CSP and no custom protocol. It also means `node_modules` are not packaged: the app's `app.asar` is about 1.2 MB, and the rest of the `.exe` is the Electron runtime.
- **Electron hardening:**
  - `contextIsolation`, `sandbox` on, `nodeIntegration` off;
  - no preload;
  - navigation, pop-ups and `<webview>` are blocked;
  - permissions are limited to pointer lock and fullscreen;
  - single-instance lock;
  - zoom disabled;
  - no application menu, so no reload or DevTools accelerators.

  It also asks for the high-performance GPU on dual-GPU laptops and ignores Chromium's GPU blocklist, so old drivers don't silently fall back to software rendering.
- **First load** generates every texture on the main thread. It yields between surfaces to keep the loading bar moving, and pre-compiles shaders with `compileAsync`, so firing, decals and particles don't hitch the first time.
- `?autoplay` skips pointer lock (used for automated testing). `window.__game` exposes the engine, player, weapon, level and physics for console poking.

## Tuning

- Light intensities: `Flashlight` in `engine.js`, the `fixtures` list and the lamp/beacons in `level.js`.
- Post-processing: SSAO radius/intensity, bloom and the grading uniforms (`CinematicShader`) in `postprocessing.js`.
- Movement: the `PLAYER` constants (speeds, acceleration, jump height, crouch heights, step lengths) at the top of `player.js`.
- Weapon: fire rate, magazine size, sight position, spread and recoil at the top of `weapon.js` and in `_fire()`.
- Texture resolution: `generateMaterials(..., { textureSize })` in `main.js` (1024 by default; 512 roughly quarters the generation time).

## Troubleshooting

- **"WebGL 2 could not be initialised"**: update the graphics driver. On Windows, Electron uses ANGLE over Direct3D 11.
- **"Click again to resume"** after pressing Esc: Chromium refuses to re-capture the mouse for about a second after you release it. Wait a moment and click again.
- **Low frame rate**: switch to the *Performance* preset in the pause menu.
