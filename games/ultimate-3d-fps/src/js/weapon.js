import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { LAYERS } from './engine.js';
import { CANNON, GROUP } from './physics.js';
import { damp } from './player.js';

// First-person rifle: procedural viewmodel, hitscan firing with spread and
// recoil, reload choreography, muzzle flash (sprites + light), shell casings
// with real physics, bullet-hole decals projected onto the hit mesh, and
// spark / dust / debris particles.

const MAG_SIZE = 30;
const FIRE_INTERVAL = 60 / 640; // 640 rpm
const SIGHT = new THREE.Vector3(0, 0.128, -0.06);
const HIP = new THREE.Vector3(0.15, -0.162, -0.33);
const ADS = new THREE.Vector3(-SIGHT.x, -SIGHT.y, -0.235);
const IMPULSE = 9;

const smooth = THREE.MathUtils.smoothstep;
const bump = (t, a, b, c, d) => smooth(t, a, b) * (1 - smooth(t, c, d));

/* -------------------------------------------------------------------------- */
/* Particles                                                                  */
/* -------------------------------------------------------------------------- */

class Particles {
  constructor(scene, max, texture, { additive }) {
    this.max = max;
    this.count = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.drag = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aAlpha', this.aAlpha);
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture }, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        uniform float uScale;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.5, uScale * aSize / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor * ${additive ? 'a' : '1.0'}, ${additive ? '1.0' : 'a'});
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.userData.noAO = true;
    this.points.renderOrder = additive ? 4 : 3;
    scene.add(this.points);
  }

  spawn(pos, vel, { life, size, grow = 0, color, alpha = 1, gravity = 0, drag = 0 }) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.p[i3] = pos.x;
    this.p[i3 + 1] = pos.y;
    this.p[i3 + 2] = pos.z;
    this.v[i3] = vel.x;
    this.v[i3 + 1] = vel.y;
    this.v[i3 + 2] = vel.z;
    this.c[i3] = color[0];
    this.c[i3 + 1] = color[1];
    this.c[i3 + 2] = color[2];
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.alpha0[i] = alpha;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
  }

  _kill(i) {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3;
    const l3 = last * 3;
    for (let k = 0; k < 3; k++) {
      this.p[i3 + k] = this.p[l3 + k];
      this.v[i3 + k] = this.v[l3 + k];
      this.c[i3 + k] = this.c[l3 + k];
    }
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size[i] = this.size[last];
    this.grow[i] = this.grow[last];
    this.alpha0[i] = this.alpha0[last];
    this.gravity[i] = this.gravity[last];
    this.drag[i] = this.drag[last];
  }

  update(dt) {
    const pos = this.aPos.array;
    const col = this.aCol.array;
    const siz = this.aSize.array;
    const alp = this.aAlpha.array;
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) this._kill(i);
    }
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const drag = Math.max(0, 1 - this.drag[i] * dt);
      this.v[i3] *= drag;
      this.v[i3 + 1] = this.v[i3 + 1] * drag - this.gravity[i] * dt;
      this.v[i3 + 2] *= drag;
      this.p[i3] += this.v[i3] * dt;
      this.p[i3 + 1] += this.v[i3 + 1] * dt;
      this.p[i3 + 2] += this.v[i3 + 2] * dt;
      if (this.p[i3 + 1] < 0.01 && this.v[i3 + 1] < 0) {
        this.p[i3 + 1] = 0.01;
        this.v[i3 + 1] *= -0.3;
        this.v[i3] *= 0.5;
        this.v[i3 + 2] *= 0.5;
      }
      const t = this.life[i] / this.maxLife[i]; // 1 -> 0
      pos[i3] = this.p[i3];
      pos[i3 + 1] = this.p[i3 + 1];
      pos[i3 + 2] = this.p[i3 + 2];
      col[i3] = this.c[i3];
      col[i3 + 1] = this.c[i3 + 1];
      col[i3 + 2] = this.c[i3 + 2];
      siz[i] = this.size[i] * (1 + this.grow[i] * (1 - t));
      alp[i] = this.alpha0[i] * Math.min(1, t * 2.5) * Math.min(1, (1 - t) * 30 + 0.2);
    }
    this.points.geometry.setDrawRange(0, this.count);
    for (const a of [this.aPos, this.aCol]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * 3);
      a.needsUpdate = true;
    }
    for (const a of [this.aSize, this.aAlpha]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count);
      a.needsUpdate = true;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Weapon                                                                     */
/* -------------------------------------------------------------------------- */

export class Weapon {
  constructor({ engine, physics, materials: M, textures: T, audio, level, player, input, post }) {
    this.engine = engine;
    this.physics = physics;
    this.audio = audio;
    this.level = level;
    this.player = player;
    this.input = input;
    this.post = post;
    this.camera = engine.camera;

    this.ammo = MAG_SIZE;
    this.fireTimer = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.reloadDuration = 0;
    this.reloadEmpty = false;
    this.aim = 0;
    this.aimEase = 0;
    this.sprintAmount = 0;
    this.consecutive = 0;
    this.bloom = 0;
    this.blockSprint = false;
    this.shots = 0;
    this.time = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.flash = 0;

    // recoil springs (gun model)
    this.kickBack = { v: 0, x: 0 };
    this.kickUp = { v: 0, x: 0 };
    this.kickRoll = { v: 0, x: 0 };
    this.kickSide = { v: 0, x: 0 };

    this._buildViewmodel(M, T);
    this._buildMuzzleFlash(T);
    this._buildFX(M, T);
    this._buildCasings();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 200;
    this.raycaster.layers.set(LAYERS.WORLD);
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._helper = new THREE.Object3D();
  }

  /* ------------------------------ construction ------------------------------ */

  _buildViewmodel(M, T) {
    this.root = new THREE.Group();
    this.camera.add(this.root);
    this.model = new THREE.Group();
    this.root.add(this.model);

    // Viewmodel-only copies of the gun materials: brighter environment
    // reflections keep the dark gunmetal readable in a dark level, and the
    // world never shares a material with the viewmodel pass.
    const vm = (mat) => {
      const m = mat.clone();
      m.envMapIntensity = 3.2;
      return m;
    };
    M = { ...M, gunMetal: vm(M.gunMetal), gunPolymer: vm(M.gunPolymer), gunAccent: vm(M.gunAccent) };

    // Soft key light for the weapon only (layer 1), from the upper left.
    const key = new THREE.DirectionalLight(0xc9d6ff, 1.6);
    key.position.set(-1, 1.2, 0.6);
    key.target.position.set(0.2, -0.3, -1);
    key.layers.set(LAYERS.VIEWMODEL);
    this.camera.add(key);
    this.camera.add(key.target);

    const dark = new THREE.MeshStandardMaterial({ color: 0x040404, roughness: 0.7, metalness: 0.2 });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = this.model) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      parent.add(m);
      return m;
    };
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const cylZ = (r, len, seg = 14, open = false) => new THREE.CylinderGeometry(r, r, len, seg, 1, open).rotateX(Math.PI / 2);

    // receiver
    add(box(0.048, 0.062, 0.25), M.gunMetal, 0, 0, -0.02);
    add(box(0.05, 0.05, 0.31), M.gunMetal, 0, 0.054, -0.05);
    add(box(0.022, 0.01, 0.3), M.gunMetal, 0, 0.084, -0.06);
    // ejection port
    add(box(0.003, 0.024, 0.065), dark, 0.0255, 0.055, -0.03);
    // handguard + vents
    add(cylZ(0.031, 0.25, 8), M.gunMetal, 0, 0.05, -0.33, 0, 0, Math.PI / 8);
    for (let k = 0; k < 4; k++) {
      for (const sx of [-1, 1]) add(box(0.004, 0.012, 0.03), dark, sx * 0.03, 0.05, -0.25 - k * 0.045);
    }
    // barrel + muzzle device
    add(cylZ(0.0105, 0.18, 12), M.gunMetal, 0, 0.05, -0.54);
    add(cylZ(0.017, 0.055, 12), M.gunMetal, 0, 0.05, -0.655);
    for (const a of [0, Math.PI / 2]) add(box(0.004, 0.036, 0.03), dark, 0, 0.05, -0.655, 0, 0, a);
    // magwell, magazine
    add(box(0.044, 0.04, 0.085), M.gunMetal, 0, -0.045, -0.06);
    this.magazine = new THREE.Group();
    this.magazine.position.set(0, -0.035, -0.06);
    this.model.add(this.magazine);
    add(box(0.03, 0.15, 0.072), M.gunPolymer, 0, -0.07, -0.008, 0.16, 0, 0, this.magazine);
    add(box(0.035, 0.012, 0.08), M.gunPolymer, 0, -0.145, -0.02, 0.16, 0, 0, this.magazine);
    this.magBaseY = this.magazine.position.y;
    // grip, trigger
    add(box(0.034, 0.105, 0.046), M.gunPolymer, 0, -0.072, 0.085, -0.32);
    add(box(0.006, 0.006, 0.075), M.gunMetal, 0, -0.058, 0.03);
    add(box(0.005, 0.022, 0.006), M.gunMetal, 0, -0.043, 0.03, 0.2);
    // buffer tube + stock
    add(cylZ(0.015, 0.17, 12), M.gunMetal, 0, 0.04, 0.19);
    add(box(0.042, 0.075, 0.13), M.gunPolymer, 0, 0.025, 0.29);
    add(box(0.045, 0.085, 0.015), M.gunPolymer, 0, 0.025, 0.36);
    // charging handle (animated during reload)
    this.chargingHandle = add(box(0.034, 0.01, 0.025), M.gunAccent, 0, 0.07, 0.115);
    this.chargingHandleZ = this.chargingHandle.position.z;
    // red-dot sight
    add(box(0.026, 0.024, 0.045), M.gunMetal, 0, 0.103, SIGHT.z);
    const housing = add(cylZ(0.019, 0.058, 24, true), M.gunMetal, SIGHT.x, SIGHT.y, SIGHT.z);
    housing.material = M.gunMetal.clone();
    housing.material.side = THREE.DoubleSide;
    const lens = add(new THREE.CircleGeometry(0.017, 24), new THREE.MeshStandardMaterial({
      color: 0x9fd8c0, transparent: true, opacity: 0.14, roughness: 0.04, metalness: 0.4, depthWrite: false,
    }), SIGHT.x, SIGHT.y, SIGHT.z - 0.026);
    lens.renderOrder = 5;
    this.redDot = add(new THREE.CircleGeometry(0.0009, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 0.6, 0.4) }), SIGHT.x, SIGHT.y, SIGHT.z - 0.024);
    this.redDot.renderOrder = 6;
    // flashlight attachment
    add(cylZ(0.013, 0.06, 14), M.gunMetal, 0.04, 0.03, -0.36);
    add(box(0.012, 0.02, 0.02), M.gunMetal, 0.031, 0.04, -0.36);

    this.root.traverse((o) => {
      o.layers.set(LAYERS.VIEWMODEL);
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    this.model.position.copy(HIP);
  }

  _buildMuzzleFlash(T) {
    const g = new THREE.Group();
    g.position.set(0, 0.05, -0.69);
    this.model.add(g);
    const mat = (tex) => new THREE.MeshBasicMaterial({
      map: tex,
      color: new THREE.Color(5, 3.8, 2.6),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), mat(T.muzzle.front));
    g.add(front);
    const sideGeo = new THREE.PlaneGeometry(0.3, 0.11).translate(0.15, 0, 0);
    const sides = [];
    for (const a of [0, Math.PI / 2]) {
      const holder = new THREE.Group();
      holder.rotation.z = a;
      const s = new THREE.Mesh(sideGeo, mat(T.muzzle.side));
      s.rotation.y = Math.PI / 2;
      holder.add(s);
      g.add(holder);
      sides.push(s);
    }
    g.traverse((o) => o.layers.set(LAYERS.VIEWMODEL));
    g.visible = false;
    this.flashGroup = g;
    this.flashFront = front;

    // The light sits inside the player's collider so it can't shine through walls.
    this.muzzleLight = new THREE.PointLight(0xffa860, 0, 10, 2);
    this.muzzleLight.position.set(0.1, -0.06, -0.22);
    this.muzzleLight.layers.enableAll();
    this.camera.add(this.muzzleLight);
  }

  _buildFX(M, T) {
    const scene = this.engine.scene;
    this.sparks = new Particles(scene, 600, T.softParticle, { additive: true });
    this.dust = new Particles(scene, 500, T.softParticle, { additive: false });

    this.decals = [];
    this.decalIndex = 0;
    this.maxDecals = 90;
    this.decalMaterial = M.bulletHole;
    // Pre-warm the decal shader (avoid a hitch on the first hit).
    const warm = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), this.decalMaterial);
    warm.position.set(0, -0.6, 0);
    warm.userData.noAO = true;
    scene.add(warm);
    this.decals.push(warm);

    this.tracers = [];
    // Unit-length streak along +Z (Object3D.lookAt points +Z at the target).
    const tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 1).translate(0, 0, 0.5);
    const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 6, 2.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(tracerGeo, tracerMat.clone());
      m.visible = false;
      m.userData.noAO = true;
      m.userData.life = 0;
      scene.add(m);
      this.tracers.push(m);
    }
  }

  _buildCasings() {
    const geo = new THREE.CylinderGeometry(0.0048, 0.0048, 0.03, 8);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.78, 0.52, 0.2), metalness: 1, roughness: 0.28 });
    this.casings = [];
    this.casingIndex = 0;
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.position.set(0, -2, 0);
      this.engine.scene.add(mesh);
      const body = new CANNON.Body({
        mass: 0.012,
        material: this.physics.materials.debris,
        collisionFilterGroup: GROUP.DEBRIS,
        collisionFilterMask: GROUP.STATIC | GROUP.PROP,
        linearDamping: 0.05,
        angularDamping: 0.3,
        allowSleep: true,
        sleepSpeedLimit: 0.08,
        sleepTimeLimit: 0.4,
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.006, 0.015, 0.006)));
      body.position.set(0, -50 - i, 0);
      this.physics.world.addBody(body);
      body.sleep();
      const c = { mesh, body, active: false, tinks: 0, age: 0, park: -50 - i };
      body.addEventListener('collide', (e) => {
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (c.active && v > 0.5 && c.tinks < 4) {
          c.tinks++;
          this.audio.casing(body.position);
        }
      });
      this.casings.push(c);
    }
  }

  /* ------------------------------ gameplay ------------------------------ */

  /** Called before the player update: aim state and sprint blocking. */
  preUpdate(dt) {
    const input = this.input;
    const wantAim = input.mouseDown(2) && !this.reloading && !(this.player.sprinting && this.sprintAmount > 0.5);
    this.aim = THREE.MathUtils.clamp(this.aim + (wantAim ? dt : -dt) / 0.17, 0, 1);
    this.aimEase = this.aim * this.aim * (3 - 2 * this.aim);
    this.blockSprint = input.mouseDown(0) || this.aim > 0.3;
  }

  startReload() {
    if (this.reloading || this.ammo >= MAG_SIZE + 1) return;
    if (this.ammo === MAG_SIZE) return;
    this.reloading = true;
    this.reloadT = 0;
    this.reloadEmpty = this.ammo === 0;
    this.reloadDuration = this.reloadEmpty ? 2.05 : 1.6;
  }

  _reloadEvents(prev, t) {
    const at = (x) => prev < x && t >= x;
    if (at(0.32)) this.audio.reload('magOut');
    if (at(1.02)) {
      this.audio.reload('magIn');
      this.ammo = this.reloadEmpty ? MAG_SIZE : MAG_SIZE + 1; // one in the chamber on a tactical reload
      this.kickBack.v += 0.25;
    }
    if (this.reloadEmpty && at(1.28)) this.audio.reload('boltBack');
    if (this.reloadEmpty && at(1.5)) {
      this.audio.reload('boltForward');
      this.kickRoll.v += 1.2;
    }
  }

  _fire() {
    this.ammo--;
    this.fireTimer += FIRE_INTERVAL;
    this.shots++;
    this.consecutive++;
    const camera = this.camera;

    // spread (radians)
    const p = this.player;
    const moving = Math.min(1, p.horizontalSpeed / 3.7);
    let spread = THREE.MathUtils.lerp(0.02, 0.0015, this.aimEase);
    spread += moving * THREE.MathUtils.lerp(0.022, 0.006, this.aimEase);
    if (!p.grounded) spread += 0.05;
    if (p.crouched) spread *= 0.7;
    spread += this.bloom;
    this.bloom = Math.min(0.035, this.bloom + THREE.MathUtils.lerp(0.0055, 0.0022, this.aimEase));

    camera.updateMatrixWorld();
    camera.getWorldPosition(this._origin);
    camera.getWorldDirection(this._dir);
    this._right.setFromMatrixColumn(camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(camera.matrixWorld, 1);
    const r = spread * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    this._dir.addScaledVector(this._right, Math.cos(a) * r).addScaledVector(this._up, Math.sin(a) * r).normalize();

    this.raycaster.set(this._origin, this._dir);
    const hit = this.raycaster.intersectObjects(this.level.shootables, false)[0] || null;
    const end = hit ? hit.point : this._origin.clone().addScaledVector(this._dir, 120);
    if (hit) this._impact(hit, this._dir);
    if (this.shots % 3 === 1) this._tracer(end);

    // feedback
    this.audio.gunshot();
    const kick = THREE.MathUtils.lerp(1, 0.55, this.aimEase) * (p.crouched ? 0.8 : 1);
    const climb = 0.0105 + Math.random() * 0.004;
    const side = (Math.random() - 0.45) * 0.006;
    p.applyRecoil(climb * kick, side * kick);
    p.addTrauma(0.085 * kick);
    this.post.addShock(0.35);

    this.kickBack.v += 1.6 * kick;
    this.kickUp.v += 2.4 * kick;
    this.kickRoll.v += (Math.random() - 0.5) * 3.0;
    this.kickSide.v += (Math.random() - 0.5) * 0.6;

    this.flash = 0.05;
    this.flashGroup.visible = true;
    this.flashGroup.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.8 + Math.random() * 0.5;
    this.flashGroup.scale.set(s, s, 0.8 + Math.random() * 0.6);
    this.muzzleLight.intensity = 22 + Math.random() * 10;

    this._ejectCasing();
  }

  _impact(hit, dir) {
    const obj = hit.object;
    const surface = obj.userData.surface || 'concrete';
    const n = new THREE.Vector3();
    if (hit.face) {
      n.copy(hit.face.normal);
      if (obj.isInstancedMesh && hit.instanceId !== undefined) {
        const im = new THREE.Matrix4();
        obj.getMatrixAt(hit.instanceId, im);
        n.transformDirection(im);
      }
      n.transformDirection(obj.matrixWorld);
      if (n.dot(dir) > 0) n.negate();
    } else {
      n.copy(dir).negate();
    }
    const point = hit.point;

    // particles
    const reflect = dir.clone().reflect(n);
    const tmpV = new THREE.Vector3();
    const jitter = (spreadAmt, speed, along) => tmpV.set(
      along.x + (Math.random() - 0.5) * spreadAmt,
      along.y + (Math.random() - 0.5) * spreadAmt,
      along.z + (Math.random() - 0.5) * spreadAmt,
    ).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
    const base = point.clone().addScaledVector(n, 0.01);
    const sparkCount = surface === 'metal' ? 16 : surface === 'concrete' ? 6 : 1;
    for (let i = 0; i < sparkCount; i++) {
      const along = reflect.clone().lerp(n, 0.5).normalize();
      this.sparks.spawn(base, jitter(1.6, surface === 'metal' ? 7 : 4.5, along), {
        life: 0.15 + Math.random() * 0.35,
        size: 0.012 + Math.random() * 0.01,
        color: [9, 4.2 + Math.random() * 2, 1.2],
        gravity: 9.81,
        drag: 1.2,
      });
    }
    const dustColor = surface === 'wood' ? [0.22, 0.15, 0.09] : surface === 'metal' ? [0.12, 0.12, 0.12] : [0.3, 0.29, 0.27];
    const puffs = surface === 'metal' ? 3 : 7;
    for (let i = 0; i < puffs; i++) {
      this.dust.spawn(base, jitter(1.2, 1.4, n), {
        life: 0.6 + Math.random() * 0.9,
        size: 0.06 + Math.random() * 0.05,
        grow: 3.5,
        color: dustColor,
        alpha: 0.35,
        gravity: -0.15,
        drag: 3.5,
      });
    }
    const chunks = surface === 'metal' ? 0 : 7;
    for (let i = 0; i < chunks; i++) {
      this.dust.spawn(base, jitter(1.8, 3.2, n), {
        life: 0.5 + Math.random() * 0.6,
        size: 0.01 + Math.random() * 0.008,
        color: surface === 'wood' ? [0.3, 0.2, 0.1] : [0.14, 0.135, 0.13],
        alpha: 1,
        gravity: 9.81,
        drag: 0.6,
      });
    }

    this._decal(obj, point, n, surface);

    // physics response
    const body = obj.userData.body;
    if (body && body.type === CANNON.Body.DYNAMIC) {
      body.wakeUp();
      const scale = obj.userData.impulseScale ?? 1;
      body.applyImpulse(
        new CANNON.Vec3(dir.x * IMPULSE * scale, dir.y * IMPULSE * scale, dir.z * IMPULSE * scale),
        new CANNON.Vec3(point.x - body.position.x, point.y - body.position.y, point.z - body.position.z),
      );
    }

    this.audio.impact(surface, point);
  }

  _decal(mesh, point, normal, surface) {
    if (mesh.isInstancedMesh || !mesh.geometry.attributes.normal) return;
    mesh.updateMatrixWorld();
    const helper = this._helper;
    helper.position.copy(point);
    helper.lookAt(point.clone().add(normal));
    helper.rotation.z = Math.random() * Math.PI * 2;
    const s = surface === 'concrete' ? 0.13 + Math.random() * 0.05 : 0.08 + Math.random() * 0.03;
    const geo = new DecalGeometry(mesh, point, helper.rotation, new THREE.Vector3(s, s, 0.12));
    if (geo.attributes.position.count === 0) {
      geo.dispose();
      return;
    }
    const decal = new THREE.Mesh(geo, this.decalMaterial);
    decal.receiveShadow = true;
    decal.userData.noAO = true;
    decal.renderOrder = 1;
    const body = mesh.userData.body;
    if (body && body.type === CANNON.Body.DYNAMIC) {
      // Follow the prop: move the world-space decal into the mesh's local space.
      mesh.updateMatrixWorld();
      geo.applyMatrix4(mesh.matrixWorld.clone().invert());
      mesh.add(decal);
    } else {
      this.engine.scene.add(decal);
    }
    if (this.decals.length < this.maxDecals) {
      this.decals.push(decal);
    } else {
      const old = this.decals[this.decalIndex];
      old.parent?.remove(old);
      old.geometry.dispose();
      this.decals[this.decalIndex] = decal;
      this.decalIndex = (this.decalIndex + 1) % this.maxDecals;
    }
  }

  _tracer(end) {
    const t = this.tracers.find((m) => !m.visible) || this.tracers[0];
    const start = this.camera.localToWorld(new THREE.Vector3(0.12, -0.09, -0.6));
    const len = start.distanceTo(end);
    if (len < 1.5) return;
    t.position.copy(start);
    t.lookAt(end);
    t.scale.set(1, 1, Math.min(len, 14));
    t.userData.life = 0.045;
    t.userData.speed = len / 0.06;
    t.userData.end = end.clone();
    t.material.opacity = 1;
    t.visible = true;
  }

  _ejectCasing() {
    const c = this.casings[this.casingIndex];
    this.casingIndex = (this.casingIndex + 1) % this.casings.length;
    const cam = this.camera;
    const pos = cam.localToWorld(new THREE.Vector3(0.11, -0.08, -0.32));
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const fwd = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate();
    const v = right.multiplyScalar(2.2 + Math.random() * 0.8)
      .addScaledVector(up, 1.5 + Math.random() * 0.6)
      .addScaledVector(fwd, -0.4 + Math.random() * 0.3)
      .add(this.player.velocity);
    const b = c.body;
    b.position.set(pos.x, pos.y, pos.z);
    b.previousPosition.copy(b.position);
    b.velocity.set(v.x, v.y, v.z);
    b.angularVelocity.set((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 40);
    b.quaternion.setFromEuler(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    b.previousQuaternion.copy(b.quaternion);
    b.wakeUp();
    if (!c.active) this.physics.link(b, c.mesh);
    c.active = true;
    c.tinks = 0;
    c.age = 0;
    c.mesh.visible = true;
  }

  /* ------------------------------ per frame ------------------------------ */

  update(dt) {
    const input = this.input;
    const p = this.player;
    this.time += dt;
    this.fireTimer = Math.max(this.fireTimer - dt, -FIRE_INTERVAL);
    if (this.fireTimer < 0 && !input.mouseDown(0)) this.fireTimer = 0;
    this.bloom = Math.max(0, this.bloom - dt * 0.05 - this.bloom * dt * 3);

    this.sprintAmount = damp(this.sprintAmount, p.sprinting && p.horizontalSpeed > 2 ? 1 : 0, 9, dt);

    if (input.wasPressed('KeyR')) this.startReload();

    if (this.reloading) {
      const prev = this.reloadT;
      this.reloadT += dt;
      this._reloadEvents(prev, this.reloadT);
      if (this.reloadT >= this.reloadDuration) this.reloading = false;
    }

    const trigger = input.mouseDown(0);
    if (trigger && !this.reloading && this.sprintAmount < 0.4) {
      if (this.ammo > 0) {
        while (this.fireTimer <= 0 && this.ammo > 0) this._fire();
      } else if (input.mousePressed(0)) {
        this.audio.dryFire();
        this.startReload();
      }
    }
    if (!trigger) this.consecutive = 0;

    this._animate(dt);
    this._updateFX(dt);
  }

  _spring(s, k, c, dt) {
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      s.v += (-k * s.x - c * s.v) * h;
      s.x += s.v * h;
    }
    return s.x;
  }

  _animate(dt) {
    const p = this.player;
    const aim = this.aimEase;
    const pos = new THREE.Vector3().lerpVectors(HIP, ADS, aim);
    const rot = new THREE.Vector3();

    // sprint pose: gun canted down and to the left
    const sp = this.sprintAmount * (1 - aim);
    pos.x += -0.05 * sp;
    pos.y += -0.04 * sp;
    pos.z += 0.03 * sp;
    rot.x += -0.32 * sp;
    rot.y += 0.6 * sp;
    rot.z += 0.3 * sp;

    // crouch
    const cr = THREE.MathUtils.clamp(p.crouchAmount, 0, 1) * (1 - aim);
    pos.y -= 0.008 * cr;
    rot.z += 0.06 * cr;

    // bob, synced with the head bob phase
    const bw = p.bobWeight * THREE.MathUtils.lerp(1, 0.12, aim) * (1 + sp * 0.8);
    const ph = p.bobPhase;
    pos.x += Math.sin(ph) * 0.008 * bw;
    pos.y += (Math.abs(Math.cos(ph)) - 0.5) * 0.012 * bw;
    rot.z += Math.sin(ph) * 0.025 * bw;
    rot.x += Math.cos(ph * 2) * 0.012 * bw;

    // look sway (inertia)
    const yawVel = p.lookYawDelta / Math.max(dt, 1e-4);
    const pitchVel = p.lookPitchDelta / Math.max(dt, 1e-4);
    const swayScale = THREE.MathUtils.lerp(1, 0.25, aim);
    this.swayX = damp(this.swayX, THREE.MathUtils.clamp(yawVel * 0.006, -0.035, 0.035) * swayScale, 12, dt);
    this.swayY = damp(this.swayY, THREE.MathUtils.clamp(pitchVel * 0.006, -0.03, 0.03) * swayScale, 12, dt);
    pos.x += this.swayX;
    pos.y -= this.swayY;
    rot.y += this.swayX * 1.6;
    rot.x -= this.swayY * 1.2;
    rot.z += this.swayX * 1.2;

    // strafe tilt
    rot.z += -p.moveRight * 0.04 * (1 - aim) * Math.min(1, p.horizontalSpeed / 2);

    // idle breathing
    const idle = 1 - Math.min(1, p.bobWeight);
    pos.y += Math.sin(this.time * 1.6) * 0.0016 * idle * (1 - aim * 0.8);
    pos.x += Math.sin(this.time * 0.8) * 0.0009 * idle * (1 - aim * 0.8);

    // landing / jump follow-through
    pos.y += p.landSpring.value * 0.035;
    rot.x += p.landSpring.value * 0.05;

    // recoil springs
    const back = this._spring(this.kickBack, 320, 24, dt);
    const up = this._spring(this.kickUp, 260, 20, dt);
    const roll = this._spring(this.kickRoll, 200, 16, dt);
    const side = this._spring(this.kickSide, 260, 22, dt);
    const recoilScale = THREE.MathUtils.lerp(1, 0.5, aim);
    pos.z += back * 0.06 * recoilScale;
    pos.y += up * 0.004 * recoilScale;
    rot.x += up * 0.09 * recoilScale;
    rot.z += roll * 0.03;
    pos.x += side * 0.02;

    // reload choreography
    if (this.reloading) {
      const t = this.reloadT;
      const d = this.reloadDuration;
      const tilt = bump(t, 0.0, 0.28, d - 0.42, d - 0.05);
      rot.z += 0.6 * tilt;
      rot.x += 0.2 * tilt;
      rot.y += -0.12 * tilt;
      pos.y -= 0.035 * tilt;
      pos.x -= 0.03 * tilt;
      pos.z += 0.02 * tilt;
      // magazine out (0.32-0.6), new one in (0.72-1.02)
      let magY = 0;
      if (t < 0.72) magY = -smooth(t, 0.3, 0.62) * 0.38;
      else magY = -(1 - smooth(t, 0.72, 1.02)) * 0.38;
      this.magazine.position.y = this.magBaseY + magY;
      this.magazine.visible = !(t > 0.62 && t < 0.72);
      // charging handle on empty reloads
      if (this.reloadEmpty) {
        const pull = smooth(t, 1.22, 1.36) * (1 - smooth(t, 1.46, 1.52));
        this.chargingHandle.position.z = this.chargingHandleZ + pull * 0.065;
        rot.x += pull * 0.06;
      }
    } else {
      this.magazine.position.y = this.magBaseY;
      this.magazine.visible = true;
      this.chargingHandle.position.z = this.chargingHandleZ;
    }

    this.model.position.copy(pos);
    this.model.rotation.set(rot.x, rot.y, rot.z);

    // muzzle flash decay
    if (this.flash > 0) {
      this.flash -= dt;
      if (this.flash <= 0) this.flashGroup.visible = false;
    }
    this.muzzleLight.intensity *= Math.exp(-dt * 55);
    if (this.muzzleLight.intensity < 0.05) this.muzzleLight.intensity = 0;

    // red dot brightness follows ADS so it doesn't glow at the hip
    this.redDot.visible = aim > 0.05;
  }

  _updateFX(dt) {
    this.sparks.update(dt);
    this.dust.update(dt);

    for (const t of this.tracers) {
      if (!t.visible) continue;
      t.userData.life -= dt;
      // slide the streak toward the impact
      const step = t.userData.speed * dt;
      const remaining = t.position.distanceTo(t.userData.end);
      if (remaining > step) t.translateZ(step);
      t.scale.z = Math.min(t.scale.z, Math.max(0.01, t.position.distanceTo(t.userData.end)));
      t.material.opacity = Math.max(0, t.userData.life / 0.045);
      if (t.userData.life <= 0) t.visible = false;
    }

    for (const c of this.casings) {
      if (!c.active) continue;
      c.age += dt;
      if (c.age > 12) {
        c.active = false;
        c.mesh.visible = false;
        this.physics.unlink(c.body);
        c.body.velocity.set(0, 0, 0);
        c.body.angularVelocity.set(0, 0, 0);
        c.body.position.set(0, c.park, 0);
        c.body.sleep();
      }
    }
  }

  /** Projected size of a world-space spread angle, for the HUD crosshair. */
  currentSpread() {
    const p = this.player;
    const moving = Math.min(1, p.horizontalSpeed / 3.7);
    let spread = THREE.MathUtils.lerp(0.02, 0.0015, this.aimEase);
    spread += moving * THREE.MathUtils.lerp(0.022, 0.006, this.aimEase);
    if (!p.grounded) spread += 0.05;
    if (p.crouched) spread *= 0.7;
    return spread + this.bloom;
  }

  setScale(uScale) {
    this.sparks.material.uniforms.uScale.value = uScale;
    this.dust.material.uniforms.uScale.value = uScale;
  }
}
