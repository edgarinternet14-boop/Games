import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

// Renderer, scene, cameras and the global lighting rig.
//
// Two cameras share one transform: `camera` renders the world (layer 0) and
// `viewmodelCamera` renders only the first-person weapon (layer 1) with its
// own fixed FOV and a cleared depth buffer, so the gun never clips into walls
// and doesn't stretch when the world FOV changes (sprint kick, aim zoom).
// Every light is enabled on both layers so the gun is lit by the same rig.

export const LAYERS = { WORLD: 0, VIEWMODEL: 1 };

export const FOG_COLOR = new THREE.Color(0x06080b);

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setClearColor(FOG_COLOR, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadow maps are refreshed exactly once per frame (see render()). The
    // post-processing stack renders the scene several times per frame (beauty,
    // SSAO normals, viewmodel) and would otherwise redraw them every time.
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    this.renderer = renderer;

    this.pixelRatioCap = 1.5;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));

    const scene = new THREE.Scene();
    scene.background = null; // the clear colour doubles as the far fog colour
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.042);
    this.scene = scene;

    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.05, 120);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.set(LAYERS.WORLD);
    scene.add(this.camera); // children (flashlight, weapon) live in the scene graph

    this.viewmodelCamera = new THREE.PerspectiveCamera(56, aspect, 0.01, 10);
    this.viewmodelCamera.layers.set(LAYERS.VIEWMODEL);

    this._setupLighting();
    this._setupEnvironment();

    this.post = null; // assigned by main.js
    this.onResize = [];
    this._scratchScale = new THREE.Vector3();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  _setupLighting() {
    RectAreaLightUniformsLib.init();

    // Very low, cold ambient: enough to read silhouettes in the dark, not
    // enough to flatten the flashlight's falloff.
    this.ambient = new THREE.AmbientLight(0x1c2533, 0.3);
    this.hemi = new THREE.HemisphereLight(0x2b3648, 0x0d0b09, 0.45);
    for (const l of [this.ambient, this.hemi]) {
      l.layers.enableAll();
      this.scene.add(l);
    }
  }

  // A tiny procedural "industrial hall" rendered into a PMREM cube so metals
  // and wet surfaces have something plausible to reflect (strip lights, a warm
  // glow from the shutter door) without any HDR image file.
  _setupEnvironment() {
    const envScene = new THREE.Scene();
    const room = new THREE.Mesh(
      new THREE.BoxGeometry(30, 9, 46),
      new THREE.MeshBasicMaterial({ color: 0x0c0e12, side: THREE.BackSide }),
    );
    room.position.y = 3.5;
    envScene.add(room);

    const strip = new THREE.BoxGeometry(0.3, 0.06, 2.4);
    const stripMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.8, 3.2) });
    for (const z of [-15, -5, 5, 15]) {
      for (const x of [-2.5, 2.5]) {
        const m = new THREE.Mesh(strip, stripMat);
        m.position.set(x, 7.6, z);
        envScene.add(m);
      }
    }
    const warm = new THREE.Mesh(new THREE.PlaneGeometry(6, 0.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.2, 1.2) }));
    warm.position.set(0, 0.3, -22.8);
    envScene.add(warm);
    const red = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.3, 0.2) }));
    red.position.set(3.8, 5.6, -22.5);
    envScene.add(red);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const target = pmrem.fromScene(envScene, 0.035, 0.1, 100);
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();
    envScene.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = w / h;
    this.viewmodelCamera.updateProjectionMatrix();
    if (this.post) this.post.setSize(w, h, this.renderer.getPixelRatio());
    for (const fn of this.onResize) fn(w, h);
  }

  setPixelRatioCap(cap) {
    this.pixelRatioCap = cap;
    this.resize();
  }

  /** Copies the world camera's transform onto the viewmodel camera. */
  syncViewmodelCamera() {
    this.camera.updateMatrixWorld();
    this.camera.matrixWorld.decompose(this.viewmodelCamera.position, this.viewmodelCamera.quaternion, this._scratchScale);
    this.viewmodelCamera.updateMatrixWorld();
  }

  render(dt) {
    this.syncViewmodelCamera();
    this.renderer.shadowMap.needsUpdate = true;
    this.post.render(dt);
  }
}

/**
 * Camera-mounted SpotLight acting as a weapon/shoulder flashlight.
 *
 * - Physically based falloff (decay = 2) and a procedural light cookie.
 * - Soft PCF shadows from a point slightly below and to the right of the eye,
 *   so shadows are visible instead of hiding exactly behind objects.
 * - The beam lags behind fast mouse movement (spring), like a hand-held light.
 * - The beam's distance to whatever it hits drives two cheap tricks: the
 *   intensity eases down when the beam is on a nearby surface (like eye
 *   adaptation, so a wall at arm's length doesn't blow out), and a warm
 *   ambient "bounce" term rises, faking the indirect light a real torch
 *   throws back. An ambient light is used for the bounce on purpose: a point
 *   light would draw a sharp specular dot on wet surfaces.
 */
export class Flashlight {
  constructor(camera, cookie, { shadowMapSize = 2048 } = {}) {
    this.camera = camera;
    this.enabled = true;
    this.baseIntensity = 300;
    this.exposure = 1;
    this.flicker = 0;
    this.flickerTime = 0;

    this.rig = new THREE.Object3D();
    this.rig.position.set(0.18, -0.17, -0.05);
    camera.add(this.rig);

    const light = new THREE.SpotLight(0xfff1de, this.baseIntensity, 45, THREE.MathUtils.degToRad(27), 0.55, 2);
    light.castShadow = true;
    light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    light.shadow.bias = -0.00005;
    light.shadow.normalBias = 0.025;
    light.shadow.camera.near = 0.12;
    light.shadow.camera.far = 45;
    light.shadow.focus = 1;
    light.map = cookie;
    light.layers.enableAll();
    this.rig.add(light);
    this.light = light;

    // Aim converges with the crosshair ~12 m ahead.
    light.target.position.set(-this.rig.position.x, -this.rig.position.y, -12);
    this.rig.add(light.target);

    this.bounce = new THREE.AmbientLight(0xffe0c0, 0);
    this.bounce.layers.enableAll();
    camera.parent.add(this.bounce);

    this.lagYaw = 0;
    this.lagPitch = 0;
    this.lagYawVel = 0;
    this.lagPitchVel = 0;

    this._ray = new THREE.Raycaster();
    this._ray.far = 30;
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this.bounceTargets = [];
    this.worldPosition = new THREE.Vector3();
    this.worldDirection = new THREE.Vector3(0, 0, -1);
  }

  setShadowMapSize(size) {
    if (this.light.shadow.mapSize.x === size) return;
    this.light.shadow.mapSize.set(size, size);
    if (this.light.shadow.map) {
      this.light.shadow.map.dispose();
      this.light.shadow.map = null;
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.flicker = 0.22;
      this.flickerTime = 0;
    }
    return this.enabled;
  }

  /**
   * @param {number} dt
   * @param {number} lookYaw   yaw change this frame (radians)
   * @param {number} lookPitch pitch change this frame (radians)
   */
  update(dt, lookYaw, lookPitch) {
    // Spring-damper lag: mouse motion pushes the beam the other way and it
    // settles back onto the crosshair.
    const k = 90;
    const c = 2 * Math.sqrt(k) * 0.8;
    this.lagYawVel += (-lookYaw * 6 - this.lagYaw * k * dt - this.lagYawVel * c * dt);
    this.lagPitchVel += (-lookPitch * 6 - this.lagPitch * k * dt - this.lagPitchVel * c * dt);
    this.lagYaw = THREE.MathUtils.clamp(this.lagYaw + this.lagYawVel * dt, -0.12, 0.12);
    this.lagPitch = THREE.MathUtils.clamp(this.lagPitch + this.lagPitchVel * dt, -0.1, 0.1);
    this.rig.rotation.set(this.lagPitch, this.lagYaw, 0);

    let intensity = this.enabled ? this.baseIntensity : 0;
    if (this.enabled && this.flicker > 0) {
      this.flicker -= dt;
      this.flickerTime += dt;
      const f = Math.sin(this.flickerTime * 90) * Math.sin(this.flickerTime * 37);
      intensity *= f > 0.1 ? 1 : 0.15;
    }

    // Beam direction in world space (for dust lighting and the bounce term).
    this.rig.updateMatrixWorld();
    this.light.getWorldPosition(this.worldPosition);
    this.light.target.getWorldPosition(this._dir);
    this.worldDirection.subVectors(this._dir, this.worldPosition).normalize();

    let exposureTarget = 1;
    let bounceTarget = 0;
    if (intensity > 0 && this.bounceTargets.length) {
      this._ray.set(this.worldPosition, this.worldDirection);
      const hit = this._ray.intersectObjects(this.bounceTargets, false)[0];
      if (hit) {
        const d = hit.distance;
        // Cancel the inverse-square blow-up inside ~6 m.
        exposureTarget = THREE.MathUtils.clamp((d / 6) ** 2, 0.03, 1);
        bounceTarget = 0.12 * (1 - THREE.MathUtils.smoothstep(d, 0.4, 6));
      }
    }
    const adapt = 1 - Math.exp(-dt * 7);
    this.exposure += (exposureTarget - this.exposure) * adapt;
    this.light.intensity = intensity * this.exposure;
    this.bounce.intensity += (bounceTarget * (intensity / this.baseIntensity) - this.bounce.intensity) * adapt;
  }
}
