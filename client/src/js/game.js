/**
 * Dunebound - client bootstrap, game loop and UI (HUD, shop, chat, menus).
 */
import * as THREE from 'three';
import { Engine } from './engine.js';
import { NetworkClient } from './network.js';
import { Input, LocalPlayer, RemotePlayers, CharacterModel, ANIM } from './player.js';
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

class UI {
  constructor(game) {
    this.game = game;
    this.toastsEl = $('toasts');
    this.chatLog = $('chat-log');
    this.promptEl = $('prompt');
    this.lastPrompt = '';
    this.goldDeltaTimer = 0;
    this.goldDeltaSum = 0;
    if (!IS_ELECTRON) {
      for (const id of ['quit-btn', 'pause-quit-btn']) $(id).classList.add('hidden');
    }
  }

  show(id, on = true) {
    $(id).classList.toggle('hidden', !on);
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
      if (c === selected) b.classList.add('active');
      b.addEventListener('click', () => {
        for (const s of wrap.children) s.classList.remove('active');
        b.classList.add('active');
        onPick(c);
      });
      wrap.appendChild(b);
    }
  }

  stats(s, petMax) {
    $('gold').textContent = fmt(s.gold);
    $('stat-str').textContent = s.strength.toFixed(1);
    $('stat-spd').textContent = s.speed.toFixed(1);
    $('stat-carry').textContent = `${s.carry} / ${s.capacity}`;
    $('stat-pets').textContent = `${s.pets.length} / ${petMax}`;
    $('stat-placed').textContent = fmt(s.placed);
    $('stat-move').textContent = `${s.moveSpeed.toFixed(1)} m/s`;
    $('shop-gold').textContent = fmt(s.gold);
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
    $('progress-layer').textContent = front >= grid.layers ? 'Complete!' : `Building layer ${front + 1} of ${grid.layers}`;
    $('progress-completed').textContent = completed ? `Pyramids raised: ${completed}` : '';
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
    while (this.toastsEl.children.length > 4) this.toastsEl.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  addChat(m) {
    const line = el('div', `chat-line${m.sys ? ' system' : ''}`);
    if (!m.sys) {
      const n = el('span', 'chat-name', `${m.n}:`);
      n.style.color = m.c;
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

  board(rows, myId) {
    const body = $('board-body');
    body.textContent = '';
    rows.forEach((r, i) => {
      const [id, name, color, placed, pets] = r;
      const tr = el('tr', id === myId ? 'me' : '');
      tr.appendChild(el('td', 'rank', `${i + 1}`));
      const n = el('td', 'name', name);
      n.style.color = color;
      tr.appendChild(n);
      tr.appendChild(el('td', 'num', fmt(placed)));
      tr.appendChild(el('td', 'num', `${pets}`));
      body.appendChild(tr);
    });
  }

  banner(title, text, ms = 4500) {
    $('banner-title').textContent = title;
    $('banner-text').textContent = text;
    const b = $('banner');
    b.classList.remove('hidden', 'out');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => b.classList.add('out'), ms);
    this.bannerHide = setTimeout(() => b.classList.add('hidden'), ms + 700);
  }

  overlay(text) {
    this.show('overlay', !!text);
    if (text) $('overlay-text').textContent = text;
  }

  renderShop(view, self, petMax) {
    if (!view || !self) return;
    const up = $('shop-upgrades');
    up.textContent = '';
    for (const u of view.upgrades) {
      const card = el('article', 'card');
      card.appendChild(el('div', 'medallion', u.name.charAt(0)));
      const body = el('div', 'card-body');
      body.appendChild(el('h3', '', u.name));
      body.appendChild(el('p', '', u.desc));
      const pips = el('div', 'pips');
      for (let i = 0; i < u.max; i++) pips.appendChild(el('span', i < u.level ? 'pip on' : 'pip'));
      body.appendChild(pips);
      card.appendChild(body);
      const btn = el('button', 'btn buy');
      btn.type = 'button';
      if (u.cost === null) {
        btn.textContent = 'Mastered';
        btn.disabled = true;
      } else {
        btn.textContent = `${fmt(u.cost)} gold`;
        btn.dataset.buy = u.id;
        btn.disabled = self.gold < u.cost;
      }
      card.appendChild(btn);
      up.appendChild(card);
    }
    const pets = $('shop-pets');
    pets.textContent = '';
    for (const p of view.pets) {
      const card = el('article', 'card');
      card.appendChild(el('div', `medallion pet-${p.id}`, p.name.split(' ').pop().charAt(0)));
      const body = el('div', 'card-body');
      body.appendChild(el('h3', '', p.name));
      body.appendChild(el('p', '', p.desc));
      body.appendChild(el('p', 'meta', `Speed ${p.speed} m/s  ·  Carries ${p.capacity}`));
      card.appendChild(body);
      const btn = el('button', 'btn buy', `${fmt(p.cost)} gold`);
      btn.type = 'button';
      btn.dataset.buy = p.id;
      btn.disabled = self.gold < p.cost || self.pets.length >= petMax;
      card.appendChild(btn);
      pets.appendChild(card);
    }
    const owned = $('shop-owned');
    owned.textContent = '';
    if (self.pets.length) {
      owned.appendChild(el('h3', '', `Your pets (${self.pets.length}/${petMax})`));
      const list = el('div', 'owned-list');
      const names = Object.fromEntries(view.pets.map((p) => [p.id, p.name]));
      for (const p of self.pets) {
        const row = el('div', 'owned');
        row.appendChild(el('span', '', names[p.species] || p.species));
        const rel = el('button', 'btn ghost small', `Release (+${fmt(p.refund)})`);
        rel.type = 'button';
        rel.dataset.release = String(p.id);
        row.appendChild(rel);
        list.appendChild(row);
      }
      owned.appendChild(list);
    }
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
    for (const id of ['hud', 'shop', 'pause', 'overlay', 'board']) this.ui.show(id, false);
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
    this.ui.banner('Welcome to the dig site', 'Lift blocks at the quarry, carry them to the pyramid and press E to set them.', 6000);
  }

  leave(reason) {
    this.net.disconnect();
    this.pending = {};
    this.floaters.clear();
    this.showMenu(reason);
  }

  openModal(name) {
    this.closeModal(false);
    this.modal = name;
    this.input.exitLock();
    this.ui.show(name, true);
    if (name === 'shop') this.ui.renderShop(this.shopView, this.self, this.world.config.pet.maxPerPlayer);
  }

  closeModal(relock = true) {
    if (!this.modal) return;
    this.ui.show(this.modal, false);
    const was = this.modal;
    this.modal = null;
    if (relock && this.state === 'playing' && was !== 'settings') this.input.requestLock();
    if (this.state === 'playing') this.ui.show('lock-hint', !this.input.locked);
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
    const view = new PyramidView(e, config, grid);
    view.onLand = (slot, pos) => this.onBlockLanded(slot, pos);
    const remotes = new RemotePlayers(e, config);
    const pets = new PetManager(e, config);
    const player = new LocalPlayer(e, config, field, this.input);
    player.attachModel(new CharacterModel(e, config, this.color, this.name));
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
    this.ui.board(st.board, this.myId);
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
    n.on('board', (rows) => this.ui.board(rows, this.myId));
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
    $('pause-settings-btn').addEventListener('click', () => this.openSettings('pause'));
    $('menu-settings-btn').addEventListener('click', () => this.openSettings('menu'));
    $('settings-done').addEventListener('click', () => this.closeSettings());
    for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => this.closeModal(true));

    for (const tab of document.querySelectorAll('.tabs button')) {
      tab.addEventListener('click', () => {
        for (const t of document.querySelectorAll('.tabs button')) t.classList.toggle('active', t === tab);
        this.ui.show('shop-upgrades', tab.dataset.tab === 'upgrades');
        this.ui.show('shop-pets', tab.dataset.tab === 'pets');
        this.sfx.click();
      });
    }
    $('shop').addEventListener('click', (e) => {
      const buy = e.target.closest('[data-buy]');
      if (buy && !buy.disabled) this.buy(buy.dataset.buy);
      const rel = e.target.closest('[data-release]');
      if (rel) this.release(Number(rel.dataset.release));
    });

    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.modal) this.input.requestLock();
    });
    $('lock-hint').addEventListener('click', () => {
      if (this.state === 'playing' && !this.modal) this.input.requestLock();
    });
    this.input.onLockChange = (locked) => {
      if (this.state !== 'playing') return;
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
      if (this.state !== 'playing') return;
      if (e.target === chatInput) return;
      if ((e.key === 'Enter' || e.code === 'KeyT') && !this.modal) {
        e.preventDefault();
        this.chatOpen = true;
        this.input.exitLock();
        chatInput.focus();
      } else if (e.code === 'Tab') {
        this.ui.show('board', true);
      } else if (e.key === 'Escape' && this.modal) {
        if (this.modal === 'settings') this.closeSettings();
        else this.closeModal(this.modal === 'pause');
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.ui.show('board', false);
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
      this.saveSettings();
    });
    vol.addEventListener('input', () => {
      this.settings.volume = Number(vol.value);
      $('set-vol-val').textContent = `${Math.round(this.settings.volume * 100)}%`;
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

  openSettings(from) {
    this.settingsFrom = from;
    $('set-quality').value = this.settings.quality;
    $('set-sens').value = String(this.settings.sensitivity);
    $('set-sens-val').textContent = `${Number(this.settings.sensitivity).toFixed(1)}x`;
    $('set-vol').value = String(this.settings.volume);
    $('set-vol-val').textContent = `${Math.round(this.settings.volume * 100)}%`;
    $('set-invert').checked = !!this.settings.invertY;
    $('set-fps').checked = !!this.settings.showFps;
    if (from === 'pause') {
      this.ui.show('pause', false);
      this.modal = 'settings';
    }
    this.ui.show('settings', true);
  }

  closeSettings() {
    this.ui.show('settings', false);
    if (this.settingsFrom === 'pause' && this.state === 'playing') {
      this.modal = 'pause';
      this.ui.show('pause', true);
    }
  }

  saveSettings() {
    storageSet(SETTINGS_KEY, this.settings);
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
