/**
 * Dunebound - players.
 *
 * Input handling, the procedural builder character, the locally predicted
 * player (height-field collision, carry weight, third-person camera) and
 * interpolated remote players.
 *
 * Character animation is fully procedural. A forward-leaning run, a slow and
 * weighted walk whenever blocks are carried, idle and weary idle, airborne and
 * the lift / place / pickup actions are evaluated as flat poses, blended with
 * smoothed weights, and finally grounded: the body height is solved from the
 * legs' forward kinematics so the planted sole always meets the sand.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeTextSprite, lathe, sculpt, gauss, RigBuilder, createRigged } from './engine.js';
import { tintColor, CARRY_SCALE } from './pyramid.js';

/**
 * Network animation codes (the server accepts 0..7). GLIDE and GRAPPLE are
 * reserved for the Phase 2 traversal tools; until they get dedicated poses the
 * character model shows them with its airborne pose.
 */
export const ANIM = Object.freeze({ IDLE: 0, WALK: 1, AIR: 2, LIFT: 3, PLACE: 4, PICKUP: 5, GLIDE: 6, GRAPPLE: 7 });

/**
 * High-level locomotion state of the local player (LocalPlayer.moveState), for
 * audio, HUD and camera code. GLIDE and GRAPPLE are reserved: Phase 2 traversal
 * modes report them through LocalPlayer.registerTraversal().
 */
export const MOVE_STATE = Object.freeze({
  IDLE: 'idle',
  RUN: 'run',
  HEAVY_WALK: 'heavyWalk',
  AIR: 'air',
  GLIDE: 'glide',
  GRAPPLE: 'grapple',
});

const damp = THREE.MathUtils.damp;
const MAX_CARRY_VISUAL = 20;
const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

function dampAngle(a, b, lambda, dt) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * (1 - Math.exp(-lambda * dt));
}

// A server that predates config.player.carry used a flat 30% full-load slowdown.
const LEGACY_CARRY = Object.freeze({ base: 1, perLoad: 0.3 });

/**
 * Carry weight: the builder's speed multiplier while carrying `carried`
 * blocks with the given capacity. Mirrors playerCarryFactor() in
 * server/gameLogic.js exactly, because the server rejects faster moves: even a
 * single block slows you sharply and a full load slows you further.
 * @param {{base:number, perLoad:number}} c config.player.carry
 */
export function carryFactor(carried, capacity, c = LEGACY_CARRY) {
  if (carried <= 0) return 1;
  return c.base - c.perLoad * clamp01(carried / Math.max(1, capacity));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const GAME_KEYS = new Set(['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** Keys a focused menu control (button, tile, select) handles itself while the pointer is free. */
const CONTROL_KEYS = new Set(['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.mouseDown = false;
    this.clicked = false;
    this.enabled = true;
    this.locked = false;
    this.onLockChange = null;

    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!this.locked && tag === 'BUTTON' && CONTROL_KEYS.has(e.code)) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!this.enabled) return;
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.mouseDown = true;
      if (this.locked) this.clicked = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.mouseDown = false;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  isDown(code) {
    return this.enabled && this.keys.has(code);
  }

  wasPressed(code) {
    return this.enabled && this.pressed.has(code);
  }

  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.clicked = false;
  }

  requestLock() {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') p.catch(() => this.canvas.requestPointerLock());
    } catch {
      this.canvas.requestPointerLock();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

// ---------------------------------------------------------------------------
// Character model
// ---------------------------------------------------------------------------

// The character is a single rigidly-skinned mesh: every body part is sculpted
// procedurally (lathe profiles with muscle definition, a deformed skull,
// pleated linen, beaded collar, nemes headdress), baked into the bind pose and
// merged per material, so a fully detailed builder costs only 7 draw calls.

const RIG = [
  ['body', null, [0, 0, 0]],
  ['hips', 'body', [0, 0.95, 0]],
  ['hipL', 'hips', [0.095, -0.04, 0]],
  ['kneeL', 'hipL', [0, -0.44, 0]],
  ['hipR', 'hips', [-0.095, -0.04, 0]],
  ['kneeR', 'hipR', [0, -0.44, 0]],
  ['spine', 'hips', [0, 0.06, 0]],
  ['head', 'spine', [0, 0.615, 0]],
  ['shoulderL', 'spine', [0.235, 0.465, 0]],
  ['elbowL', 'shoulderL', [0, -0.29, 0]],
  ['shoulderR', 'spine', [-0.235, 0.465, 0]],
  ['elbowR', 'shoulderR', [0, -0.29, 0]],
];
const MATERIAL_SLOTS = ['skin', 'feature', 'linen', 'accent', 'gold', 'nemes', 'beads'];

const HEAD_R = 0.1;
const HEAD_Y = 0.115;

/** Skull shaping: taller cranium, tapered jaw and chin, cheekbones, brow and eye sockets. */
function deformHead(v) {
  const nx = v.x / HEAD_R;
  const ny = v.y / HEAD_R;
  const nz = v.z / HEAD_R;
  v.y *= 1.2;
  if (ny < 0) {
    const k = -ny;
    v.x *= 1 - 0.3 * k * k;
    v.z *= 1 - 0.08 * k;
    if (nz > 0.2) v.z += 0.012 * k * k * nz;
  }
  if (nz < -0.1 && ny > -0.3) v.z *= 1.1;
  if (nz > 0) {
    v.x *= 1 + 0.07 * gauss(ny + 0.05, 0.12);
    v.z -= 0.007 * gauss(Math.abs(nx) - 0.38, 0.1) * gauss(ny - 0.12, 0.08);
    v.z += 0.004 * gauss(ny - 0.27, 0.05) * gauss(nx, 0.5);
  }
  v.x *= 1 - 0.05 * gauss(ny - 0.4, 0.15);
  return v;
}

function headPoint(nx, ny) {
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const v = deformHead(new THREE.Vector3(nx * HEAD_R, ny * HEAD_R, nz * HEAD_R));
  v.y += HEAD_Y;
  return v;
}

function noseGeometry() {
  const g = new THREE.BufferGeometry();
  const p = [0, 0.028, 0.0, 0, -0.026, 0.03, -0.017, -0.03, 0.006, 0.017, -0.03, 0.006, 0, -0.032, -0.004, -0.008, 0.02, -0.004, 0.008, 0.02, -0.004];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((p.length / 3) * 2).fill(0), 2));
  g.setIndex([0, 1, 3, 0, 2, 1, 1, 2, 4, 1, 4, 3, 0, 5, 2, 0, 3, 6]);
  g.computeVertexNormals();
  return g;
}

/** Builds the shared bind-pose geometry (one group per material slot). Cached per block size. */
let CHARACTER_GEOMETRY = null;
function characterGeometry() {
  if (CHARACTER_GEOMETRY) return CHARACTER_GEOMETRY;
  const rb = new RigBuilder(RIG, MATERIAL_SLOTS);
  const add = (slot, geo, bone, o) => rb.add(slot, geo, bone, o);

  // ----- pelvis: pleated shendyt kilt, belt and apron -----
  const kilt = lathe([[0.268, -0.4], [0.258, -0.32], [0.236, -0.2], [0.205, -0.08], [0.182, 0.02], [0.172, 0.07]], 64);
  sculpt(kilt, (v) => {
    const a = Math.atan2(v.x, v.z);
    const t = Math.min(1, Math.max(0, (0.07 - v.y) / 0.47));
    const pleat = 1 + 0.03 * Math.sin(a * 30) * t;
    v.x *= pleat;
    v.z *= pleat * 0.86;
  });
  add('linen', kilt, 'hips');
  add('accent', lathe([[0.184, 0.02], [0.188, 0.05], [0.185, 0.085]], 40), 'hips', { s: [1, 1, 0.87] });
  add('gold', new RoundedBoxGeometry(0.075, 0.06, 0.02, 2, 0.006), 'hips', { p: [0, 0.052, 0.163] });
  const apron = new THREE.BoxGeometry(0.14, 0.34, 0.012, 1, 6, 1);
  sculpt(apron, (v) => {
    const t = (0.17 - v.y) / 0.34;
    v.x *= 1 + 0.6 * t;
    v.z += 0.02 * t * t;
  });
  add('accent', apron, 'hips', { p: [0, -0.13, 0.205], r: [-0.12, 0, 0] });
  add('gold', new THREE.BoxGeometry(0.23, 0.022, 0.014), 'hips', { p: [0, -0.295, 0.245], r: [-0.12, 0, 0] });

  // ----- legs -----
  for (const [hip, knee, s] of [['hipL', 'kneeL', 1], ['hipR', 'kneeR', -1]]) {
    const thigh = lathe([[0.058, -0.44], [0.068, -0.38], [0.082, -0.28], [0.095, -0.15], [0.1, -0.04], [0.092, 0.04], [0.0, 0.08]], 20);
    sculpt(thigh, (v) => {
      if (v.z > 0) v.z += 0.008 * gauss(v.y + 0.22, 0.08);
      v.x += s * 0.004 * gauss(v.y + 0.1, 0.1) * Math.sign(v.x * s);
    });
    add('skin', thigh, hip);
    add('skin', new THREE.SphereGeometry(0.057, 14, 10), knee, { p: [0, 0, 0.006] });
    const shin = lathe([[0.0, -0.465], [0.034, -0.455], [0.038, -0.42], [0.048, -0.33], [0.063, -0.2], [0.066, -0.12], [0.057, -0.04], [0.055, 0.0]], 20);
    sculpt(shin, (v) => {
      if (v.z < 0) v.z -= 0.016 * gauss(v.y + 0.16, 0.06);
    });
    add('skin', shin, knee);
    add('skin', new THREE.CapsuleGeometry(0.036, 0.15, 4, 12), knee, { p: [0, -0.462, 0.048], r: [Math.PI / 2, 0, 0], s: [1.15, 1, 0.62] });
    add('feature', new RoundedBoxGeometry(0.105, 0.02, 0.27, 2, 0.008), knee, { p: [0, -0.497, 0.045], color: [0.36, 0.22, 0.12] });
    add('gold', new THREE.TorusGeometry(0.043, 0.006, 6, 18), knee, { p: [0, -0.468, 0.08], s: [1.2, 0.75, 1] });
    add('gold', new THREE.TorusGeometry(0.036, 0.006, 6, 18), knee, { p: [0, -0.4, 0], r: [Math.PI / 2, 0, 0] });
  }

  // ----- torso with pectorals, abdomen, spine groove and scapulae -----
  const torso = lathe(
    [[0.152, -0.03], [0.148, 0.05], [0.15, 0.13], [0.163, 0.23], [0.177, 0.32], [0.18, 0.39], [0.168, 0.45], [0.13, 0.51], [0.075, 0.55], [0.062, 0.565]],
    40,
  );
  sculpt(torso, (v) => {
    v.x *= 1.34 * (1 + 0.08 * gauss(v.y - 0.33, 0.08));
    v.z *= 0.78;
    if (v.z > 0) {
      v.z += 0.022 * gauss(Math.abs(v.x) - 0.075, 0.055) * gauss(v.y - 0.36, 0.05);
      v.z += 0.008 * gauss(v.y - 0.17, 0.09) * gauss(v.x, 0.07) * (0.6 + 0.4 * Math.cos(((v.y - 0.06) * Math.PI) / 0.065));
      v.z -= 0.004 * gauss(v.x, 0.008) * gauss(v.y - 0.2, 0.12);
    } else {
      v.z += 0.006 * gauss(v.x, 0.015) * gauss(v.y - 0.25, 0.18);
      v.z -= 0.014 * gauss(Math.abs(v.x) - 0.09, 0.05) * gauss(v.y - 0.4, 0.06);
    }
  });
  add('skin', torso, 'spine');
  add('skin', lathe([[0.07, 0.5], [0.066, 0.56], [0.062, 0.625]], 20), 'spine');
  const collar = lathe([[0.207, 0.383], [0.19, 0.43], [0.163, 0.475], [0.125, 0.515], [0.083, 0.552]], 48);
  add('beads', collar, 'spine', { s: [1.3, 1, 0.82] });
  add('gold', lathe([[0.211, 0.376], [0.209, 0.39]], 48), 'spine', { s: [1.3, 1, 0.82] });

  // ----- head (baked 14% larger than the sculpt units for heroic proportions) -----
  rb.bones.head.scale.setScalar(1.14);
  rb.bones.head.updateMatrixWorld(true);
  const head = new THREE.SphereGeometry(HEAD_R, 40, 30, Math.PI * 1.5, Math.PI * 2);
  sculpt(head, deformHead);
  add('skin', head, 'head', { p: [0, HEAD_Y, 0] });
  const np = headPoint(0, -0.02);
  add('skin', noseGeometry(), 'head', { p: [np.x, np.y, np.z - 0.004] });
  for (const s of [1, -1]) {
    const eye = headPoint(0.36 * s, 0.13);
    add('feature', new THREE.SphereGeometry(0.0135, 14, 10), 'head', { p: [eye.x, eye.y, eye.z - 0.007], color: [0.93, 0.9, 0.85] });
    add('feature', new THREE.CircleGeometry(0.0072, 16), 'head', { p: [eye.x, eye.y, eye.z + 0.0058], r: [0, 0.28 * s, 0], color: [0.1, 0.06, 0.03] });
    add('feature', new THREE.CapsuleGeometry(0.0026, 0.034, 2, 6), 'head', {
      p: [eye.x + 0.009 * s, eye.y + 0.011, eye.z + 0.002],
      r: [0, 0.25 * s, Math.PI / 2 - 0.14 * s],
      color: [0.03, 0.03, 0.035],
    });
    const brow = headPoint(0.36 * s, 0.31);
    add('feature', new THREE.CapsuleGeometry(0.0032, 0.03, 2, 6), 'head', {
      p: [brow.x, brow.y, brow.z + 0.002],
      r: [0, 0.25 * s, Math.PI / 2 + 0.1 * s],
      color: [0.06, 0.04, 0.03],
    });
  }
  const lipU = headPoint(0, -0.36);
  add('feature', new THREE.CapsuleGeometry(0.0072, 0.026, 2, 8), 'head', { p: [lipU.x, lipU.y, lipU.z - 0.002], r: [0, 0, Math.PI / 2], s: [1, 1, 0.6], color: [0.42, 0.21, 0.17] });
  const lipL = headPoint(0, -0.45);
  add('feature', new THREE.CapsuleGeometry(0.0082, 0.022, 2, 8), 'head', { p: [lipL.x, lipL.y, lipL.z - 0.003], r: [0, 0, Math.PI / 2], s: [1, 1, 0.6], color: [0.46, 0.23, 0.19] });

  // Nemes headdress: tilted cap, gold brow band with uraeus, striped lappets and tail.
  const capXform = (geo) => {
    geo.scale(1.06, 1.14, 1.12);
    geo.rotateX(-0.6);
    geo.translate(0, 0.122, -0.008);
    return geo;
  };
  add('nemes', capXform(new THREE.SphereGeometry(0.113, 36, 18, Math.PI * 1.5, Math.PI * 2, 0, Math.PI * 0.62)), 'head');
  const edgeY = 0.113 * Math.cos(Math.PI * 0.62);
  const edgeR = 0.113 * Math.sin(Math.PI * 0.62);
  add('gold', capXform(new THREE.TorusGeometry(edgeR, 0.0075, 8, 48).rotateX(Math.PI / 2).translate(0, edgeY, 0)), 'head');
  add('gold', capXform(new THREE.ConeGeometry(0.008, 0.035, 8).translate(0, edgeY + 0.02, edgeR + 0.004)), 'head');
  add('gold', capXform(new THREE.SphereGeometry(0.011, 10, 8).translate(0, edgeY + 0.04, edgeR + 0.003)), 'head');
  for (const s of [1, -1]) {
    const lap = new THREE.BoxGeometry(0.068, 0.3, 0.016, 1, 10, 1);
    sculpt(lap, (v) => {
      const t = (0.15 - v.y) / 0.3;
      v.x *= 0.85 + 0.6 * t;
      v.z += 0.035 * t * t;
    });
    add('nemes', lap, 'head', { p: [0.118 * s, -0.055, 0.014], r: [-0.08, 0, 0.1 * s] });
  }
  add('nemes', new THREE.CylinderGeometry(0.03, 0.017, 0.21, 12), 'head', { p: [0, -0.03, -0.108], r: [0.25, 0, 0] });

  rb.bones.head.scale.setScalar(1);
  rb.bones.head.updateMatrixWorld(true);

  // ----- arms -----
  for (const [shoulder, elbow, s] of [['shoulderL', 'elbowL', 1], ['shoulderR', 'elbowR', -1]]) {
    add('skin', new THREE.SphereGeometry(0.078, 18, 12), shoulder, { p: [0, -0.018, 0], s: [1, 0.9, 1.05] });
    const upper = lathe([[0.048, -0.3], [0.055, -0.24], [0.066, -0.16], [0.068, -0.1], [0.064, -0.05], [0.058, 0.0]], 18);
    sculpt(upper, (v) => {
      if (v.z > 0) v.z += 0.009 * gauss(v.y + 0.13, 0.05);
      else v.z -= 0.005 * gauss(v.y + 0.1, 0.06);
    });
    add('skin', upper, shoulder);
    add('gold', new THREE.TorusGeometry(0.067, 0.009, 8, 22), shoulder, { p: [0, -0.07, 0], r: [Math.PI / 2, 0, 0] });
    add('skin', new THREE.SphereGeometry(0.049, 12, 10), elbow);
    add('skin', lathe([[0.032, -0.255], [0.036, -0.23], [0.047, -0.15], [0.056, -0.08], [0.052, -0.02], [0.047, 0.0]], 18), elbow);
    add('gold', new THREE.TorusGeometry(0.042, 0.011, 8, 22), elbow, { p: [0, -0.215, 0], r: [Math.PI / 2, 0, 0] });
    add('skin', new RoundedBoxGeometry(0.074, 0.088, 0.032, 2, 0.013), elbow, { p: [0, -0.3, 0.004] });
    for (let f = 0; f < 4; f++) {
      add('skin', new THREE.CapsuleGeometry(0.0085, 0.045 - Math.abs(f - 1.5) * 0.006, 2, 6), elbow, {
        p: [(f - 1.5) * 0.016, -0.37, 0.012],
        r: [0.3, 0, 0],
      });
    }
    add('skin', new THREE.CapsuleGeometry(0.0105, 0.035, 2, 6), elbow, { p: [-s * 0.034, -0.295, 0.02], r: [0.4, 0, -s * 0.6] });
  }

  CHARACTER_GEOMETRY = rb.build();
  return CHARACTER_GEOMETRY;
}

let SHARED = null;
function shared(engine, config) {
  if (SHARED && SHARED.engine === engine) return SHARED;
  const pc = config.pyramid;
  const t = engine.tex;
  SHARED = {
    engine,
    stone: new THREE.SphereGeometry(0.28, 20, 14),
    block: new RoundedBoxGeometry(pc.blockW - 0.03, pc.blockH - 0.02, pc.blockW - 0.03, 1, 0.08),
    blockH: pc.blockH,
    feature: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, clearcoat: 0.3, clearcoatRoughness: 0.3 }),
    beads: new THREE.MeshPhysicalMaterial({
      map: t.beads.map,
      normalMap: t.beads.normalMap,
      roughness: 0.32,
      metalness: 0.25,
      clearcoat: 0.8,
      clearcoatRoughness: 0.15,
    }),
    skins: [0x7a5440, 0x8f6249, 0x664534, 0xa47857, 0x58392a].map(
      (c) =>
        new THREE.MeshPhysicalMaterial({
          color: c,
          map: t.skin.map,
          roughness: 0.5,
          roughnessMap: t.skin.roughnessMap,
          normalMap: t.skin.normalMap,
          normalScale: new THREE.Vector2(0.35, 0.35),
          sheen: 0.4,
          sheenRoughness: 0.45,
          sheenColor: new THREE.Color(0.85, 0.42, 0.28),
          clearcoat: 0.12,
          clearcoatRoughness: 0.4,
        }),
    ),
  };
  for (const m of SHARED.skins) {
    m.normalMap = m.normalMap.clone();
    m.normalMap.repeat.set(3, 3);
    m.normalMap.needsUpdate = true;
  }
  return SHARED;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Two-tone nemes stripes: the player's colour alternating with gold. */
function nemesTexture(color) {
  const c = new THREE.Color(color);
  const gold = new THREE.Color(0xd9a531);
  const rows = 24;
  const data = new Uint8Array(4 * rows * 4);
  for (let y = 0; y < rows; y++) {
    const col = Math.floor(y / 2) % 2 ? gold : c;
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      data[i] = col.r * 255;
      data[i + 1] = col.g * 255;
      data[i + 2] = col.b * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, 4, rows, THREE.RGBAFormat);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Procedural animation
// ---------------------------------------------------------------------------

// A pose is a flat Float32Array with one value per animated degree of freedom
// (bone rotations in radians, body offsets in metres). Rotation signs on this
// rig (+z is the facing direction): a negative x rotation swings a thigh or an
// arm forward, a positive x rotation flexes a knee and leans the body, spine
// or head forward, and a negative x rotation flexes an elbow.
const J = Object.freeze({
  LEAN: 0, // whole-body forward lean, pivoting at the feet
  ROLL: 1, // whole-body sideways tilt
  SHIFT: 2, // lateral weight shift of the body (m, +x = the left side)
  LIFT: 3, // extra height on top of the ground contact (running flight)
  CONTACT: 4, // 1 = feet planted (body height solved from the legs), 0 = free in the air
  HIPS_X: 5,
  HIPS_Y: 6,
  HIPS_Z: 7,
  SPINE_X: 8,
  SPINE_Y: 9,
  SPINE_Z: 10,
  HEAD_X: 11,
  HEAD_Y: 12,
  HEAD_Z: 13,
  THIGH_LX: 14,
  THIGH_LZ: 15,
  KNEE_L: 16,
  THIGH_RX: 17,
  THIGH_RZ: 18,
  KNEE_R: 19,
  ARM_LX: 20,
  ARM_LY: 21,
  ARM_LZ: 22,
  ELBOW_L: 23,
  ARM_RX: 24,
  ARM_RY: 25,
  ARM_RZ: 26,
  ELBOW_R: 27,
  HOLD: 28, // how closely the carried stack follows the hands (0 = it rests at its overhead spot)
});
const POSE_SIZE = 29;
const LEG_LENGTH = 0.92; // hip joint to sole, used to keep planted feet in place during weight shifts

// Scratch poses shared by every character (animate() is synchronous).
const POSE_A = new Float32Array(POSE_SIZE);
const POSE_B = new Float32Array(POSE_SIZE);
const POSE_GAIT = new Float32Array(POSE_SIZE);
const POSE_IDLE = new Float32Array(POSE_SIZE);
const POSE = new Float32Array(POSE_SIZE);

/** Moves v towards target at a constant rate (per second). */
function ramp(v, target, rate, dt) {
  return v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt);
}

/** Periodic bump peaking at 1 where the cycle fraction u equals c; k sets how narrow it is. */
function bump(u, c, k) {
  return Math.exp(k * (Math.cos(TAU * (u - c)) - 1));
}

/** out = a + (b - a) * w, skipping the arithmetic (and stale inputs) at the ends. */
function mixPose(out, a, b, w) {
  if (w <= 0.001) {
    if (out !== a) out.set(a);
  } else if (w >= 0.999) {
    if (out !== b) out.set(b);
  } else {
    for (let i = 0; i < POSE_SIZE; i++) out[i] = a[i] + (b[i] - a[i]) * w;
  }
  return out;
}

/** Relaxed standing pose: arms at the sides, knees soft, feet planted. */
function restPose(p) {
  p.fill(0);
  p[J.CONTACT] = 1;
  p[J.HOLD] = 1;
  p[J.KNEE_L] = p[J.KNEE_R] = 0.04;
  p[J.ARM_LZ] = 0.09;
  p[J.ARM_RZ] = -0.09;
  p[J.ELBOW_L] = p[J.ELBOW_R] = -0.22;
  return p;
}

/**
 * Blends the arms towards the overhead grip under a carried stack. The grip
 * counters most of the trunk's forward pitch so the load stays balanced over
 * the feet; heavier loads bend the elbows more.
 */
function holdOverhead(p, h, w = 1) {
  const el = -0.42 - 0.12 * h;
  const arm = -2.85 - 0.8 * (p[J.LEAN] + p[J.HIPS_X] + p[J.SPINE_X]);
  p[J.ARM_LX] += (arm - p[J.ARM_LX]) * w;
  p[J.ARM_RX] += (arm - p[J.ARM_RX]) * w;
  p[J.ARM_LY] -= p[J.ARM_LY] * w;
  p[J.ARM_RY] -= p[J.ARM_RY] * w;
  p[J.ARM_LZ] += (0.32 - p[J.ARM_LZ]) * w;
  p[J.ARM_RZ] += (-0.32 - p[J.ARM_RZ]) * w;
  p[J.ELBOW_L] += (el - p[J.ELBOW_L]) * w;
  p[J.ELBOW_R] += (el - p[J.ELBOW_R]) * w;
}

/** Keeps both feet where they are while the pelvis rolls and the body shifts sideways; spread widens the stance. */
function plantFeet(p, spread) {
  const foot = p[J.SHIFT] / LEG_LENGTH;
  p[J.THIGH_LZ] = -p[J.HIPS_Z] - foot + spread;
  p[J.THIGH_RZ] = -p[J.HIPS_Z] - foot - spread;
}

/** Thigh swing amplitude (rad) of the run at ground speed v. */
const runReach = (v) => 0.28 + 0.55 * clamp01(v / 7);
/** Thigh swing amplitude (rad) of the heavy walk: longer, deliberate strides as the pace rises. */
const heavyReach = (v, h) => Math.min(0.7, 0.34 + 0.1 * v) * (1 - 0.15 * h);

// Running stride, per leg, with u the leg's cycle fraction (0 = its foot strike)
// and thigh angles measured from the vertical (forward positive). The thigh
// peaks forward late in the swing and retracts into the strike so the foot
// lands under the hips. The knee is nearly straight at the strike, gives a
// little as the leg takes the weight, snaps straight to push off, then folds
// fast after toe-off and stays tucked while the leg swings forward, opening
// again just before the next strike.
const runAbsorb = (u) => bump(u, 0.1, 12);
const runTuck = (u) => smooth01((u - 0.3) / 0.17) * (1 - smooth01((u - 0.78) / 0.2));
const runThigh = (u, reach, absorb) => 0.2 + reach * Math.cos(TAU * (u - 0.8)) + 0.3 * absorb * runAbsorb(u);
const runKnee = (u, absorb, tuck) => 0.18 + absorb * runAbsorb(u) - 0.12 * bump(u, 0.3, 20) + tuck * runTuck(u);

/** Forward run. u: the left leg's cycle fraction, v: ground speed (m/s). */
function runPose(p, u, v) {
  restPose(p);
  const s = clamp01(v / 7);
  const reach = runReach(v);
  const absorb = 0.16 + 0.26 * s;
  const tuck = 0.7 + 1.2 * s;
  const uR = (u + 0.5) % 1;
  const fL = runThigh(u, reach, absorb);
  const fR = runThigh(uR, reach, absorb);
  const step = (u * 2) % 1;
  const impact = bump(step, 0.1, 10);
  const twist = (fL - fR) / (2 * reach); // +1 with the left leg forward
  // Lean into the run from the ankles and through the spine, more the faster you go.
  p[J.LEAN] = 0.03 + 0.08 * s;
  p[J.SPINE_X] = 0.04 + 0.16 * s + 0.03 * s * impact;
  p[J.THIGH_LX] = -fL - p[J.LEAN];
  p[J.THIGH_RX] = -fR - p[J.LEAN];
  p[J.KNEE_L] = runKnee(u, absorb, tuck);
  p[J.KNEE_R] = runKnee(uR, absorb, tuck);
  // Flight between steps lifts the body off the stance leg; it is lowest as each foot lands.
  p[J.LIFT] = (0.015 + 0.05 * s) * bump(step, 0.76, 5);
  // Pelvis and shoulders counter-rotate; the head keeps facing forward with the eyes level.
  p[J.HIPS_Y] = -0.12 * s * twist;
  p[J.SPINE_Y] = 0.28 * s * twist;
  p[J.HEAD_Y] = -0.16 * s * twist;
  p[J.HIPS_Z] = 0.04 * s * Math.cos(TAU * (u - 0.18));
  p[J.SPINE_Z] = -0.7 * p[J.HIPS_Z];
  plantFeet(p, -0.015);
  p[J.HEAD_X] = 0.04 - p[J.LEAN] - p[J.SPINE_X];
  // Arms pump opposite to the legs with the elbows bent 70-90 degrees.
  const swing = 0.35 + 0.6 * s;
  const aL = (fR - 0.2) / reach;
  const aR = (fL - 0.2) / reach;
  p[J.ARM_LX] = 0.15 - swing * aL;
  p[J.ARM_RX] = 0.15 - swing * aR;
  p[J.ARM_LY] = -0.2 * s * Math.max(0, aL);
  p[J.ARM_RY] = 0.2 * s * Math.max(0, aR);
  p[J.ARM_LZ] = 0.14;
  p[J.ARM_RZ] = -0.14;
  p[J.ELBOW_L] = -(0.6 + 0.7 * s) - 0.5 * s * Math.max(0, aL);
  p[J.ELBOW_R] = -(0.6 + 0.7 * s) - 0.5 * s * Math.max(0, aR);
  return p;
}

// Heavy walk, per leg: bent-kneed, with a heel strike, deep knee absorption
// right after the plant and a low foot clearance through the swing. Stance
// knee flex is paired with thigh flex so the planted sandal stays flat and the
// whole drop shows in the body.
const heavyAbsorb = (u) => bump(u, 0.07, 18);
const heavySwing = (u) => smooth01((u - 0.47) / 0.12) * (1 - smooth01((u - 0.8) / 0.16));
const heavyThigh = (u, reach, bend, absorb) => -0.04 + reach * Math.cos(TAU * (u - 0.92)) + 0.7 * (bend + absorb * heavyAbsorb(u));
const heavyKnee = (u, bend, absorb, lift) => bend + absorb * heavyAbsorb(u) + lift * heavySwing(u);

/**
 * Time warp for the heavy walk: within each step the pose lingers just after
 * the foot plant (the stomp hold) and hurries through the swing. hold < 1.
 */
function warpStride(u, hold) {
  const s2 = u * 2;
  const half = Math.floor(s2);
  const v = s2 - half;
  const w = v - (hold / TAU) * (Math.sin(TAU * (v - 0.07)) - Math.sin(-TAU * 0.07));
  return (half + w) / 2;
}

/** Slow, burdened walk under an overhead load. u: warped left-leg cycle fraction, h: load heft 0..1. */
function heavyPose(p, u, v, h) {
  restPose(p);
  const reach = heavyReach(v, h);
  const bend = 0.1 + 0.12 * h;
  const absorb = 0.4 + 0.4 * h;
  const lift = (0.85 + 0.05 * Math.min(v, 4)) * (1 - 0.15 * h);
  const uR = (u + 0.5) % 1;
  const fL = heavyThigh(u, reach, bend, absorb);
  const fR = heavyThigh(uR, reach, bend, absorb);
  const impact = bump((u * 2) % 1, 0.07, 12);
  const sway = Math.sin(TAU * (u - 0.06)); // +1 mid left stance
  const twist = (fL - fR) / (2 * reach);
  p[J.LEAN] = 0.05 + 0.05 * h;
  p[J.THIGH_LX] = -fL - p[J.LEAN];
  p[J.THIGH_RX] = -fR - p[J.LEAN];
  p[J.KNEE_L] = heavyKnee(u, bend, absorb, lift);
  p[J.KNEE_R] = heavyKnee(uR, bend, absorb, lift);
  // Weight rolls over each stance leg: the body shifts across, the pelvis drops on the swing side
  // and the trunk leans out over the planted foot.
  p[J.SHIFT] = (0.05 + 0.05 * h) * sway;
  p[J.HIPS_Z] = (0.07 + 0.07 * h) * sway;
  const lean = (0.04 + 0.05 * h) * sway;
  p[J.SPINE_Z] = -p[J.HIPS_Z] - lean;
  p[J.HEAD_Z] = 0.6 * lean;
  plantFeet(p, 0.05 + 0.03 * h);
  // Hunched under the load (LEAN above), folding a little further with every plant.
  p[J.SPINE_X] = 0.07 + 0.08 * h + (0.03 + 0.04 * h) * impact;
  p[J.HIPS_Y] = -0.05 * twist;
  p[J.SPINE_Y] = 0.07 * twist;
  p[J.HEAD_X] = 0.16 - p[J.LEAN] - p[J.SPINE_X] + 0.05 * impact;
  holdOverhead(p, h);
  return p;
}

/** Empty-handed idle: breathing, a slow weight shift and the odd glance around. */
function idlePose(p, t, seed) {
  restPose(p);
  const breath = Math.sin(t * 1.8);
  const shift = Math.sin(t * 0.37 + seed);
  p[J.SHIFT] = 0.012 * shift;
  p[J.HIPS_Z] = 0.022 * shift;
  p[J.SPINE_Z] = -0.022 * shift;
  plantFeet(p, 0.02);
  p[J.THIGH_LX] = -0.03;
  p[J.THIGH_RX] = 0.03;
  p[J.KNEE_L] = 0.05 + 0.06 * Math.max(0, -shift);
  p[J.KNEE_R] = 0.05 + 0.06 * Math.max(0, shift);
  p[J.SPINE_X] = 0.02 + breath * 0.012;
  p[J.HEAD_X] = -0.01 - breath * 0.006 + 0.03 * Math.sin(t * 0.5 + seed);
  p[J.HEAD_Y] = 0.18 * Math.sin(t * 0.21 + seed) * Math.sin(t * 0.13 + 2 * seed);
  p[J.ARM_LX] = 0.03 - breath * 0.012;
  p[J.ARM_RX] = 0.05 - breath * 0.012;
  return p;
}

/**
 * Weary idle under a load: bent knees, laboured breathing, the weight sagging
 * from leg to leg, and every few seconds a quick re-brace (a dip, then a shove
 * of the stack back up).
 */
function wearyPose(p, t, h, seed) {
  restPose(p);
  const breath = Math.sin(t * (2.3 + h));
  const shift = Math.sin(t * 0.55 + seed);
  const bend = 0.22 + 0.24 * h;
  const brace = (t / (4.2 + 0.2 * seed) + seed) % 1;
  const dip = bump(brace, 0.5, 80);
  const shove = bump(brace, 0.56, 80);
  p[J.KNEE_L] = bend + 0.1 * Math.max(0, -shift) + 0.22 * dip;
  p[J.KNEE_R] = bend + 0.1 * Math.max(0, shift) + 0.22 * dip;
  p[J.LEAN] = 0.04 + 0.05 * h;
  p[J.THIGH_LX] = -0.45 * p[J.KNEE_L] - p[J.LEAN];
  p[J.THIGH_RX] = -0.45 * p[J.KNEE_R] - p[J.LEAN];
  p[J.SHIFT] = (0.02 + 0.025 * h) * shift;
  p[J.HIPS_Z] = (0.03 + 0.04 * h) * shift;
  p[J.SPINE_Z] = -1.2 * p[J.HIPS_Z];
  plantFeet(p, 0.04);
  p[J.SPINE_X] = 0.08 + 0.1 * h + (0.02 + 0.025 * h) * breath + 0.05 * dip;
  p[J.HEAD_X] = 0.14 + 0.08 * h - 0.03 * breath;
  holdOverhead(p, h);
  p[J.ARM_LX] -= 0.025 * breath;
  p[J.ARM_RX] -= 0.025 * breath;
  p[J.ELBOW_L] += 0.18 * shove - 0.2 * dip;
  p[J.ELBOW_R] += 0.18 * shove - 0.2 * dip;
  return p;
}

/** Airborne: legs tucked, arms thrown out; a loaded builder barely tucks and keeps the stack overhead. */
function airPose(p, cw, h) {
  restPose(p);
  p[J.CONTACT] = 0;
  const k = 1 - 0.45 * cw;
  p[J.THIGH_LX] = -0.55 * k;
  p[J.THIGH_RX] = -0.15 * k;
  p[J.KNEE_L] = 1.0 * k;
  p[J.KNEE_R] = 0.1 + 0.5 * k;
  p[J.SPINE_X] = 0.06;
  p[J.HEAD_X] = -0.04;
  p[J.ARM_LX] = p[J.ARM_RX] = -0.9;
  p[J.ARM_LZ] = 0.4;
  p[J.ARM_RZ] = -0.4;
  p[J.ELBOW_L] = p[J.ELBOW_R] = -0.45;
  if (cw > 0.001) holdOverhead(p, h, cw);
  return p;
}

/** Layers a lift / place / pickup action over the current pose. actionT: action progress 0..1. */
function actionPose(p, anim, actionT) {
  const t = Math.sin(Math.PI * clamp01(actionT));
  const to = (j, v) => (p[j] += (v - p[j]) * t);
  if (anim === ANIM.LIFT) {
    // Squat and press a lifting stone overhead (the pose loops for repeated reps).
    const d = 1 - t;
    p[J.LEAN] = p[J.SHIFT] = p[J.LIFT] = 0;
    p[J.HIPS_Y] = p[J.HIPS_Z] = p[J.SPINE_Y] = p[J.SPINE_Z] = p[J.HEAD_Y] = p[J.HEAD_Z] = 0;
    p[J.CONTACT] = 1;
    p[J.HOLD] = 0;
    p[J.THIGH_LX] = p[J.THIGH_RX] = -0.85 * d;
    p[J.THIGH_LZ] = 0.06;
    p[J.THIGH_RZ] = -0.06;
    p[J.KNEE_L] = p[J.KNEE_R] = 1.5 * d;
    p[J.SPINE_X] = 0.25 * d;
    p[J.HEAD_X] = -0.12 * d;
    p[J.ARM_LX] = p[J.ARM_RX] = -0.9 - 2.0 * t;
    p[J.ARM_LY] = p[J.ARM_RY] = 0;
    p[J.ARM_LZ] = 0.35;
    p[J.ARM_RZ] = -0.35;
    p[J.ELBOW_L] = p[J.ELBOW_R] = -0.9 * d - 0.15;
  } else if (anim === ANIM.PLACE) {
    // Dip the stack forward and lean in to set the top block; the rest stays in the hands.
    to(J.ARM_LX, -2.1);
    to(J.ARM_RX, -2.1);
    to(J.SPINE_X, 0.3);
  } else if (anim === ANIM.PICKUP) {
    // Bend at the knees and hips and reach down to the pile.
    to(J.SPINE_X, 0.75);
    to(J.HEAD_X, -0.4);
    to(J.THIGH_LX, -0.6);
    to(J.THIGH_RX, -0.6);
    to(J.KNEE_L, 0.95);
    to(J.KNEE_R, 0.95);
    to(J.ARM_LX, -1.3);
    to(J.ARM_RX, -1.3);
    to(J.ELBOW_L, -0.3);
    to(J.ELBOW_R, -0.3);
  }
  return p;
}

/** Occasional strain bursts under a load (0..1); heavier loads strain more often. */
function strainEnvelope(t, seed, h) {
  const n = Math.sin(t * 0.83 + seed) * Math.sin(t * 0.37 + seed * 1.7);
  return smooth01((n - (0.55 - 0.35 * h)) / 0.25);
}

// Sole contact points (heel and toe) in the knee bone's frame. The toe point sits a little behind
// the sandal tip, as if the toes flexed, so a push-off does not lever the whole body up.
const SOLE = [new THREE.Vector3(0, -0.505, -0.075), new THREE.Vector3(0, -0.505, 0.12)];
// Fingertip grip in the elbow bone's frame, and where the stack rests in body space when it does
// not follow the hands.
const GRIP = new THREE.Vector3(0, -0.36, 0.01);
const STACK_REST = new THREE.Vector3(0, 2.1, 0);
const SETTLE_GRAVITY = 30; // m/s^2, how fast the body settles onto a lower foot
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();

export class CharacterModel {
  constructor(engine, config, color, seedName = '') {
    const S = shared(engine, config);
    const M = engine.materials;
    this.engine = engine;
    this.S = S;
    const seed = hashString(seedName);
    this.accent = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness: 0.62, sheen: 0.5, sheenRoughness: 0.6 });
    this.nemesTex = nemesTexture(color);
    this.headMat = new THREE.MeshPhysicalMaterial({ map: this.nemesTex, roughness: 0.55, sheen: 0.4, sheenRoughness: 0.5, side: THREE.DoubleSide });
    const materials = {
      skin: S.skins[seed % S.skins.length],
      feature: S.feature,
      linen: M.linen,
      accent: this.accent,
      gold: M.gold,
      nemes: this.headMat,
      beads: S.beads,
    };

    this.root = new THREE.Group();
    const rigged = createRigged(characterGeometry(), RIG, MATERIAL_SLOTS.map((k) => materials[k]));
    const map = rigged.bones;
    this.bones = map;
    this.mesh = rigged.mesh;
    this.root.add(this.mesh);
    this.root.scale.setScalar(0.95 + ((seed >>> 8) % 100) / 900);

    this.body = map.body;
    this.hips = map.hips;
    this.spine = map.spine;
    this.head = map.head;
    this.legL = { hip: map.hipL, knee: map.kneeL };
    this.legR = { hip: map.hipR, knee: map.kneeR };
    this.armL = { shoulder: map.shoulderL, elbow: map.elbowL };
    this.armR = { shoulder: map.shoulderR, elbow: map.elbowR };
    this.legs = [this.legL, this.legR];

    this.liftStone = new THREE.Mesh(S.stone, M.rock);
    this.liftStone.castShadow = true;
    this.liftStone.position.set(0, 1.6, 0.12);
    this.liftStone.visible = false;
    this.body.add(this.liftStone);

    this.carryMesh = new THREE.InstancedMesh(S.block, M.block, MAX_CARRY_VISUAL);
    this.carryMesh.castShadow = true;
    this.carryMesh.receiveShadow = true;
    this.carryMesh.count = 0;
    this.carryMesh.frustumCulled = false;
    this.carryMesh.position.copy(STACK_REST);
    this.body.add(this.carryMesh);
    this.carryCount = 0;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(CARRY_SCALE, CARRY_SCALE, CARRY_SCALE);
    this._e = new THREE.Euler();

    this.seed = (seed % 6283) / 1000; // per-character offset (radians) for idle fidgets
    this.phase = Math.random() * 10; // gait clock: one stride per 2*PI, left foot strikes at multiples of 2*PI
    this.step = Math.floor(this.phase / Math.PI);
    this.walk = 0; // locomotion blend, 0 standing .. 1 moving
    this.time = Math.random() * 10;
    this.speed = 0; // smoothed ground speed
    // Blend weights: linear ramps eased with smoothstep, so a pose change starts and ends gently.
    this.carryRamp = 0;
    this.airRamp = 0;
    this.actionRamp = 0;
    this.carryBlend = 0; // 0 run / idle .. 1 heavy walk / weary idle
    this.airBlend = 0;
    this.actionBlend = 0;
    this.action = ANIM.IDLE; // last action played, kept while it fades out
    this.actionT = 0;
    this.heft = 0.4; // how heavy the current load looks, 0..1
    this.airTime = 0;
    this.groundY = 0.04; // body height above the root from the ground contact solve
    this.groundV = 0;
    // Carried-stack dynamics: vertical give (m), sideways roll and forward pitch (rad), with velocities.
    this.stack = { d: 0, dv: 0, r: 0, rv: 0, p: 0, pv: 0 };
    /** Called on every foot plant with { heavy, intensity, x, y, z, side }; owners forward it. */
    this.onFootstep = null;
    this.nameTag = null;
  }

  setName(name, color) {
    if (this.nameTag) {
      this.root.remove(this.nameTag);
      this.nameTag.material.map.dispose();
      this.nameTag.material.dispose();
    }
    this.nameTag = makeTextSprite(name, {
      font: '600 44px "Segoe UI", system-ui, sans-serif',
      height: 64,
      color,
      outlineWidth: 6,
      scale: 0.42,
    });
    this.nameTag.position.y = 2.45;
    this.root.add(this.nameTag);
  }

  setColor(color) {
    this.accent.color.set(color);
    const old = this.nemesTex;
    this.nemesTex = nemesTexture(color);
    this.headMat.map = this.nemesTex;
    this.headMat.needsUpdate = true;
    old.dispose();
  }

  setCarry(blocks) {
    const n = Math.min(MAX_CARRY_VISUAL, blocks.length);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) this.carryMesh.setColorAt(i, tintColor(blocks[i], c));
    if (this.carryMesh.instanceColor) this.carryMesh.instanceColor.needsUpdate = true;
    this.carryMesh.count = n;
    this.carryCount = n;
    if (n === 0) {
      this.carryMesh.position.copy(STACK_REST);
      this.carryMesh.rotation.set(0, 0, 0);
    }
    this._layoutStack();
  }

  stackHeight() {
    return this.carryCount * this.S.blockH * CARRY_SCALE;
  }

  /** World position of the top carried block (where placement animations start). */
  carryTopWorld(target = new THREE.Vector3()) {
    if (this.carryCount > 0) {
      this.carryMesh.getMatrixAt(this.carryCount - 1, this._m4);
      target.setFromMatrixPosition(this._m4);
    } else {
      target.set(0, 0, 0);
    }
    this.carryMesh.updateWorldMatrix(true, false);
    return this.carryMesh.localToWorld(target);
  }

  /**
   * Advances the animation by dt.
   * @param {number} dt
   * @param {{speed:number, airborne:boolean, anim:number, actionT:number, load?:number}} s
   *   load: carried / capacity when known (the local player); otherwise judged from the stack size.
   */
  animate(dt, s) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const t = this.time;
    const n = this.carryCount;
    const carrying = n > 0;
    const speed = Math.max(0, s.speed || 0);
    const airborne = !!s.airborne;
    const anim = s.anim;

    // ----- blend weights -----
    const prevSpeed = this.speed;
    this.speed = damp(this.speed, Math.min(speed, 20), 6, dt);
    const accel = dt > 0 ? (this.speed - prevSpeed) / dt : 0;
    this.walk = damp(this.walk, smooth01((speed - 0.25) / 1.1), 7, dt);
    // Picking up kills the run within ~0.12 s; setting the load down eases back over 0.35 s.
    this.carryRamp = ramp(this.carryRamp, carrying ? 1 : 0, carrying ? 1 / 0.12 : 1 / 0.35, dt);
    this.carryBlend = smooth01(this.carryRamp);
    this.airRamp = ramp(this.airRamp, airborne ? 1 : 0, airborne ? 1 / 0.16 : 1 / 0.12, dt);
    this.airBlend = smooth01(this.airRamp);
    const acting = anim === ANIM.LIFT || anim === ANIM.PLACE || anim === ANIM.PICKUP;
    if (acting) {
      this.action = anim;
      this.actionT = s.actionT || 0;
    }
    this.actionRamp = ramp(this.actionRamp, acting ? 1 : 0, 1 / 0.14, dt);
    this.actionBlend = smooth01(this.actionRamp);
    if (carrying) {
      // More blocks, and a fuller load relative to capacity, look heavier.
      const stackTerm = 1 - Math.exp(-(n - 1) / 5);
      const fill = typeof s.load === 'number' ? clamp01(s.load) : stackTerm;
      this.heft = damp(this.heft, 0.25 + 0.3 * fill + 0.45 * stackTerm, 4, dt);
    }
    const h = this.heft;
    const v = this.speed;
    const cw = this.carryBlend;

    // ----- gait clock and foot plants -----
    // Stride rates (cycles/s), matched to each gait's swing reach so the planted feet stay put.
    // Past full reach (fast runs, light loads at high Speed) only a quicker cadence keeps them planted.
    const fRun = 1.25 + 0.1 * v + 0.1 * Math.max(0, v - 12);
    const fHeavy = Math.min(2.4, (1.05 * v) / (4 * LEG_LENGTH * Math.sin(heavyReach(v, h)))) + 0.15 * Math.max(0, v - 6.5);
    this.phase += dt * TAU * (fRun + (fHeavy - fRun) * cw) * smooth01(v / 0.6);
    const step = Math.floor(this.phase / Math.PI);
    if (step !== this.step) {
      this.step = step;
      if (this.walk > 0.35 && this.airBlend < 0.5 && speed > 0.3) {
        const intensity = carrying ? 0.45 + 0.55 * h : Math.min(0.7, 0.12 + 0.055 * v);
        this._plant(step % 2 === 0 ? 'L' : 'R', carrying, intensity);
      }
    }
    if (airborne) {
      this.airTime += dt;
    } else {
      if (this.airTime > 0.2) this._plant(this.step % 2 === 0 ? 'L' : 'R', carrying, carrying ? Math.min(1, 0.75 + 0.25 * h) : Math.min(0.85, 0.35 + 0.5 * this.airTime));
      this.airTime = 0;
    }

    // ----- evaluate and blend poses -----
    const u = (this.phase / TAU) % 1;
    if (this.walk > 0.001) {
      if (cw < 0.999) runPose(POSE_A, u, v);
      if (cw > 0.001) heavyPose(POSE_B, warpStride(u, 0.35 + 0.3 * h), v, h);
      mixPose(POSE_GAIT, POSE_A, POSE_B, cw);
    }
    if (this.walk < 0.999) {
      if (cw < 0.999) idlePose(POSE_A, t, this.seed);
      if (cw > 0.001) wearyPose(POSE_B, t, h, this.seed);
      mixPose(POSE_IDLE, POSE_A, POSE_B, cw);
    }
    const P = mixPose(POSE, POSE_IDLE, POSE_GAIT, this.walk);
    if (this.airBlend > 0.001) mixPose(P, P, airPose(POSE_A, cw, h), this.airBlend);
    if (this.actionBlend > 0.001) {
      POSE_A.set(P);
      mixPose(P, P, actionPose(POSE_A, this.action, this.actionT), this.actionBlend);
    }
    if (carrying) this._stackDynamics(dt, P, accel, cw);

    this._applyPose(P, dt);
    if (carrying) this._layoutStack(P);
    // The training stone sits between the palms.
    this.liftStone.visible = anim === ANIM.LIFT && !carrying;
    if (this.liftStone.visible) {
      this._hands(this.liftStone.position);
      this.liftStone.position.y += 0.04;
    }
    if (this.nameTag) this.nameTag.position.y = 2.45 + this.stackHeight();
  }

  /** Foot plant: kicks the carried stack and reports the footstep. */
  _plant(side, heavy, intensity) {
    if (heavy) {
      const st = this.stack;
      st.dv -= (0.25 + 0.3 * this.heft) * intensity;
      st.rv += (side === 'L' ? 1 : -1) * (0.2 + 0.2 * this.heft) * intensity;
      st.pv += 0.25 * intensity;
    }
    if (!this.onFootstep) return;
    const r = this.root;
    const lx = (side === 'L' ? 0.11 : -0.11) * r.scale.x;
    const lz = 0.1 * r.scale.x;
    const c = Math.cos(r.rotation.y);
    const sn = Math.sin(r.rotation.y);
    this.onFootstep({ heavy, intensity, x: r.position.x + lx * c + lz * sn, y: r.position.y, z: r.position.z - lx * sn + lz * c, side });
  }

  /**
   * Springy secondary motion of the carried stack (it gives, sways and settles
   * after every plant) plus occasional strain tremble, fed into the arms that
   * hold it.
   */
  _stackDynamics(dt, P, accel, cw) {
    const st = this.stack;
    const n = this.carryCount;
    const wd = (TAU * 1.7) / Math.sqrt(1 + 0.08 * n);
    const ws = (TAU * 1.6) / Math.sqrt(1 + 0.1 * n);
    const rollEq = -0.45 * P[J.SHIFT];
    const pitchEq = Math.max(-0.08, Math.min(0.08, -0.006 * accel));
    const steps = Math.max(1, Math.ceil(dt * 120));
    const hdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      st.dv += (-wd * wd * st.d - 0.4 * wd * st.dv) * hdt;
      st.d += st.dv * hdt;
      st.rv += (-ws * ws * (st.r - rollEq) - 0.5 * ws * st.rv) * hdt;
      st.r += st.rv * hdt;
      st.pv += (-ws * ws * (st.p - pitchEq) - 0.44 * ws * st.pv) * hdt;
      st.p += st.pv * hdt;
    }
    st.d = Math.max(-0.07, Math.min(0.05, st.d));
    st.r = Math.max(-0.12, Math.min(0.12, st.r));
    st.p = Math.max(-0.12, Math.min(0.12, st.p));

    // The elbows give under the load; the shoulders roll forward with them so the hands sink
    // roughly straight down instead of swinging back behind the head.
    const k = cw * P[J.HOLD];
    const give = (k * st.d) / 0.12;
    P[J.ELBOW_L] += give;
    P[J.ELBOW_R] += give;
    P[J.ARM_LX] -= 0.8 * give;
    P[J.ARM_RX] -= 0.8 * give;
    P[J.ARM_LZ] += k * 0.35 * st.r;
    P[J.ARM_RZ] += k * 0.35 * st.r;
    const t = this.time;
    const shake = k * strainEnvelope(t, this.seed, this.heft) * (0.012 + 0.02 * this.heft);
    if (shake > 0) {
      P[J.ARM_LX] += shake * Math.sin(t * 37);
      P[J.ARM_RX] += shake * Math.sin(t * 41 + 2);
      P[J.ARM_LZ] += shake * 0.6 * Math.sin(t * 29 + 1);
      P[J.ARM_RZ] -= shake * 0.6 * Math.sin(t * 31);
      P[J.ELBOW_L] += shake * Math.sin(t * 47 + 0.5);
      P[J.ELBOW_R] += shake * Math.sin(t * 43 + 1.5);
    }
  }

  _applyPose(P, dt) {
    this.body.rotation.set(P[J.LEAN], 0, P[J.ROLL]);
    this.hips.rotation.set(P[J.HIPS_X], P[J.HIPS_Y], P[J.HIPS_Z]);
    this.spine.rotation.set(P[J.SPINE_X], P[J.SPINE_Y], P[J.SPINE_Z]);
    this.head.rotation.set(P[J.HEAD_X], P[J.HEAD_Y], P[J.HEAD_Z]);
    this.legL.hip.rotation.set(P[J.THIGH_LX], 0, P[J.THIGH_LZ]);
    this.legL.knee.rotation.set(P[J.KNEE_L], 0, 0);
    this.legR.hip.rotation.set(P[J.THIGH_RX], 0, P[J.THIGH_RZ]);
    this.legR.knee.rotation.set(P[J.KNEE_R], 0, 0);
    this.armL.shoulder.rotation.set(P[J.ARM_LX], P[J.ARM_LY], P[J.ARM_LZ]);
    this.armL.elbow.rotation.set(P[J.ELBOW_L], 0, 0);
    this.armR.shoulder.rotation.set(P[J.ARM_RX], P[J.ARM_RY], P[J.ARM_RZ]);
    this.armR.elbow.rotation.set(P[J.ELBOW_R], 0, 0);

    // Ground the body: solve its height from the legs so the lowest sole rests on the sand. Feet
    // never sink, but when the supporting sole lifts away (a toe-off flick) the body settles with a
    // gravity-like fall instead of snapping down to the next-lowest point.
    this.hips.updateMatrix();
    this.spine.updateMatrix();
    const bodyRot = _mA.makeRotationFromEuler(this.body.rotation);
    let low = Infinity;
    for (const leg of this.legs) {
      leg.hip.updateMatrix();
      leg.knee.updateMatrix();
      _mB.multiplyMatrices(bodyRot, this.hips.matrix).multiply(leg.hip.matrix).multiply(leg.knee.matrix);
      for (const p of SOLE) low = Math.min(low, _vA.copy(p).applyMatrix4(_mB).y);
    }
    const target = -low * P[J.CONTACT];
    if (target >= this.groundY) {
      this.groundY = target;
      this.groundV = 0;
    } else {
      this.groundV -= SETTLE_GRAVITY * dt;
      this.groundY += this.groundV * dt;
      if (this.groundY <= target) {
        this.groundY = target;
        this.groundV = 0;
      }
    }
    this.body.position.set(P[J.SHIFT], this.groundY + P[J.LIFT], 0);
  }

  /** Grip point of one hand in body space (bone matrices must be current). */
  _grip(arm, out) {
    arm.shoulder.updateMatrix();
    arm.elbow.updateMatrix();
    _mB.multiplyMatrices(this.hips.matrix, this.spine.matrix).multiply(arm.shoulder.matrix).multiply(arm.elbow.matrix);
    return out.copy(GRIP).applyMatrix4(_mB);
  }

  /** Midpoint of both grips in body space, leaving the left grip in _vA and the right in _vB (call after _applyPose). */
  _hands(out) {
    this._grip(this.armL, _vA);
    this._grip(this.armR, _vB);
    return out.addVectors(_vA, _vB).multiplyScalar(0.5);
  }

  /**
   * Places the carried stack on the hands (kept level against the body lean) and
   * stacks the blocks with a little shear from the sway springs, so the top of
   * the stack swings the most. Tall stacks are balanced more carefully: less of
   * the hands' tilt and less shear per block reach them.
   */
  _layoutStack(P = null) {
    const n = this.carryCount;
    if (n === 0) return;
    const cm = this.carryMesh;
    const st = this.stack;
    if (P) {
      // The stack always rides in the hands (lifted from the pile, pressed overhead, lowered to set
      // a block); k only controls how much of the hands' tilt it follows.
      const k = P[J.HOLD] * this.carryBlend;
      const mid = this._hands(_vC);
      cm.position.copy(mid);
      const dx = _vA.x - _vB.x;
      const balance = Math.min(1, 1.5 / n);
      cm.rotation.set(-P[J.LEAN], Math.atan2(-(_vA.z - _vB.z), dx) * k, -P[J.ROLL] + Math.atan2(_vA.y - _vB.y, dx) * k * balance);
    }
    const shear = 3 / (3 + n);
    const hgt = this.S.blockH * CARRY_SCALE;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < n; i++) {
      const f = (0.2 + 0.12 * i) * shear;
      const ar = st.r * f;
      const ap = st.p * f;
      const ux = -Math.sin(ar) * 0.5 * hgt;
      const uy = Math.cos(ar) * Math.cos(ap) * 0.5 * hgt;
      const uz = Math.sin(ap) * 0.5 * hgt;
      x += ux;
      y += uy;
      z += uz;
      this._e.set(ap, (((i * 37) % 11) - 5) * 0.015, ar);
      this._q.setFromEuler(this._e);
      this._v.set(x, y, z);
      this._m4.compose(this._v, this._q, this._s);
      cm.setMatrixAt(i, this._m4);
      x += ux;
      y += uy;
      z += uz;
    }
    cm.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.accent.dispose();
    this.headMat.dispose();
    this.nemesTex.dispose();
    this.mesh.skeleton.dispose();
    this.carryMesh.dispose();
    if (this.nameTag) {
      this.nameTag.material.map.dispose();
      this.nameTag.material.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Local player (client-side prediction + camera)
// ---------------------------------------------------------------------------

export class LocalPlayer {
  constructor(engine, config, field, input) {
    this.engine = engine;
    this.config = config;
    this.field = field;
    this.input = input;
    this.pc = config.player;
    this.model = null;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.onGround = true;
    this.visualY = 0;
    this.ry = Math.PI;
    this.yaw = 0;
    this.pitch = 0.32;
    this.dist = 9;
    this.camDist = 9;
    this.carry = [];
    this.stats = { moveSpeed: 6, capacity: 1 };
    this.anim = ANIM.IDLE;
    this.moveState = MOVE_STATE.IDLE;
    this.action = null; // { anim, t, dur }
    this.faceTarget = null;
    this.camTarget = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    // Carry weight: speedScale is the target multiplier (carry factor x terrain), speedCap the
    // smoothed ground speed actually allowed this frame.
    this.speedScale = 1;
    this.speedCap = this.stats.moveSpeed;
    // Camera settle after heavy footfalls (m, m/s).
    this.camDip = 0;
    this.camDipV = 0;
    /** Called on every foot plant with { heavy, intensity, x, y, z, side, local: true }. */
    this.onFootstep = null;
    // Phase 2 traversal modes (gliders, grappling hooks); see registerTraversal().
    this.traversals = new Map();
    this.traversal = null; // { name, mode } while a mode owns the movement
    this.intent = { x: 0, z: 0, jump: false, active: false };
  }

  attachModel(model) {
    if (this.model) {
      this.engine.scene.remove(this.model.root);
      this.model.onFootstep = null;
    }
    this.model = model;
    model.onFootstep = (e) => this._footstep(e);
    this.engine.scene.add(model.root);
  }

  setPosition(x, y, z) {
    this.pos.set(x, y, z);
    this.visualY = y;
    this.vel.set(0, 0, 0);
    this.vy = 0;
  }

  setCarry(blocks) {
    this.carry = blocks.slice();
    if (this.model) this.model.setCarry(this.carry);
  }

  playAction(anim, dur) {
    this.action = { anim, t: 0, dur };
  }

  /** Carried blocks relative to capacity, 0..1. */
  loadRatio() {
    return clamp01(this.carry.length / Math.max(1, this.stats.capacity));
  }

  /**
   * Phase 2 extension point for traversal tools such as gliders and grappling
   * hooks. Each frame, the first registered mode whose canEnter() accepts
   * takes over movement until its update() returns false; with no mode active
   * the default ground/air movement runs. A mode is
   *   { state: MOVE_STATE.GLIDE, anim: ANIM.GLIDE,
   *     canEnter(player, intent) -> boolean,
   *     enter(player, intent)?, update(player, dt, intent) -> boolean (still active), exit(player)? }
   * where intent = { x, z (camera-relative wish direction, unit or zero), jump, active }.
   * update() sets player.vel / player.vy and calls player.moveHorizontal(dt) and
   * player.moveVertical(dt, gravityScale), which keep wall and ground collision.
   * canEnter() is polled every frame while no mode is active (including the
   * frame a mode ends), so a mode keeps its own cooldown or input edge checks.
   * Passing mode = null unregisters it.
   */
  registerTraversal(name, mode) {
    if (this.traversal && this.traversal.name === name) this.endTraversal();
    if (mode) this.traversals.set(name, mode);
    else this.traversals.delete(name);
  }

  endTraversal() {
    const active = this.traversal;
    this.traversal = null;
    if (active && active.mode.exit) active.mode.exit(this);
  }

  _beginTraversal(dt, intent) {
    for (const [name, mode] of this.traversals) {
      if (!mode.canEnter(this, intent)) continue;
      this.traversal = { name, mode };
      if (mode.enter) mode.enter(this, intent);
      if (!mode.update(this, dt, intent)) this.endTraversal();
      return;
    }
  }

  _footstep(e) {
    e.local = true;
    if (e.heavy) this.camDipV -= 0.85 * e.intensity;
    if (this.onFootstep) this.onFootstep(e);
  }

  /** True if a circle footprint at (x, z) intersects a wall taller than one step from feetY. */
  blocked(x, z, feetY) {
    const r = this.pc.radius;
    const lim = feetY + this.pc.stepHeight;
    const f = this.field;
    const pts = [
      [x - r, z - r],
      [x + r, z - r],
      [x - r, z + r],
      [x + r, z + r],
      [x, z],
    ];
    for (const [px, pz] of pts) {
      const h = f.heightAt(px, pz);
      if (h >= f.blocked || h > lim) return true;
    }
    return false;
  }

  groundAt(x, z, feetY) {
    const r = this.pc.radius * 0.7;
    const lim = feetY + this.pc.stepHeight;
    const f = this.field;
    let best = 0;
    const pts = [
      [x - r, z - r],
      [x + r, z - r],
      [x - r, z + r],
      [x + r, z + r],
      [x, z],
    ];
    for (const [px, pz] of pts) {
      const h = f.heightAt(px, pz);
      if (h < f.blocked && h <= lim && h > best) best = h;
    }
    return best;
  }

  /** Mouse look, then this frame's camera-relative movement wish. */
  readIntent(settings, controlsActive) {
    const input = this.input;
    const sens = 0.0022 * (settings.sensitivity || 1);
    if (controlsActive) {
      this.yaw -= input.mouseDX * sens;
      this.pitch += input.mouseDY * sens * (settings.invertY ? -1 : 1);
      this.pitch = THREE.MathUtils.clamp(this.pitch, -0.35, 1.25);
      this.dist = THREE.MathUtils.clamp(this.dist + input.wheel * 1.2, 3.5, 22);
    }
    let mx = 0;
    let mz = 0;
    if (controlsActive) {
      if (input.isDown('KeyW') || input.isDown('ArrowUp')) mz -= 1;
      if (input.isDown('KeyS') || input.isDown('ArrowDown')) mz += 1;
      if (input.isDown('KeyA') || input.isDown('ArrowLeft')) mx -= 1;
      if (input.isDown('KeyD') || input.isDown('ArrowRight')) mx += 1;
    }
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    this.forward.set(-sy, 0, -cy);
    let wx = mx * cy + mz * sy;
    let wz = -mx * sy + mz * cy;
    const len = Math.hypot(wx, wz);
    if (len > 0) {
      wx /= len;
      wz /= len;
    }
    const it = this.intent;
    it.x = wx;
    it.z = wz;
    it.jump = controlsActive && input.wasPressed('Space');
    it.active = controlsActive;
    return it;
  }

  /**
   * Carry weight and terrain. The allowed speed drops within a fraction of a
   * second of a pickup (the server only tolerates the unloaded pace for a
   * short grace period) and recovers gently once the load is set down.
   */
  updateSpeedCap(dt) {
    const carry = carryFactor(this.carry.length, this.stats.capacity, this.pc.carry);
    this.speedScale = carry * this.field.speedAt(this.pos.x, this.pos.z);
    const target = this.stats.moveSpeed * this.speedScale;
    this.speedCap = damp(this.speedCap, target, target < this.speedCap ? 14 : 4, dt);
  }

  /** Default ground and air movement: steer, collide, jump and fall. */
  walkAndJump(dt, it) {
    const loaded = this.carry.length > 0;
    const speed = this.speedCap;
    // A loaded builder gets going and turns more sluggishly.
    const accel = this.onGround ? (loaded ? 7.5 : 12) : 3.5;
    this.vel.x = damp(this.vel.x, it.x * speed, accel, dt);
    this.vel.z = damp(this.vel.z, it.z * speed, accel, dt);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > speed) {
      this.vel.x *= speed / hs;
      this.vel.z *= speed / hs;
    }
    this.moveHorizontal(dt);
    if (it.jump && this.onGround) {
      this.vy = this.pc.jumpVelocity * (loaded ? 0.86 - 0.1 * this.loadRatio() : 1);
      this.onGround = false;
    }
    this.moveVertical(dt);
  }

  /** Applies vel on x/z with wall collision, clamped to the world. */
  moveHorizontal(dt) {
    const half = this.config.worldHalf;
    const nx = THREE.MathUtils.clamp(this.pos.x + this.vel.x * dt, -half, half);
    if (!this.blocked(nx, this.pos.z, this.pos.y)) this.pos.x = nx;
    else this.vel.x = 0;
    const nz = THREE.MathUtils.clamp(this.pos.z + this.vel.z * dt, -half, half);
    if (!this.blocked(this.pos.x, nz, this.pos.y)) this.pos.z = nz;
    else this.vel.z = 0;
  }

  /** Applies gravity (scaled) and vy, landing on the height field. */
  moveVertical(dt, gravityScale = 1) {
    // Walking down small terrain steps (the causeway ramps step 0.1 m per cell) keeps you planted
    // instead of free-falling for a frame; real drops (> 0.3 m) and jumps still go airborne.
    const snap = this.onGround && this.vy <= 0 && gravityScale === 1;
    this.vy -= this.pc.gravity * gravityScale * dt;
    this.pos.y += this.vy * dt;
    const ground = this.groundAt(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= ground || (snap && this.pos.y - ground <= 0.3)) {
      this.pos.y = ground;
      this.vy = 0;
      this.onGround = true;
    } else {
      this.onGround = this.pos.y - ground < 0.03;
    }
  }

  update(dt, settings, controlsActive) {
    const intent = this.readIntent(settings, controlsActive);
    this.updateSpeedCap(dt);
    if (this.traversal && !this.traversal.mode.update(this, dt, intent)) this.endTraversal();
    if (!this.traversal) this._beginTraversal(dt, intent);
    if (!this.traversal) this.walkAndJump(dt, intent);
    // Smooth the visual body over step-ups and small grounded step-downs; falls follow physics exactly.
    // On a bridge ramp the body follows the drawn deck rather than the field's 1 m steps.
    const deck = this.onGround ? this.field.deckHeightAt(this.pos.x, this.pos.z) : null;
    const bodyY = deck !== null && Math.abs(deck - this.pos.y) < 0.15 ? deck : this.pos.y;
    const smoothDown = this.onGround && this.visualY - bodyY < 0.35;
    this.visualY = bodyY > this.visualY || smoothDown ? damp(this.visualY, bodyY, 20, dt) : bodyY;

    const loaded = this.carry.length > 0;
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.4) this.ry = dampAngle(this.ry, Math.atan2(this.vel.x, this.vel.z), loaded ? 7 : 12, dt);
    else if (this.faceTarget) {
      this.ry = dampAngle(this.ry, Math.atan2(this.faceTarget.x - this.pos.x, this.faceTarget.z - this.pos.z), 8, dt);
    }

    let actionT = 0;
    if (this.action) {
      this.action.t += dt;
      actionT = this.action.t / this.action.dur;
      if (actionT >= 1) this.action = null;
    }
    const mode = this.traversal && this.traversal.mode;
    if (mode) this.anim = mode.anim !== undefined ? mode.anim : ANIM.AIR;
    else if (!this.onGround) this.anim = ANIM.AIR;
    else if (this.action) this.anim = this.action.anim;
    else this.anim = hSpeed > 0.4 ? ANIM.WALK : ANIM.IDLE;
    if (mode) this.moveState = mode.state || MOVE_STATE.AIR;
    else if (!this.onGround) this.moveState = MOVE_STATE.AIR;
    else if (hSpeed > 0.4) this.moveState = loaded ? MOVE_STATE.HEAVY_WALK : MOVE_STATE.RUN;
    else this.moveState = MOVE_STATE.IDLE;

    if (this.model) {
      this.model.root.position.set(this.pos.x, this.visualY, this.pos.z);
      this.model.root.rotation.y = this.ry;
      const airborne = !this.onGround || this.anim === ANIM.GLIDE || this.anim === ANIM.GRAPPLE;
      this.model.animate(dt, { speed: hSpeed, airborne, anim: this.anim, actionT, load: this.loadRatio() });
    }
    this.updateCamera(dt);
  }

  updateCamera(dt) {
    const cam = this.engine.camera;
    // Heavy footfalls dip the view a few centimetres and let it settle (a damped spring).
    const steps = Math.max(1, Math.ceil(dt * 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.camDipV += (-110 * this.camDip - 13 * this.camDipV) * h;
      this.camDip += this.camDipV * h;
    }
    this.camDip = THREE.MathUtils.clamp(this.camDip, -0.09, 0.03);
    const lift = Math.min(this.carry.length, 8) * 0.14;
    this.camTarget.set(this.pos.x, this.visualY + 1.7 + lift + this.camDip, this.pos.z);
    const cp = Math.cos(this.pitch);
    const dx = Math.sin(this.yaw) * cp;
    const dy = Math.sin(this.pitch);
    const dz = Math.cos(this.yaw) * cp;
    // Pull the camera in when the pyramid would block the view.
    let allowed = this.dist;
    for (let t = 0.6; t <= this.dist; t += 0.3) {
      const x = this.camTarget.x + dx * t;
      const y = this.camTarget.y + dy * t;
      const z = this.camTarget.z + dz * t;
      if (this.field.surfaceAt(x, z) > y - 0.35) {
        allowed = Math.max(1.0, t - 0.45);
        break;
      }
    }
    this.camDist = allowed < this.camDist ? damp(this.camDist, allowed, 25, dt) : damp(this.camDist, allowed, 3, dt);
    cam.position.set(this.camTarget.x + dx * this.camDist, this.camTarget.y + dy * this.camDist, this.camTarget.z + dz * this.camDist);
    const floor = this.field.surfaceAt(cam.position.x, cam.position.z) + 0.3;
    if (cam.position.y < floor) cam.position.y = floor;
    // The look point dips a little further than the camera: a slight nod with each heavy step.
    cam.lookAt(this.camLook.copy(this.camTarget).setY(this.camTarget.y + 0.4 * this.camDip));
  }

  /** Network representation: [x, y, z, ry, anim]. */
  netState() {
    return [
      Math.round(this.pos.x * 100) / 100,
      Math.round(this.pos.y * 100) / 100,
      Math.round(this.pos.z * 100) / 100,
      Math.round(this.ry * 100) / 100,
      this.anim,
    ];
  }
}

// ---------------------------------------------------------------------------
// Remote players
// ---------------------------------------------------------------------------

export class RemotePlayers {
  constructor(engine, config) {
    this.engine = engine;
    this.config = config;
    this.players = new Map();
    this.actionLen = { [ANIM.LIFT]: 0.9, [ANIM.PLACE]: 0.35, [ANIM.PICKUP]: 0.45 };
    /** Called on every remote foot plant with { heavy, intensity, x, y, z, side, local: false }. */
    this.onFootstep = null;
    /** Client height field, used to stand remote bodies on the drawn bridge decks. */
    this.field = null;
  }

  add(info) {
    this.remove(info.id);
    const model = new CharacterModel(this.engine, this.config, info.color, info.name);
    model.setName(info.name, info.color);
    model.root.position.set(info.x, info.y, info.z);
    model.root.rotation.y = info.ry || 0;
    model.setCarry(info.carry || []);
    model.onFootstep = (e) => {
      e.local = false;
      if (this.onFootstep) this.onFootstep(e);
    };
    this.engine.scene.add(model.root);
    // capacity: largest load seen so far, a stand-in for the capacity the server does not broadcast.
    const capacity = Math.max(1, (info.carry || []).length);
    this.players.set(info.id, { id: info.id, name: info.name, color: info.color, model, anim: 0, animT: 0, speed: 0, capacity });
  }

  remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.engine.scene.remove(p.model.root);
    p.model.onFootstep = null;
    p.model.dispose();
    this.players.delete(id);
  }

  clear() {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  setCarry(id, blocks) {
    const p = this.players.get(id);
    if (!p) return;
    p.capacity = Math.max(p.capacity, blocks.length);
    p.model.setCarry(blocks);
  }

  carryTop(id, target) {
    const p = this.players.get(id);
    return p ? p.model.carryTopWorld(target) : null;
  }

  update(dt, sampled) {
    for (const p of this.players.values()) {
      const s = sampled && sampled.get(p.id);
      if (s) {
        if (s.anim !== p.anim) {
          p.anim = s.anim;
          p.animT = 0;
        }
      }
      const airborne = p.anim === ANIM.AIR || p.anim === ANIM.GLIDE || p.anim === ANIM.GRAPPLE;
      if (s) {
        const deck = this.field && !airborne ? this.field.deckHeightAt(s.x, s.z) : null;
        p.model.root.position.set(s.x, deck !== null && Math.abs(deck - s.y) < 0.15 ? deck : s.y, s.z);
        p.model.root.rotation.y = s.ry;
        p.speed = s.speed;
      }
      p.animT += dt;
      const len = this.actionLen[p.anim];
      let anim = p.anim;
      let actionT = 0;
      if (len) {
        actionT = (p.animT % len) / len;
        if (anim !== ANIM.LIFT && p.animT > len) anim = ANIM.IDLE;
      }
      p.model.animate(dt, { speed: p.speed, airborne, anim, actionT, load: p.model.carryCount / p.capacity });
    }
  }
}
