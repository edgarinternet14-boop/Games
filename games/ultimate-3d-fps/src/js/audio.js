// Procedural audio. Like the textures, every sound is synthesised at runtime
// with the Web Audio API: filtered noise bursts, pitched oscillators and a
// convolution reverb whose impulse response is generated from decaying
// noise, giving the hall its long, metallic tail.

const rand = (a, b) => a + Math.random() * (b - a);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
    this._lastCasing = 0;
    this._lastImpactProp = 0;
  }

  /** Must be called from a user gesture (click to play). */
  init() {
    // resume() only settles once the browser grants playback, so never await
    // it: without a user gesture it would block the caller indefinitely.
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulseResponse(3.2, 2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.55;
    this.reverb.connect(this.wet).connect(this.master);

    this.noise = this._noiseBuffer(2);
    this._startAmbience();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  /** Player position and right vector, used for stereo panning. */
  setListener(position, right) {
    this.listener.x = position.x;
    this.listener.y = position.y;
    this.listener.z = position.z;
    this.listener.rx = right.x;
    this.listener.rz = right.z;
  }

  /* ----------------------------- building blocks ----------------------------- */

  _noiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Stereo decaying noise with sparse early reflections = large concrete hall. */
  _impulseResponse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (t < 0.004 ? t / 0.004 : 1);
      }
      for (let k = 0; k < 14; k++) {
        const at = Math.floor(rand(0.008, 0.09) * ctx.sampleRate);
        if (at < len) d[at] += rand(-0.6, 0.6);
      }
    }
    return buf;
  }

  /** Output node with gain, stereo pan and reverb send. */
  _voice({ gain = 1, pan = 0, send = 0.3 } = {}) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(this.dry);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      p.connect(s).connect(this.reverb);
    }
    return g;
  }

  _noiseBurst(dest, { t = this.ctx.currentTime, type = 'bandpass', freq = 1000, q = 1, attack = 0.001, decay = 0.1, gain = 1, sweepTo = null }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rand(0.9, 1.1);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(env).connect(dest);
    src.start(t, rand(0, 1.5));
    src.stop(t + attack + decay + 0.05);
  }

  _tone(dest, { t = this.ctx.currentTime, type = 'sine', freq = 440, freqTo = null, attack = 0.002, decay = 0.2, gain = 0.5 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqTo) o.frequency.exponentialRampToValueAtTime(freqTo, t + attack + decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.connect(env).connect(dest);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  _spatial(pos) {
    if (!pos) return { pan: 0, gain: 1 };
    const l = this.listener;
    const dx = pos.x - l.x;
    const dy = pos.y - l.y;
    const dz = pos.z - l.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const pan = dist > 0.01 ? (dx * l.rx + dz * l.rz) / dist : 0;
    return { pan: pan * 0.85, gain: 1 / (1 + dist * 0.18), dist };
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /* --------------------------------- sounds --------------------------------- */

  gunshot() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._voice({ gain: 0.9, send: 0.75 });
    // supersonic crack
    this._noiseBurst(out, { t, type: 'highpass', freq: 1800, q: 0.7, decay: 0.07, gain: 0.9 });
    // muzzle blast body
    this._noiseBurst(out, { t, type: 'lowpass', freq: 2600, sweepTo: 300, q: 0.8, decay: 0.32, gain: 1.0 });
    // chest thump
    this._tone(out, { t, freq: rand(105, 125), freqTo: 38, decay: 0.2, gain: 0.95 });
    // mechanism
    this._tone(out, { t: t + 0.012, type: 'square', freq: rand(2100, 2600), freqTo: 1400, decay: 0.025, gain: 0.08 });
  }

  dryFire() {
    if (!this.ready) return;
    const out = this._voice({ gain: 0.5, send: 0.1 });
    this._noiseBurst(out, { type: 'bandpass', freq: 3500, q: 6, decay: 0.03, gain: 0.8 });
    this._tone(out, { type: 'square', freq: 1700, freqTo: 1200, decay: 0.02, gain: 0.08 });
  }

  /** stage: 'magOut' | 'magIn' | 'boltBack' | 'boltForward' */
  reload(stage) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._voice({ gain: 0.55, pan: 0.2, send: 0.15 });
    switch (stage) {
      case 'magOut':
        this._noiseBurst(out, { t, freq: 1800, q: 3, decay: 0.05, gain: 0.7 });
        this._noiseBurst(out, { t: t + 0.05, type: 'lowpass', freq: 900, decay: 0.1, gain: 0.4 });
        break;
      case 'magIn':
        this._noiseBurst(out, { t, freq: 2400, q: 4, decay: 0.035, gain: 0.9 });
        this._tone(out, { t, type: 'triangle', freq: 820, freqTo: 600, decay: 0.06, gain: 0.25 });
        this._noiseBurst(out, { t: t + 0.06, freq: 3200, q: 5, decay: 0.03, gain: 0.6 });
        break;
      case 'boltBack':
        this._noiseBurst(out, { t, freq: 1500, q: 2, decay: 0.08, gain: 0.6, sweepTo: 2600 });
        break;
      case 'boltForward':
        this._noiseBurst(out, { t, freq: 2800, q: 3, decay: 0.05, gain: 1.0 });
        this._tone(out, { t, type: 'triangle', freq: 640, freqTo: 420, decay: 0.08, gain: 0.3 });
        break;
      default:
        break;
    }
  }

  footstep(surface = 'concrete', intensity = 1, crouched = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const g = (crouched ? 0.45 : 1) * (0.35 + intensity * 0.3);
    const out = this._voice({ gain: g, pan: rand(-0.08, 0.08), send: 0.35 });
    if (surface === 'metal') {
      this._noiseBurst(out, { t, freq: rand(1800, 2600), q: 3, decay: 0.07, gain: 0.5 });
      this._tone(out, { t, type: 'triangle', freq: rand(380, 460), decay: 0.25, gain: 0.12 });
      this._tone(out, { t, freq: rand(1150, 1350), decay: 0.18, gain: 0.05 });
    } else if (surface === 'wood') {
      this._noiseBurst(out, { t, freq: rand(500, 700), q: 2, decay: 0.08, gain: 0.6 });
      this._tone(out, { t, freq: rand(150, 190), freqTo: 90, decay: 0.08, gain: 0.3 });
    } else {
      // gritty concrete scuff + heel thud
      this._noiseBurst(out, { t, freq: rand(900, 1400), q: 0.9, decay: 0.07, gain: 0.45 });
      this._noiseBurst(out, { t: t + 0.03, type: 'highpass', freq: 3000, decay: 0.04, gain: 0.12 });
      this._tone(out, { t, freq: rand(70, 90), freqTo: 45, decay: 0.07, gain: 0.35 });
    }
  }

  jump() {
    if (!this.ready) return;
    const out = this._voice({ gain: 0.25, send: 0.1 });
    this._noiseBurst(out, { freq: 600, q: 1, decay: 0.18, gain: 0.5, sweepTo: 1600 });
  }

  land(strength, surface) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._voice({ gain: 0.5 + strength * 0.6, send: 0.4 });
    this._tone(out, { t, freq: 95, freqTo: 40, decay: 0.15 + strength * 0.1, gain: 0.7 });
    this._noiseBurst(out, { t, type: 'lowpass', freq: 1400, decay: 0.12, gain: 0.5 });
    if (surface === 'metal') this._tone(out, { t, type: 'triangle', freq: 310, decay: 0.5, gain: 0.25 });
  }

  impact(surface, position) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const s = this._spatial(position);
    const out = this._voice({ gain: 0.55 * s.gain, pan: s.pan, send: 0.5 });
    if (surface === 'metal') {
      this._noiseBurst(out, { t, type: 'highpass', freq: 2500, decay: 0.05, gain: 0.6 });
      for (let k = 0; k < 3; k++) {
        this._tone(out, { t, freq: rand(1400, 3800), decay: rand(0.15, 0.4), gain: 0.12 });
      }
    } else if (surface === 'wood') {
      this._noiseBurst(out, { t, freq: rand(380, 520), q: 2, decay: 0.09, gain: 0.9 });
      this._tone(out, { t, freq: rand(160, 220), freqTo: 110, decay: 0.07, gain: 0.35 });
    } else {
      this._noiseBurst(out, { t, freq: rand(1800, 2600), q: 1.2, decay: 0.06, gain: 0.8 });
      this._noiseBurst(out, { t: t + 0.02, type: 'highpass', freq: 4000, decay: 0.1, gain: 0.25 });
    }
  }

  /** Prop collisions (crates, barrels) – throttled to avoid machine-gunning. */
  propImpact(surface, strength, position) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this._lastImpactProp < 0.04) return;
    this._lastImpactProp = now;
    const s = this._spatial(position);
    const out = this._voice({ gain: Math.min(1, strength) * 0.7 * s.gain, pan: s.pan, send: 0.5 });
    if (surface === 'metal') {
      // hollow drum: inharmonic partials
      const f0 = rand(150, 190);
      for (const m of [1, 1.58, 2.31, 3.4]) this._tone(out, { t: now, type: 'sine', freq: f0 * m, decay: rand(0.4, 0.9) / m, gain: 0.3 / m });
      this._noiseBurst(out, { t: now, type: 'lowpass', freq: 1200, decay: 0.08, gain: 0.5 });
    } else {
      this._noiseBurst(out, { t: now, freq: rand(250, 400), q: 1.5, decay: 0.12, gain: 0.9 });
      this._tone(out, { t: now, freq: rand(90, 130), freqTo: 60, decay: 0.12, gain: 0.5 });
    }
  }

  casing(position) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this._lastCasing < 0.03) return;
    this._lastCasing = now;
    const s = this._spatial(position);
    const out = this._voice({ gain: 0.14 * s.gain, pan: s.pan, send: 0.3 });
    const f = rand(3800, 5600);
    this._tone(out, { t: now, freq: f, decay: rand(0.08, 0.18), gain: 0.5 });
    this._tone(out, { t: now, freq: f * 1.51, decay: 0.06, gain: 0.25 });
  }

  flashlight() {
    if (!this.ready) return;
    const out = this._voice({ gain: 0.35, send: 0.05 });
    this._noiseBurst(out, { freq: 4200, q: 8, decay: 0.02, gain: 0.8 });
    this._tone(out, { type: 'square', freq: 2900, decay: 0.012, gain: 0.05 });
  }

  /* -------------------------------- ambience -------------------------------- */

  _startAmbience() {
    const ctx = this.ctx;
    const amb = ctx.createGain();
    amb.gain.value = 0.0;
    amb.gain.setTargetAtTime(1, ctx.currentTime, 2);
    amb.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.4;
    amb.connect(send).connect(this.reverb);

    // Low industrial drone: two detuned saws through a slowly breathing filter.
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 160;
    droneFilter.Q.value = 2;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.035;
    for (const f of [41.2, 41.55, 82.1]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(droneFilter);
      o.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 70;
    lfo.connect(lfoGain).connect(droneFilter.frequency);
    lfo.start();
    droneFilter.connect(droneGain).connect(amb);

    // Air handling rumble: looping brown-ish noise.
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    rumble.loop = true;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 280;
    const rg = ctx.createGain();
    rg.gain.value = 0.06;
    rumble.connect(rf).connect(rg).connect(amb);
    rumble.start();

    // Fluorescent ballast hum (100 Hz + harmonics), quiet.
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 100;
    const hf = ctx.createBiquadFilter();
    hf.type = 'bandpass';
    hf.frequency.value = 200;
    hf.Q.value = 6;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0.006;
    hum.connect(hf).connect(this.humGain).connect(amb);
    hum.start();

    this._ambBus = amb;
    const drip = () => {
      if (!this.ctx) return;
      if (this.ctx.state === 'running') {
        const t = this.ctx.currentTime;
        const out = this._voice({ gain: rand(0.05, 0.12), pan: rand(-0.9, 0.9), send: 0.9 });
        const f = rand(1100, 2200);
        this._tone(out, { t, freq: f, freqTo: f * 0.55, decay: 0.09, gain: 0.6 });
        if (Math.random() < 0.3) this._tone(out, { t: t + rand(0.12, 0.3), freq: f * 1.1, freqTo: f * 0.6, decay: 0.07, gain: 0.3 });
      }
      setTimeout(drip, rand(1200, 5200));
    };
    setTimeout(drip, 1500);

    const creak = () => {
      if (!this.ctx) return;
      if (this.ctx.state === 'running') {
        const t = this.ctx.currentTime;
        const out = this._voice({ gain: rand(0.06, 0.13), pan: rand(-1, 1), send: 1 });
        const dur = rand(0.8, 2.2);
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(rand(60, 90), t);
        o.frequency.linearRampToValueAtTime(rand(40, 120), t + dur);
        const f = this.ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = rand(500, 1100);
        f.Q.value = 9;
        const env = this.ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.3);
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(f).connect(env).connect(out);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
      setTimeout(creak, rand(9000, 22000));
    };
    setTimeout(creak, 6000);
  }

  /** Ballast hum follows the fluorescent flicker. */
  setHum(level) {
    if (this.humGain) this.humGain.gain.setTargetAtTime(0.002 + level * 0.008, this.ctx.currentTime, 0.02);
  }
}
