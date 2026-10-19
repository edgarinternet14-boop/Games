import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as PP from 'postprocessing';

// Post-processing.
//
// "cinematic" preset (three.js EffectComposer, HDR half-float targets, 4x MSAA):
//
//   RenderPass (world)            linear HDR scene
//   SSAOPass                      screen-space AO multiplied into the image
//   RenderPass (viewmodel)        weapon over the world, depth cleared
//   UnrealBloomPass               glow around emissive tubes, muzzle flash, sparks
//   OutputPass                    ACES Filmic tone mapping + sRGB encode
//   CinematicPass (custom)        grading, chromatic aberration, vignette, grain
//
// The grading pass runs after tone mapping so it works on display-referred
// values, the way a colourist grades footage, and grain is added in that same
// space so it reads like film grain instead of HDR noise.
//
// "performance" preset (pmndrs postprocessing): the same look built from one
// merged EffectPass (mipmap bloom, ACES tone mapping, grading, vignette,
// noise) and no SSAO, for weaker GPUs.

export const CinematicShader = {
  name: 'CinematicShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uGrain: { value: 0.06 },
    uVignette: { value: 0.55 },
    uAberration: { value: 0.0024 },
    uLift: { value: new THREE.Vector3(0.006, 0.012, 0.02) },
    uGamma: { value: new THREE.Vector3(1.0, 1.01, 1.02) },
    uGain: { value: new THREE.Vector3(1.05, 1.0, 0.93) },
    uSaturation: { value: 0.84 },
    uContrast: { value: 1.18 },
    uShock: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uAberration;
    uniform vec3 uLift;
    uniform vec3 uGamma;
    uniform vec3 uGain;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uShock;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec2 centered = vUv - 0.5;
      float aspect = uResolution.x / uResolution.y;
      vec2 cv = centered * vec2(aspect, 1.0);
      float r2 = dot(cv, cv);

      // Radial chromatic aberration, growing toward the frame edges and
      // briefly kicked by camera shocks (shots, hard landings).
      float ca = uAberration * (0.25 + r2 * 2.2) + uShock * 0.004;
      vec2 shift = centered * ca;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - shift).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + shift).b;
      col = clamp(col, 0.0, 1.0);

      // Lift / gamma / gain: teal in the shadows, warm highlights.
      col = col * uGain + uLift * (1.0 - col);
      col = pow(max(col, vec3(0.0)), 1.0 / uGamma);

      // Filmic S-curve contrast.
      vec3 s = col * col * (3.0 - 2.0 * col);
      col = mix(col, s, uContrast - 1.0);

      // Desaturate slightly for a gritty look.
      float l = luma(col);
      col = mix(vec3(l), col, uSaturation);

      // Optical vignette.
      float d = length(cv);
      float vig = smoothstep(0.95, 0.2, d);
      col *= mix(1.0 - uVignette, 1.0, vig);

      // Animated, luminance-weighted film grain (triangular distribution).
      vec2 seed = gl_FragCoord.xy + fract(uTime * 7.31) * 517.0;
      float g = hash12(seed) + hash12(seed * 1.37 + 91.7) - 1.0;
      float response = mix(1.0, 0.3, smoothstep(0.12, 0.85, l));
      col += g * uGrain * response;

      // Dither to kill banding in the dark gradients.
      col += (hash12(gl_FragCoord.xy + 13.1 + fract(uTime) * 61.0) - 0.5) / 255.0;

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * SSAOPass with three additions: an AO intensity uniform, a resolution scale
 * (AO is smooth, so it can be computed at reduced resolution), and objects
 * flagged with `userData.noAO` (decals, light cones, particles) are excluded
 * from the normal/depth pre-pass so they don't cast fake occlusion.
 */
class AtmosphericSSAOPass extends SSAOPass {
  constructor(scene, camera, width, height, kernelSize, resolutionScale) {
    super(scene, camera, Math.max(1, Math.round(width * resolutionScale)), Math.max(1, Math.round(height * resolutionScale)), kernelSize);
    this.resolutionScale = resolutionScale;
    const mat = this.ssaoMaterial;
    mat.uniforms.intensity = { value: 1 };
    mat.fragmentShader = mat.fragmentShader
      .replace('uniform float maxDistance;', 'uniform float maxDistance;\n\t\tuniform float intensity;')
      .replace('gl_FragColor = vec4( vec3( 1.0 - occlusion ), 1.0 );', 'gl_FragColor = vec4( vec3( 1.0 - occlusion * intensity ), 1.0 );');
    mat.needsUpdate = true;
  }

  get intensity() {
    return this.ssaoMaterial.uniforms.intensity.value;
  }

  set intensity(v) {
    this.ssaoMaterial.uniforms.intensity.value = v;
  }

  setSize(width, height) {
    super.setSize(Math.max(1, Math.round(width * this.resolutionScale)), Math.max(1, Math.round(height * this.resolutionScale)));
  }

  /** The camera FOV changes (sprint, aim), so keep the projection in sync. */
  syncCamera() {
    const u = this.ssaoMaterial.uniforms;
    u.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix);
    u.cameraInverseProjectionMatrix.value.copy(this.camera.projectionMatrixInverse);
  }

  _overrideVisibility() {
    super._overrideVisibility();
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      if (o.visible && o.userData.noAO) {
        o.visible = false;
        cache.push(o);
      }
    });
  }
}

export const PRESETS = {
  cinematic: {
    label: 'Cinematic (SSAO + Bloom + Grade)',
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
  },
  performance: {
    label: 'Performance (pmndrs merged pass)',
    pixelRatioCap: 1.0,
    shadowMapSize: 1024,
  },
};

export class PostProcessing {
  constructor(renderer, scene, camera, viewmodelCamera, { preset = 'cinematic' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.viewmodelCamera = viewmodelCamera;
    this.time = 0;
    this.shock = 0;
    this.preset = null;
    this.composer = null;
    this.passes = {};
    this._originalAutoClear = renderer.autoClear;
    this.setPreset(preset);
  }

  setPreset(name) {
    if (!PRESETS[name]) name = 'cinematic';
    if (name === this.preset) return;
    this._dispose();
    this.preset = name;
    const size = this.renderer.getSize(new THREE.Vector2());
    const pr = this.renderer.getPixelRatio();
    if (name === 'cinematic') this._buildCinematic(size.x, size.y, pr);
    else this._buildPerformance(size.x, size.y, pr);
  }

  _buildCinematic(w, h, pr) {
    this.renderer.autoClear = this._originalAutoClear;
    const target = new THREE.WebGLRenderTarget(Math.round(w * pr), Math.round(h * pr), {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(this.renderer, target);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);

    const world = new RenderPass(this.scene, this.camera);

    const ssao = new AtmosphericSSAOPass(this.scene, this.camera, w * pr, h * pr, 32, 0.6);
    ssao.kernelRadius = 0.75;
    ssao.minDistance = 0.0002;
    ssao.maxDistance = 0.02;
    ssao.intensity = 1.0;

    const viewmodel = new RenderPass(this.scene, this.viewmodelCamera);
    viewmodel.clear = false;
    viewmodel.clearDepth = true;

    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.5, 1.5);

    const output = new OutputPass();

    const grade = new ShaderPass(CinematicShader);
    grade.uniforms.uResolution.value.set(w * pr, h * pr);

    composer.addPass(world);
    composer.addPass(ssao);
    composer.addPass(viewmodel);
    composer.addPass(bloom);
    composer.addPass(output);
    composer.addPass(grade);

    this.composer = composer;
    this.passes = { world, ssao, viewmodel, bloom, output, grade };
  }

  _buildPerformance(w, h, pr) {
    const composer = new PP.EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 4,
    });
    composer.addPass(new PP.RenderPass(this.scene, this.camera));

    const viewmodel = new PP.RenderPass(this.scene, this.viewmodelCamera);
    viewmodel.clearPass.color = false;
    viewmodel.clearPass.depth = true;
    viewmodel.ignoreBackground = true;
    viewmodel.skipShadowMapUpdate = true;
    composer.addPass(viewmodel);

    const bloom = new PP.BloomEffect({
      mipmapBlur: true,
      intensity: 1.0,
      luminanceThreshold: 1.5,
      luminanceSmoothing: 0.25,
      radius: 0.7,
    });
    const tone = new PP.ToneMappingEffect({ mode: PP.ToneMappingMode.ACES_FILMIC });
    const hueSat = new PP.HueSaturationEffect({ saturation: -0.16 });
    const contrast = new PP.BrightnessContrastEffect({ brightness: 0.0, contrast: 0.1 });
    const vignette = new PP.VignetteEffect({ offset: 0.32, darkness: 0.62 });
    const noise = new PP.NoiseEffect({ blendFunction: PP.BlendFunction.OVERLAY, premultiply: false });
    noise.blendMode.opacity.value = 0.16;
    composer.addPass(new PP.EffectPass(this.camera, bloom, tone, hueSat, contrast, vignette, noise));

    composer.setSize(w, h);
    this.composer = composer;
    this.passes = { bloom, noise };
  }

  _dispose() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.dispose?.();
    this.composer = null;
    this.passes = {};
  }

  setSize(w, h, pr) {
    if (!this.composer) return;
    if (this.preset === 'cinematic') {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
      this.passes.grade.uniforms.uResolution.value.set(w * pr, h * pr);
    } else {
      this.composer.setSize(w, h);
    }
  }

  /** Brief chromatic/blur kick for gunshots and hard landings (0..1). */
  addShock(amount) {
    this.shock = Math.min(1, this.shock + amount);
  }

  render(dt) {
    this.time += dt;
    this.shock = Math.max(0, this.shock - dt * 6);
    if (this.preset === 'cinematic') {
      this.passes.ssao.syncCamera();
      const u = this.passes.grade.uniforms;
      u.uTime.value = this.time;
      u.uShock.value = this.shock;
    }
    this.composer.render(dt);
  }
}
