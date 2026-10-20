/**
 * Dunebound - players.
 *
 * Input handling, the procedural builder character (with walk / carry / lift
 * animations), the locally predicted player with height-field collision and a
 * third-person camera, and interpolated remote players.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeTextSprite, lathe, sculpt, gauss, RigBuilder, createRigged } from './engine.js';
import { tintColor, CARRY_SCALE } from './pyramid.js';

export const ANIM = Object.freeze({ IDLE: 0, WALK: 1, AIR: 2, LIFT: 3, PLACE: 4, PICKUP: 5 });

const damp = THREE.MathUtils.damp;
const MAX_CARRY_VISUAL = 20;

function dampAngle(a, b, lambda, dt) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * (1 - Math.exp(-lambda * dt));
}

/** Same formula as the server's loadFactor(): carrying a full load slows you to 70%. */
export function loadFactor(carried, capacity) {
  return 1 - 0.3 * Math.min(1, Math.max(0, carried / Math.max(1, capacity)));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const GAME_KEYS = new Set(['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

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
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
    this.carryMesh.position.y = 2.1;
    this.body.add(this.carryMesh);
    this.carryCount = 0;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(CARRY_SCALE, CARRY_SCALE, CARRY_SCALE);
    this._e = new THREE.Euler();

    this.phase = Math.random() * 10;
    this.walk = 0;
    this.time = Math.random() * 10;
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
  }

  stackHeight() {
    return this.carryCount * this.S.blockH * CARRY_SCALE;
  }

  /** World position of the top carried block (where placement animations start). */
  carryTopWorld(target = new THREE.Vector3()) {
    const y = 2.1 + Math.max(0, this.carryCount - 0.5) * this.S.blockH * CARRY_SCALE;
    target.set(0, y, 0);
    return this.body.localToWorld(target);
  }

  _j(obj, axis, target, dt, lambda = 14) {
    obj.rotation[axis] = damp(obj.rotation[axis], target, lambda, dt);
  }

  /**
   * @param {number} dt
   * @param {{speed:number, airborne:boolean, anim:number, actionT:number}} s
   */
  animate(dt, s) {
    this.time += dt;
    const carrying = this.carryCount > 0;
    this.walk = damp(this.walk, Math.min(1.3, s.speed / 4.5), 8, dt);
    if (s.speed > 0.25) this.phase += dt * (4.6 + s.speed * 0.95);
    const w = this.walk;
    const sw = Math.sin(this.phase);
    let bodyY = Math.abs(Math.cos(this.phase)) * 0.055 * w;
    let spineX = 0.07 * w + Math.sin(this.time * 1.8) * 0.015;
    let legLX = sw * 0.75 * w;
    let legRX = -sw * 0.75 * w;
    let kneeL = (0.08 + Math.max(0, Math.sin(this.phase + 1.5)) * 1.05) * w + 0.04;
    let kneeR = (0.08 + Math.max(0, Math.sin(this.phase + 1.5 + Math.PI)) * 1.05) * w + 0.04;
    let shLX;
    let shRX;
    let shLZ;
    let shRZ;
    let elL;
    let elR;
    if (carrying) {
      const sway = Math.sin(this.phase) * 0.06 * w;
      shLX = -2.85 + sway;
      shRX = -2.85 - sway;
      shLZ = 0.32;
      shRZ = -0.32;
      elL = elR = -0.42;
      spineX -= 0.06;
    } else {
      shLX = -legLX * 0.8;
      shRX = -legRX * 0.8;
      shLZ = 0.09;
      shRZ = -0.09;
      elL = elR = -0.22 - w * 0.35;
    }
    this.liftStone.visible = false;
    if (s.airborne) {
      legLX = -0.55;
      legRX = -0.15;
      kneeL = 1.0;
      kneeR = 0.5;
      if (!carrying) {
        shLX = shRX = -0.9;
        shLZ = 0.4;
        shRZ = -0.4;
      }
    } else if (s.anim === ANIM.LIFT) {
      // Squat and press a lifting stone overhead.
      const t = Math.sin(Math.PI * Math.min(1, s.actionT));
      bodyY = -0.26 * (1 - t);
      legLX = legRX = -0.85 * (1 - t);
      kneeL = kneeR = 1.5 * (1 - t);
      shLX = shRX = -0.9 - 2.0 * t;
      shLZ = 0.35;
      shRZ = -0.35;
      elL = elR = -0.9 * (1 - t) - 0.15;
      spineX = 0.25 * (1 - t);
      this.liftStone.visible = !carrying;
      this.liftStone.position.y = 1.15 + 0.95 * t + bodyY;
    } else if (s.anim === ANIM.PLACE) {
      const t = Math.sin(Math.PI * Math.min(1, s.actionT));
      shLX = shRX = -2.85 + 1.3 * t;
      spineX = 0.1 + 0.25 * t;
    } else if (s.anim === ANIM.PICKUP) {
      const t = Math.sin(Math.PI * Math.min(1, s.actionT));
      spineX = 0.75 * t;
      bodyY = -0.18 * t;
      kneeL = kneeR = 0.7 * t;
      legLX = legRX = -0.4 * t;
      shLX = shRX = -1.3 * t;
    }
    this.body.position.y = damp(this.body.position.y, bodyY, 16, dt);
    this._j(this.spine, 'x', spineX, dt);
    this._j(this.legL.hip, 'x', legLX, dt, 18);
    this._j(this.legR.hip, 'x', legRX, dt, 18);
    this._j(this.legL.knee, 'x', kneeL, dt, 18);
    this._j(this.legR.knee, 'x', kneeR, dt, 18);
    this._j(this.armL.shoulder, 'x', shLX, dt);
    this._j(this.armR.shoulder, 'x', shRX, dt);
    this._j(this.armL.shoulder, 'z', shLZ, dt);
    this._j(this.armR.shoulder, 'z', shRZ, dt);
    this._j(this.armL.elbow, 'x', elL, dt);
    this._j(this.armR.elbow, 'x', elR, dt);
    this._j(this.head, 'x', carrying ? 0.12 : -spineX * 0.5, dt);

    // Carried stack sways with the stride.
    if (this.carryCount > 0) {
      const h = this.S.blockH * CARRY_SCALE;
      for (let i = 0; i < this.carryCount; i++) {
        const sway = Math.sin(this.phase + i * 0.35) * 0.012 * i * w;
        this._e.set(0, (((i * 37) % 11) - 5) * 0.015, sway);
        this._q.setFromEuler(this._e);
        this._v.set(sway * i * 0.5, h * (i + 0.5), 0);
        this._m4.compose(this._v, this._q, this._s);
        this.carryMesh.setMatrixAt(i, this._m4);
      }
      this.carryMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.nameTag) this.nameTag.position.y = 2.45 + this.stackHeight();
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
    this.action = null; // { anim, t, dur }
    this.faceTarget = null;
    this.camTarget = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
  }

  attachModel(model) {
    if (this.model) this.engine.scene.remove(this.model.root);
    this.model = model;
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

  update(dt, settings, controlsActive) {
    const input = this.input;
    const sens = 0.0022 * (settings.sensitivity || 1);
    if (controlsActive) {
      this.yaw -= input.mouseDX * sens;
      this.pitch += input.mouseDY * sens * (settings.invertY ? -1 : 1);
      this.pitch = THREE.MathUtils.clamp(this.pitch, -0.35, 1.25);
      this.dist = THREE.MathUtils.clamp(this.dist + input.wheel * 1.2, 3.5, 22);
    }

    // Movement relative to the camera.
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
    const speed = this.stats.moveSpeed * loadFactor(this.carry.length, this.stats.capacity);
    const accel = this.onGround ? 12 : 3.5;
    this.vel.x = damp(this.vel.x, wx * speed, accel, dt);
    this.vel.z = damp(this.vel.z, wz * speed, accel, dt);

    const half = this.config.worldHalf;
    const nx = THREE.MathUtils.clamp(this.pos.x + this.vel.x * dt, -half, half);
    if (!this.blocked(nx, this.pos.z, this.pos.y)) this.pos.x = nx;
    else this.vel.x = 0;
    const nz = THREE.MathUtils.clamp(this.pos.z + this.vel.z * dt, -half, half);
    if (!this.blocked(this.pos.x, nz, this.pos.y)) this.pos.z = nz;
    else this.vel.z = 0;

    if (controlsActive && this.onGround && input.wasPressed('Space')) {
      this.vy = this.pc.jumpVelocity;
      this.onGround = false;
    }
    this.vy -= this.pc.gravity * dt;
    this.pos.y += this.vy * dt;
    const ground = this.groundAt(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vy = 0;
      this.onGround = true;
    } else {
      this.onGround = this.pos.y - ground < 0.03;
    }
    // Smooth the visual body over step-ups; falls follow physics exactly.
    this.visualY = this.pos.y > this.visualY ? damp(this.visualY, this.pos.y, 20, dt) : this.pos.y;

    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.4) this.ry = dampAngle(this.ry, Math.atan2(this.vel.x, this.vel.z), 12, dt);
    else if (this.faceTarget) {
      this.ry = dampAngle(this.ry, Math.atan2(this.faceTarget.x - this.pos.x, this.faceTarget.z - this.pos.z), 8, dt);
    }

    let actionT = 0;
    if (this.action) {
      this.action.t += dt;
      actionT = this.action.t / this.action.dur;
      if (actionT >= 1) this.action = null;
    }
    if (!this.onGround) this.anim = ANIM.AIR;
    else if (this.action) this.anim = this.action.anim;
    else this.anim = hSpeed > 0.4 ? ANIM.WALK : ANIM.IDLE;

    if (this.model) {
      this.model.root.position.set(this.pos.x, this.visualY, this.pos.z);
      this.model.root.rotation.y = this.ry;
      this.model.animate(dt, { speed: hSpeed, airborne: !this.onGround, anim: this.anim, actionT });
    }
    this.updateCamera(dt);
  }

  updateCamera(dt) {
    const cam = this.engine.camera;
    const lift = Math.min(this.carry.length, 8) * 0.14;
    this.camTarget.set(this.pos.x, this.visualY + 1.7 + lift, this.pos.z);
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
    cam.lookAt(this.camTarget);
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
  }

  add(info) {
    this.remove(info.id);
    const model = new CharacterModel(this.engine, this.config, info.color, info.name);
    model.setName(info.name, info.color);
    model.root.position.set(info.x, info.y, info.z);
    model.root.rotation.y = info.ry || 0;
    model.setCarry(info.carry || []);
    this.engine.scene.add(model.root);
    this.players.set(info.id, { id: info.id, name: info.name, color: info.color, model, anim: 0, animT: 0, speed: 0 });
  }

  remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.engine.scene.remove(p.model.root);
    p.model.dispose();
    this.players.delete(id);
  }

  clear() {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  setCarry(id, blocks) {
    const p = this.players.get(id);
    if (p) p.model.setCarry(blocks);
  }

  carryTop(id, target) {
    const p = this.players.get(id);
    return p ? p.model.carryTopWorld(target) : null;
  }

  update(dt, sampled) {
    for (const p of this.players.values()) {
      const s = sampled && sampled.get(p.id);
      if (s) {
        p.model.root.position.set(s.x, s.y, s.z);
        p.model.root.rotation.y = s.ry;
        p.speed = s.speed;
        if (s.anim !== p.anim) {
          p.anim = s.anim;
          p.animT = 0;
        }
      }
      p.animT += dt;
      const len = this.actionLen[p.anim];
      let anim = p.anim;
      let actionT = 0;
      if (len) {
        actionT = (p.animT % len) / len;
        if (anim !== ANIM.LIFT && p.animT > len) anim = ANIM.IDLE;
      }
      p.model.animate(dt, { speed: p.speed, airborne: p.anim === ANIM.AIR, anim, actionT });
    }
  }
}
