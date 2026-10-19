import * as CANNON from 'cannon-es';
import * as THREE from 'three';

// cannon-es integration.
//
// The world runs at a fixed 120 Hz with an accumulator, so the simulation is
// identical at 30, 60 or 240 fps. "Fixed listeners" (the character
// controller) run before every sub-step, i.e. before the solver, which lets
// them set velocities and forces that the contact solver then respects. (The
// built-in 'preStep' event fires after the solver, which would let a
// controller push bodies into walls for a step.) Rendered objects are
// interpolated between the last two physics states, so motion stays smooth
// when the display rate doesn't divide evenly into 120 Hz.

export const GROUP = {
  STATIC: 1,
  PROP: 2,
  PLAYER: 4,
  DEBRIS: 8,
};

export const FIXED_STEP = 1 / 120;
const MAX_SUBSTEPS = 8;

const _v = new CANNON.Vec3();
const _q = new CANNON.Quaternion();
const _from = new CANNON.Vec3();
const _to = new CANNON.Vec3();

export class PhysicsWorld {
  constructor() {
    const world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -9.81, 0),
      allowSleep: true,
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 12;
    world.solver.tolerance = 1e-4;
    world.quatNormalizeFast = true;
    world.quatNormalizeSkip = 0;
    world.defaultContactMaterial.friction = 0.4;
    world.defaultContactMaterial.restitution = 0.05;
    world.defaultContactMaterial.contactEquationStiffness = 1e7;
    world.defaultContactMaterial.contactEquationRelaxation = 3;
    this.world = world;

    this.materials = {
      static: new CANNON.Material('static'),
      prop: new CANNON.Material('prop'),
      player: new CANNON.Material('player'),
      debris: new CANNON.Material('debris'),
    };
    const m = this.materials;
    const contact = (a, b, opts) => world.addContactMaterial(new CANNON.ContactMaterial(a, b, {
      contactEquationStiffness: 1e7,
      contactEquationRelaxation: 3,
      frictionEquationStiffness: 1e7,
      frictionEquationRelaxation: 3,
      ...opts,
    }));
    // The player slides along walls: zero friction, the controller handles traction.
    contact(m.player, m.static, { friction: 0, restitution: 0 });
    contact(m.player, m.prop, { friction: 0, restitution: 0 });
    contact(m.prop, m.static, { friction: 0.55, restitution: 0.08 });
    contact(m.prop, m.prop, { friction: 0.45, restitution: 0.05 });
    contact(m.debris, m.static, { friction: 0.3, restitution: 0.42 });
    contact(m.debris, m.prop, { friction: 0.3, restitution: 0.35 });

    this.accumulator = 0;
    this.alpha = 0;
    this.links = [];
    this.fixedListeners = [];
  }

  addFixedListener(fn) {
    this.fixedListeners.push(fn);
  }

  /** Static box collider. `size` is full extents in metres. */
  addStaticBox(size, position, quaternion = null, { surface = 'concrete' } = {}) {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      material: this.materials.static,
      collisionFilterGroup: GROUP.STATIC,
      collisionFilterMask: GROUP.PROP | GROUP.PLAYER | GROUP.DEBRIS,
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)));
    body.position.set(position.x, position.y, position.z);
    if (quaternion) body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    body.surface = surface;
    this.world.addBody(body);
    return body;
  }

  /** Static collider matching a BoxGeometry mesh (uses the mesh's world transform). */
  addStaticForMesh(mesh, opts = {}) {
    const p = mesh.geometry.parameters;
    mesh.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    mesh.matrixWorld.decompose(pos, quat, scl);
    const size = new THREE.Vector3(p.width * scl.x, p.height * scl.y, p.depth * scl.z);
    const body = this.addStaticBox(size, pos, quat, { surface: mesh.userData.surface || 'concrete', ...opts });
    mesh.userData.body = body;
    return body;
  }

  _dynamicBody(mesh, shape, mass, { surface, sleeping = true, linearDamping = 0.05, angularDamping = 0.08 } = {}) {
    const body = new CANNON.Body({
      mass,
      material: this.materials.prop,
      collisionFilterGroup: GROUP.PROP,
      collisionFilterMask: GROUP.STATIC | GROUP.PROP | GROUP.PLAYER | GROUP.DEBRIS,
      linearDamping,
      angularDamping,
      allowSleep: true,
      sleepSpeedLimit: 0.15,
      sleepTimeLimit: 0.6,
    });
    body.addShape(shape);
    body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
    body.quaternion.set(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
    body.previousPosition.copy(body.position);
    body.previousQuaternion.copy(body.quaternion);
    body.surface = surface || mesh.userData.surface || 'wood';
    this.world.addBody(body);
    // Props are placed at rest; starting them asleep keeps stacks perfectly still
    // until something touches them.
    if (sleeping) body.sleep();
    mesh.userData.body = body;
    this.link(body, mesh);
    return body;
  }

  addDynamicBox(mesh, mass, opts) {
    const p = mesh.geometry.parameters;
    const shape = new CANNON.Box(new CANNON.Vec3(p.width / 2, p.height / 2, p.depth / 2));
    return this._dynamicBody(mesh, shape, mass, opts);
  }

  addDynamicCylinder(mesh, mass, opts) {
    const p = mesh.geometry.parameters;
    const shape = new CANNON.Cylinder(p.radiusTop, p.radiusBottom, p.height, 14);
    return this._dynamicBody(mesh, shape, mass, opts);
  }

  link(body, object) {
    this.links.push({ body, object });
  }

  unlink(body) {
    const i = this.links.findIndex((l) => l.body === body);
    if (i >= 0) this.links.splice(i, 1);
  }

  /** Advances the simulation by `dt` seconds of wall-clock time. */
  step(dt) {
    this.accumulator += Math.min(dt, 0.25);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      for (let i = 0; i < this.fixedListeners.length; i++) this.fixedListeners[i](FIXED_STEP);
      this.world.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    // If we fell too far behind (debugger, tab switch) drop the backlog
    // instead of spiralling.
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    this.alpha = this.accumulator / FIXED_STEP;

    for (let i = 0; i < this.links.length; i++) {
      const { body, object } = this.links[i];
      this.interpolate(body, object.position, object.quaternion);
    }
  }

  /** Writes the render-interpolated transform of `body` into THREE objects. */
  interpolate(body, outPosition, outQuaternion = null) {
    const a = this.alpha;
    body.previousPosition.lerp(body.position, a, _v);
    outPosition.set(_v.x, _v.y, _v.z);
    if (outQuaternion) {
      body.previousQuaternion.slerp(body.quaternion, a, _q);
      outQuaternion.set(_q.x, _q.y, _q.z, _q.w);
    }
    return outPosition;
  }

  /**
   * Closest ray hit against the given collision groups.
   * @returns {{ body: CANNON.Body, point: THREE.Vector3, normal: THREE.Vector3, distance: number } | null}
   */
  raycast(from, to, mask = GROUP.STATIC | GROUP.PROP, result = new CANNON.RaycastResult()) {
    _from.set(from.x, from.y, from.z);
    _to.set(to.x, to.y, to.z);
    result.reset();
    this.world.raycastClosest(_from, _to, { collisionFilterMask: mask, skipBackfaces: true }, result);
    if (!result.hasHit) return null;
    return {
      body: result.body,
      point: new THREE.Vector3(result.hitPointWorld.x, result.hitPointWorld.y, result.hitPointWorld.z),
      normal: new THREE.Vector3(result.hitNormalWorld.x, result.hitNormalWorld.y, result.hitNormalWorld.z),
      distance: result.distance,
    };
  }

  /** Point-to-point pendulum joint between a static anchor and a body. */
  addPendulum(body, anchorWorld, pivotLocal) {
    const anchor = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, collisionFilterGroup: 0, collisionFilterMask: 0 });
    anchor.position.set(anchorWorld.x, anchorWorld.y, anchorWorld.z);
    this.world.addBody(anchor);
    const c = new CANNON.PointToPointConstraint(
      anchor,
      new CANNON.Vec3(0, 0, 0),
      body,
      new CANNON.Vec3(pivotLocal.x, pivotLocal.y, pivotLocal.z),
    );
    this.world.addConstraint(c);
    return c;
  }
}

/* -------------------------------------------------------------------------- */
/* Character capsule                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the player's collider: three stacked spheres approximating a
 * capsule (cannon-es has no native capsule). The body origin is the centre
 * of the bottom sphere; crouching slides the upper two spheres down.
 */
export function createCharacterBody(physics, { radius, height, mass, position }) {
  const body = new CANNON.Body({
    mass,
    material: physics.materials.player,
    fixedRotation: true,
    linearDamping: 0,
    angularDamping: 1,
    allowSleep: false,
    collisionFilterGroup: GROUP.PLAYER,
    collisionFilterMask: GROUP.STATIC | GROUP.PROP,
  });
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, 0, 0));
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, 0, 0));
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, 0, 0));
  body.position.set(position.x, position.y, position.z);
  body.previousPosition.copy(body.position);
  setCharacterHeight(body, radius, height);
  physics.world.addBody(body);
  return body;
}

export function setCharacterHeight(body, radius, height) {
  const top = Math.max(0, height - radius * 2);
  body.shapeOffsets[1].set(0, top * 0.5, 0);
  body.shapeOffsets[2].set(0, top, 0);
  body.updateBoundingRadius();
  body.updateMassProperties();
  body.aabbNeedsUpdate = true;
}

export { CANNON };
