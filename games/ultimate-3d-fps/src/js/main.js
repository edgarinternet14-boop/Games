import * as THREE from 'three';
import { Engine, Flashlight } from './engine.js';
import { generateMaterials } from './materials.js';
import { PhysicsWorld } from './physics.js';
import { Input, Player } from './player.js';
import { Weapon } from './weapon.js';
import { buildLevel } from './level.js';
import { PostProcessing, PRESETS } from './postprocessing.js';
import { AudioEngine } from './audio.js';

// Boot sequence, UI and the game loop.
//
// Frame order (playing):
//   1. weapon.preUpdate     aim-down-sights state, sprint blocking
//   2. player.handleInput   mouse look + movement intent
//   3. physics.step         fixed 120 Hz sub-steps (character controller runs inside)
//   4. player.updateCamera  interpolated position, bob, crouch, shake, recoil, FOV
//   5. weapon.update        firing (hitscan from the final camera), animation, FX
//   6. level.update         flicker, beacons, lamp draught, dust lighting
//   7. engine.render        shadow maps once, then the post-processing stack

const params = new URLSearchParams(window.location.search);
const AUTOPLAY = params.has('autoplay'); // automated testing: play without pointer lock
const IS_ELECTRON = navigator.userAgent.includes('Electron');

const SETTINGS_KEY = 'ultimate-3d-fps/settings/v1';
const DEFAULT_SETTINGS = {
  sensitivity: 2.2,
  fov: 78,
  invertY: false,
  volume: 0.8,
  preset: 'cinematic',
};

function loadSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
    const s = { ...DEFAULT_SETTINGS, ...stored };
    if (!PRESETS[s.preset]) s.preset = DEFAULT_SETTINGS.preset;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable (private mode etc.): settings just won't persist
  }
}

const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      resolve();
    }
  };
  requestAnimationFrame(finish);
  setTimeout(finish, 50);
});

const $ = (id) => document.getElementById(id);

/* -------------------------------------------------------------------------- */
/* UI                                                                         */
/* -------------------------------------------------------------------------- */

class UI {
  constructor() {
    this.loading = $('loading');
    this.title = $('title');
    this.pause = $('pause');
    this.hud = $('hud');
    this.error = $('error');
    this.progressBar = $('progress-bar');
    this.progressLabel = $('progress-label');
    this.ammoMag = $('ammo-mag');
    this.ammoBox = $('ammo');
    this.status = $('status');
    this.hints = $('hints');
    this.fps = $('fps');
    this.crosshair = $('crosshair');
    this.pauseNote = $('pause-note');
    this._lastAmmo = -1;
    this._lastStatus = '';
    this._fpsFrames = 0;
    this._fpsTime = 0;
    this.showFps = false;
  }

  setProgress(p, label) {
    this.progressBar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`;
    if (label) this.progressLabel.textContent = label;
  }

  show(screen) {
    for (const el of [this.loading, this.title, this.pause]) el.classList.toggle('hidden', el !== screen);
    this.hud.classList.toggle('hidden', screen !== null);
  }

  fatal(message) {
    this.error.classList.remove('hidden');
    $('error-text').textContent = message;
  }

  updateHud(dt, { weapon, player, flashlight, camera, height }) {
    if (weapon.ammo !== this._lastAmmo) {
      this._lastAmmo = weapon.ammo;
      this.ammoMag.textContent = String(weapon.ammo).padStart(2, '0');
      this.ammoBox.classList.toggle('low', weapon.ammo <= 8);
      this.ammoBox.classList.toggle('empty', weapon.ammo === 0);
    }
    let status = '';
    if (weapon.reloading) status = 'RELOADING';
    else if (weapon.ammo === 0) status = 'EMPTY — PRESS R';
    else if (!flashlight.enabled) status = 'FLASHLIGHT OFF';
    if (player.crouched) status = status ? `${status} · CROUCHED` : 'CROUCHED';
    if (status !== this._lastStatus) {
      this._lastStatus = status;
      this.status.textContent = status;
    }

    // Crosshair gap = projected bullet spread.
    const spread = weapon.currentSpread();
    const px = (Math.tan(spread) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * (height / 2);
    this.crosshair.style.setProperty('--gap', `${(4 + px).toFixed(1)}px`);
    this.crosshair.style.opacity = String(Math.max(0, 1 - weapon.aimEase * 2.5) * (weapon.sprintAmount > 0.5 ? 0.25 : 1));

    if (this.showFps) {
      this._fpsFrames++;
      this._fpsTime += dt;
      if (this._fpsTime >= 0.5) {
        this.fps.textContent = `${Math.round(this._fpsFrames / this._fpsTime)} FPS`;
        this._fpsFrames = 0;
        this._fpsTime = 0;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function boot() {
  const ui = new UI();
  window.addEventListener('error', (e) => ui.fatal(String(e.error?.stack || e.message)));
  window.addEventListener('unhandledrejection', (e) => ui.fatal(String(e.reason?.stack || e.reason)));

  const settings = loadSettings();
  const canvas = $('viewport');

  let engine;
  try {
    engine = new Engine(canvas);
  } catch (err) {
    ui.fatal(`WebGL 2 could not be initialised. Update your graphics driver.\n\n${err?.message || err}`);
    return;
  }
  if (!engine.renderer.capabilities.isWebGL2) {
    ui.fatal('This game needs WebGL 2.');
    return;
  }

  ui.setProgress(0.02, 'Initialising renderer');
  await nextFrame();

  const { materials, textures } = await generateMaterials(
    engine.renderer,
    (p, label) => ui.setProgress(0.04 + p * 0.76, label),
    { textureSize: 1024 },
  );

  ui.setProgress(0.82, 'Building Sector 7');
  await nextFrame();

  const physics = new PhysicsWorld();
  const audio = new AudioEngine();
  audio.volume = settings.volume;
  const level = buildLevel({ engine, physics, materials, textures, audio });

  const preset = PRESETS[settings.preset];
  const flashlight = new Flashlight(engine.camera, textures.flashlightCookie, { shadowMapSize: preset.shadowMapSize });
  flashlight.bounceTargets = level.bounceTargets;

  const input = new Input(canvas);
  const player = new Player({
    engine,
    physics,
    input,
    flashlight,
    spawn: level.spawn,
    spawnYaw: level.spawnYaw,
    settings,
  });

  const post = new PostProcessing(engine.renderer, engine.scene, engine.camera, engine.viewmodelCamera, { preset: settings.preset });
  engine.post = post;
  engine.setPixelRatioCap(preset.pixelRatioCap);

  const weapon = new Weapon({ engine, physics, materials, textures, audio, level, player, input, post });

  player.onFootstep = (surface, intensity, crouched) => audio.footstep(surface, intensity, crouched);
  player.onJump = () => audio.jump();
  player.onLand = (strength, surface) => {
    audio.land(strength, surface);
    post.addShock(strength * 0.8);
  };

  // Point sprites are sized in world units; convert using the current projection.
  const pointScale = () => {
    const h = engine.renderer.domElement.height;
    return h / (2 * Math.tan(THREE.MathUtils.degToRad(engine.camera.fov) / 2));
  };

  ui.setProgress(0.9, 'Compiling shaders');
  await nextFrame();
  player.handleInput({ aim: 0, blockSprint: false });
  physics.step(1 / 60);
  player.updateCamera(1 / 60);
  level.update(0, 0, { flashlight });
  try {
    await engine.renderer.compileAsync(engine.scene, engine.camera);
    await engine.renderer.compileAsync(engine.scene, engine.viewmodelCamera);
  } catch {
    // compileAsync is an optimisation only
  }
  engine.render(1 / 60);

  ui.setProgress(1, 'Ready');
  await nextFrame();

  /* ------------------------------ state machine ------------------------------ */

  let state = 'title';
  let elapsed = 0;
  let hintTimer = 0;

  const startPlaying = () => {
    state = 'playing';
    input.enabled = true;
    input.reset();
    audio.resume();
    ui.show(null);
    if (hintTimer === 0) {
      ui.hints.classList.add('visible');
      hintTimer = 0.001;
    }
  };

  const pauseGame = () => {
    if (state !== 'playing') return;
    state = 'paused';
    input.enabled = false;
    input.reset();
    audio.suspend();
    ui.pauseNote.textContent = '';
    ui.show(ui.pause);
  };

  const requestPlay = async () => {
    try {
      audio.init();
    } catch {
      // audio is optional
    }
    if (AUTOPLAY) {
      startPlaying();
      return;
    }
    try {
      await input.requestLock();
    } catch {
      // Chromium refuses to re-lock for ~1 s after the user pressed Esc.
      ui.pauseNote.textContent = 'Click again to resume.';
    }
  };

  // Resizing clears the canvas; repaint the frozen frame behind the pause menu.
  engine.onResize.push(() => {
    if (state === 'paused') engine.render(0);
  });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) startPlaying();
    else pauseGame();
  });
  window.addEventListener('blur', () => {
    if (state === 'playing') {
      input.exitLock();
      pauseGame();
    }
  });

  $('title').addEventListener('click', requestPlay);
  $('btn-resume').addEventListener('click', requestPlay);
  const quit = $('btn-quit');
  if (IS_ELECTRON) quit.addEventListener('click', () => window.close());
  else quit.classList.add('hidden');

  // settings controls
  const presetSel = $('opt-preset');
  for (const [key, p] of Object.entries(PRESETS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = p.label;
    presetSel.append(o);
  }
  presetSel.value = settings.preset;
  presetSel.addEventListener('change', () => {
    settings.preset = presetSel.value;
    const p = PRESETS[settings.preset];
    post.setPreset(settings.preset);
    engine.setPixelRatioCap(p.pixelRatioCap);
    flashlight.setShadowMapSize(p.shadowMapSize);
    saveSettings(settings);
    engine.render(0);
  });
  const bindRange = (id, key, fmt, apply = () => {}) => {
    const el = $(id);
    const out = $(`${id}-value`);
    el.value = settings[key];
    out.textContent = fmt(settings[key]);
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      out.textContent = fmt(settings[key]);
      apply(settings[key]);
      saveSettings(settings);
    });
  };
  bindRange('opt-sens', 'sensitivity', (v) => v.toFixed(1));
  bindRange('opt-fov', 'fov', (v) => `${v}°`);
  bindRange('opt-volume', 'volume', (v) => `${Math.round(v * 100)}%`, (v) => audio.setVolume(v));
  const invert = $('opt-invert');
  invert.checked = settings.invertY;
  invert.addEventListener('change', () => {
    settings.invertY = invert.checked;
    saveSettings(settings);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      ui.showFps = !ui.showFps;
      ui.fps.hidden = !ui.showFps;
    }
  });

  window.__game = { engine, physics, player, weapon, level, post, input, audio, flashlight, settings, start: startPlaying, pause: pauseGame };

  /* ------------------------------ loop ------------------------------ */

  const timer = new THREE.Timer();
  timer.connect(document);

  engine.renderer.setAnimationLoop((timestamp) => {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.1);
    if (state === 'paused') return; // the last frame stays on screen under the menu

    elapsed += dt;
    const scale = pointScale();
    level.dust.material.uniforms.uScale.value = scale;
    weapon.setScale(scale);

    if (state === 'playing') {
      if (input.wasPressed('KeyF')) {
        flashlight.toggle();
        audio.flashlight();
      }
      weapon.preUpdate(dt);
      player.handleInput({ aim: weapon.aimEase, blockSprint: weapon.blockSprint });
      physics.step(dt);
      player.updateCamera(dt);
      weapon.update(dt);
      level.update(dt, elapsed, { flashlight });
      audio.setListener(engine.camera.position, player.right);
      ui.updateHud(dt, { weapon, player, flashlight, camera: engine.camera, height: window.innerHeight });

      if (hintTimer > 0) {
        hintTimer += dt;
        if (hintTimer > 9) {
          ui.hints.classList.remove('visible');
          hintTimer = -1;
        }
      }
      input.endFrame();
    } else {
      // Title screen: the world keeps living behind the menu.
      physics.step(dt);
      player.updateCamera(dt);
      weapon.update(dt);
      level.update(dt, elapsed, { flashlight });
    }

    engine.render(dt);
  });

  ui.show(ui.title);
  if (AUTOPLAY) requestPlay();
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('error');
  if (el) {
    el.classList.remove('hidden');
    document.getElementById('error-text').textContent = String(err?.stack || err);
  }
});
