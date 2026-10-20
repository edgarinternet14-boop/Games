/**
 * Dunebound - AI pets.
 *
 * Pets are simulated entirely on the server (state machine + A* pathfinding).
 * This module only renders them: anatomically sculpted, rigidly skinned models
 * per species (one draw call per material), interpolated from server
 * snapshots, with a gait animation and the blocks they haul.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeTextSprite, lathe, latheZ, sculpt, gauss, taperedTube, RigBuilder, createRigged } from './engine.js';
import { tintColor } from './pyramid.js';

export const PET_STATE = Object.freeze({ IDLE: 0, MOVING: 1, LOADING: 2, PLACING: 3 });
const PET_CARRY_SCALE = 0.38;
const damp = THREE.MathUtils.damp;
const SLOTS = ['fur', 'feature', 'accent', 'gold', 'shell', 'nemes'];

const EYE_AMBER = [0.85, 0.55, 0.12];
const PUPIL = [0.03, 0.02, 0.01];
const NOSE = [0.07, 0.05, 0.05];

function quadRig(o) {
  return [
    ['root', null, [0, 0, 0]],
    ['spine', 'root', o.spine],
    ['neck', 'spine', o.neck],
    ['head', 'neck', o.head],
    ['tail', 'spine', o.tail],
    ['legFL', 'spine', [o.front[0], o.front[1], o.front[2]]],
    ['kneeFL', 'legFL', [0, -o.frontUpper, 0]],
    ['legFR', 'spine', [-o.front[0], o.front[1], o.front[2]]],
    ['kneeFR', 'legFR', [0, -o.frontUpper, 0]],
    ['legBL', 'spine', [o.back[0], o.back[1], o.back[2]]],
    ['kneeBL', 'legBL', [0, -o.backUpper, 0]],
    ['legBR', 'spine', [-o.back[0], o.back[1], o.back[2]]],
    ['kneeBR', 'legBR', [0, -o.backUpper, 0]],
  ];
}

/** Adds the four two-segment legs of a quadruped. */
function addLegs(rb, o) {
  for (const [leg, knee, front] of [
    ['legFL', 'kneeFL', true],
    ['legFR', 'kneeFR', true],
    ['legBL', 'kneeBL', false],
    ['legBR', 'kneeBR', false],
  ]) {
    const up = front ? o.frontUpper : o.backUpper;
    const low = front ? o.frontLower : o.backLower;
    const r = front ? o.legR : o.legR * 1.15;
    const thigh = front ? 0.95 : 1.35;
    rb.add(
      'fur',
      lathe([[r * 0.7, -up], [r * 0.85, -up * 0.6], [r * 1.25 * thigh, -up * 0.2], [r * 1.3 * thigh, 0.0], [0.0, r * 1.5]], 16),
      leg,
    );
    rb.add('fur', new THREE.SphereGeometry(r * 0.75, 12, 8), knee);
    rb.add('fur', lathe([[r * 0.45, -low], [r * 0.5, -low * 0.8], [r * 0.6, -low * 0.35], [r * 0.72, 0.0]], 14), knee);
    if (o.hoof) {
      rb.add('feature', new THREE.SphereGeometry(r * 1.2, 14, 8), knee, { p: [0, -low, r * 0.4], s: [1.1, 0.42, 1.35], color: o.hoof });
    } else {
      rb.add('fur', new THREE.SphereGeometry(r * 0.85, 14, 10), knee, { p: [0, -low + r * 0.2, r * 0.35], s: [1, 0.6, 1.35] });
      for (let t = 0; t < 3; t++) {
        rb.add('feature', new THREE.ConeGeometry(r * 0.12, r * 0.4, 5), knee, {
          p: [(t - 1) * r * 0.45, -low + r * 0.05, r * 1.35],
          r: [Math.PI / 2 + 0.4, 0, 0],
          color: [0.12, 0.1, 0.08],
        });
      }
    }
  }
}

function addEyes(rb, bone, x, y, z, r, color = EYE_AMBER) {
  for (const s of [1, -1]) {
    rb.add('feature', new THREE.SphereGeometry(r, 14, 10), bone, { p: [x * s, y, z], color });
    rb.add('feature', new THREE.SphereGeometry(r * 0.5, 10, 8), bone, { p: [x * s + s * r * 0.25, y, z + r * 0.62], s: [0.6, 1.2, 0.5], color: PUPIL });
  }
}

/** Tilted nemes cap shared by the sphinx cub; returns the transform helper and brow-band edge. */
function nemesCap(rb, bone, radius, scale, tilt, offset) {
  const xform = (geo) => {
    geo.scale(scale[0], scale[1], scale[2]);
    geo.rotateX(tilt);
    geo.translate(offset[0], offset[1], offset[2]);
    return geo;
  };
  rb.add('nemes', xform(new THREE.SphereGeometry(radius, 32, 16, Math.PI * 1.5, Math.PI * 2, 0, Math.PI * 0.6)), bone);
  const eY = radius * Math.cos(Math.PI * 0.6);
  const eR = radius * Math.sin(Math.PI * 0.6);
  rb.add('gold', xform(new THREE.TorusGeometry(eR, radius * 0.065, 8, 48).rotateX(Math.PI / 2).translate(0, eY, 0)), bone);
  rb.add('gold', xform(new THREE.ConeGeometry(radius * 0.08, radius * 0.38, 8).translate(0, eY + radius * 0.2, eR + 0.004)), bone);
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

const JACKAL = {
  spine: [0, 0.52, 0],
  neck: [0, 0.07, 0.25],
  head: [0, 0.15, 0.1],
  tail: [0, 0.04, -0.31],
  front: [0.075, -0.02, 0.19],
  back: [0.075, 0.0, -0.21],
  frontUpper: 0.25,
  frontLower: 0.23,
  backUpper: 0.26,
  backLower: 0.24,
  legR: 0.031,
  carry: [0, 0.135, -0.05],
  tagY: 1.08,
};

function buildJackal() {
  const o = JACKAL;
  const rig = quadRig(o);
  const rb = new RigBuilder(rig, SLOTS);
  const torso = latheZ(
    [[0.0, -0.34], [0.06, -0.33], [0.1, -0.28], [0.112, -0.18], [0.098, -0.06], [0.096, 0.04], [0.118, 0.14], [0.132, 0.22], [0.11, 0.29], [0.0, 0.33]],
    28,
  );
  sculpt(torso, (v) => {
    v.x *= 0.8;
    if (v.y < 0) {
      v.y -= 0.045 * gauss(v.z - 0.16, 0.09);
      v.y *= 1 - 0.18 * gauss(v.z + 0.06, 0.08);
    }
    if (v.y > 0) v.y += 0.012 * gauss(v.z - 0.2, 0.06);
  });
  rb.add('fur', torso, 'spine');
  rb.add('fur', taperedTube([[0, -0.05, -0.05], [0, 0.04, 0.02], [0, 0.13, 0.08]], (t) => 0.075 - t * 0.022), 'neck');
  const skull = new THREE.SphereGeometry(0.08, 24, 18);
  sculpt(skull, (v) => {
    v.z *= 1.18;
    v.y *= 0.9;
    if (v.z > 0 && v.y < 0) v.y *= 0.8;
  });
  rb.add('fur', skull, 'head');
  const snout = latheZ([[0.05, 0.02], [0.044, 0.08], [0.034, 0.14], [0.024, 0.19], [0.0, 0.215]], 18);
  sculpt(snout, (v) => {
    v.y *= 0.78;
    v.y -= v.z * 0.12;
  });
  rb.add('fur', snout, 'head', { p: [0, -0.015, 0.03] });
  rb.add('feature', new THREE.SphereGeometry(0.021, 12, 8), 'head', { p: [0, -0.04, 0.24], s: [1.2, 0.8, 0.9], color: NOSE });
  rb.add('feature', new THREE.BoxGeometry(0.004, 0.004, 0.13), 'head', { p: [0, -0.055, 0.16], color: [0.05, 0.03, 0.03] });
  addEyes(rb, 'head', 0.04, 0.02, 0.07, 0.013);
  for (const s of [1, -1]) {
    const ear = new THREE.ConeGeometry(0.04, 0.14, 4, 1);
    sculpt(ear, (v) => {
      v.z *= 0.35;
    });
    rb.add('fur', ear, 'head', { p: [0.045 * s, 0.1, -0.02], r: [0, 0, -0.18 * s] });
    rb.add('feature', ear, 'head', { p: [0.045 * s, 0.095, -0.012], r: [0, 0, -0.18 * s], s: [0.7, 0.75, 0.7], color: [0.35, 0.18, 0.16] });
  }
  addLegs(rb, o);
  rb.add('fur', taperedTube([[0, 0, 0], [0, -0.08, -0.13], [0, -0.24, -0.2], [0, -0.36, -0.2]], (t) => 0.03 + Math.sin(Math.PI * t) * 0.03 - t * 0.02), 'tail');
  rb.add('gold', new THREE.TorusGeometry(0.072, 0.014, 8, 24), 'neck', { p: [0, -0.01, -0.01], r: [Math.PI / 2 - 0.5, 0, 0] });
  rb.add('accent', new THREE.SphereGeometry(0.022, 12, 10), 'neck', { p: [0, -0.07, 0.06] });
  rb.add('gold', new THREE.ConeGeometry(0.02, 0.05, 10), 'neck', { p: [0, -0.1, 0.07], r: [Math.PI, 0, 0] });
  return { ...o, rig, geometry: rb.build(), carryBone: 'spine', gait: 'quad', fur: 0x1c1a1f, sheen: [0.32, 0.3, 0.38] };
}

const CAMEL = {
  spine: [0, 1.32, 0],
  neck: [0, 0.06, 0.56],
  head: [0, 0.5, 0.56],
  tail: [0, 0.08, -0.62],
  front: [0.19, -0.14, 0.42],
  back: [0.19, -0.12, -0.45],
  frontUpper: 0.52,
  frontLower: 0.62,
  backUpper: 0.52,
  backLower: 0.64,
  legR: 0.068,
  hoof: [0.28, 0.2, 0.14],
  carry: [0, 0.66, -0.02],
  tagY: 2.6,
};

function buildCamel() {
  const o = CAMEL;
  const rig = quadRig(o);
  const rb = new RigBuilder(rig, SLOTS);
  const torso = latheZ([[0.0, -0.64], [0.15, -0.6], [0.27, -0.45], [0.31, -0.25], [0.32, 0.0], [0.33, 0.25], [0.3, 0.45], [0.18, 0.58], [0.0, 0.63]], 32);
  sculpt(torso, (v) => {
    v.x *= 0.76;
    if (v.y < 0) v.y *= 1.06;
  });
  rb.add('fur', torso, 'spine');
  const hump = new THREE.SphereGeometry(0.33, 28, 18);
  sculpt(hump, (v) => {
    if (v.y < 0) v.y *= 0.4;
    v.x *= 0.74;
    v.z *= 1.25;
    v.y *= 0.95;
  });
  rb.add('fur', hump, 'spine', { p: [0, 0.27, -0.02] });
  rb.add('fur', taperedTube([[0, -0.05, -0.08], [0, -0.14, 0.18], [0, 0.02, 0.42], [0, 0.4, 0.54], [0, 0.52, 0.56]], (t) => 0.16 - t * 0.07, 28), 'neck');
  const skull = latheZ([[0.0, -0.13], [0.08, -0.12], [0.1, -0.05], [0.094, 0.06], [0.075, 0.16], [0.068, 0.22], [0.0, 0.26]], 22);
  sculpt(skull, (v) => {
    v.x *= 0.82;
    if (v.z > 0.12 && v.y < 0) v.y -= 0.018;
  });
  rb.add('fur', skull, 'head');
  rb.add('fur', new THREE.SphereGeometry(0.06, 12, 8), 'head', { p: [0, 0.06, -0.02], s: [1.6, 0.6, 1] });
  addEyes(rb, 'head', 0.075, 0.04, -0.01, 0.018, [0.2, 0.12, 0.06]);
  for (const s of [1, -1]) {
    rb.add('fur', new THREE.ConeGeometry(0.025, 0.07, 6), 'head', { p: [0.055 * s, 0.085, -0.1], r: [-0.4, 0, -0.5 * s] });
    rb.add('feature', new THREE.CapsuleGeometry(0.006, 0.025, 2, 6), 'head', { p: [0.025 * s, 0.01, 0.255], r: [0, 0, 0.6 * s], color: NOSE });
  }
  rb.add('gold', new THREE.TorusGeometry(0.083, 0.008, 8, 24), 'head', { p: [0, -0.005, 0.12], s: [0.85, 1, 1] });
  addLegs(rb, o);
  for (const k of ['kneeFL', 'kneeFR', 'kneeBL', 'kneeBR']) {
    rb.add('feature', new THREE.SphereGeometry(o.legR * 1.05, 12, 8), k, { p: [0, 0, 0.02], color: [0.45, 0.33, 0.2] });
  }
  rb.add('fur', taperedTube([[0, 0, 0], [0, -0.2, -0.06], [0, -0.42, -0.05]], (t) => 0.025 - t * 0.01), 'tail');
  rb.add('feature', new THREE.SphereGeometry(0.035, 10, 8), 'tail', { p: [0, -0.45, -0.05], s: [0.8, 1.4, 0.8], color: [0.25, 0.17, 0.1] });
  // Saddle blanket draped over the hump with a gold fringe.
  const blanket = new THREE.SphereGeometry(0.36, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.47);
  rb.add('accent', blanket, 'spine', { p: [0, 0.255, -0.02], s: [0.78, 0.82, 1.3] });
  const edgeY = 0.36 * Math.cos(Math.PI * 0.47);
  const edgeR = 0.36 * Math.sin(Math.PI * 0.47);
  rb.add('gold', new THREE.TorusGeometry(edgeR, 0.012, 6, 48).rotateX(Math.PI / 2).translate(0, edgeY, 0), 'spine', {
    p: [0, 0.255, -0.02],
    s: [0.78, 0.82, 1.3],
  });
  return { ...o, rig, geometry: rb.build(), carryBone: 'spine', gait: 'pace', fur: 0xc7a06c, sheen: [1, 0.86, 0.66] };
}

const SPHINX = {
  spine: [0, 0.46, 0],
  neck: [0, 0.09, 0.22],
  head: [0, 0.13, 0.08],
  tail: [0, 0.06, -0.3],
  front: [0.09, -0.04, 0.18],
  back: [0.09, -0.02, -0.2],
  frontUpper: 0.2,
  frontLower: 0.2,
  backUpper: 0.21,
  backLower: 0.21,
  legR: 0.046,
  carry: [0, 0.165, -0.06],
  tagY: 1.25,
};

function buildSphinx() {
  const o = SPHINX;
  const rig = quadRig(o);
  const rb = new RigBuilder(rig, SLOTS);
  const torso = latheZ([[0.0, -0.32], [0.08, -0.31], [0.135, -0.24], [0.15, -0.12], [0.138, 0.0], [0.148, 0.1], [0.162, 0.2], [0.13, 0.28], [0.0, 0.31]], 28);
  sculpt(torso, (v) => {
    v.x *= 0.86;
    if (v.y < 0) v.y -= 0.02 * gauss(v.z - 0.12, 0.1);
  });
  rb.add('fur', torso, 'spine');
  rb.add('fur', taperedTube([[0, -0.05, -0.05], [0, 0.03, 0.02], [0, 0.11, 0.06]], (t) => 0.1 - t * 0.02), 'neck');
  const skull = new THREE.SphereGeometry(0.125, 28, 20);
  sculpt(skull, (v) => {
    if (v.z > 0) v.z *= 0.85;
    v.x *= 1.05;
  });
  rb.add('fur', skull, 'head');
  for (const s of [1, -1]) {
    rb.add('fur', new THREE.SphereGeometry(0.045, 14, 10), 'head', { p: [0.03 * s, -0.04, 0.095], s: [1, 0.85, 0.9] });
  }
  rb.add('fur', new THREE.SphereGeometry(0.04, 12, 8), 'head', { p: [0, -0.085, 0.07], s: [1.1, 0.7, 1] });
  rb.add('feature', new THREE.ConeGeometry(0.022, 0.03, 3), 'head', { p: [0, -0.012, 0.13], r: [Math.PI, 0, 0], s: [1.3, 1, 0.6], color: [0.42, 0.22, 0.2] });
  addEyes(rb, 'head', 0.048, 0.03, 0.088, 0.016);
  nemesCap(rb, 'head', 0.12, [1.25, 1.2, 1.2], -0.55, [0, 0.03, -0.015]);
  for (const s of [1, -1]) {
    const lap = new THREE.BoxGeometry(0.075, 0.24, 0.018, 1, 8, 1);
    sculpt(lap, (v) => {
      const t = (0.12 - v.y) / 0.24;
      v.x *= 0.85 + 0.55 * t;
      v.z += 0.03 * t * t;
    });
    rb.add('nemes', lap, 'head', { p: [0.13 * s, -0.12, 0.02], r: [-0.1, 0, 0.12 * s] });
  }
  addLegs(rb, o);
  rb.add('fur', taperedTube([[0, 0, 0], [0, -0.05, -0.15], [0, 0.04, -0.33], [0, 0.16, -0.42]], (t) => 0.024 - t * 0.008, 24), 'tail');
  rb.add('feature', new THREE.SphereGeometry(0.04, 12, 8), 'tail', { p: [0, 0.18, -0.43], s: [0.8, 1.3, 0.8], color: [0.32, 0.18, 0.08] });
  return { ...o, rig, geometry: rb.build(), carryBone: 'spine', gait: 'quad', fur: 0xd6a35c, sheen: [1, 0.85, 0.55] };
}

const SCARAB_RIG = (() => {
  const rig = [
    ['root', null, [0, 0, 0]],
    ['thorax', 'root', [0, 0.4, 0]],
    ['head', 'thorax', [0, -0.03, 0.34]],
  ];
  [
    [0.22, 0.2],
    [0.24, 0.0],
    [0.22, -0.2],
  ].forEach(([x, z], i) => {
    for (const [s, side] of [
      [1, 'L'],
      [-1, 'R'],
    ]) {
      rig.push([`coxa${i}${side}`, 'thorax', [x * s, -0.1, z]]);
      rig.push([`tibia${i}${side}`, `coxa${i}${side}`, [0.22 * s, -0.08, 0]]);
    }
  });
  return rig;
})();

function buildScarab() {
  const rb = new RigBuilder(SCARAB_RIG, SLOTS);
  // Elytra: two domed wing cases meeting at a fine suture.
  for (const s of [1, -1]) {
    const half = new THREE.SphereGeometry(0.4, 32, 22, s > 0 ? 0 : Math.PI, Math.PI);
    sculpt(half, (v) => {
      v.x *= 0.52;
      v.y *= v.y > 0 ? 0.48 : 0.2;
      v.z *= 0.78;
      const back = Math.max(0, -v.z / 0.3);
      v.z -= 0.04 * back * back;
    });
    rb.add('shell', half, 'thorax', { p: [s * 0.004, 0.0, -0.17] });
  }
  const pronotum = new THREE.SphereGeometry(0.3, 28, 18);
  sculpt(pronotum, (v) => {
    v.x *= 0.76;
    v.y *= v.y > 0 ? 0.36 : 0.18;
    v.z *= 0.5;
  });
  rb.add('shell', pronotum, 'thorax', { p: [0, 0.01, 0.16] });
  rb.add('accent', new THREE.SphereGeometry(0.045, 16, 12), 'thorax', { p: [0, 0.115, 0.17], s: [1, 0.55, 1] });
  rb.add('gold', new THREE.TorusGeometry(0.048, 0.008, 6, 20), 'thorax', { p: [0, 0.11, 0.17], r: [Math.PI / 2, 0, 0] });
  const headGeo = new THREE.SphereGeometry(0.13, 22, 14);
  sculpt(headGeo, (v) => {
    v.x *= 1.25;
    v.y *= 0.42;
    v.z *= 0.8;
  });
  rb.add('shell', headGeo, 'head');
  for (let i = 0; i < 6; i++) {
    const a = ((i - 2.5) / 2.5) * 0.9;
    rb.add('gold', new THREE.ConeGeometry(0.018, 0.07, 5), 'head', {
      p: [Math.sin(a) * 0.15, 0.0, 0.085 + Math.cos(a) * 0.03],
      r: [Math.PI / 2, 0, -a],
      s: [1, 1, 0.45],
    });
  }
  for (const s of [1, -1]) {
    rb.add('feature', new THREE.SphereGeometry(0.022, 10, 8), 'head', { p: [0.13 * s, 0.0, 0.0], color: [0.04, 0.04, 0.05] });
    rb.add('feature', new THREE.CapsuleGeometry(0.005, 0.08, 2, 6), 'head', { p: [0.09 * s, 0.01, 0.1], r: [1.1, 0, -0.6 * s], color: [0.1, 0.07, 0.03] });
    rb.add('gold', new THREE.SphereGeometry(0.016, 8, 6), 'head', { p: [0.125 * s, 0.03, 0.135], s: [1, 0.7, 1.4] });
  }
  for (let i = 0; i < 3; i++) {
    for (const [s, side] of [
      [1, 'L'],
      [-1, 'R'],
    ]) {
      const coxa = `coxa${i}${side}`;
      const tibia = `tibia${i}${side}`;
      const front = i === 0;
      rb.add('feature', new THREE.SphereGeometry(0.035, 10, 8), coxa, { color: [0.12, 0.09, 0.04] });
      rb.add('shell', new THREE.CapsuleGeometry(0.026, 0.2, 3, 8), coxa, { p: [0.11 * s, -0.04, 0], r: [0, 0, (Math.PI / 2 - 0.35) * s], s: [1, 1, 0.75] });
      rb.add('shell', new THREE.CapsuleGeometry(front ? 0.026 : 0.019, 0.24, 3, 8), tibia, {
        p: [0.06 * s, -0.12, 0],
        r: [0, 0, 0.45 * s],
        s: [front ? 1.5 : 1, 1, 0.7],
      });
      for (let k = 0; k < 3; k++) {
        rb.add('gold', new THREE.ConeGeometry(0.008, 0.04, 5), tibia, { p: [(0.035 + k * 0.03) * s, -0.06 - k * 0.06, 0.012], r: [0, 0, -1.2 * s] });
      }
    }
  }
  return {
    rig: SCARAB_RIG,
    geometry: rb.build(),
    carryBone: 'thorax',
    carry: [0, 0.2, -0.16],
    tagY: 1.1,
    gait: 'tripod',
    fur: 0x1b1408,
    sheen: [0.4, 0.3, 0.1],
  };
}

const BUILDERS = { jackal: buildJackal, camel: buildCamel, sphinx: buildSphinx, scarab: buildScarab };

/** Owner-coloured nemes stripes for the sphinx cub. */
function stripeTexture(color) {
  const c = new THREE.Color(color);
  const gold = new THREE.Color(0xd9a531);
  const rows = 20;
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
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class PetManager {
  constructor(engine, config) {
    this.engine = engine;
    this.config = config;
    this.pets = new Map();
    this.species = {};
    this.names = { jackal: 'Desert Jackal', camel: 'Pack Camel', sphinx: 'Sphinx Cub', scarab: 'Golden Scarab' };
    const pc = config.pyramid;
    this.blockGeo = new RoundedBoxGeometry(pc.blockW - 0.03, pc.blockH - 0.02, pc.blockW - 0.03, 1, 0.08);
    this.blockH = pc.blockH;
    const t = engine.tex;
    this.featureMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.2 });
    this.shellMat = new THREE.MeshPhysicalMaterial({
      color: 0xd2ad3c,
      metalness: 1,
      roughness: 0.18,
      normalMap: t.fur.normalMap,
      normalScale: new THREE.Vector2(0.18, 0.18),
      iridescence: 0.55,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [260, 420],
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      emissive: 0x120c00,
      emissiveIntensity: 0.2,
    });
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(PET_CARRY_SCALE, PET_CARRY_SCALE, PET_CARRY_SCALE);
  }

  setNames(list) {
    for (const p of list || []) this.names[p.id] = p.name;
  }

  /** Builds (once) the shared rigged geometry and fur material of a species. */
  speciesData(name) {
    if (!this.species[name]) {
      const def = (BUILDERS[name] || buildJackal)();
      def.furMat = new THREE.MeshPhysicalMaterial({
        color: def.fur,
        map: this.engine.tex.fur.map,
        normalMap: this.engine.tex.fur.normalMap,
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughness: 0.82,
        sheen: 1,
        sheenRoughness: 0.55,
        sheenColor: new THREE.Color(...def.sheen),
      });
      this.species[name] = def;
    }
    return this.species[name];
  }

  add(info) {
    this.remove(info.id);
    const def = this.speciesData(info.species);
    const accent = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(info.ownerColor || '#ffffff'), roughness: 0.55, sheen: 0.6, sheenRoughness: 0.6 });
    const nemesTex = info.species === 'sphinx' ? stripeTexture(info.ownerColor || '#2f63b8') : null;
    const nemes = nemesTex ? new THREE.MeshPhysicalMaterial({ map: nemesTex, roughness: 0.5, side: THREE.DoubleSide }) : accent;
    const mats = { fur: def.furMat, feature: this.featureMat, accent, gold: this.engine.materials.gold, shell: this.shellMat, nemes };
    const { mesh, bones } = createRigged(def.geometry, def.rig, SLOTS.map((k) => mats[k]));
    const root = new THREE.Group();
    root.add(mesh);
    const carry = new THREE.InstancedMesh(this.blockGeo, this.engine.materials.block, 8);
    carry.count = 0;
    carry.castShadow = true;
    carry.frustumCulled = false;
    carry.position.set(def.carry[0], def.carry[1], def.carry[2]);
    bones[def.carryBone].add(carry);
    const label = info.ownerName ? `${info.ownerName}'s ${this.names[info.species] || info.species}` : this.names[info.species];
    const tag = makeTextSprite(label, {
      font: '600 40px "Segoe UI", system-ui, sans-serif',
      height: 60,
      color: info.ownerColor || '#f6dfa4',
      outlineWidth: 6,
      scale: 0.32,
    });
    tag.position.y = def.tagY;
    root.add(tag);
    root.position.set(info.x, info.y, info.z);
    root.rotation.y = info.ry || 0;
    this.engine.scene.add(root);
    const pet = {
      id: info.id,
      owner: info.owner,
      species: info.species,
      def,
      root,
      mesh,
      bones,
      carry,
      tag,
      accent,
      nemes,
      nemesTex,
      phase: Math.random() * 6,
      walk: 0,
      state: 0,
      count: 0,
      t: Math.random() * 10,
    };
    this.pets.set(info.id, pet);
    this.setCarry(info.id, info.carry || []);
    return pet;
  }

  remove(id) {
    const p = this.pets.get(id);
    if (!p) return;
    this.engine.scene.remove(p.root);
    p.mesh.skeleton.dispose();
    p.tag.material.map.dispose();
    p.tag.material.dispose();
    p.accent.dispose();
    if (p.nemesTex) {
      p.nemesTex.dispose();
      p.nemes.dispose();
    }
    p.carry.dispose();
    this.pets.delete(id);
  }

  clear() {
    for (const id of [...this.pets.keys()]) this.remove(id);
  }

  setCarry(id, blocks) {
    const p = this.pets.get(id);
    if (!p) return;
    const n = Math.min(8, blocks.length);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) p.carry.setColorAt(i, tintColor(blocks[i], c));
    if (p.carry.instanceColor) p.carry.instanceColor.needsUpdate = true;
    p.carry.count = n;
    p.count = n;
  }

  carryTop(id, target = new THREE.Vector3()) {
    const p = this.pets.get(id);
    if (!p) return null;
    target.set(0, Math.max(0, p.count - 0.5) * this.blockH * PET_CARRY_SCALE, 0);
    return p.carry.localToWorld(target);
  }

  update(dt, sampled) {
    for (const p of this.pets.values()) {
      const s = sampled && sampled.get(p.id);
      let speed = 0;
      if (s) {
        p.root.position.set(s.x, s.y, s.z);
        p.root.rotation.y = s.ry;
        speed = s.speed;
        p.state = s.anim;
      }
      p.t += dt;
      p.walk = damp(p.walk, Math.min(1.2, speed / 3), 8, dt);
      p.phase += dt * (speed > 0.2 ? 5 + speed * 1.3 : 0);
      const w = p.walk;
      const b = p.bones;
      const sw = Math.sin(p.phase);
      const busy = p.state === PET_STATE.LOADING || p.state === PET_STATE.PLACING;
      if (p.def.gait === 'tripod') {
        for (let i = 0; i < 3; i++) {
          for (const [side, sign] of [
            ['L', 1],
            ['R', -1],
          ]) {
            const ph = (i + (side === 'L' ? 0 : 1)) % 2 ? sw : -sw;
            b[`coxa${i}${side}`].rotation.y = ph * 0.4 * w * sign;
            b[`coxa${i}${side}`].rotation.z = Math.max(0, ph) * 0.3 * w * sign;
            b[`tibia${i}${side}`].rotation.z = -Math.max(0, ph) * 0.25 * w * sign;
          }
        }
        b.thorax.position.y = 0.4 + Math.abs(Math.cos(p.phase)) * 0.015 * w;
        b.head.rotation.x = damp(b.head.rotation.x, busy ? 0.25 : 0, 6, dt);
      } else {
        const pace = p.def.gait === 'pace';
        const legs = [
          ['legFL', 'kneeFL', 0, true],
          ['legFR', 'kneeFR', 1, true],
          ['legBL', 'kneeBL', pace ? 0 : 1, false],
          ['legBR', 'kneeBR', pace ? 1 : 0, false],
        ];
        for (const [leg, knee, side, front] of legs) {
          b[leg].rotation.x = (side ? sw : -sw) * 0.55 * w;
          const lift = Math.max(0, Math.sin(p.phase + (side ? Math.PI : 0) + 0.8)) * w;
          b[knee].rotation.x = front ? -lift * 0.9 : lift * 0.9;
        }
        b.spine.position.y = p.def.spine[1] + Math.abs(Math.cos(p.phase)) * 0.03 * w + Math.sin(p.t * 1.6) * 0.004;
        b.spine.rotation.z = Math.sin(p.phase) * 0.03 * w;
        b.neck.rotation.x = damp(b.neck.rotation.x, busy ? 0.55 : Math.sin(p.phase * 2) * 0.05 * w, 6, dt);
        b.head.rotation.x = damp(b.head.rotation.x, busy ? 0.3 : 0, 6, dt);
        b.tail.rotation.y = Math.sin(p.t * 5 + p.id) * (0.25 + w * 0.25);
        b.tail.rotation.x = -0.15 * w;
      }
      if (p.count > 0) {
        const h = this.blockH * PET_CARRY_SCALE;
        for (let i = 0; i < p.count; i++) {
          const sway = Math.sin(p.phase + i * 0.4) * 0.01 * i * w;
          this._q.setFromAxisAngle(this._v.set(0, 0, 1), sway);
          this._v.set(0, h * (i + 0.5), 0);
          this._m4.compose(this._v, this._q, this._s);
          p.carry.setMatrixAt(i, this._m4);
        }
        p.carry.instanceMatrix.needsUpdate = true;
      }
      p.tag.position.y = p.def.tagY + p.count * this.blockH * PET_CARRY_SCALE;
    }
  }
}
