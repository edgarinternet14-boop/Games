import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyWorldUVs, applyCylinderUVs, PerlinNoise } from './materials.js';
import { CANNON } from './physics.js';

// The level: an abandoned underground storage hall ("Sector 7").
//
// 28 x 44 m, 7.5 m ceiling. Pillars, ceiling I-beams, a raised catwalk with
// stairs, stacked shipping containers, a low duct you have to crouch under,
// jersey barriers, physics crates and oil drums, pipes, a rolling shutter
// with warm light leaking underneath, an exit door, flickering fluorescent
// tubes (RectAreaLights), rotating red beacons, a hanging lamp swinging on a
// physics pendulum, and dust motes that light up inside the light cones.

export const HALL = { minX: -14, maxX: 14, minZ: -22, maxZ: 22, height: 7.5 };

const _v = new THREE.Vector3();

export function buildLevel({ engine, physics, materials: M, textures: T, audio }) {
  const scene = engine.scene;
  const root = new THREE.Group();
  root.name = 'level';
  scene.add(root);

  const level = {
    root,
    shootables: [],
    bounceTargets: [],
    spawn: new THREE.Vector3(1.2, 0, 19.5),
    spawnYaw: 0.08,
    flickers: [],
    beacons: [],
    lamp: null,
    dust: null,
    update: null,
  };

  /* ------------------------------- helpers ------------------------------- */

  function register(mesh, { shootable = true, bounce = false } = {}) {
    if (shootable) level.shootables.push(mesh);
    if (bounce) level.bounceTargets.push(mesh);
  }

  /** Static box with world-scaled UVs and a matching collider. */
  function box(size, pos, material, {
    tile = 4, rotY = 0, rotX = 0, rotZ = 0, surface = 'concrete', collider = true,
    cast = true, receive = true, shootable = true, bounce = false, parent = root,
  } = {}) {
    const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    applyWorldUVs(geo, tile, rotX || rotY || rotZ ? new THREE.Vector3() : pos);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(pos);
    mesh.rotation.set(rotX, rotY, rotZ);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.userData.surface = surface;
    parent.add(mesh);
    if (collider) physics.addStaticForMesh(mesh, { surface });
    register(mesh, { shootable, bounce });
    return mesh;
  }

  function invisibleCollider(size, pos, quaternion = null, surface = 'metal') {
    return physics.addStaticBox(size, pos, quaternion, { surface });
  }

  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  /* ------------------------------ shell ------------------------------ */

  const W = HALL.maxX - HALL.minX;
  const D = HALL.maxZ - HALL.minZ;
  const H = HALL.height;
  box(V(W + 1.2, 1, D + 1.2), V(0, -0.5, 0), M.concreteFloor, { tile: 4, bounce: true });
  box(V(W + 1.2, 0.6, D + 1.2), V(0, H + 0.3, 0), M.ceiling, { tile: 4, cast: false, bounce: true });
  box(V(0.6, H, D), V(HALL.minX - 0.3, H / 2, 0), M.concreteWall, { tile: 4, bounce: true });
  box(V(0.6, H, D), V(HALL.maxX + 0.3, H / 2, 0), M.concreteWall, { tile: 4, bounce: true });
  box(V(W + 1.2, H, 0.6), V(0, H / 2, HALL.minZ - 0.3), M.concreteWall, { tile: 4, bounce: true });
  box(V(W + 1.2, H, 0.6), V(0, H / 2, HALL.maxZ + 0.3), M.concreteWall, { tile: 4, bounce: true });

  // Pillars with hazard-striped skirts.
  for (const x of [-5.5, 5.5]) {
    for (const z of [-15, -5, 5, 15]) {
      box(V(0.9, H, 0.9), V(x, H / 2, z), M.concreteWall, { tile: 4, collider: false, bounce: true });
      box(V(0.96, 1.1, 0.96), V(x, 0.55, z), M.hazard, { tile: 2, collider: false, surface: 'metal' });
      invisibleCollider(V(0.96, H, 0.96), V(x, H / 2, z), null, 'concrete');
    }
  }

  // Ceiling steel: I-beams across the hall plus two longitudinal girders,
  // merged into a single draw call.
  {
    const parts = [];
    const add = (sx, sy, sz, px, py, pz) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(px, py, pz);
      applyWorldUVs(g, 2);
      parts.push(g);
    };
    for (let z = -20; z <= 20; z += 5) {
      add(W, 0.03, 0.3, 0, H - 0.015, z);
      add(W, 0.42, 0.025, 0, H - 0.24, z);
      add(W, 0.03, 0.3, 0, H - 0.465, z);
    }
    for (const x of [-5.5, 5.5]) {
      add(0.3, 0.03, D, x, H - 0.495, 0);
      add(0.025, 0.4, D, x, H - 0.71, 0);
      add(0.3, 0.03, D, x, H - 0.925, 0);
    }
    const beams = new THREE.Mesh(mergeGeometries(parts), M.rustedMetal);
    beams.castShadow = true;
    beams.receiveShadow = true;
    beams.userData.surface = 'metal';
    root.add(beams);
    register(beams);
    parts.forEach((g) => g.dispose());
  }

  /* ------------------------------ catwalk + stairs ------------------------------ */

  const cwX0 = 10.4;
  const cwX1 = HALL.maxX;
  const cwY = 3.4;
  const cwZ0 = HALL.minZ;
  const cwZ1 = 6;
  const cwLen = cwZ1 - cwZ0;
  const cwCx = (cwX0 + cwX1) / 2;
  const cwCz = (cwZ0 + cwZ1) / 2;
  box(V(cwX1 - cwX0, 0.12, cwLen), V(cwCx, cwY - 0.06, cwCz), M.rustedMetal, { tile: 2, surface: 'metal', bounce: true });
  box(V(0.05, 0.14, cwLen), V(cwX0 - 0.025, cwY - 0.06, cwCz), M.hazard, { tile: 1.5, surface: 'metal', collider: false });
  box(V(0.16, 0.24, cwLen), V(cwX0 + 0.2, cwY - 0.24, cwCz), M.rustedMetal, { tile: 2, surface: 'metal', collider: false });
  for (const z of [-21, -15, -9, -3, 3]) {
    box(V(0.2, cwY - 0.36, 0.2), V(cwX0 + 0.2, (cwY - 0.36) / 2, z), M.rustedMetal, { tile: 2, surface: 'metal' });
  }

  // Railing posts as one InstancedMesh.
  const railX = cwX0 + 0.06;
  {
    const postGeo = new THREE.BoxGeometry(0.05, 1.05, 0.05);
    applyWorldUVs(postGeo, 1);
    const zs = [];
    for (let z = cwZ0 + 0.4; z <= cwZ1; z += 1.4) zs.push(z);
    const posts = new THREE.InstancedMesh(postGeo, M.rustedMetal, zs.length + 4);
    const m4 = new THREE.Matrix4();
    zs.forEach((z, i) => posts.setMatrixAt(i, m4.makeTranslation(railX, cwY + 0.525, z)));
    // posts along the stair rail
    for (let k = 0; k < 4; k++) {
      const t = (k + 1) / 5;
      const z = cwZ1 + t * 8;
      const y = cwY * (1 - t);
      posts.setMatrixAt(zs.length + k, m4.makeTranslation(railX, y + 0.525, z));
    }
    posts.castShadow = true;
    posts.receiveShadow = true;
    posts.userData.surface = 'metal';
    root.add(posts);
    register(posts);
  }
  box(V(0.06, 0.06, cwLen), V(railX, cwY + 1.05, cwCz), M.rustedMetal, { tile: 2, surface: 'metal', collider: false });
  box(V(0.04, 0.04, cwLen), V(railX, cwY + 0.55, cwCz), M.rustedMetal, { tile: 2, surface: 'metal', collider: false });
  invisibleCollider(V(0.14, 1.15, cwLen), V(railX, cwY + 0.575, cwCz));

  // Stairs: 17 steps (0.2 m rise) from the floor at z=14 up to the catwalk at z=6.
  {
    const steps = 17;
    const run = 8 / steps;
    const stairW = cwX1 - (cwX0 + 0.2);
    const stairCx = (cwX0 + 0.2 + cwX1) / 2;
    const stepGeo = new THREE.BoxGeometry(stairW - 0.08, 0.05, run + 0.02);
    applyWorldUVs(stepGeo, 2);
    const stepMesh = new THREE.InstancedMesh(stepGeo, M.rustedMetal, steps);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < steps; i++) {
      const top = (i + 1) * 0.2;
      stepMesh.setMatrixAt(i, m4.makeTranslation(stairCx, top - 0.025, 14 - (i + 0.5) * run));
    }
    stepMesh.castShadow = true;
    stepMesh.receiveShadow = true;
    stepMesh.userData.surface = 'metal';
    root.add(stepMesh);
    register(stepMesh);

    const theta = Math.atan2(cwY, 8);
    const len = Math.hypot(cwY, 8);
    for (const x of [cwX0 + 0.23, cwX1 - 0.03]) {
      box(V(0.06, 0.3, len), V(x, cwY / 2 - 0.12, 10), M.rustedMetal, { tile: 2, rotX: theta, surface: 'metal', collider: false });
    }
    // Rail along the open side of the stairs.
    box(V(0.06, 0.06, len), V(railX, cwY / 2 + 1.05, 10), M.rustedMetal, { tile: 2, rotX: theta, surface: 'metal', collider: false });

    // Invisible ramp the player actually walks on (smooth instead of bumpy
    // steps). Its surface runs from (z=14, y=0) to (z=6, y=cwY): flush with the
    // catwalk deck at the top (any lip there would stop the player walking
    // down), and continuing 0.5 m into the floor slab at the bottom.
    const q = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), theta);
    const n = V(0, 1, 0).applyQuaternion(q);
    const zTop = cwZ1;
    const zBottom = 14.5;
    const rampLen = (zBottom - zTop) / Math.cos(theta);
    const zc = (zTop + zBottom) / 2;
    const center = V(stairCx, (14 - zc) * (cwY / 8), zc).addScaledVector(n, -0.05);
    invisibleCollider(V(stairW, 0.1, rampLen), center, q, 'metal');
    invisibleCollider(V(0.14, 1.15, len), V(railX, cwY / 2 + 0.6, 10), q, 'metal');
  }

  /* ------------------------------ containers ------------------------------ */

  const containerSize = V(2.44, 2.59, 6.06);
  box(containerSize, V(-10.6, 1.295, -14), M.containerPaint, { tile: 4.5, surface: 'metal', bounce: true });
  box(containerSize, V(-10.5, 1.295, -6.6), M.containerPaint, { tile: 4.5, rotY: 0.05, surface: 'metal', bounce: true });
  box(containerSize, V(-10.75, 3.885, -13.6), M.containerPaint, { tile: 4.5, rotY: -0.04, surface: 'metal', bounce: true });

  /* ------------------------------ duct (crouch under it) ------------------------------ */

  box(V(7.2, 0.7, 1.0), V(-10.4, 1.65, -19.6), M.rustedMetal, { tile: 1.5, surface: 'metal' });
  box(V(1.0, 5.5, 1.0), V(-7.3, 4.75, -19.6), M.rustedMetal, { tile: 1.5, surface: 'metal' });
  box(V(1.6, 0.22, 0.02), V(-11.2, 1.41, -19.09), M.hazard, { tile: 1, surface: 'metal', collider: false, cast: false });

  /* ------------------------------ jersey barriers ------------------------------ */

  {
    const shape = new THREE.Shape();
    shape.moveTo(-0.3, 0);
    shape.lineTo(0.3, 0);
    shape.lineTo(0.3, 0.08);
    shape.lineTo(0.17, 0.26);
    shape.lineTo(0.1, 0.84);
    shape.lineTo(-0.1, 0.84);
    shape.lineTo(-0.17, 0.26);
    shape.lineTo(-0.3, 0.08);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 2.4, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.01, bevelSegments: 1 });
    geo.translate(0, 0, -1.2);
    applyWorldUVs(geo, 3);
    for (const [x, z, r] of [[-2.2, 3.0, 0.25], [2.8, -1.8, -0.15], [0.4, 9.6, 1.45], [-1.6, -10.2, 0.55], [7.8, -15.5, 1.3]]) {
      const mesh = new THREE.Mesh(geo, M.concreteWall);
      mesh.position.set(x, 0, z);
      mesh.rotation.y = r;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.surface = 'concrete';
      root.add(mesh);
      register(mesh, { bounce: true });
      invisibleCollider(V(0.42, 0.84, 2.42), V(x, 0.42, z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), r), 'concrete');
    }
  }

  /* ------------------------------ pipes ------------------------------ */

  {
    const pipe = (r, len, pos, axis) => {
      const geo = new THREE.CylinderGeometry(r, r, len, 18, 1, false);
      applyCylinderUVs(geo, r, len, 1.5);
      const mesh = new THREE.Mesh(geo, M.rustedMetal);
      mesh.position.copy(pos);
      if (axis === 'x') mesh.rotation.z = Math.PI / 2;
      if (axis === 'z') mesh.rotation.x = Math.PI / 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.surface = 'metal';
      root.add(mesh);
      register(mesh);
      // flanges every 4 m
      const flangeGeo = new THREE.CylinderGeometry(r * 1.35, r * 1.35, 0.05, 18);
      const count = Math.floor(len / 4);
      const fl = new THREE.InstancedMesh(flangeGeo, M.rustedMetal, count);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        const o = -len / 2 + (i + 0.5) * (len / count);
        m4.makeTranslation(0, o, 0);
        fl.setMatrixAt(i, m4);
      }
      fl.position.copy(mesh.position);
      fl.rotation.copy(mesh.rotation);
      fl.castShadow = true;
      fl.userData.surface = 'metal';
      root.add(fl);
      return mesh;
    };
    pipe(0.16, W, V(0, 5.7, HALL.minZ + 0.3), 'x');
    pipe(0.1, W, V(0, 6.15, HALL.minZ + 0.22), 'x');
    pipe(0.12, W, V(0, 6.5, HALL.minZ + 0.35), 'x');
    pipe(0.18, D, V(HALL.minX + 0.35, 6.0, 0), 'z');
    pipe(0.11, D, V(HALL.maxX - 0.25, 6.4, 0), 'z');
    pipe(0.12, 5.7, V(HALL.maxX - 0.4, 2.85, HALL.minZ + 0.45), 'y');
    invisibleCollider(V(0.24, 5.7, 0.24), V(HALL.maxX - 0.4, 2.85, HALL.minZ + 0.45), null, 'metal');
    pipe(0.1, 6.0, V(HALL.minX + 0.35, 3.0, HALL.maxZ - 0.4), 'y');
    invisibleCollider(V(0.2, 6.0, 0.2), V(HALL.minX + 0.35, 3.0, HALL.maxZ - 0.4), null, 'metal');
  }

  /* ------------------------------ shutter door (north) ------------------------------ */

  {
    const z = HALL.minZ;
    box(V(0.3, 5.3, 0.45), V(-3.15, 2.65, z + 0.2), M.rustedMetal, { tile: 2, surface: 'metal' });
    box(V(0.3, 5.3, 0.45), V(3.15, 2.65, z + 0.2), M.rustedMetal, { tile: 2, surface: 'metal' });
    box(V(6.6, 0.7, 0.6), V(0, 5.6, z + 0.28), M.rustedMetal, { tile: 2, surface: 'metal' });
    const shutter = box(V(6.0, 5.0, 0.1), V(0, 2.54, z + 0.12), M.containerPaint, { tile: 1.6, surface: 'metal', collider: false });
    // horizontal slats: swap U/V so the corrugation runs sideways
    const uv = shutter.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
    uv.needsUpdate = true;

    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.1, 1.1) });
    const glow = new THREE.Mesh(new THREE.BoxGeometry(5.9, 0.04, 0.02), glowMat);
    glow.position.set(0, 0.02, z + 0.18);
    glow.userData.noAO = true;
    root.add(glow);
    const leak = new THREE.PointLight(0xffa24a, 5, 9, 2);
    leak.position.set(0, 0.18, z + 0.5);
    leak.layers.enableAll();
    root.add(leak);
    level.shutterLight = leak;

    const sector = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 1.4),
      new THREE.MeshStandardMaterial({ map: T.stencilSector, transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    sector.position.set(0, 6.55, z + 0.02);
    sector.receiveShadow = true;
    sector.userData.noAO = true;
    root.add(sector);
  }

  // "NO ENTRY" on the west wall
  {
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 0.8),
      new THREE.MeshStandardMaterial({ map: T.stencilNoEntry, transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    plate.position.set(HALL.minX + 0.02, 2.4, 9);
    plate.rotation.y = Math.PI / 2;
    plate.receiveShadow = true;
    plate.userData.noAO = true;
    root.add(plate);
  }

  /* ------------------------------ exit door (south) ------------------------------ */

  {
    const z = HALL.maxZ;
    const x = -6;
    box(V(1.1, 2.15, 0.08), V(x, 1.075, z - 0.04), M.containerPaint, { tile: 2, surface: 'metal', collider: false });
    box(V(0.12, 2.3, 0.16), V(x - 0.61, 1.15, z - 0.06), M.rustedMetal, { tile: 2, surface: 'metal', collider: false });
    box(V(0.12, 2.3, 0.16), V(x + 0.61, 1.15, z - 0.06), M.rustedMetal, { tile: 2, surface: 'metal', collider: false });
    box(V(1.34, 0.12, 0.16), V(x, 2.36, z - 0.06), M.rustedMetal, { tile: 2, surface: 'metal', collider: false });
    box(V(0.74, 0.3, 0.1), V(x, 2.62, z - 0.05), M.gunMetal, { tile: 1, surface: 'metal', collider: false });
    const signMat = new THREE.MeshStandardMaterial({
      map: T.exitSign,
      emissiveMap: T.exitSign,
      emissive: 0xffffff,
      emissiveIntensity: 2.6,
      roughness: 0.35,
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.25), signMat);
    sign.position.set(x, 2.62, z - 0.101);
    sign.rotation.y = Math.PI;
    root.add(sign);
    const green = new THREE.PointLight(0x3dff7a, 0.9, 5, 2);
    green.position.set(x, 2.45, z - 0.5);
    green.layers.enableAll();
    root.add(green);
  }

  /* ------------------------------ floor markings ------------------------------ */

  {
    const mat = new THREE.MeshStandardMaterial({
      map: T.floorMarking,
      transparent: true,
      depthWrite: false,
      roughness: 0.55,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const strip = (w, len, x, z, rotY) => {
      const geo = new THREE.PlaneGeometry(w, len);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) * (len / 1.6), uv.getX(i));
      uv.needsUpdate = true;
      const m = new THREE.Mesh(geo, mat);
      m.rotation.set(-Math.PI / 2, 0, rotY);
      m.position.set(x, 0.003, z);
      m.receiveShadow = true;
      m.userData.noAO = true;
      root.add(m);
    };
    strip(0.12, 41, -2.6, 0, 0);
    strip(0.12, 41, 2.6, 0, 0);
    strip(0.15, 6, 0, HALL.minZ + 1.6, Math.PI / 2);
    strip(0.12, 20, 9.6, -8, 0);
  }

  /* ------------------------------ physics props ------------------------------ */

  const propBodies = [];
  const watchImpacts = (body) => {
    body.addEventListener('collide', (e) => {
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (v > 1.4) audio.propImpact(body.surface, v / 6, body.position);
    });
    propBodies.push(body);
  };

  const crate = (size, x, y, z, rotY = 0, variant = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), variant ? M.crateB : M.crateA);
    mesh.position.set(x, y + size / 2, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surface = 'wood';
    root.add(mesh);
    register(mesh, { bounce: true });
    const body = physics.addDynamicBox(mesh, size * size * size * 32, { surface: 'wood' });
    watchImpacts(body);
    return mesh;
  };

  const barrelGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 28);
  const barrel = (x, y, z, red = true, lying = false, rotY = 0) => {
    const mesh = new THREE.Mesh(barrelGeo, red ? M.drumRed : M.drumBlue);
    if (lying) {
      mesh.position.set(x, y + 0.29, z);
      mesh.rotation.set(0, rotY, Math.PI / 2);
    } else {
      mesh.position.set(x, y + 0.44, z);
      mesh.rotation.y = rotY;
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surface = 'metal';
    root.add(mesh);
    register(mesh, { bounce: true });
    const body = physics.addDynamicCylinder(mesh, 28, { surface: 'metal' });
    watchImpacts(body);
    return mesh;
  };

  // crates
  crate(0.9, -8.6, 0, -5.4, 0.1, 0);
  crate(0.9, -8.7, 0, -6.45, -0.05, 1);
  crate(0.75, -8.62, 0.9, -5.9, 0.4, 0);
  crate(1.1, 12.0, 0, -12.0, 0.2, 1);
  crate(0.9, 12.9, 0, -13.4, -0.3, 0);
  crate(0.75, 12.05, 1.1, -12.1, 0.7, 0);
  crate(0.9, 4.3, 0, 6.6, 0.3, 1);
  crate(0.75, 4.5, 0, 7.7, -0.2, 0);
  crate(0.9, -4.2, 0, 14.8, 0.5, 0);
  crate(0.75, -3.3, 0, 15.9, 0.1, 1);
  crate(1.1, 3.6, 0, -19.0, 0.05, 0);
  crate(0.9, 4.9, 0, -19.6, -0.25, 1);
  crate(0.75, 3.75, 1.1, -19.1, 0.35, 1);
  crate(0.75, 12.4, cwY, -17.5, 0.15, 0);

  // barrels
  barrel(-6.0, 0, -17.6, true);
  barrel(-6.62, 0, -17.65, false, false, 0.4);
  barrel(-6.3, 0, -18.2, true, false, 1.1);
  barrel(-5.1, 0, -16.9, false, true, 0.6);
  barrel(7.4, 0, 12.2, false);
  barrel(8.0, 0, 12.5, true, false, 0.3);
  barrel(7.7, 0, 11.6, true, false, 2.0);
  barrel(9.4, 0, -4.4, false);
  barrel(9.55, 0, -3.8, true, false, 0.9);
  barrel(-12.6, 0, 3.2, true);
  barrel(-12.2, 0, 3.75, false, false, 0.5);

  /* ------------------------------ fluorescent tubes ------------------------------ */

  const tubeGeo = new THREE.CylinderGeometry(0.026, 0.026, 2.3, 12);
  tubeGeo.rotateX(Math.PI / 2);
  const housingGeo = new THREE.BoxGeometry(0.3, 0.07, 2.5);
  applyWorldUVs(housingGeo, 1);
  const wireGeo = new THREE.CylinderGeometry(0.004, 0.004, 1, 4);
  const fixtures = [
    [-3, -15, 'dying'], [3, -15, 'dead'], [-3, -5, 'dead'], [3, -5, 'faulty'],
    [-3, 5, 'dead'], [3, 5, 'dead'], [-3, 15, 'steady'], [3, 15, 'dead'],
  ];
  const flickerNoise = new PerlinNoise(99);
  fixtures.forEach(([x, z, mode], idx) => {
    const y = 6.3;
    const housing = new THREE.Mesh(housingGeo, M.rustedMetal);
    housing.position.set(x, y, z);
    housing.castShadow = true;
    housing.userData.surface = 'metal';
    root.add(housing);
    register(housing);
    for (const dz of [-1, 1]) {
      const wire = new THREE.Mesh(wireGeo, M.gunMetal);
      const top = H - 0.47;
      wire.scale.y = top - y;
      wire.position.set(x, (top + y) / 2, z + dz);
      root.add(wire);
    }
    const lit = mode !== 'dead';
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0xdde4ea,
      emissive: new THREE.Color(0.86, 0.92, 1.0),
      emissiveIntensity: lit ? 6 : 0,
      roughness: 0.3,
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.position.set(x, y - 0.055, z);
    tube.userData.surface = 'metal';
    root.add(tube);
    register(tube);
    if (!lit) return;
    const rect = new THREE.RectAreaLight(0xdbe6ff, 0, 0.14, 2.3);
    rect.position.set(x, y - 0.09, z);
    rect.rotation.x = -Math.PI / 2;
    rect.layers.enableAll();
    root.add(rect);
    level.flickers.push({ mode, tubeMat, rect, base: mode === 'steady' ? 320 : 280, level: 1, timer: Math.random() * 3, burst: 0, phase: idx * 13.7 });
  });

  function updateFlicker(f, dt, time) {
    let lvl = 1;
    if (f.mode === 'steady') {
      lvl = 0.94 + flickerNoise.noise1(time * 3 + f.phase) * 0.05;
    } else if (f.mode === 'faulty') {
      f.timer -= dt;
      if (f.timer <= 0) {
        f.burst = 0.25 + Math.random() * 0.9;
        f.timer = 2.5 + Math.random() * 6;
      }
      if (f.burst > 0) {
        f.burst -= dt;
        lvl = Math.random() < 0.55 ? 0.05 : 1;
      }
    } else if (f.mode === 'dying') {
      f.timer -= dt;
      if (f.timer <= 0) {
        f.burst = 0.08 + Math.random() * 0.5;
        f.timer = 0.6 + Math.random() * 3.5;
      }
      if (f.burst > 0) {
        f.burst -= dt;
        lvl = Math.random() < 0.4 ? 0.7 : 0.08;
      } else {
        lvl = 0.02;
      }
    }
    f.level = lvl;
    f.rect.intensity = f.base * lvl;
    f.tubeMat.emissiveIntensity = 6 * lvl;
  }

  /* ------------------------------ hanging lamp (pendulum) ------------------------------ */

  {
    const anchor = V(0.3, H - 0.47, 0.6);
    const L = 2.3;
    const theta0 = 0.16;
    const group = new THREE.Group();
    root.add(group);

    const shadeProfile = [
      new THREE.Vector2(0.0, 0.16),
      new THREE.Vector2(0.06, 0.16),
      new THREE.Vector2(0.07, 0.1),
      new THREE.Vector2(0.16, 0.04),
      new THREE.Vector2(0.3, -0.06),
      new THREE.Vector2(0.38, -0.14),
      new THREE.Vector2(0.385, -0.16),
    ];
    const shadeMat = M.containerPaint.clone();
    shadeMat.side = THREE.DoubleSide;
    const shade = new THREE.Mesh(new THREE.LatheGeometry(shadeProfile, 32), shadeMat);
    shade.castShadow = false;
    shade.userData.surface = 'metal';
    group.add(shade);

    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff2d6, emissive: 0xffd9a0, emissiveIntensity: 14, roughness: 0.2 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), bulbMat);
    bulb.position.y = -0.04;
    group.add(bulb);

    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, L, 6), M.gunMetal);
    chain.position.y = 0.16 + L / 2 - 0.16;
    group.add(chain);

    const spot = new THREE.SpotLight(0xffd59a, 150, 24, 0.66, 0.55, 2);
    spot.position.set(0, -0.06, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0001;
    spot.shadow.normalBias = 0.03;
    spot.shadow.camera.near = 0.2;
    spot.shadow.camera.far = 22;
    spot.layers.enableAll();
    spot.target.position.set(0, -6, 0);
    group.add(spot);
    group.add(spot.target);

    // Fake volumetric cone, additive, fading with distance from the bulb.
    const coneLen = 5.6;
    const coneGeo = new THREE.ConeGeometry(Math.tan(0.6) * coneLen, coneLen, 40, 1, true);
    coneGeo.translate(0, -coneLen / 2, 0);
    const coneMat = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: 0.11 }, uColor: { value: new THREE.Color(1.0, 0.82, 0.55) }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vAxial;
        varying vec3 vNormalV;
        varying vec3 vViewV;
        varying vec3 vWorld;
        void main() {
          vAxial = 1.0 - uv.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormalV = normalize(normalMatrix * normal);
          vViewV = normalize(-mv.xyz);
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uIntensity;
        uniform vec3 uColor;
        uniform float uTime;
        varying float vAxial;
        varying vec3 vNormalV;
        varying vec3 vViewV;
        varying vec3 vWorld;
        void main() {
          float facing = abs(dot(vNormalV, vViewV));
          float edge = pow(facing, 1.6);
          float along = pow(1.0 - vAxial, 1.8) * smoothstep(0.0, 0.06, vAxial);
          float swirl = 0.8 + 0.2 * sin(vWorld.y * 3.0 + uTime * 0.7 + vWorld.x * 2.0);
          float a = edge * along * swirl * uIntensity;
          gl_FragColor = vec4(uColor * a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.y = -0.06;
    cone.userData.noAO = true;
    cone.renderOrder = 2;
    group.add(cone);

    // Physics: rigid pendulum. The body's local +Y always points at the
    // anchor, so the body's rotation *is* the lamp's rotation.
    const body = new CANNON.Body({
      mass: 6,
      linearDamping: 0.012,
      angularDamping: 0.6,
      allowSleep: false,
      collisionFilterGroup: 0,
      collisionFilterMask: 0,
    });
    body.addShape(new CANNON.Sphere(0.25));
    const q0 = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), theta0);
    const p0 = V(0, -L, 0).applyQuaternion(q0).add(anchor);
    body.position.set(p0.x, p0.y, p0.z);
    body.quaternion.set(q0.x, q0.y, q0.z, q0.w);
    body.previousPosition.copy(body.position);
    body.previousQuaternion.copy(body.quaternion);
    body.surface = 'metal';
    physics.world.addBody(body);
    physics.addPendulum(body, anchor, V(0, L, 0));
    physics.link(body, group);
    group.position.copy(p0);
    group.quaternion.copy(q0);
    shade.userData.body = body;
    bulb.userData.body = body;
    register(shade);
    register(bulb);

    level.lamp = { group, body, spot, cone, coneMat, bulbMat, anchor, noise: new PerlinNoise(7) };
  }

  /* ------------------------------ rotating beacons ------------------------------ */

  {
    const domeGeo = new THREE.SphereGeometry(0.11, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const baseGeo = new THREE.CylinderGeometry(0.12, 0.13, 0.08, 20);
    const bracketGeo = new THREE.BoxGeometry(0.08, 0.08, 0.3);
    const makeBeacon = (pos, facing, phase) => {
      const g = new THREE.Group();
      g.position.copy(pos);
      g.rotation.y = facing;
      root.add(g);
      const bracket = new THREE.Mesh(bracketGeo, M.rustedMetal);
      bracket.position.set(0, -0.04, -0.11);
      g.add(bracket);
      const base = new THREE.Mesh(baseGeo, M.gunMetal);
      base.position.y = -0.04;
      g.add(base);
      const domeMat = new THREE.MeshStandardMaterial({ color: 0x400806, emissive: 0xff1a0a, emissiveIntensity: 7, roughness: 0.2, transparent: true, opacity: 0.92 });
      const dome = new THREE.Mesh(domeGeo, domeMat);
      g.add(dome);
      const spot = new THREE.SpotLight(0xff2210, 45, 16, 0.42, 0.35, 2);
      spot.position.set(0, 0.05, 0);
      spot.layers.enableAll();
      g.add(spot);
      g.add(spot.target);
      level.beacons.push({ spot, domeMat, phase, group: g });
    };
    makeBeacon(V(3.7, 5.55, HALL.minZ + 0.2), 0, 0);
    makeBeacon(V(HALL.minX + 0.2, 5.0, 10), Math.PI / 2, 1.7);
  }

  /* ------------------------------ dust motes ------------------------------ */

  level.dust = createDust(scene);

  /* ------------------------------ per-frame update ------------------------------ */

  let humLevel = 0;
  level.update = (dt, time, { flashlight }) => {
    humLevel = 0;
    for (const f of level.flickers) {
      updateFlicker(f, dt, time);
      humLevel = Math.max(humLevel, f.level);
    }
    audio.setHum(humLevel);

    for (const b of level.beacons) {
      const a = time * 3.2 + b.phase;
      b.spot.target.position.set(Math.cos(a) * 3, -1.1, Math.sin(a) * 3);
      b.domeMat.emissiveIntensity = 5 + 4 * Math.max(0, Math.sin(a - Math.PI / 2));
    }

    // A slow draught keeps the hanging lamp gently alive.
    const lamp = level.lamp;
    const fx = lamp.noise.noise1(time * 0.15, 1) * 2.2;
    const fz = lamp.noise.noise1(time * 0.15, 2) * 2.2;
    lamp.body.applyForce(new CANNON.Vec3(fx, 0, fz));
    lamp.coneMat.uniforms.uTime.value = time;

    level.shutterLight.intensity = 5 + Math.sin(time * 0.9) * 0.4 + lamp.noise.noise1(time * 2, 3) * 0.6;

    // dust lighting uniforms
    const u = level.dust.material.uniforms;
    u.uTime.value = time;
    u.uLightPos.value[0].copy(flashlight.worldPosition);
    u.uLightDir.value[0].copy(flashlight.worldDirection);
    u.uLightCos.value[0] = Math.cos(flashlight.light.angle);
    u.uLightIntensity.value[0] = flashlight.light.intensity / flashlight.baseIntensity;
    lamp.spot.getWorldPosition(u.uLightPos.value[1]);
    lamp.spot.target.getWorldPosition(_v);
    u.uLightDir.value[1].subVectors(_v, u.uLightPos.value[1]).normalize();
    u.uLightCos.value[1] = Math.cos(lamp.spot.angle);
    u.uLightIntensity.value[1] = 0.7;
  };

  return level;
}

/* -------------------------------------------------------------------------- */
/* Dust motes                                                                 */
/* -------------------------------------------------------------------------- */

function createDust(scene) {
  const count = 2600;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const min = new THREE.Vector3(HALL.minX, 0.1, HALL.minZ);
  const size = new THREE.Vector3(HALL.maxX - HALL.minX, HALL.height - 0.3, HALL.maxZ - HALL.minZ);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = min.x + Math.random() * size.x;
    positions[i * 3 + 1] = min.y + Math.random() * size.y;
    positions[i * 3 + 2] = min.z + Math.random() * size.z;
    seeds[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3.5, 0), 40);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 600 },
      uBoxMin: { value: min },
      uBoxSize: { value: size },
      uLightPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uLightDir: { value: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1, 0)] },
      uLightCos: { value: [0.9, 0.9] },
      uLightIntensity: { value: [1, 1] },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uScale;
      uniform vec3 uBoxMin;
      uniform vec3 uBoxSize;
      uniform vec3 uLightPos[2];
      uniform vec3 uLightDir[2];
      uniform float uLightCos[2];
      uniform float uLightIntensity[2];
      attribute float aSeed;
      varying float vBright;
      void main() {
        vec3 p = position;
        float s = aSeed * 6.2831;
        p += vec3(sin(uTime * 0.13 + s * 3.0), sin(uTime * 0.09 + s * 5.0) * 0.6, cos(uTime * 0.11 + s * 2.0)) * 0.45;
        p += vec3(uTime * 0.035, -uTime * 0.012, uTime * 0.018);
        p = uBoxMin + mod(p - uBoxMin, uBoxSize);

        float b = 0.0;
        for (int i = 0; i < 2; i++) {
          vec3 L = p - uLightPos[i];
          float d = length(L);
          float c = dot(L / max(d, 1e-3), uLightDir[i]);
          float cone = smoothstep(uLightCos[i], uLightCos[i] + 0.08, c);
          b += cone * uLightIntensity[i] * 3.0 / (1.0 + d * d * 0.12);
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float depth = -mv.z;
        b *= smoothstep(0.25, 1.0, depth) * (1.0 - smoothstep(12.0, 20.0, depth));
        vBright = b * (0.55 + 0.45 * sin(uTime * 2.0 + s * 9.0));
        gl_PointSize = max(1.0, uScale * (0.008 + aSeed * 0.012) / depth);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vBright;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.05, length(c));
        if (a * vBright < 0.002) discard;
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.82) * vBright * a * 0.6, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.userData.noAO = true;
  points.renderOrder = 3;
  scene.add(points);
  return points;
}
