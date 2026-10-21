/**
 * Dunebound - client bootstrap, game loop and UI (HUD, shop, chat, menus).
 */
import * as THREE from 'three';
import { Engine } from './engine.js';
import { NetworkClient } from './network.js';
import { Input, LocalPlayer, RemotePlayers, CharacterModel, ANIM, carryFactor } from './player.js';
import { PyramidGrid, HeightField, PyramidView } from './pyramid.js';
import { PetManager } from './pets.js';

const $ = (id) => document.getElementById(id);
const IS_ELECTRON = navigator.userAgent.includes('Electron');
const SETTINGS_KEY = 'dunebound.settings.v1';
const REPEAT_MS = { pickup: 400, place: 230, train: 480 };

function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode / locked down profile); settings just won't persist.
  }
}

function profileToken() {
  let t = storageGet('dunebound.token', null);
  if (typeof t !== 'string' || !/^[a-f0-9]{32}$/.test(t)) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    t = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    storageSet('dunebound.token', t);
  }
  return t;
}

function defaultServer() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  return storageGet('dunebound.server', 'http://localhost:3000');
}

function detectQuality(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
    if (/intel/i.test(name)) return 'medium';
    if (/nvidia|geforce|rtx|radeon rx|apple m\d/i.test(name)) return 'ultra';
  } catch {
    // Fall through to the default.
  }
  return 'high';
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return Math.floor(n).toLocaleString('en-US');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rectDistance(px, pz, x0, z0, x1, z1) {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dz = Math.max(z0 - pz, 0, pz - z1);
  return Math.hypot(dx, dz);
}

// ---------------------------------------------------------------------------
// Procedural audio (WebAudio, no sound files)
// ---------------------------------------------------------------------------

class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startWind();
    this.startRiver();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  tone({ freq, type = 'sine', dur = 0.2, gain = 0.2, attack = 0.005, glide = null, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  burst({ dur = 0.3, freq = 800, q = 1, type = 'lowpass', gain = 0.3, sweep = null, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  thud(v = 1) {
    if (v < 0.02) return;
    this.burst({ dur: 0.38, freq: 520, sweep: 80, gain: 0.55 * v });
    this.tone({ freq: 74, glide: 42, dur: 0.35, gain: 0.5 * v, type: 'sine' });
  }

  lift() {
    this.burst({ dur: 0.22, freq: 1200, sweep: 500, type: 'bandpass', q: 2, gain: 0.25 });
    this.tone({ freq: 140, glide: 190, dur: 0.16, gain: 0.08, type: 'triangle' });
  }

  coin() {
    this.tone({ freq: 1318, type: 'triangle', dur: 0.14, gain: 0.09 });
    this.tone({ freq: 1760, type: 'triangle', dur: 0.2, gain: 0.08, delay: 0.07 });
  }

  click() {
    this.tone({ freq: 720, type: 'triangle', dur: 0.05, gain: 0.05 });
  }

  train() {
    this.tone({ freq: 120, glide: 95, type: 'sawtooth', dur: 0.2, gain: 0.05 });
    this.burst({ dur: 0.15, freq: 300, gain: 0.12 });
  }

  error() {
    this.tone({ freq: 220, type: 'square', dur: 0.1, gain: 0.04 });
    this.tone({ freq: 165, type: 'square', dur: 0.14, gain: 0.04, delay: 0.09 });
  }

  fanfare() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.12, delay: i * 0.14 }));
    [523.25, 659.25, 783.99].forEach((f) => this.tone({ freq: f, type: 'sine', dur: 1.6, gain: 0.08, delay: 0.62 }));
  }

  /** Builder footstep: a soft sand crunch, plus a deep thump when hauling stone. */
  footstep(heavy, v = 1) {
    if (!this.ctx || v < 0.02) return;
    if (heavy) {
      this.tone({ freq: 74, glide: 44, dur: 0.2, gain: 0.2 * v, type: 'sine' });
      this.burst({ dur: 0.16, freq: 950, sweep: 280, gain: 0.16 * v });
    } else {
      this.burst({ dur: 0.07, freq: 1500, q: 1.1, type: 'bandpass', gain: 0.05 * v });
    }
  }

  /** Wading through the Reed Ford. */
  splash(v = 1) {
    if (!this.ctx || v < 0.02) return;
    this.burst({ dur: 0.38, freq: 1200, sweep: 420, q: 0.9, type: 'bandpass', gain: 0.17 * v });
    this.burst({ dur: 0.22, freq: 3200, q: 2.5, type: 'bandpass', gain: 0.05 * v, delay: 0.03 });
  }

  /**
   * The Nile's ambience, three looping noise layers: the deep rush of the current,
   * waves lapping the banks in slow swells, and a bright babble over the shallows.
   * Silent until setRiver() raises it as the listener nears the water.
   */
  startRiver() {
    const c = this.ctx;
    this.riverGain = c.createGain();
    this.riverGain.gain.value = 0;
    this.riverGain.connect(this.master);
    const layer = (type, freq, q, gain) => {
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.loopStart = Math.random() * 0.5;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(this.riverGain);
      src.start(0, Math.random());
      return { f, g };
    };
    const lfo = (hz, depth, target) => {
      const o = c.createOscillator();
      o.frequency.value = hz;
      const g = c.createGain();
      g.gain.value = depth;
      o.connect(g).connect(target);
      o.start();
    };
    const rush = layer('lowpass', 520, 0.7, 0.55);
    lfo(0.13, 140, rush.f.frequency);
    const lap = layer('bandpass', 640, 0.8, 0.22);
    lfo(0.17, 0.2, lap.g.gain);
    lfo(0.071, 160, lap.f.frequency);
    const babble = layer('bandpass', 3400, 3.5, 0.05);
    lfo(2.3, 900, babble.f.frequency);
    lfo(0.4, 0.03, babble.g.gain);
  }

  /** River loudness, 0 (far away) .. 1 (on the bank). */
  setRiver(level) {
    if (!this.riverGain) return;
    this.riverGain.gain.setTargetAtTime(0.32 * level, this.ctx.currentTime, 0.5);
  }

  startWind() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 420;
    f.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.value = 0.045;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(f.frequency);
    const lfo2 = this.ctx.createOscillator();
    lfo2.frequency.value = 0.11;
    const lfo2Gain = this.ctx.createGain();
    lfo2Gain.gain.value = 0.02;
    lfo2.connect(lfo2Gain).connect(g.gain);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    lfo.start();
    lfo2.start();
  }
}

// ---------------------------------------------------------------------------
// World-anchored floating text
// ---------------------------------------------------------------------------

class Floaters {
  constructor(container, camera) {
    this.container = container;
    this.camera = camera;
    this.items = [];
    this._v = new THREE.Vector3();
  }

  spawn(text, pos, cls = '') {
    const e = el('div', `floater ${cls}`, text);
    this.container.appendChild(e);
    this.items.push({ e, pos: pos.clone(), t: 0, life: 1.5 });
    if (this.items.length > 40) this.remove(0);
  }

  remove(i) {
    this.items[i].e.remove();
    this.items.splice(i, 1);
  }

  update(dt) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      it.pos.y += dt * 0.9;
      const p = this._v.copy(it.pos).project(this.camera);
      const visible = p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2;
      it.e.style.opacity = visible ? String(Math.min(1, (it.life - it.t) * 2)) : '0';
      it.e.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -50%)`;
      if (it.t >= it.life) this.remove(i);
    }
  }

  clear() {
    while (this.items.length) this.remove(0);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A thin-stroke line icon from the <symbol> sprite in index.html (`name` without the `i-` prefix). */
function icon(name, cls = '') {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  const u = document.createElementNS(SVG_NS, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.appendChild(u);
  return s;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Updates the live node `to` in place to match a freshly built `from`. Nodes in
 * the same place with the same tag are kept, so a re-render never swaps out an
 * element under the pointer or the keyboard focus.
 */
function morph(to, from) {
  if (to.nodeType !== from.nodeType || to.nodeName !== from.nodeName) {
    to.replaceWith(from);
    return;
  }
  if (to.nodeType === Node.TEXT_NODE) {
    if (to.data !== from.data) to.data = from.data;
    return;
  }
  if (to.nodeType !== Node.ELEMENT_NODE) return;
  for (const { name } of [...to.attributes]) if (!from.hasAttribute(name)) to.removeAttribute(name);
  for (const { name, value } of [...from.attributes]) if (to.getAttribute(name) !== value) to.setAttribute(name, value);
  const have = [...to.childNodes];
  const want = [...from.childNodes];
  want.forEach((n, i) => (i < have.length ? morph(have[i], n) : to.appendChild(n)));
  for (let i = want.length; i < have.length; i++) have[i].remove();
}

/**
 * Builder carry-weight speed multiplier: player.js carryFactor(), the same formula
 * the server enforces (playerCarryFactor in server/gameLogic.js).
 */
const ladenFactor = (carried, capacity, rule) => (rule ? carryFactor(carried, capacity, rule) : carryFactor(carried, capacity));

const ROMAN = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function roman(n) {
  let out = '';
  for (const [v, r] of ROMAN) {
    while (n >= v) {
      out += r;
      n -= v;
    }
  }
  return out;
}

/** Scales a shop effect such as "+6% movement speed" to `level` stacks ("+18% movement speed"). */
function scaledEffect(desc, level) {
  const m = /^\+(\d+(?:\.\d+)?)(%?)\s+(.*)$/.exec(desc || '');
  if (!m) return desc;
  const v = Number(m[1]) * level;
  return `+${Number.isInteger(v) ? v : v.toFixed(1)}${m[2]} ${m[3]}`;
}

/** Readable glyph colour (dark ink or cream) for a seal stamped in `hex`. */
function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#f4e7cf';
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? '#1d1712' : '#f4e7cf';
}

/**
 * Presentation for each Bazaar ware: its sprite icon and, for upgrades, a line
 * of lore. Names, prices, levels and effects always come from the server's shop view.
 */
const WARES = Object.freeze({
  harness: { icon: 'harness', lore: 'Braided linen straps that spread the weight of stone across the shoulders.' },
  sandals: { icon: 'sandals', lore: 'Light reed soles for swift, sure steps across the hot sand.' },
  regimen: { icon: 'regimen', lore: 'The discipline of the temple masters: every repetition counts for more.' },
  favor: { icon: 'favor', lore: 'The Pharaoh rewards those who raise his house of eternity.' },
  jackal: { icon: 'jackal' },
  camel: { icon: 'camel' },
  sphinx: { icon: 'sphinx' },
  scarab: { icon: 'scarab' },
});

const wareIcon = (id) => (WARES[id] ? WARES[id].icon : 'diamond');

const TITLES = [
  [400, 'Architect of Eternity'],
  [150, 'Master Builder'],
  [50, 'Mason of the Dunes'],
  [10, 'Stone Hauler'],
  [0, 'Apprentice of the Quarry'],
];

function builderTitle(placed) {
  for (const [n, title] of TITLES) if (placed >= n) return title;
  return TITLES[TITLES.length - 1][1];
}

// Screen margins (px) that keep the edge-clamped objective marker clear of the HUD:
// the stat/progress clusters at the top, the context prompt at the bottom and the
// chat panel in the bottom-left corner.
const OBJ_MARGIN = { side: 70, top: 112, bottom: 214, chatRight: 470, chatTop: 300 };
// HUD panels the marker steps around wherever it would otherwise land on them.
const OBJ_AVOID = ['stats', 'progress', 'net', 'chat', 'dock', 'prompt'];

class UI {
  constructor(game) {
    this.game = game;
    this.toastsEl = $('toasts');
    this.chatLog = $('chat-log');
    this.promptEl = $('prompt');
    this.lastPrompt = '';
    this.goldDeltaTimer = 0;
    this.goldDeltaSum = 0;
    // Bazaar state: active tab, selected ware per tab and the last data it was rendered from.
    this.shopTab = 'upgrades';
    this.shopSel = { upgrades: null, pets: null };
    this.shopArgs = null;
    // Objective waypoint; it is positioned every frame, so DOM writes are cached.
    this.obj = {
      el: $('objective'),
      use: $('obj-icon'),
      name: $('obj-name'),
      dist: $('obj-dist'),
      arrow: document.querySelector('#objective .obj-arrow'),
      hidden: true,
      kind: '',
      label: '',
      distText: '',
      alpha: '',
      edge: false,
      flip: false,
      // Screen rects [x0, y0, x1, y1] of the HUD panels the marker keeps off, re-measured now and then.
      zones: [],
      zonesAt: -Infinity,
    };
    window.addEventListener('resize', () => {
      this.obj.zonesAt = -Infinity;
    });
    this._ov = new THREE.Vector3();
    this._bv = new THREE.Vector3();
    if (!IS_ELECTRON) {
      for (const id of ['quit-btn', 'pause-quit-btn']) $(id).classList.add('hidden');
    }
  }

  show(id, on = true) {
    $(id).classList.toggle('hidden', !on);
  }

  isShown(id) {
    return !$(id).classList.contains('hidden');
  }

  loading(p, text) {
    $('loading-bar').style.width = `${Math.round(p * 100)}%`;
    if (text) $('loading-text').textContent = `${text}…`;
  }

  menuStatus(text, kind = '') {
    const s = $('menu-status');
    s.textContent = text || '';
    s.className = `status ${kind}`;
  }

  buildSwatches(palette, selected, onPick) {
    const wrap = $('swatches');
    wrap.textContent = '';
    for (const c of palette) {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.style.background = c;
      b.dataset.color = c;
      b.setAttribute('aria-label', `Colour ${c}`);
      b.setAttribute('aria-pressed', String(c === selected));
      if (c === selected) b.classList.add('active');
      b.addEventListener('click', () => {
        for (const s of wrap.children) {
          s.classList.remove('active');
          s.setAttribute('aria-pressed', 'false');
        }
        b.classList.add('active');
        b.setAttribute('aria-pressed', 'true');
        onPick(c);
      });
      wrap.appendChild(b);
    }
  }

  /** config.player.carry of the current world (null on servers without carry weight). */
  carryRule() {
    const W = this.game.world;
    return W && W.config.player ? W.config.player.carry || null : null;
  }

  stats(s, petMax) {
    $('gold').textContent = fmt(s.gold);
    $('stat-str').textContent = s.strength.toFixed(1);
    $('stat-spd').textContent = s.speed.toFixed(1);
    $('stat-carry').textContent = `${s.carry} / ${s.capacity}`;
    $('stat-pets').textContent = `${s.pets.length} / ${petMax}`;
    $('stat-placed').textContent = fmt(s.placed);
    // Pace shows what you actually move at: the carry-weight penalty applies while hauling.
    const factor = ladenFactor(s.carry, s.capacity, this.carryRule());
    $('stat-move').textContent = `${(s.moveSpeed * factor).toFixed(1)} m/s`;
    $('row-pace').classList.toggle('slow', factor < 1);
    $('row-carry').classList.toggle('on', s.carry > 0);
    this.show('laden', s.carry > 0);
    if (s.carry > 0) {
      $('laden-fill').style.width = `${Math.round(clamp01(s.carry / Math.max(1, s.capacity)) * 100)}%`;
      $('laden-text').textContent = `Laden · ${Math.round(factor * 100)}% pace`;
    }
    $('shop-gold').textContent = fmt(s.gold);
    $('char-gold').textContent = fmt(s.gold);
    if (this.game.modal === 'character') this.renderCharacter();
  }

  goldDelta(diff) {
    if (!diff) return;
    this.goldDeltaSum += diff;
    const d = $('gold-delta');
    d.textContent = `${this.goldDeltaSum > 0 ? '+' : '-'}${fmt(Math.abs(this.goldDeltaSum))}`;
    d.classList.toggle('negative', this.goldDeltaSum < 0);
    d.classList.remove('pop');
    void d.offsetWidth;
    d.classList.add('pop');
    clearTimeout(this.goldDeltaTimer);
    this.goldDeltaTimer = setTimeout(() => {
      this.goldDeltaSum = 0;
      d.classList.remove('pop');
    }, 1400);
  }

  progress(grid, completed) {
    const placed = grid.placed;
    $('progress-count').textContent = `${placed} / ${grid.total}`;
    $('progress-bar').style.width = `${(placed / grid.total) * 100}%`;
    const front = grid.frontLayer();
    $('progress-layer').textContent = front >= grid.layers ? 'Complete' : `Layer ${front + 1} of ${grid.layers}`;
    $('progress-completed').textContent = completed ? `Pyramids raised · ${completed}` : '';
  }

  net(players, rtt, fps) {
    $('net-players').textContent = `${players} builder${players === 1 ? '' : 's'}`;
    $('net-ping').textContent = rtt ? `${Math.round(rtt)} ms` : '-- ms';
    $('net-fps').textContent = fps ? `${fps} fps` : '';
  }

  prompt(ctx) {
    const text = ctx ? ctx.text : '';
    const key = ctx ? `${ctx.type}|${text}` : '';
    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    const p = this.promptEl;
    p.textContent = '';
    if (!ctx) {
      p.classList.add('hidden');
      return;
    }
    p.classList.remove('hidden');
    p.classList.toggle('info', ctx.type === 'info');
    if (ctx.type !== 'info') p.appendChild(el('kbd', '', ctx.type === 'train' ? 'Hold E' : 'E'));
    p.appendChild(el('span', '', text));
  }

  toast(text, kind = 'info') {
    const t = el('div', `toast ${kind}`, text);
    this.toastsEl.appendChild(t);
    while (this.toastsEl.children.length > 3) this.toastsEl.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  addChat(m) {
    const line = el('div', `chat-line${m.sys ? ' system' : ''}`);
    if (!m.sys) {
      const n = el('span', 'chat-name', `${m.n}:`);
      // Sash colours are lifted towards cream so dark ones stay readable on the smoky panel.
      n.style.color = m.c;
      n.style.color = `color-mix(in srgb, ${m.c} 70%, #f4ead6)`;
      line.appendChild(n);
      line.appendChild(document.createTextNode(' '));
    }
    line.appendChild(el('span', 'chat-text', m.t));
    this.chatLog.appendChild(line);
    while (this.chatLog.children.length > 60) this.chatLog.firstChild.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    this.chatLog.classList.add('active');
    clearTimeout(this.chatFade);
    this.chatFade = setTimeout(() => this.chatLog.classList.remove('active'), 8000);
  }

  resetChat(history) {
    this.chatLog.textContent = '';
    for (const m of history || []) this.addChat(m);
  }

  /** A small square seal stamped in a builder's sash colour with their initial. */
  playerSeal(name, color, size = '') {
    const s = el('span', size ? `seal player ${size}` : 'seal player', (name || '?').charAt(0));
    this.tintSeal(s, color);
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  tintSeal(seal, color) {
    seal.style.setProperty('--seal', color || '#b13d2b');
    seal.style.color = inkOn(color);
  }

  /**
   * Builders board. `rows` is the server's top list; `total` is everyone on site and
   * `me` the local builder's own row, added at the foot when they are outside the list.
   */
  board(rows, myId, total = rows.length, me = null) {
    const body = $('board-body');
    body.textContent = '';
    const addRow = (r, rank, top) => {
      const [id, name, color, placed, pets] = r;
      const cls = [id === myId ? 'me' : '', top ? 'top' : ''].filter(Boolean).join(' ');
      const tr = el('tr', cls);
      tr.appendChild(el('td', 'rank', rank));
      const who = el('td', 'who');
      const cell = el('div', 'who-cell');
      cell.appendChild(this.playerSeal(name, color, 'sm'));
      cell.appendChild(el('span', 'who-name', name));
      if (id === myId) cell.appendChild(el('span', 'who-you', 'You'));
      who.appendChild(cell);
      tr.appendChild(who);
      tr.appendChild(el('td', 'num', fmt(placed)));
      tr.appendChild(el('td', 'num', `${pets}`));
      body.appendChild(tr);
    };
    rows.forEach((r, i) => addRow(r, roman(i + 1), i < 3));
    if (me && !rows.some((r) => r[0] === myId)) addRow(me, '·', false);
    $('board-count').textContent = `${Math.max(total, rows.length)} on site`;
  }

  banner(title, text, ms = 4500) {
    $('banner-title').textContent = title;
    $('banner-text').textContent = text;
    const b = $('banner');
    b.classList.remove('hidden', 'out');
    clearTimeout(this.bannerTimer);
    clearTimeout(this.bannerHide);
    this.bannerTimer = setTimeout(() => b.classList.add('out'), ms);
    this.bannerHide = setTimeout(() => b.classList.add('hidden'), ms + 700);
  }

  overlay(text) {
    this.show('overlay', !!text);
    if (text) $('overlay-text').textContent = text;
  }

  /** Moves keyboard focus into a freshly opened modal (selected tile, first menu item or close button). */
  focusModal(name) {
    const root = $(name);
    const target = root.querySelector('.tile-grid:not(.hidden) .tile.selected') || root.querySelector('.menu-item:not(.hidden)') || root.querySelector('[data-close]') || root.querySelector('button, select, input');
    if (target) target.focus({ preventScroll: true });
  }

  /** Paints the filled part of a range slider's hairline track. */
  rangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 1;
    input.style.setProperty('--fill', `${(((Number(input.value) - min) / (max - min)) * 100).toFixed(1)}%`);
  }

  pips(level, max) {
    const p = el('span', 'pips');
    p.setAttribute('aria-label', `Level ${level} of ${max}`);
    for (let i = 0; i < max; i++) p.appendChild(el('span', i < level ? 'pip on' : 'pip'));
    return p;
  }

  // ----- Bazaar ------------------------------------------------------------------

  renderShop(view, self, petMax) {
    if (!view || !self) return;
    this.shopArgs = { view, self, petMax };
    const focus = this.shopFocus();
    for (const kind of ['upgrades', 'pets']) {
      const list = view[kind];
      if (!list.some((it) => it.id === this.shopSel[kind])) this.shopSel[kind] = list.length ? list[0].id : null;
      const grid = $(`shop-${kind}`);
      const next = grid.cloneNode(false);
      for (const item of list) next.appendChild(this.shopTile(item, kind, self));
      morph(grid, next);
    }
    this.renderShopDetail();
    this.renderOwned();
    this.restoreShopFocus(focus);
  }

  shopTile(item, kind, self) {
    const t = el('button', 'tile');
    t.type = 'button';
    t.dataset.select = item.id;
    const selected = this.shopSel[kind] === item.id;
    t.classList.toggle('selected', selected);
    t.setAttribute('aria-pressed', String(selected));
    const ic = el('span', 'tile-icon');
    ic.appendChild(icon(wareIcon(item.id)));
    t.appendChild(ic);
    t.appendChild(el('span', 'tile-name', item.name));
    let owned = 0;
    if (kind === 'upgrades') {
      t.appendChild(this.pips(item.level, item.max));
    } else {
      owned = self.pets.filter((p) => p.species === item.id).length;
      t.appendChild(el('span', 'tile-meta', `Hauls ${item.capacity} · ${item.speed.toFixed(1)} m/s`));
    }
    const price = el('span', 'tile-price');
    if (item.cost === null) {
      price.textContent = 'Mastered';
      t.classList.add('maxed');
    } else {
      price.appendChild(icon('coin'));
      price.appendChild(document.createTextNode(fmt(item.cost)));
      if (self.gold < item.cost) t.classList.add('short');
    }
    if (owned) price.appendChild(el('span', 'tile-owned', `${owned} owned`));
    t.appendChild(price);
    t.setAttribute('aria-label', `${item.name}, ${item.cost === null ? 'mastered' : `${fmt(item.cost)} gold`}`);
    return t;
  }

  renderShopDetail() {
    const live = $('shop-detail');
    const next = live.cloneNode(false);
    this.fillShopDetail(next);
    morph(live, next);
  }

  fillShopDetail(d) {
    const a = this.shopArgs;
    if (!a) return;
    const { view, self, petMax } = a;
    const kind = this.shopTab;
    const item = view[kind].find((it) => it.id === this.shopSel[kind]);
    if (!item) return;
    const art = el('div', 'detail-icon');
    art.appendChild(icon(wareIcon(item.id)));
    d.appendChild(art);
    d.appendChild(el('h3', '', item.name));
    const stats = el('dl', 'detail-stats');
    const stat = (k, v) => {
      const row = el('div');
      row.appendChild(el('dt', '', k));
      row.appendChild(el('dd', '', v));
      stats.appendChild(row);
    };
    let note = '';
    let can = false;
    if (kind === 'upgrades') {
      d.appendChild(el('p', 'kind', `Upgrade · Level ${item.level} of ${item.max}`));
      d.appendChild(el('p', 'lore', WARES[item.id] && WARES[item.id].lore ? WARES[item.id].lore : item.desc));
      stat('Per level', item.desc);
      stat('Current', item.level ? scaledEffect(item.desc, item.level) : 'Not yet learned');
      stat('Next', item.cost === null ? 'Mastered' : scaledEffect(item.desc, item.level + 1));
      can = item.cost !== null && self.gold >= item.cost;
      if (item.cost !== null && !can) note = `You need ${fmt(item.cost - self.gold)} more gold.`;
    } else {
      const owned = self.pets.filter((p) => p.species === item.id).length;
      d.appendChild(el('p', 'kind', `Pet · ${owned ? `${owned} in your crew` : 'Not in your crew'}`));
      d.appendChild(el('p', 'lore', item.desc));
      stat('Pace', `${item.speed.toFixed(1)} m/s`);
      stat('Hauls', `${item.capacity} block${item.capacity === 1 ? '' : 's'} per trip`);
      stat('Crew', `${self.pets.length} / ${petMax}`);
      const full = self.pets.length >= petMax;
      can = !full && self.gold >= item.cost;
      if (full) note = 'Every crew slot is filled. Release a pet to make room.';
      else if (!can) note = `You need ${fmt(item.cost - self.gold)} more gold.`;
    }
    d.appendChild(stats);
    const cost = el('div', 'cost');
    if (item.cost === null) {
      cost.classList.add('maxed');
      cost.textContent = 'Fully mastered';
    } else {
      cost.appendChild(icon('coin'));
      cost.appendChild(document.createTextNode(fmt(item.cost)));
      cost.appendChild(el('small', '', 'gold'));
    }
    d.appendChild(cost);
    if (item.cost !== null) {
      const btn = el('button', 'btn primary acquire', 'Acquire');
      btn.type = 'button';
      btn.dataset.buy = item.id;
      btn.disabled = !can;
      d.appendChild(btn);
    }
    d.appendChild(el('p', note ? 'detail-note' : 'detail-note ok', note));
  }

  renderOwned() {
    const live = $('shop-owned');
    const a = this.shopArgs;
    const show = !!a && this.shopTab === 'pets' && a.self.pets.length > 0;
    this.show('shop-owned', show);
    const next = live.cloneNode(false);
    if (show) this.fillOwned(next, a);
    morph(live, next);
  }

  fillOwned(owned, a) {
    const { view, self, petMax } = a;
    const title = el('h3', 'section-title');
    title.appendChild(el('span', '', 'Your crew'));
    title.appendChild(el('span', 'count', `${self.pets.length} / ${petMax}`));
    owned.appendChild(title);
    const list = el('div', 'owned-list');
    const species = Object.fromEntries(view.pets.map((p) => [p.id, p]));
    for (const p of self.pets) {
      const info = species[p.species];
      const name = info ? info.name : p.species;
      const row = el('div', 'owned');
      row.appendChild(icon(wareIcon(p.species)));
      row.appendChild(el('span', 'owned-name', name));
      if (info) row.appendChild(el('span', 'owned-meta', `Hauls ${info.capacity} · ${info.speed.toFixed(1)} m/s`));
      const rel = el('button', 'btn small release', 'Release');
      rel.type = 'button';
      rel.dataset.release = String(p.id);
      rel.appendChild(icon('coin'));
      rel.appendChild(document.createTextNode(`+${fmt(p.refund)}`));
      rel.setAttribute('aria-label', `Release ${name} for ${fmt(p.refund)} gold`);
      row.appendChild(rel);
      list.appendChild(row);
    }
    owned.appendChild(list);
  }

  setShopTab(tab) {
    this.shopTab = tab === 'pets' ? 'pets' : 'upgrades';
    for (const t of document.querySelectorAll('#shop .tabs button')) {
      const on = t.dataset.tab === this.shopTab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    this.show('shop-upgrades', this.shopTab === 'upgrades');
    this.show('shop-pets', this.shopTab === 'pets');
    this.renderShopDetail();
    this.renderOwned();
  }

  /** Selects a ware in the active tab. Returns false when it was already selected. */
  selectShopItem(id) {
    const kind = this.shopTab;
    if (this.shopSel[kind] === id) return false;
    this.shopSel[kind] = id;
    for (const t of $(`shop-${kind}`).querySelectorAll('.tile')) {
      const on = t.dataset.select === id;
      t.classList.toggle('selected', on);
      t.setAttribute('aria-pressed', String(on));
    }
    this.renderShopDetail();
    return true;
  }

  /** Remembers which Bazaar control has focus so a live re-render (gold ticking in) keeps it. */
  shopFocus() {
    const a = document.activeElement;
    if (!a || !a.dataset || !$('shop').contains(a)) return null;
    if (a.dataset.select) return { attr: 'select', value: a.dataset.select };
    if (a.dataset.buy) return { attr: 'buy', value: a.dataset.buy };
    if (a.dataset.release) return { attr: 'release', value: a.dataset.release };
    return null;
  }

  restoreShopFocus(f) {
    if (!f) return;
    const root = $('shop');
    const find = (attr, value) => [...root.querySelectorAll(`[data-${attr}]`)].find((n) => n.dataset[attr] === value && !n.disabled);
    const target = find(f.attr, f.value) || root.querySelector(`#shop-${this.shopTab} .tile.selected`);
    if (target) target.focus({ preventScroll: true });
  }

  // ----- Character sheet ---------------------------------------------------------

  renderCharacter() {
    const g = this.game;
    const s = g.self;
    const W = g.world;
    if (!s || !W) return;
    const petMax = W.config.pet.maxPerPlayer;
    const rule = this.carryRule();
    const name = g.name || 'Builder';
    $('char-name').textContent = name;
    const seal = $('char-seal');
    seal.textContent = name.charAt(0);
    this.tintSeal(seal, g.myColor || g.color);
    $('char-sub').textContent = `${builderTitle(s.placed)} — ${fmt(s.placed)} block${s.placed === 1 ? '' : 's'} set`;
    $('char-gold').textContent = fmt(s.gold);

    const attrs = $('char-attrs');
    attrs.textContent = '';
    const card = (iconName, label, value, unit, desc) => {
      const c = el('article', 'attr');
      c.appendChild(icon(iconName));
      c.appendChild(el('div', 'attr-label', label));
      const v = el('div', 'attr-value', value);
      if (unit) v.appendChild(el('small', '', unit));
      c.appendChild(v);
      c.appendChild(el('p', 'attr-desc', desc));
      attrs.appendChild(c);
      return c;
    };
    card('strength', 'Strength', s.strength.toFixed(1), '', 'Raises how many blocks you can lift at once. Train at the lifting stones.');
    card('wind', 'Speed', s.speed.toFixed(1), '', 'Lengthens your stride. Run laps around the sundial track.');
    card(
      'block',
      'Carry capacity',
      String(s.capacity),
      s.capacity === 1 ? 'block' : 'blocks',
      s.carry > 0 ? `Hauling ${s.carry} of ${s.capacity} right now.` : 'Strength and the Linen Carry Harness both raise it.',
    );
    // Pace, with the carry-weight penalty spelled out.
    const pace = card(
      'pace',
      'Pace',
      s.moveSpeed.toFixed(1),
      'm/s',
      s.carry > 0 ? 'Stone is heavy: laden, you trudge and cannot sprint.' : 'You run freely empty-handed. Any block slows you to a heavy walk.',
    );
    const meter = el('div', 'attr-meter');
    const meterRow = (label, f, cls) => {
      const r = el('div', cls ? `meter-row ${cls}` : 'meter-row');
      r.appendChild(el('span', '', label));
      const m = el('span', 'meter');
      const fill = el('i');
      fill.style.width = `${Math.round(clamp01(f) * 100)}%`;
      m.appendChild(fill);
      r.appendChild(m);
      r.appendChild(el('b', '', `${(s.moveSpeed * f).toFixed(1)} m/s`));
      meter.appendChild(r);
    };
    if (s.carry > 0) meterRow('Laden', ladenFactor(s.carry, s.capacity, rule), 'now');
    meterRow('One block', ladenFactor(1, s.capacity, rule));
    if (s.capacity > 1) meterRow('Full load', ladenFactor(s.capacity, s.capacity, rule));
    pace.appendChild(meter);
    pace.classList.toggle('burdened', s.carry > 0);
    card('pyramid', 'Blocks set', fmt(s.placed), '', 'Every block you set pays you gold and raises the pyramid.');
    card('regimen', 'Training', `×${s.trainMult}`, '', 'Multiplies every strength rep and lap. The Temple Regimen raises it.');

    const view = g.shopView;
    const ups = $('char-upgrades');
    ups.textContent = '';
    if (!view) ups.appendChild(el('p', 'empty', 'Visit the Bazaar to see the upgrades on offer.'));
    for (const u of view ? view.upgrades : []) {
      const level = s.upgrades && Number.isFinite(s.upgrades[u.id]) ? s.upgrades[u.id] : u.level;
      const row = el('div', level ? 'disc-row' : 'disc-row unlearned');
      row.appendChild(icon(wareIcon(u.id)));
      const txt = el('div');
      txt.appendChild(el('span', 'disc-name', u.name));
      txt.appendChild(el('span', 'disc-effect', level ? scaledEffect(u.desc, level) : `${u.desc} per level`));
      txt.appendChild(this.pips(level, u.max));
      row.appendChild(txt);
      ups.appendChild(row);
    }

    const crew = $('char-pets');
    crew.textContent = '';
    $('char-pet-count').textContent = `${s.pets.length} / ${petMax}`;
    const species = view ? Object.fromEntries(view.pets.map((p) => [p.id, p])) : {};
    if (!s.pets.length) crew.appendChild(el('p', 'empty', 'No pets yet. The merchant at the Bazaar sells loyal haulers who work while you rest.'));
    for (const p of s.pets) {
      const info = species[p.species];
      const c = el('div', 'crew');
      c.appendChild(icon(wareIcon(p.species)));
      const txt = el('div');
      txt.appendChild(el('span', 'crew-name', info ? info.name : p.species));
      if (info) txt.appendChild(el('span', 'crew-meta', `Hauls ${info.capacity} · ${info.speed.toFixed(1)} m/s`));
      c.appendChild(txt);
      crew.appendChild(c);
    }
  }

  // ----- Objective waypoint ----------------------------------------------------------

  /**
   * Positions the objective marker by projecting its world point with `camera`.
   * `t` is null (hidden) or { kind: 'quarry'|'pyramid', name, x, y, z, dist, alpha }.
   * Off-screen or behind the camera, the marker is clamped to the screen edge and
   * a chevron points the way.
   */
  objective(camera, t) {
    const o = this.obj;
    if (!t || t.alpha < 0.02) {
      if (!o.hidden) {
        o.el.classList.add('hidden');
        o.hidden = true;
      }
      return;
    }
    if (o.hidden) {
      o.el.classList.remove('hidden');
      o.hidden = false;
    }
    if (o.kind !== t.kind) {
      o.kind = t.kind;
      o.use.setAttribute('href', `#i-${t.kind}`);
    }
    if (o.label !== t.name) {
      o.label = t.name;
      o.name.textContent = t.name;
    }
    const dist = `${Math.max(0, Math.round(t.dist))} m`;
    if (dist !== o.distText) {
      o.distText = dist;
      o.dist.textContent = dist;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;
    const left = Math.min(cx - 20, OBJ_MARGIN.side);
    const right = w - left;
    const top = Math.min(cy - 20, OBJ_MARGIN.top);
    const bottom = Math.max(cy + 20, h - OBJ_MARGIN.bottom);
    camera.updateMatrixWorld();
    const v = this._ov.set(t.x, t.y, t.z).applyMatrix4(camera.matrixWorldInverse);
    const behind = v.z > -camera.near;
    let x = 0;
    let y = 0;
    let dx = 0;
    let dy = 0;
    let edge = behind;
    if (behind) {
      // Behind the camera: slide along the bottom edge towards the side the target is on.
      dx = v.x;
      dy = Math.abs(v.z) * 0.6 + 1e-3;
    } else {
      const p = v.applyMatrix4(camera.projectionMatrix);
      x = ((p.x + 1) / 2) * w;
      y = ((1 - p.y) / 2) * h;
      edge = x < left || x > right || y < top || y > bottom;
      dx = x - w / 2;
      dy = y - h / 2;
    }
    let angle = 0;
    if (edge) {
      // Slide along the ray from the screen centre until it meets the margin box.
      const clampTo = (bot) => {
        const kx = dx !== 0 ? (dx > 0 ? right - cx : cx - left) / Math.abs(dx) : Infinity;
        const ky = dy !== 0 ? (dy > 0 ? bot - cy : cy - top) / Math.abs(dy) : Infinity;
        const k = Math.min(kx, ky);
        x = cx + dx * k;
        y = cy + dy * k;
      };
      clampTo(bottom);
      // Lift it straight up out of the chat panel so it stays on the screen edge.
      const chatTop = Math.max(cy + 20, h - OBJ_MARGIN.chatTop);
      if (x < OBJ_MARGIN.chatRight && y > chatTop) y = chatTop;
      angle = Math.atan2(dy, dx);
    }
    // Step around the HUD panels (and, once clamped to the edge, the builder's own figure) instead
    // of covering them. A marker moved off its target becomes an edge marker pointing back at it.
    this.measureZones(camera, edge ? t.body : null);
    const moved = this.avoidZones(x, y, edge && Math.sin(angle) > 0.45, w, h, behind ? Math.sign(dx) : 0);
    if (moved) {
      if (!edge) {
        edge = true;
        angle = Math.atan2(y - moved[1], x - moved[0]);
      }
      x = moved[0];
      y = moved[1];
    }
    o.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    if (edge !== o.edge) {
      o.edge = edge;
      o.el.classList.toggle('edge', edge);
    }
    // When the chevron points down, the label moves above the lozenge so they never overlap.
    const flip = edge && Math.sin(angle) > 0.45;
    if (flip !== o.flip) {
      o.flip = flip;
      o.el.classList.toggle('flip', flip);
    }
    if (edge) o.arrow.style.transform = `rotate(${angle.toFixed(3)}rad) translateX(30px)`;
    const alpha = t.alpha.toFixed(2);
    if (alpha !== o.alpha) {
      o.alpha = alpha;
      o.el.style.opacity = alpha;
    }
  }

  /**
   * Refreshes the screen rects the objective marker avoids: the HUD panels (measured
   * from the DOM at most every 0.4 s) and, every frame, the local builder's figure.
   */
  measureZones(camera, body) {
    const o = this.obj;
    const now = performance.now();
    if (now - o.zonesAt > 400) {
      o.zonesAt = now;
      o.panels = [];
      for (const id of OBJ_AVOID) {
        const r = $(id).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) o.panels.push([r.left - 6, r.top - 6, r.right + 6, r.bottom + 6]);
      }
    }
    o.zones = o.panels.slice();
    if (!body || body[3] <= 0) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const p = this._bv.set(body[0], body[1], body[2]).project(camera);
    if (p.z > 1) return; // behind the camera
    const fx = ((p.x + 1) / 2) * w;
    const fy = ((1 - p.y) / 2) * h;
    p.set(body[0], body[1] + body[3], body[2]).project(camera);
    if (p.z > 1) return;
    const hx = ((p.x + 1) / 2) * w;
    const hy = ((1 - p.y) / 2) * h;
    const half = Math.abs(fy - hy) * 0.22 + 8;
    o.zones.push([Math.min(fx, hx) - half, Math.min(fy, hy) - 6, Math.max(fx, hx) + half, Math.max(fy, hy) + 6]);
  }

  /**
   * Nearest marker position, moving along one axis, whose lozenge and label (above it
   * when flipped) clear every zone and stay on screen; null when it is clear already or
   * nothing fits. `side` (-1/+1) favours moving towards the side a target behind lies on.
   */
  avoidZones(x, y, flip, w, h, side) {
    const zones = this.obj.zones;
    const box = (px, py) => (flip ? [px - 56, py - 66, px + 56, py + 18] : [px - 56, py - 18, px + 56, py + 66]);
    const hits = (b) => zones.some((z) => b[0] < z[2] && b[2] > z[0] && b[1] < z[3] && b[3] > z[1]);
    const b0 = box(x, y);
    if (!hits(b0)) return null;
    let best = null;
    let bestCost = Infinity;
    const tryAt = (px, py) => {
      const b = box(px, py);
      if (b[0] < 4 || b[1] < 4 || b[2] > w - 4 || b[3] > h - 4 || hits(b)) return;
      // Sideways steps read better than vertical ones (the marker keeps its height on the horizon).
      const cost = Math.abs(px - x) + 1.5 * Math.abs(py - y) + (side && (px - x) * side < 0 ? 40 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = [px, py];
      }
    };
    for (const z of zones) {
      tryAt(x, y + (z[3] - b0[1]) + 1);
      tryAt(x, y - (b0[3] - z[1]) - 1);
      tryAt(x + (z[2] - b0[0]) + 1, y);
      tryAt(x - (b0[2] - z[0]) - 1, y);
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

class Game {
  constructor() {
    this.canvas = $('scene');
    this.engine = new Engine(this.canvas);
    const saved = storageGet(SETTINGS_KEY, null);
    this.settings = Object.assign(
      { quality: detectQuality(this.engine.renderer), sensitivity: 1, volume: 0.7, invertY: false, showFps: false },
      saved || {},
    );
    this.net = new NetworkClient();
    this.input = new Input(this.canvas);
    this.sfx = new Sfx();
    this.lastAmbience = 0;
    this.sfx.volume = this.settings.volume;
    this.ui = new UI(this);
    this.floaters = new Floaters($('floaters'), this.engine.camera);
    this.state = 'loading';
    this.world = null;
    this.self = null;
    this.myId = 0;
    this.players = new Map();
    this.pileStock = 0;
    this.completed = 0;
    this.resetPending = false;
    this.modal = null;
    this.modalFrom = null;
    this.pending = {};
    this.nextRepeat = 0;
    this.lastSend = 0;
    this.lastHud = 0;
    this.frames = 0;
    this.fps = 0;
    this.fpsAt = performance.now();
    this.orbit = 0;
    this.shake = 0;
    this.last = performance.now();
    this.ctx = null;
    this.name = storageGet('dunebound.name', '');
    this.color = storageGet('dunebound.color', '#c8553d');
    this._v = new THREE.Vector3();
    // HUD objective waypoint target, refreshed every frame by updateObjective().
    // body: the local builder's feet and height, which the marker steps around on screen.
    this.objective = { kind: '', name: '', x: 0, y: 0, z: 0, dist: 0, alpha: 0, body: [0, 0, 0, 0] };
    this.bindNetwork();
    this.bindUI();
  }

  async boot() {
    try {
      await this.engine.init((p, text) => this.ui.loading(p, text));
    } catch (err) {
      console.error(err);
      this.ui.loading(1, 'Your graphics driver could not start WebGL 2. Please update it and try again');
      return;
    }
    this.engine.setQuality(this.settings.quality);
    this.ui.show('loading', false);
    this.showMenu();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ----- menus ---------------------------------------------------------------

  showMenu(reason) {
    this.state = 'menu';
    this.modal = null;
    this.input.exitLock();
    for (const id of ['hud', 'shop', 'character', 'pause', 'settings', 'overlay', 'board']) this.ui.show(id, false);
    $('board').classList.remove('pinned');
    this.ui.show('menu', true);
    $('name-input').value = this.name;
    $('server-input').value = defaultServer();
    this.ui.buildSwatches(['#c8553d', '#2a9d8f', '#e9c46a', '#6d597a', '#3a86ff', '#e76f51', '#8ab17d', '#f4a1c1'], this.color, (c) => {
      this.color = c;
      this.sfx.click();
    });
    this.ui.menuStatus(reason || '', reason ? 'error' : '');
    $('play-btn').disabled = false;
  }

  async join() {
    const name = $('name-input').value.trim().slice(0, 16);
    const url = $('server-input').value.trim();
    if (!name) {
      this.ui.menuStatus('Choose a name for your builder.', 'error');
      return;
    }
    this.sfx.init();
    this.state = 'connecting';
    $('play-btn').disabled = true;
    this.ui.menuStatus(`Connecting to ${url || 'localhost:3000'}…`);
    try {
      const welcome = await this.net.connect(url, { name, color: this.color, token: profileToken() });
      this.name = name;
      storageSet('dunebound.name', name);
      storageSet('dunebound.color', this.color);
      if (location.protocol === 'file:') storageSet('dunebound.server', url);
      this.onWelcome(welcome);
      this.enterPlay();
    } catch (err) {
      this.state = 'menu';
      $('play-btn').disabled = false;
      this.ui.menuStatus(err.message, 'error');
    }
  }

  enterPlay() {
    this.state = 'playing';
    this.ui.show('menu', false);
    this.ui.show('hud', true);
    this.ui.show('lock-hint', true);
    this.input.requestLock();
    this.ui.banner('Welcome to the dig site', 'Cross the Nile to the quarry, lift stone and haul it home to the pyramid. Follow the golden waypoint.', 6500);
  }

  leave(reason) {
    this.net.disconnect();
    this.pending = {};
    this.floaters.clear();
    this.showMenu(reason);
  }

  /** Opens a modal panel; `from` names the panel to return to when it is dismissed. */
  openModal(name, from = null) {
    this.closeModal(false);
    this.pinBoard(false);
    this.modal = name;
    this.modalFrom = from;
    this.input.exitLock();
    this.ui.show(name, true);
    if (name === 'shop') this.ui.renderShop(this.shopView, this.self, this.world.config.pet.maxPerPlayer);
    else if (name === 'character') this.ui.renderCharacter();
    this.ui.focusModal(name);
  }

  closeModal(relock = true) {
    if (!this.modal) return;
    const root = $(this.modal);
    if (root.contains(document.activeElement)) document.activeElement.blur();
    this.ui.show(this.modal, false);
    const was = this.modal;
    this.modal = null;
    if (relock && this.state === 'playing' && was !== 'settings') this.input.requestLock();
    if (this.state === 'playing') this.ui.show('lock-hint', !this.input.locked);
  }

  /** Dismisses the open modal; a panel opened from the pause menu returns to it. */
  backOut(relock) {
    if (this.modal && this.modal !== 'pause' && this.modalFrom === 'pause') this.openModal('pause');
    else this.closeModal(relock);
  }

  /** The builders board opened from the dock stays up until a click; Tab shows it only while held. */
  pinBoard(on) {
    const board = $('board');
    if (!on && !board.classList.contains('pinned')) return;
    board.classList.toggle('pinned', on);
    this.ui.show('board', on);
    if (this.state === 'playing') this.ui.show('lock-hint', !on && !this.input.locked && !this.modal);
  }

  /** Renders the builders board, with the local builder's own row when they are outside the top list. */
  showBoard(rows) {
    const W = this.world;
    const total = W ? W.remotes.players.size + 1 : rows.length;
    const me = this.self ? [this.myId, this.name, this.color, this.self.placed, this.self.pets.length] : null;
    this.ui.board(rows, this.myId, total, me);
  }

  controlsActive() {
    return this.state === 'playing' && this.input.locked && !this.modal;
  }

  // ----- world -----------------------------------------------------------------

  buildWorld(config) {
    const e = this.engine;
    if (this.world) {
      this.world.view.dispose();
      this.world.remotes.clear();
      this.world.pets.clear();
      e.scene.remove(this.world.player.model.root);
      e.scene.remove(this.world.merchant.root);
    }
    e.buildWorld(config);
    const grid = new PyramidGrid(config.pyramid);
    const field = new HeightField(config);
    field.addCameraBoxes(e.cameraBoxes || []);
    const view = new PyramidView(e, config, grid);
    view.onLand = (slot, pos) => this.onBlockLanded(slot, pos);
    const remotes = new RemotePlayers(e, config);
    remotes.field = field;
    const pets = new PetManager(e, config);
    const player = new LocalPlayer(e, config, field, this.input);
    player.attachModel(new CharacterModel(e, config, this.color, this.name));
    player.onFootstep = (evt) => this.onFootstep(evt);
    remotes.onFootstep = (evt) => this.onFootstep(evt);
    const merchant = new CharacterModel(e, config, '#d4a32c', 'merchant');
    if (e.bazaar) {
      merchant.root.position.set(e.bazaar.x, 0, e.bazaar.z + 0.6);
      merchant.root.rotation.y = Math.PI;
    }
    e.scene.add(merchant.root);
    this.world = { key: JSON.stringify(config), config, grid, field, view, remotes, pets, player, merchant };
  }

  onWelcome(w) {
    if (!this.world || this.world.key !== JSON.stringify(w.config)) this.buildWorld(w.config);
    const W = this.world;
    this.myId = w.id;
    const st = w.state;
    W.grid.load(st.pyramid);
    W.field.rebuild(W.grid);
    W.view.setState(st.pyramid);
    W.view.setPile(st.pile);
    this.pileStock = st.pile;
    W.remotes.clear();
    W.pets.clear();
    this.players.clear();
    for (const p of st.players) {
      this.players.set(p.id, p);
      if (p.id === this.myId) {
        W.player.setPosition(p.x, p.y, p.z);
        W.player.yaw = 0;
        W.player.model.setColor(p.color);
        W.player.setCarry(p.carry);
        this.myColor = p.color;
      } else {
        W.remotes.add(p);
      }
    }
    this.self = null;
    this.applySelf(w.self);
    for (const q of st.pets) W.pets.add(q);
    this.ui.resetChat(st.chat);
    this.showBoard(st.board);
    this.completed = st.completed;
    this.resetPending = st.resetIn > 0;
    this.ui.progress(W.grid, this.completed);
  }

  applySelf(s) {
    if (!s) return;
    const prevGold = this.self ? this.self.gold : s.gold;
    const prevCap = this.self ? this.self.capacity : s.capacity;
    this.self = Object.assign(this.self || {}, s);
    if (s.shop) {
      this.shopView = s.shop;
      if (this.world) this.world.pets.setNames(s.shop.pets);
    }
    const W = this.world;
    if (W) {
      W.player.stats.moveSpeed = this.self.moveSpeed;
      W.player.stats.capacity = this.self.capacity;
    }
    const petMax = W ? W.config.pet.maxPerPlayer : 4;
    this.ui.stats(this.self, petMax);
    if (this.self.gold !== prevGold) {
      this.ui.goldDelta(this.self.gold - prevGold);
      if (this.self.gold > prevGold) this.sfx.coin();
    }
    if (this.self.capacity > prevCap) this.ui.toast(`You can now carry ${this.self.capacity} blocks at once!`, 'good');
    if (this.modal === 'shop') this.ui.renderShop(this.shopView, this.self, petMax);
  }

  // ----- network events -------------------------------------------------------------

  bindNetwork() {
    const n = this.net;
    n.on('pj', (p) => {
      if (!this.world) return;
      this.players.set(p.id, p);
      this.world.remotes.add(p);
    });
    n.on('pl', ({ id }) => {
      if (!this.world) return;
      this.players.delete(id);
      this.world.remotes.remove(id);
    });
    n.on('qs', (q) => this.world && this.world.pets.add(q));
    n.on('qr', ({ id }) => this.world && this.world.pets.remove(id));
    n.on('carry', ({ k, id, b }) => {
      const W = this.world;
      if (!W) return;
      if (k === 'p') {
        if (id === this.myId) {
          W.player.setCarry(b);
          if (this.self) {
            this.self.carry = b.length;
            this.ui.stats(this.self, W.config.pet.maxPerPlayer);
          }
        } else W.remotes.setCarry(id, b);
      } else W.pets.setCarry(id, b);
    });
    n.on('placed', (e) => this.onPlaced(e));
    n.on('pile', (stock) => {
      this.pileStock = stock;
      if (this.world) this.world.view.setPile(stock);
    });
    n.on('self', (s) => this.applySelf(s));
    n.on('chat', (m) => this.ui.addChat(m));
    n.on('board', (rows) => this.showBoard(rows));
    n.on('complete', (e) => {
      this.completed = e.n;
      this.resetPending = true;
      this.world.view.celebrate();
      this.sfx.fanfare();
      this.ui.banner(`Pyramid #${e.n} complete!`, `Every builder receives ${fmt(e.bonus)} gold. A new foundation will be laid in ${e.resetIn} seconds.`, 7000);
      this.ui.progress(this.world.grid, this.completed);
    });
    n.on('reset', () => {
      const W = this.world;
      if (!W) return;
      this.resetPending = false;
      W.grid.reset();
      W.field.rebuild(W.grid);
      W.view.reset();
      this.ui.progress(W.grid, this.completed);
      this.ui.banner('A new pyramid begins', 'The sands are cleared. Lay the first course of stone!');
    });
    n.on('trained', (e) => {
      if (!this.world) return;
      this.floaters.spawn(`+${e.gain} Speed`, this._v.copy(this.world.player.pos).setY(this.world.player.pos.y + 2.4), 'speed');
    });
    n.on('correction', (c) => {
      if (this.world) this.world.player.setPosition(c.x, c.y, c.z);
    });
    n.on('kicked', (e) => this.leave(e.reason || 'You were disconnected.'));
    n.on('disconnected', (reason) => {
      if (this.state !== 'playing') return;
      if (reason === 'io server disconnect') this.leave('The server closed the connection.');
      else this.ui.overlay('Connection lost. Reconnecting…');
    });
    n.on('reconnecting', (attempt) => {
      if (this.state === 'playing') this.ui.overlay(`Connection lost. Reconnecting (attempt ${attempt})…`);
    });
    n.on('welcome', (w) => {
      this.ui.overlay(null);
      this.onWelcome(w);
      this.ui.toast('Reconnected to the dig site.', 'good');
    });
    n.on('fatal', (msg) => this.leave(msg));
  }

  onPlaced(e) {
    const W = this.world;
    if (!W) return;
    W.grid.place(e.s, e.b);
    W.field.applyBlock(W.grid.box(e.s));
    let from = null;
    if (e.k === 'p') from = e.id === this.myId ? W.player.model.carryTopWorld(new THREE.Vector3()) : W.remotes.carryTop(e.id, new THREE.Vector3());
    else from = W.pets.carryTop(e.id, new THREE.Vector3());
    W.view.place(e.s, e.b, from);
    // Pet rewards show up in the HUD gold counter; floaters are reserved for blocks you set yourself.
    if (e.o === this.myId && e.k === 'p') {
      const at = new THREE.Vector3(W.grid.cxs[e.s], W.grid.cys[e.s] + 1.2, W.grid.czs[e.s]);
      this.floaters.spawn(`+${e.r}`, at, 'gold');
    }
    this.ui.progress(W.grid, this.completed);
  }

  /** Footstep feedback from the local player and nearby remote players: sound plus a puff of sand or spray. */
  onFootstep(evt) {
    const W = this.world;
    if (!W) return;
    const cam = this.engine.camera.position;
    const d = Math.hypot(evt.x - cam.x, evt.y - cam.y, evt.z - cam.z);
    if (!evt.local && d > 40) return;
    const att = evt.local ? 1 : (1 - d / 40) ** 2;
    const wading = W.field.speedAt(evt.x, evt.z) < 1;
    if (wading) this.sfx.splash((0.45 + 0.55 * evt.intensity) * att);
    else this.sfx.footstep(evt.heavy, evt.intensity * att);
    if (evt.heavy || wading || (evt.local && evt.intensity > 0.45)) {
      this.engine.spawnDust(evt.x, evt.y, evt.z, evt.heavy ? 1.1 + 0.3 * evt.intensity : 0.35 + 0.4 * evt.intensity);
    }
  }

  /** The river gets louder as the listener (player, or the menu camera) approaches its banks. */
  updateAmbience(now, focus) {
    if (now - this.lastAmbience < 200) return;
    this.lastAmbience = now;
    const river = this.engine.river;
    const p = focus || this.engine.camera.position;
    const edge = river ? Math.max(0, river.distance(p.x, p.z, 200) - river.halfWidth) : Infinity;
    this.sfx.setRiver(Math.max(0, 1 - edge / 120) ** 2.2);
  }

  onBlockLanded(slot, pos) {
    const d = pos.distanceTo(this.engine.camera.position);
    const v = Math.max(0, 1 - d / 60);
    this.sfx.thud(v * v);
    if (d < 14) this.shake = Math.max(this.shake, 0.12 * (1 - d / 14));
  }

  // ----- interactions ---------------------------------------------------------------

  computeContext() {
    const W = this.world;
    const cfg = W.config;
    const P = W.player.pos;
    const carrying = W.player.carry.length;
    const cap = this.self ? this.self.capacity : 1;
    const pile = cfg.pile;
    if (rectDistance(P.x, P.z, pile.minX, pile.minZ, pile.maxX, pile.maxZ) <= pile.range) {
      if (carrying >= cap) return { type: 'info', text: `Your arms are full (${carrying}/${cap}). Haul the blocks to the pyramid.` };
      if (this.pileStock <= 0) return { type: 'info', text: 'The pile is empty. Quarry workers are cutting more stone…' };
      return { type: 'pickup', text: `Lift blocks  (${carrying}/${cap})` };
    }
    if (carrying > 0 && !this.resetPending) {
      const f = W.player.forward;
      const slot = W.view.findTarget(P.x, P.y, P.z, f.x, f.z, cfg.player.handHeight, cfg.player.reach);
      if (slot >= 0) return { type: 'place', slot, text: `Set block  ·  Layer ${W.grid.layerOf[slot] + 1}` };
      const pc = cfg.pyramid;
      const half = (pc.base * pc.blockW) / 2;
      if (rectDistance(P.x, P.z, pc.cx - half, pc.cz - half, pc.cx + half, pc.cz + half) < 6) {
        return { type: 'info', text: 'No open slot in reach. Climb the steps or walk along the face.' };
      }
    }
    const z = cfg.zones;
    if (Math.hypot(P.x - z.strength.x, P.z - z.strength.z) <= z.strength.r) {
      const gain = this.self ? this.self.trainMult : 1;
      return { type: 'train', text: `Lift stones  (+${gain} Strength per rep)` };
    }
    const dTrack = Math.hypot(P.x - z.track.x, P.z - z.track.z);
    if (dTrack <= z.track.r && dTrack >= z.track.inner) return { type: 'info', text: 'Run laps around the sundial to train Speed.' };
    if (Math.hypot(P.x - z.shop.x, P.z - z.shop.z) <= z.shop.r) return { type: 'shop', text: 'Browse the Bazaar' };
    if (carrying === 0 && this.self && this.self.placed === 0) return { type: 'info', text: 'Head to the QUARRY to lift your first block.' };
    return null;
  }

  async perform(ctx) {
    const W = this.world;
    if (ctx.type === 'shop') {
      this.sfx.click();
      this.openModal('shop');
      return;
    }
    if (this.pending[ctx.type]) return;
    this.pending[ctx.type] = true;
    try {
      if (ctx.type === 'pickup') {
        const r = await this.net.request('pickup');
        if (r.ok) {
          this.sfx.lift();
          W.player.playAction(ANIM.PICKUP, 0.45);
        } else this.reject(r);
      } else if (ctx.type === 'place') {
        const r = await this.net.request('place', { slot: ctx.slot });
        if (r.ok) W.player.playAction(ANIM.PLACE, 0.35);
        else this.reject(r);
      } else if (ctx.type === 'train') {
        W.player.playAction(ANIM.LIFT, 0.9);
        const r = await this.net.request('train');
        if (r.ok) {
          this.sfx.train();
          this.floaters.spawn(`+${r.gain} Strength`, this._v.copy(W.player.pos).setY(W.player.pos.y + 2.6), 'strength');
        } else this.reject(r);
      }
    } catch (err) {
      this.ui.toast(err.message, 'bad');
    } finally {
      this.pending[ctx.type] = false;
    }
  }

  reject(r) {
    if (r && r.silent) return;
    this.sfx.error();
    this.ui.toast((r && r.reason) || 'That did not work.', 'bad');
  }

  async buy(item) {
    try {
      const r = await this.net.request('buy', { item });
      if (r.ok) {
        this.sfx.coin();
        const name = r.kind === 'pet' ? this.shopView.pets.find((p) => p.id === item).name : this.shopView.upgrades.find((u) => u.id === item).name;
        this.ui.toast(r.kind === 'pet' ? `${name} joined your crew!` : `${name} upgraded to level ${r.level}.`, 'good');
      } else this.reject(r);
    } catch (err) {
      this.ui.toast(err.message, 'bad');
    }
  }

  async release(petId) {
    try {
      const r = await this.net.request('release', { pet: petId });
      if (r.ok) this.ui.toast(`Your pet returns to the wild. +${fmt(r.refund)} gold.`, 'info');
      else this.reject(r);
    } catch (err) {
      this.ui.toast(err.message, 'bad');
    }
  }

  // ----- DOM wiring -----------------------------------------------------------------

  bindUI() {
    $('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.state === 'menu') this.join();
    });
    const quit = () => window.close();
    $('quit-btn').addEventListener('click', quit);
    $('pause-quit-btn').addEventListener('click', quit);
    $('resume-btn').addEventListener('click', () => this.closeModal(true));
    $('leave-btn').addEventListener('click', () => this.leave(''));
    $('pause-char-btn').addEventListener('click', () => this.openModal('character', 'pause'));
    $('pause-settings-btn').addEventListener('click', () => this.openSettings('pause'));
    $('menu-settings-btn').addEventListener('click', () => this.openSettings('menu'));
    $('settings-done').addEventListener('click', () => this.closeSettings());
    for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => this.backOut(true));

    for (const tab of document.querySelectorAll('#shop .tabs button')) {
      tab.addEventListener('click', () => {
        this.ui.setShopTab(tab.dataset.tab);
        this.sfx.click();
      });
    }
    $('shop').addEventListener('click', (e) => {
      const sel = e.target.closest('[data-select]');
      if (sel) {
        if (this.ui.selectShopItem(sel.dataset.select)) this.sfx.click();
        return;
      }
      const buy = e.target.closest('[data-buy]');
      if (buy && !buy.disabled) this.buy(buy.dataset.buy);
      const rel = e.target.closest('[data-release]');
      if (rel) this.release(Number(rel.dataset.release));
    });
    $('shop').addEventListener('keydown', (e) => this.onShopKey(e));

    // HUD quick menu (clickable whenever the pointer is free; doubles as a key legend).
    $('dock').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dock]');
      if (!b || this.state !== 'playing') return;
      b.blur();
      const action = b.dataset.dock;
      if (action === 'character' || action === 'pause') this.openModal(action);
      else if (action === 'board') this.pinBoard(!this.ui.isShown('board'));
      else if (action === 'chat') {
        this.chatOpen = true;
        this.input.exitLock();
        $('chat-input').focus();
      }
    });

    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.modal) this.input.requestLock();
    });
    $('lock-hint').addEventListener('click', () => {
      if (this.state === 'playing' && !this.modal) this.input.requestLock();
    });
    $('board').addEventListener('click', () => {
      if (!$('board').classList.contains('pinned')) return;
      this.pinBoard(false);
      if (this.state === 'playing' && !this.modal) this.input.requestLock();
    });
    this.input.onLockChange = (locked) => {
      if (this.state !== 'playing') return;
      if (locked) this.pinBoard(false);
      this.ui.show('lock-hint', !locked && !this.modal);
      if (!locked && !this.modal && !this.chatOpen) this.openModal('pause');
    };

    const chatInput = $('chat-input');
    chatInput.addEventListener('focus', () => {
      this.chatOpen = true;
      this.input.enabled = false;
      this.input.keys.clear();
      $('chat').classList.add('open');
    });
    chatInput.addEventListener('blur', () => {
      this.chatOpen = false;
      this.input.enabled = true;
      $('chat').classList.remove('open');
    });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const text = chatInput.value.trim();
        if (text) this.net.sendChat(text);
        chatInput.value = '';
        chatInput.blur();
        if (this.state === 'playing') this.input.requestLock();
      } else if (e.key === 'Escape') {
        chatInput.value = '';
        chatInput.blur();
      }
      e.stopPropagation();
    });

    window.addEventListener('keydown', (e) => {
      // Tab is a game key (the builders board), so menus and modals cycle focus themselves.
      if (e.code === 'Tab' && this.trapFocus(e)) return;
      if (e.key === 'Escape' && this.state === 'menu' && this.ui.isShown('settings')) {
        this.closeSettings();
        return;
      }
      if (this.state !== 'playing') return;
      if (e.target === chatInput) return;
      if ((e.key === 'Enter' || e.code === 'KeyT') && !this.modal) {
        e.preventDefault();
        this.chatOpen = true;
        this.input.exitLock();
        chatInput.focus();
      } else if (e.code === 'Tab') {
        $('board').classList.remove('pinned');
        this.ui.show('board', true);
      } else if (e.code === 'KeyC' && !e.repeat) {
        if (this.modal === 'character') this.backOut(true);
        else if (this.modal !== 'settings') this.openModal('character', this.modal === 'pause' ? 'pause' : null);
      } else if (e.key === 'Escape' && this.modal) {
        if (this.modal === 'settings') this.closeSettings();
        else this.backOut(this.modal === 'pause');
      } else if (e.key === 'Escape') {
        this.pinBoard(false);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab' && !$('board').classList.contains('pinned')) this.ui.show('board', false);
    });

    // Settings controls.
    const q = $('set-quality');
    const sens = $('set-sens');
    const vol = $('set-vol');
    const inv = $('set-invert');
    const fps = $('set-fps');
    q.addEventListener('change', () => {
      this.settings.quality = q.value;
      this.engine.setQuality(q.value);
      this.saveSettings();
    });
    sens.addEventListener('input', () => {
      this.settings.sensitivity = Number(sens.value);
      $('set-sens-val').textContent = `${this.settings.sensitivity.toFixed(1)}x`;
      this.ui.rangeFill(sens);
      this.saveSettings();
    });
    vol.addEventListener('input', () => {
      this.settings.volume = Number(vol.value);
      $('set-vol-val').textContent = `${Math.round(this.settings.volume * 100)}%`;
      this.ui.rangeFill(vol);
      this.sfx.setVolume(this.settings.volume);
      this.saveSettings();
    });
    inv.addEventListener('change', () => {
      this.settings.invertY = inv.checked;
      this.saveSettings();
    });
    fps.addEventListener('change', () => {
      this.settings.showFps = fps.checked;
      this.saveSettings();
    });
  }

  /**
   * Keeps Tab focus inside the open modal (or the main menu). Returns false when
   * no menu is up, so Tab falls through to the builders board.
   */
  trapFocus(e) {
    let root = null;
    if (this.modal) root = $(this.modal);
    else if (this.state === 'menu') root = this.ui.isShown('settings') ? $('settings') : $('menu');
    if (!root) return false;
    e.preventDefault();
    const items = [...root.querySelectorAll('button, input, select')].filter((n) => !n.disabled && n.getClientRects().length > 0);
    if (!items.length) return true;
    const i = items.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
    items[next].focus();
    return true;
  }

  /** Bazaar keyboard control: arrow keys walk the tile grid, Enter on the selected tile acquires it. */
  onShopKey(e) {
    const tile = e.target.closest && e.target.closest('.tile');
    if (!tile) return;
    if (e.key === 'Enter' && tile.classList.contains('selected')) {
      e.preventDefault();
      const buy = $('shop-detail').querySelector('[data-buy]');
      if (buy && !buy.disabled) this.buy(buy.dataset.buy);
      else this.sfx.error();
      return;
    }
    const grid = tile.parentElement;
    const tiles = [...grid.querySelectorAll('.tile')];
    const cols = Math.max(1, window.getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    const i = tiles.indexOf(tile);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (!step) return;
    e.preventDefault();
    const j = i + step;
    if (j < 0 || j >= tiles.length) return;
    if (this.ui.selectShopItem(tiles[j].dataset.select)) this.sfx.click();
    tiles[j].focus();
  }

  openSettings(from) {
    this.settingsFrom = from;
    $('set-quality').value = this.settings.quality;
    $('set-sens').value = String(this.settings.sensitivity);
    $('set-sens-val').textContent = `${Number(this.settings.sensitivity).toFixed(1)}x`;
    $('set-vol').value = String(this.settings.volume);
    $('set-vol-val').textContent = `${Math.round(this.settings.volume * 100)}%`;
    this.ui.rangeFill($('set-sens'));
    this.ui.rangeFill($('set-vol'));
    $('set-invert').checked = !!this.settings.invertY;
    $('set-fps').checked = !!this.settings.showFps;
    if (from === 'pause') {
      this.ui.show('pause', false);
      this.modal = 'settings';
    }
    this.ui.show('settings', true);
    $('set-quality').focus({ preventScroll: true });
  }

  closeSettings() {
    if ($('settings').contains(document.activeElement)) document.activeElement.blur();
    this.ui.show('settings', false);
    if (this.settingsFrom === 'pause' && this.state === 'playing') {
      this.modal = 'pause';
      this.ui.show('pause', true);
      this.ui.focusModal('pause');
    }
  }

  saveSettings() {
    storageSet(SETTINGS_KEY, this.settings);
  }

  /**
   * Feeds the HUD objective waypoint: the quarry pile while empty-handed, the
   * pyramid's open layer while carrying. It fades out once you have arrived.
   */
  updateObjective() {
    const W = this.world;
    const t = this.objective;
    if (!W || !this.self) {
      this.ui.objective(this.engine.camera, null);
      return;
    }
    const cfg = W.config;
    const P = W.player.pos;
    if (W.player.carry.length === 0) {
      const pile = cfg.pile;
      t.kind = 'quarry';
      t.name = 'Quarry';
      t.x = (pile.minX + pile.maxX) / 2;
      t.y = 5.2;
      t.z = (pile.minZ + pile.maxZ) / 2;
      t.dist = rectDistance(P.x, P.z, pile.minX, pile.minZ, pile.maxX, pile.maxZ);
      t.alpha = clamp01((t.dist - pile.range - 1) / 8);
    } else {
      const pc = cfg.pyramid;
      const half = (pc.base * pc.blockW) / 2;
      const layer = Math.min(W.grid.frontLayer(), W.grid.layers - 1);
      t.kind = 'pyramid';
      t.name = `Pyramid · Layer ${layer + 1}`;
      t.x = pc.cx;
      t.y = (layer + 1) * pc.blockH + 2.4;
      t.z = pc.cz;
      t.dist = rectDistance(P.x, P.z, pc.cx - half, pc.cz - half, pc.cx + half, pc.cz + half);
      t.alpha = clamp01((t.dist - 2) / 8);
    }
    const body = t.body;
    body[0] = P.x;
    body[1] = W.player.visualY;
    body[2] = P.z;
    body[3] = 1.9 + (W.player.model ? W.player.model.stackHeight() : 0);
    this.ui.objective(this.engine.camera, t);
    // The quarry's world label gives way to the waypoint naming the same place.
    const label = this.engine.quarryLabel;
    if (label) label.material.opacity = t.kind === 'quarry' ? 1 - t.alpha : 1;
  }

  // ----- main loop --------------------------------------------------------------------

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.05, Math.max(0.0005, (now - this.last) / 1000));
    this.last = now;
    this.frames++;
    if (now - this.fpsAt >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
      this.frames = 0;
      this.fpsAt = now;
    }
    const W = this.world;
    const e = this.engine;
    let focus = null;

    if (this.state === 'playing' && W) {
      const active = this.controlsActive();
      W.player.update(dt, this.settings, active);
      const ctx = this.computeContext();
      this.ctx = ctx;
      W.view.setGhost(ctx && ctx.type === 'place' ? ctx.slot : -1);
      W.player.faceTarget = ctx && ctx.type === 'place' ? { x: W.grid.cxs[ctx.slot], z: W.grid.czs[ctx.slot] } : null;
      this.ui.prompt(this.modal ? null : ctx);
      if (active && ctx && ctx.type !== 'info') {
        const trigger = this.input.wasPressed('KeyE') || this.input.clicked;
        const holding = this.input.isDown('KeyE') || this.input.mouseDown;
        const repeat = REPEAT_MS[ctx.type];
        if (trigger || (holding && repeat && now >= this.nextRepeat)) {
          this.nextRepeat = now + (repeat || 1e9);
          this.perform(ctx);
        }
      }
      if (now - this.lastSend >= 50) {
        this.lastSend = now;
        this.net.sendMove(W.player.netState());
      }
      const sampled = this.net.sample();
      W.remotes.update(dt, sampled.players);
      W.pets.update(dt, sampled.pets);
      if (this.shake > 0.001) {
        e.camera.position.x += (Math.random() - 0.5) * this.shake;
        e.camera.position.y += (Math.random() - 0.5) * this.shake;
        this.shake *= Math.exp(-dt * 10);
      }
      focus = W.player.pos;
      this.floaters.update(dt);
      this.updateObjective();
      if (now - this.lastHud > 250) {
        this.lastHud = now;
        this.ui.net(W.remotes.players.size + 1, this.net.rtt, this.settings.showFps ? this.fps : 0);
      }
    } else {
      // Cinematic orbit behind the menus.
      this.orbit += dt * 0.035;
      const r = 78;
      e.camera.position.set(Math.sin(this.orbit) * r, 20 + Math.sin(this.orbit * 0.7) * 4, Math.cos(this.orbit) * r);
      e.camera.lookAt(0, 7, 0);
      if (W) {
        const sampled = this.net.sample();
        W.pets.update(dt, sampled.pets);
        W.remotes.update(dt, sampled.players);
      }
    }
    if (W) {
      W.view.update(dt);
      W.merchant.animate(dt, { speed: 0, airborne: false, anim: ANIM.IDLE, actionT: 0 });
    }
    this.updateAmbience(now, focus);
    e.update(dt, focus);
    e.render();
    this.input.endFrame();
  }
}

const game = new Game();
window.addEventListener('error', (e) => console.error('[dunebound]', e.message));
// Developer hook: open with ?debug to inspect the running game from the console.
if (new URLSearchParams(location.search).has('debug')) window.dunebound = game;
game.boot();
