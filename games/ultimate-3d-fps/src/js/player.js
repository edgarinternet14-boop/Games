import * as THREE from 'three';
import { CANNON, GROUP, createCharacterBody, setCharacterHeight } from './physics.js';
import { PerlinNoise } from './materials.js';

// First-person controller.
//
// Physics side (fixedUpdate, 120 Hz, before the solver): ground probing with
// five downward rays, slope-aware acceleration, gravity cancelled while
// grounded (no sliding down ramps), coyote time, jump buffering, crouch with
// a head-room check before standing back up.
//
// Camera side (update, every frame): mouse look, procedural head bob driven
// by distance travelled, smooth crouch transition, landing dip spring,
// trauma-based camera shake (jump / land / fire), recoil springs, strafe
// roll, sprint FOV kick and idle breathing.

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'KeyC', 'KeyF', 'KeyR', 'Tab', 'AltLeft',
]);

export class Input {
  constructor(element) {
    this.element = element;
    this.down = new Set();
    this.pressed = new Set();
    this.buttons = 0;
    this.buttonsPressed = 0;
    this.dx = 0;
    this.dy = 0;
    this.locked = false;
    this.enabled = false; // only true while the game is being played

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat && !this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Chromium occasionally reports a huge bogus delta right after pointer
      // lock or on some mice; one of those would snap the view around.
      if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      const bit = 1 << e.button;
      if (!(this.buttons & bit)) this.buttonsPressed |= bit;
      this.buttons |= bit;
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.reset();
    });
  }

  async requestLock() {
    try {
      await this.element.requestPointerLock({ unadjustedMovement: true });
    } catch {
      // Raw input isn't available everywhere; fall back to accelerated input.
      await this.element.requestPointerLock();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  reset() {
    this.down.clear();
    this.pressed.clear();
    this.buttons = 0;
    this.buttonsPressed = 0;
    this.dx = 0;
    this.dy = 0;
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  mouseDown(button) {
    return (this.buttons & (1 << button)) !== 0;
  }

  mousePressed(button) {
    return (this.buttonsPressed & (1 << button)) !== 0;
  }

  consumeMouse() {
    const d = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  endFrame() {
    this.pressed.clear();
    this.buttonsPressed = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Springs                                                                    */
/* -------------------------------------------------------------------------- */

/** Damped spring, sub-stepped so it stays stable at low frame rates. */
export class Spring {
  constructor(stiffness, dampingRatio, value = 0) {
    this.k = stiffness;
    this.c = 2 * Math.sqrt(stiffness) * dampingRatio;
    this.value = value;
    this.velocity = 0;
    this.target = 0;
  }

  impulse(v) {
    this.velocity += v;
  }

  update(dt) {
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Frame-rate independent exponential approach. */
export function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/* -------------------------------------------------------------------------- */
/* Player                                                                     */
/* -------------------------------------------------------------------------- */

export const PLAYER = {
  radius: 0.32,
  standHeight: 1.8,
  crouchHeight: 1.15,
  eyeStand: 1.66,
  eyeCrouch: 1.02,
  mass: 80,
  walkSpeed: 3.7,
  sprintSpeed: 6.6,
  crouchSpeed: 1.9,
  aimSpeedFactor: 0.62,
  groundAccel: 13,
  groundDecel: 10,
  airAccel: 2.4,
  jumpHeight: 1.05,
  coyoteTime: 0.12,
  jumpBuffer: 0.14,
  maxGroundSlopeY: 0.6, // normal.y; ~53 degrees
  stepLengthWalk: 1.45,
  stepLengthSprint: 1.95,
  stepLengthCrouch: 1.15,
};

const PROBE_OFFSETS = [
  [0, 0],
  [0.55, 0],
  [-0.55, 0],
  [0, 0.55],
  [0, -0.55],
];
const UP_OFFSETS = [
  [0, 0],
  [0.6, 0],
  [-0.6, 0],
  [0, 0.6],
  [0, -0.6],
];

export class Player {
  /**
   * @param {object} o
   * @param {import('./engine.js').Engine} o.engine
   * @param {import('./physics.js').PhysicsWorld} o.physics
   * @param {Input} o.input
   * @param {import('./engine.js').Flashlight} o.flashlight
   * @param {THREE.Vector3} o.spawn  feet position
   * @param {number} o.spawnYaw
   */
  constructor({ engine, physics, input, flashlight, spawn, spawnYaw = 0, settings }) {
    this.engine = engine;
    this.camera = engine.camera;
    this.physics = physics;
    this.input = input;
    this.flashlight = flashlight;
    this.settings = settings;
    this.spawn = spawn.clone();
    this.spawnYaw = spawnYaw;

    this.body = createCharacterBody(physics, {
      radius: PLAYER.radius,
      height: PLAYER.standHeight,
      mass: PLAYER.mass,
      position: new THREE.Vector3(spawn.x, spawn.y + PLAYER.radius, spawn.z),
    });

    // look
    this.yaw = spawnYaw;
    this.pitch = 0;
    this.lookYawDelta = 0;
    this.lookPitchDelta = 0;

    // intent (written per frame, consumed per fixed step)
    this.wish = new THREE.Vector3();
    this.targetSpeed = PLAYER.walkSpeed;
    this.jumpBufferTimer = 0;
    this.crouchToggled = false;
    this.wantsCrouch = false;
    this.sprinting = false;
    this.moveForward = 0;
    this.moveRight = 0;

    // physics state
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 'concrete';
    this.groundGap = 0;
    this.timeSinceGrounded = 0;
    this.jumpCooldown = 0;
    this.fallSpeed = 0;
    this.crouched = false;
    this.events = { jumped: false, landed: 0 };

    // camera feel
    this.crouchAmount = 0;
    this.crouchVel = 0;
    this.bobPhase = 0;
    this.bobWeight = 0;
    this.stepIndex = 0;
    this.trauma = 0;
    this.shakeTime = 0;
    this.noise = new PerlinNoise(4242);
    this.landSpring = new Spring(160, 0.55);
    this.landPitch = new Spring(120, 0.6);
    this.recoilPitch = new Spring(220, 0.75);
    this.recoilYaw = new Spring(220, 0.8);
    this.strafeRoll = 0;
    this.fov = settings.fov;
    this.time = 0;
    this.aim = 0;

    this.velocity = new THREE.Vector3(); // interpolated, for gameplay queries
    this.horizontalSpeed = 0;
    this.position = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();

    // callbacks wired by main.js
    this.onFootstep = () => {};
    this.onJump = () => {};
    this.onLand = () => {};

    this._ray = new CANNON.RaycastResult();
    this._from = new CANNON.Vec3();
    this._to = new CANNON.Vec3();
    this._tmp = new THREE.Vector3();
    this._camPos = new THREE.Vector3();

    physics.addFixedListener((h) => this.fixedUpdate(h));
  }

  /* ------------------------------ physics ------------------------------ */

  _probeGround() {
    const b = this.body;
    const r = PLAYER.radius;
    // Allowed gap between the sphere and the ground. Larger while already
    // grounded so the player sticks to ramps and steps down small ledges.
    const tolerance = this.grounded ? 0.25 : 0.05;
    const rayLength = (r + tolerance) / PLAYER.maxGroundSlopeY + 0.05;
    let bestGap = Infinity;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let surface = 'concrete';
    for (const [ox, oz] of PROBE_OFFSETS) {
      this._from.set(b.position.x + ox * r, b.position.y, b.position.z + oz * r);
      this._to.set(this._from.x, b.position.y - rayLength, this._from.z);
      this._ray.reset();
      this.physics.world.raycastClosest(this._from, this._to, { collisionFilterMask: GROUP.STATIC | GROUP.PROP, skipBackfaces: true }, this._ray);
      if (!this._ray.hasHit) continue;
      const n = this._ray.hitNormalWorld;
      if (n.y < PLAYER.maxGroundSlopeY) continue;
      // Perpendicular distance from the sphere centre to the hit plane: exact
      // on slopes, where the vertical ray distance would overestimate the gap.
      const p = this._ray.hitPointWorld;
      const gap = (b.position.x - p.x) * n.x + (b.position.y - p.y) * n.y + (b.position.z - p.z) * n.z - r;
      if (gap < bestGap) {
        bestGap = gap;
        nx = n.x;
        ny = n.y;
        nz = n.z;
        surface = this._ray.body?.surface || 'concrete';
      }
    }
    if (bestGap <= tolerance) {
      this.groundNormal.set(nx, ny, nz);
      this.groundSurface = surface;
      this.groundGap = Math.max(0, bestGap);
      return true;
    }
    this.groundNormal.set(0, 1, 0);
    this.groundGap = 0;
    return false;
  }

  _hasHeadroom() {
    const b = this.body;
    const r = PLAYER.radius;
    const topNow = b.position.y + (PLAYER.crouchHeight - 2 * r);
    const need = PLAYER.standHeight - PLAYER.crouchHeight + 0.03;
    for (const [ox, oz] of UP_OFFSETS) {
      this._from.set(b.position.x + ox * r, topNow, b.position.z + oz * r);
      this._to.set(this._from.x, topNow + r + need, this._from.z);
      this._ray.reset();
      this.physics.world.raycastClosest(this._from, this._to, { collisionFilterMask: GROUP.STATIC | GROUP.PROP, skipBackfaces: false }, this._ray);
      if (this._ray.hasHit) return false;
    }
    return true;
  }

  fixedUpdate(h) {
    const b = this.body;
    const v = b.velocity;

    // crouch state (collider changes instantly; the camera eases)
    if (this.wantsCrouch && !this.crouched) {
      this.crouched = true;
      setCharacterHeight(b, PLAYER.radius, PLAYER.crouchHeight);
    } else if (!this.wantsCrouch && this.crouched && this._hasHeadroom()) {
      this.crouched = false;
      setCharacterHeight(b, PLAYER.radius, PLAYER.standHeight);
    }

    this.jumpCooldown -= h;
    this.jumpBufferTimer -= h;
    const wasGrounded = this.grounded;
    this.grounded = this.jumpCooldown <= 0 && this._probeGround();
    if (this.grounded) {
      if (!wasGrounded && this.fallSpeed > 0) {
        this.events.landed = Math.max(this.events.landed, this.fallSpeed);
      }
      this.timeSinceGrounded = 0;
      this.fallSpeed = 0;
    } else {
      this.timeSinceGrounded += h;
      this.fallSpeed = Math.max(0, -v.y);
    }

    const tx = this.wish.x * this.targetSpeed;
    const tz = this.wish.z * this.targetSpeed;
    const moving = this.wish.lengthSq() > 0.001;

    // jump (buffered + coyote time)
    if (this.jumpBufferTimer > 0 && this.timeSinceGrounded <= PLAYER.coyoteTime) {
      v.y = Math.sqrt(2 * 9.81 * PLAYER.jumpHeight);
      this.jumpBufferTimer = 0;
      this.jumpCooldown = 0.2;
      this.timeSinceGrounded = PLAYER.coyoteTime + 1;
      this.grounded = false;
      this.events.jumped = true;
    }

    if (this.grounded) {
      const n = this.groundNormal;
      // Keep the horizontal target and solve vy so velocity lies on the slope.
      const ty = -(n.x * tx + n.z * tz) / n.y;
      const k = 1 - Math.exp(-(moving ? PLAYER.groundAccel : PLAYER.groundDecel) * h);
      v.x += (tx - v.x) * k;
      v.z += (tz - v.z) * k;
      v.y += (ty - v.y) * k;
      // Snap down onto the ground after stepping off a small ledge or over a
      // crest, instead of hovering until gravity takes over.
      if (this.groundGap > 0.015) v.y = Math.min(v.y, -this.groundGap * 30);
      // Cancel gravity on the ground: no creeping down ramps when idle.
      b.force.y += b.mass * 9.81;
    } else if (moving) {
      const k = 1 - Math.exp(-PLAYER.airAccel * h);
      v.x += (tx - v.x) * k;
      v.z += (tz - v.z) * k;
    }

    // fell out of the world
    if (b.position.y < -25) this.respawn();
  }

  respawn() {
    const b = this.body;
    b.position.set(this.spawn.x, this.spawn.y + PLAYER.radius + 0.05, this.spawn.z);
    b.previousPosition.copy(b.position);
    b.velocity.set(0, 0, 0);
    this.yaw = this.spawnYaw;
    this.pitch = 0;
  }

  /* ------------------------------ per frame ------------------------------ */

  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Visual recoil kick (radians); part of it permanently climbs the aim. */
  applyRecoil(pitch, yaw) {
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch * 0.3, -1.52, 1.52);
    this.yaw += yaw * 0.3;
    this.recoilPitch.impulse(pitch * 22);
    this.recoilYaw.impulse(yaw * 22);
  }

  /**
   * Phase 1 (before the physics step): mouse look and movement intent.
   * @param {{ aim: number, blockSprint: boolean }} weaponState
   */
  handleInput(weaponState) {
    const input = this.input;
    this.aim = weaponState.aim;

    /* ---- look ---- */
    const { dx, dy } = input.consumeMouse();
    const zoomFactor = this.fov / this.settings.fov;
    const sens = this.settings.sensitivity * 0.001 * zoomFactor;
    const prevYaw = this.yaw;
    const prevPitch = this.pitch;
    this.yaw -= dx * sens;
    this.pitch -= dy * sens * (this.settings.invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.52, 1.52);
    this.lookYawDelta = this.yaw - prevYaw;
    this.lookPitchDelta = this.pitch - prevPitch;

    /* ---- movement intent ---- */
    const f = (input.isDown('KeyW') || input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('KeyS') || input.isDown('ArrowDown') ? 1 : 0);
    const s = (input.isDown('KeyD') || input.isDown('ArrowRight') ? 1 : 0) - (input.isDown('KeyA') || input.isDown('ArrowLeft') ? 1 : 0);
    this.moveForward = f;
    this.moveRight = s;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    this.forward.set(-sy, 0, -cy);
    this.right.set(cy, 0, -sy);
    this.wish.set(0, 0, 0).addScaledVector(this.forward, f).addScaledVector(this.right, s);
    if (this.wish.lengthSq() > 0) this.wish.normalize();

    if (input.wasPressed('KeyC')) this.crouchToggled = !this.crouchToggled;
    const holdCrouch = input.isDown('ControlLeft');
    if (holdCrouch) this.crouchToggled = false;
    this.wantsCrouch = holdCrouch || this.crouchToggled;

    const sprintKey = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    this.sprinting = sprintKey && f > 0 && !this.crouched && !weaponState.blockSprint && this.aim < 0.5;
    if (sprintKey && f > 0 && this.crouchToggled) this.crouchToggled = false; // sprinting stands you up

    let speed = this.crouched ? PLAYER.crouchSpeed : this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    if (f < 0) speed *= 0.85; // backpedal is slower
    speed *= THREE.MathUtils.lerp(1, PLAYER.aimSpeedFactor, this.aim);
    this.targetSpeed = speed;

    if (input.wasPressed('Space')) this.jumpBufferTimer = PLAYER.jumpBuffer;
  }

  /**
   * Phase 2 (after the physics step): turn the interpolated body state and
   * physics events into the final camera transform.
   * @param {number} dt
   */
  updateCamera(dt) {
    this.time += dt;

    /* ---- physics events -> feel ---- */
    if (this.events.jumped) {
      this.events.jumped = false;
      this.addTrauma(0.12);
      this.landSpring.impulse(0.55);
      this.landPitch.impulse(-0.35);
      this.onJump();
    }
    if (this.events.landed > 0) {
      const impact = this.events.landed;
      this.events.landed = 0;
      if (impact > 1.5) {
        const strength = THREE.MathUtils.clamp((impact - 1.5) / 7, 0, 1);
        this.landSpring.impulse(-0.6 - strength * 2.4);
        this.landPitch.impulse(0.4 + strength * 1.6);
        this.addTrauma(0.1 + strength * 0.5);
        this.onLand(strength, this.groundSurface);
      }
    }

    /* ---- interpolated body state ---- */
    this.physics.interpolate(this.body, this.position);
    const bv = this.body.velocity;
    this.velocity.set(bv.x, bv.y, bv.z);
    this.horizontalSpeed = Math.hypot(bv.x, bv.z);

    /* ---- crouch transition (critically damped) ---- */
    {
      const target = this.crouched ? 1 : 0;
      const k = 260;
      const c = 2 * Math.sqrt(k);
      const steps = Math.max(1, Math.ceil(dt / 0.008));
      const hh = dt / steps;
      for (let i = 0; i < steps; i++) {
        this.crouchVel += (-(this.crouchAmount - target) * k - this.crouchVel * c) * hh;
        this.crouchAmount += this.crouchVel * hh;
      }
    }
    const crouchEase = THREE.MathUtils.clamp(this.crouchAmount, -0.1, 1.1);
    const eyeHeight = THREE.MathUtils.lerp(PLAYER.eyeStand, PLAYER.eyeCrouch, crouchEase);

    /* ---- head bob: phase advances with distance walked ---- */
    const speedNorm = this.horizontalSpeed / PLAYER.walkSpeed;
    const bobTarget = this.grounded && this.horizontalSpeed > 0.4 ? Math.min(speedNorm, 1.8) : 0;
    this.bobWeight = damp(this.bobWeight, bobTarget, 8, dt);
    const stepLength = this.crouched ? PLAYER.stepLengthCrouch : this.sprinting ? PLAYER.stepLengthSprint : PLAYER.stepLengthWalk;
    if (this.grounded) {
      this.bobPhase += (this.horizontalSpeed * dt / stepLength) * Math.PI;
    }
    const stepIndex = Math.floor(this.bobPhase / Math.PI);
    if (stepIndex !== this.stepIndex) {
      this.stepIndex = stepIndex;
      if (this.grounded && this.horizontalSpeed > 0.6) {
        this.onFootstep(this.groundSurface, THREE.MathUtils.clamp(speedNorm, 0.3, 1.6), this.crouched);
      }
    }
    const amp = this.bobWeight * (this.crouched ? 0.6 : 1) * THREE.MathUtils.lerp(1, 0.25, this.aim);
    const bobY = -Math.cos(this.bobPhase * 2) * 0.026 * amp;
    const bobX = Math.sin(this.bobPhase) * 0.024 * amp;
    const bobRoll = Math.sin(this.bobPhase) * 0.0045 * amp;
    const bobPitch = Math.cos(this.bobPhase * 2) * 0.0028 * amp;

    // idle breathing when standing still
    const idle = (1 - Math.min(1, this.bobWeight)) * THREE.MathUtils.lerp(1, 0.4, this.aim);
    const breathPitch = Math.sin(this.time * 1.25) * 0.0022 * idle;
    const breathYaw = Math.sin(this.time * 0.63) * 0.0016 * idle;

    /* ---- springs, shake, roll ---- */
    this.landSpring.update(dt);
    this.landPitch.update(dt);
    this.recoilPitch.update(dt);
    this.recoilYaw.update(dt);

    this.trauma = Math.max(0, this.trauma - dt * 1.35);
    this.shakeTime += dt;
    const shake = this.trauma * this.trauma;
    const t = this.shakeTime * 16;
    const shakeYaw = 0.03 * shake * this.noise.noise1(t, 1);
    const shakePitch = 0.03 * shake * this.noise.noise1(t, 2);
    const shakeRoll = 0.045 * shake * this.noise.noise1(t, 3);
    const shakeX = 0.035 * shake * this.noise.noise1(t, 4);
    const shakeY = 0.035 * shake * this.noise.noise1(t, 5);

    const lateral = (bv.x * this.right.x + bv.z * this.right.z) / PLAYER.walkSpeed;
    this.strafeRoll = damp(this.strafeRoll, -lateral * 0.016, 6, dt);

    /* ---- FOV ---- */
    const sprintKick = this.sprinting && this.horizontalSpeed > PLAYER.walkSpeed ? 8 : 0;
    const targetFov = (this.settings.fov + sprintKick) * THREE.MathUtils.lerp(1, 0.72, this.aim);
    this.fov = damp(this.fov, targetFov, 9, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    /* ---- compose camera ---- */
    const feetY = this.position.y - PLAYER.radius;
    const cam = this._camPos.set(this.position.x, feetY + eyeHeight + this.landSpring.value * 0.12 + bobY + shakeY, this.position.z);
    cam.addScaledVector(this.right, bobX + shakeX);
    this.camera.position.copy(cam);
    this.camera.rotation.set(
      this.pitch + this.recoilPitch.value + shakePitch + bobPitch + breathPitch + this.landPitch.value * 0.03,
      this.yaw + this.recoilYaw.value + shakeYaw + breathYaw,
      bobRoll + shakeRoll + this.strafeRoll,
    );
    this.camera.updateMatrixWorld();

    this.flashlight.update(dt, this.lookYawDelta, this.lookPitchDelta);
  }
}
