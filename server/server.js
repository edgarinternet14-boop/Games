'use strict';

/**
 * Dunebound - authoritative multiplayer server.
 *
 * The server is the single source of truth for:
 *   - every player's validated position, stats, gold and carried blocks
 *   - every block: in the quarry pile, carried by a player/pet, or set in the pyramid
 *   - the pyramid grid (placement validation + broadcast)
 *   - pets, which are simulated here (state machine + A* pathfinding) and streamed
 *     to every client so all players see the same pet hauling the same block.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const L = require('./gameLogic');

const { CONFIG, PILE, PETS, ZONES } = L;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SERVE_WEB_CLIENT = process.env.SERVE_WEB_CLIENT !== '0';
const TICK_MS = 1000 / CONFIG.tickRate;
const SAVE_INTERVAL_MS = 30000;

const ANIM_MAX = 5; // 0 idle, 1 walk, 2 airborne, 3 lifting, 4 placing, 5 picking up
const PET_IDLE = 0;
const PET_MOVING = 1;
const PET_LOADING = 2;
const PET_PLACING = 3;

const round2 = (v) => Math.round(v * 100) / 100;
const now = () => Date.now();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

class Player {
  constructor(id, socket, tokenHash, stats, x, y, z) {
    this.id = id;
    this.socket = socket;
    this.tokenHash = tokenHash;
    this.stats = stats; // persisted profile: name, color, gold, strength, speed, placed, upgrades, pets
    this.x = x;
    this.y = y;
    this.z = z;
    this.ry = Math.PI;
    this.anim = 0;
    this.carry = []; // ids of the blocks this player is holding
    this.petIds = new Set();
    this.cid = 0; // correction id: moves stamped with an older id are ignored
    this.lastMoveAt = now();
    this.lastRepAt = 0;
    this.lastPickupAt = 0;
    this.lastPlaceAt = 0;
    this.trackDist = 0;
    this.chatTimes = [];
    this.selfDirty = true;
    this.shopDirty = true;
  }

  get name() {
    return this.stats.name;
  }

  get color() {
    return this.stats.color;
  }
}

class Pet {
  constructor(id, owner, species, x, y, z) {
    this.id = id;
    this.owner = owner;
    this.species = species;
    this.x = x;
    this.y = y;
    this.z = z;
    this.ry = 0;
    this.state = 'toPile';
    this.code = PET_MOVING;
    this.carry = [];
    this.path = null;
    this.pathIdx = 0;
    this.timer = 0;
    this.target = -1;
    this.skip = new Map(); // slot -> time until which the slot is ignored (unreachable)
    this.retryAt = 0;
    this.stuck = 0;
    this.lastX = x;
    this.lastZ = z;
  }
}

// ---------------------------------------------------------------------------
// Game server
// ---------------------------------------------------------------------------

class GameServer {
  constructor(io) {
    this.io = io;
    this.grid = new L.PyramidGrid();
    this.field = new L.HeightField();
    this.paths = new L.PathFinder(this.field);
    this.players = new Map();
    this.byToken = new Map();
    this.pets = new Map();
    this.pile = [];
    this.reservations = new Map(); // slot -> pet id
    this.chatLog = [];
    this.profiles = Object.create(null);
    this.nextPlayerId = 1;
    this.nextPetId = 1;
    this.nextBlockId = 1;
    this.completed = 0;
    this.resetAt = 0;
    this.pileDirty = false;
    this.boardDirty = false;
    this.lastBoardAt = 0;
    this.pileTimer = 0;
    this.pathBudget = 0;
    this.frontLayer = 0;
    this.worldDirty = false;
    this.profilesDirty = false;
    this.saving = false;
    this.startedAt = now();
    this.lastTick = now();

    this.load();
    while (this.pile.length < PILE.initialStock) this.pile.push(this.nextBlockId++);
    this.frontLayer = this.grid.frontLayer();

    io.on('connection', (socket) => this.onConnection(socket));
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
    this.saveHandle = setInterval(() => this.save(), SAVE_INTERVAL_MS);
  }

  // ----- persistence -------------------------------------------------------

  load() {
    try {
      const world = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'world.json'), 'utf8'));
      this.grid.load(world.pyramid);
      this.field.rebuild(this.grid);
      this.completed = Math.max(0, world.completed | 0);
      let maxId = 0;
      for (const id of this.grid.slots) if (id > maxId) maxId = id;
      this.nextBlockId = Math.max(maxId + 1, world.nextBlockId | 0, 1);
      const stock = L.clamp(world.pile | 0, 0, PILE.maxStock);
      for (let i = 0; i < stock; i++) this.pile.push(this.nextBlockId++);
      log(`Loaded world: ${this.grid.placed}/${this.grid.total} blocks placed, ${this.completed} pyramids completed.`);
    } catch (err) {
      if (err.code !== 'ENOENT') log('Could not read world.json, starting a fresh world:', err.message);
    }
    try {
      const profiles = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'profiles.json'), 'utf8'));
      if (profiles && typeof profiles === 'object') {
        for (const key of Object.keys(profiles)) {
          if (/^[a-f0-9]{64}$/.test(key)) this.profiles[key] = L.normalizeProfile(profiles[key]);
        }
      }
      log(`Loaded ${Object.keys(this.profiles).length} player profiles.`);
    } catch (err) {
      if (err.code !== 'ENOENT') log('Could not read profiles.json:', err.message);
    }
  }

  snapshotProfiles() {
    for (const p of this.players.values()) this.profiles[p.tokenHash] = p.stats;
  }

  worldData() {
    return {
      version: CONFIG.version,
      completed: this.completed,
      nextBlockId: this.nextBlockId,
      pile: this.pile.length,
      pyramid: this.grid.toArray(),
      savedAt: new Date().toISOString(),
    };
  }

  async save(force = false) {
    if (this.saving) return;
    if (!force && !this.worldDirty && !this.profilesDirty && this.players.size === 0) return;
    this.saving = true;
    try {
      this.snapshotProfiles();
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await writeAtomic(path.join(DATA_DIR, 'world.json'), JSON.stringify(this.worldData()));
      await writeAtomic(path.join(DATA_DIR, 'profiles.json'), JSON.stringify(this.profiles));
      this.worldDirty = false;
      this.profilesDirty = false;
    } catch (err) {
      log('Save failed:', err.message);
    } finally {
      this.saving = false;
    }
  }

  saveSync() {
    try {
      this.snapshotProfiles();
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'world.json'), JSON.stringify(this.worldData()));
      fs.writeFileSync(path.join(DATA_DIR, 'profiles.json'), JSON.stringify(this.profiles));
    } catch (err) {
      log('Final save failed:', err.message);
    }
  }

  // ----- views -------------------------------------------------------------

  publicPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      x: round2(p.x),
      y: round2(p.y),
      z: round2(p.z),
      ry: round2(p.ry),
      carry: p.carry.slice(),
      placed: p.stats.placed,
    };
  }

  publicPet(pet) {
    const owner = this.players.get(pet.owner);
    return {
      id: pet.id,
      owner: pet.owner,
      ownerName: owner ? owner.name : '',
      ownerColor: owner ? owner.color : '#ffffff',
      species: pet.species,
      x: round2(pet.x),
      y: round2(pet.y),
      z: round2(pet.z),
      ry: round2(pet.ry),
      carry: pet.carry.slice(),
    };
  }

  selfView(p) {
    const s = p.stats;
    const view = {
      gold: s.gold,
      strength: round2(s.strength),
      speed: round2(s.speed),
      capacity: L.carryCapacity(s),
      moveSpeed: round2(L.moveSpeed(s)),
      trainMult: L.trainingMultiplier(s),
      placed: s.placed,
      upgrades: Object.assign({}, s.upgrades),
      carry: p.carry.length,
      pets: [...p.petIds].map((id) => {
        const pet = this.pets.get(id);
        return { id, species: pet.species, refund: L.petRefund(pet.species) };
      }),
    };
    if (p.shopDirty) {
      view.shop = L.shopView(s);
      p.shopDirty = false;
    }
    return view;
  }

  boardView() {
    return [...this.players.values()]
      .sort((a, b) => b.stats.placed - a.stats.placed)
      .slice(0, 12)
      .map((p) => [p.id, p.name, p.color, p.stats.placed, p.petIds.size]);
  }

  fullState() {
    return {
      players: [...this.players.values()].map((p) => this.publicPlayer(p)),
      pets: [...this.pets.values()].map((pet) => this.publicPet(pet)),
      pyramid: this.grid.toArray(),
      pile: this.pile.length,
      completed: this.completed,
      resetIn: this.resetAt ? Math.max(0, (this.resetAt - now()) / 1000) : 0,
      chat: this.chatLog.slice(-30),
      board: this.boardView(),
    };
  }

  // ----- connection handling ----------------------------------------------

  onConnection(socket) {
    // Token bucket rate limiter: drops events from clients that flood the server.
    const bucket = { tokens: 60, at: now() };
    socket.use((packet, next) => {
      const t = now();
      bucket.tokens = Math.min(60, bucket.tokens + ((t - bucket.at) / 1000) * 45);
      bucket.at = t;
      if (bucket.tokens < 1) return;
      bucket.tokens -= 1;
      next();
    });

    socket.on('join', (data, ack) => this.onJoin(socket, data, ack));
    socket.on('tping', (_t, ack) => {
      if (typeof ack === 'function') ack(now());
    });
    socket.on('m', (data) => this.withPlayer(socket, (p) => this.onMove(p, data)));
    socket.on('pickup', (_d, ack) => this.withPlayer(socket, (p) => this.onPickup(p, ack), ack));
    socket.on('place', (data, ack) => this.withPlayer(socket, (p) => this.onPlace(p, data, ack), ack));
    socket.on('train', (_d, ack) => this.withPlayer(socket, (p) => this.onTrain(p, ack), ack));
    socket.on('buy', (data, ack) => this.withPlayer(socket, (p) => this.onBuy(p, data, ack), ack));
    socket.on('release', (data, ack) => this.withPlayer(socket, (p) => this.onRelease(p, data, ack), ack));
    socket.on('chat', (text) => this.withPlayer(socket, (p) => this.onChat(p, text)));
    socket.on('disconnect', () => {
      const p = socket.data.player;
      if (p && this.players.get(p.id) === p) this.removePlayer(p, 'left the dig site');
    });
  }

  withPlayer(socket, fn, ack) {
    const p = socket.data.player;
    if (!p || this.players.get(p.id) !== p) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'Not joined.' });
      return;
    }
    try {
      fn(p);
    } catch (err) {
      log('Handler error:', err && err.stack ? err.stack : err);
      if (typeof ack === 'function') ack({ ok: false, reason: 'Server error.' });
    }
  }

  onJoin(socket, data, ack) {
    if (typeof ack !== 'function') return;
    if (socket.data.player) return ack({ ok: false, reason: 'Already joined.' });
    if (!data || typeof data !== 'object' || !L.isToken(data.token)) {
      return ack({ ok: false, reason: 'Invalid profile token.' });
    }
    const tokenHash = crypto.createHash('sha256').update(data.token).digest('hex');
    const existing = this.byToken.get(tokenHash);
    if (existing) {
      existing.socket.emit('kicked', { reason: 'You signed in from another window.' });
      this.removePlayer(existing, 'reconnected');
      existing.socket.data.player = null;
      existing.socket.disconnect(true);
    }
    if (this.players.size >= CONFIG.maxPlayers) return ack({ ok: false, reason: 'The server is full.' });

    const stats = L.normalizeProfile(this.profiles[tokenHash]);
    const id = this.nextPlayerId++;
    stats.name = L.sanitizeName(data.name) || (this.profiles[tokenHash] ? stats.name : `Builder${id}`);
    stats.color = L.sanitizeColor(data.color);

    const spawn = this.randomSpawn();
    const p = new Player(id, socket, tokenHash, stats, spawn.x, spawn.y, spawn.z);
    this.players.set(id, p);
    this.byToken.set(tokenHash, p);
    socket.data.player = p;

    const spawnedPets = [];
    for (const species of stats.pets) {
      if (this.pets.size >= CONFIG.pet.maxGlobal) break;
      spawnedPets.push(this.spawnPet(p, species, false));
    }
    // Pets that could not be spawned because of the global cap stay in the profile only.

    ack({
      ok: true,
      id,
      serverTime: now(),
      config: L.publicConfig(),
      state: this.fullState(),
      self: this.selfView(p),
    });
    socket.broadcast.emit('pj', this.publicPlayer(p));
    for (const pet of spawnedPets) socket.broadcast.emit('qs', this.publicPet(pet));
    this.boardDirty = true;
    this.profilesDirty = true;
    this.systemChat(`${p.name} joined the dig site.`);
    log(`+ ${p.name} (#${id}) joined from ${socket.handshake.address}. Players online: ${this.players.size}`);
  }

  randomSpawn() {
    const z = ZONES.spawn;
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * z.r;
      const x = z.x + Math.cos(a) * r;
      const zz = z.z + Math.sin(a) * r;
      const h = this.field.heightAt(x, zz);
      if (h < L.BLOCKED) return { x, y: h, z: zz };
    }
    return { x: z.x, y: 0, z: z.z };
  }

  removePlayer(p, reason) {
    if (this.players.get(p.id) !== p) return;
    for (const petId of [...p.petIds]) this.despawnPet(this.pets.get(petId));
    this.returnToPile(p.carry);
    p.carry = [];
    this.profiles[p.tokenHash] = p.stats;
    this.players.delete(p.id);
    if (this.byToken.get(p.tokenHash) === p) this.byToken.delete(p.tokenHash);
    this.io.emit('pl', { id: p.id });
    this.boardDirty = true;
    this.profilesDirty = true;
    this.systemChat(`${p.name} ${reason}.`);
    log(`- ${p.name} (#${p.id}) ${reason}. Players online: ${this.players.size}`);
  }

  returnToPile(blocks) {
    for (const id of blocks) {
      if (this.pile.length < PILE.maxStock) this.pile.push(id);
    }
    if (blocks.length) this.pileDirty = true;
  }

  correct(p) {
    p.cid++;
    p.socket.emit('correction', { x: round2(p.x), y: round2(p.y), z: round2(p.z), cid: p.cid });
  }

  // ----- player actions -----------------------------------------------------

  onMove(p, data) {
    if (!Array.isArray(data) || data.length < 6) return;
    const [x, y, z, ry, anim, cid] = data;
    if (!L.finite(x, y, z, ry, anim, cid)) return;
    if (cid !== p.cid) return; // stale move sent before the client applied a correction

    const t = now();
    const dt = L.clamp((t - p.lastMoveAt) / 1000, 0.016, 1);
    p.lastMoveAt = t;

    const half = CONFIG.worldHalf;
    const nx = L.clamp(x, -half, half);
    const nz = L.clamp(z, -half, half);
    const maxSpeed = L.moveSpeed(p.stats);
    const allowed = maxSpeed * dt * 1.5 + 0.6;
    const dist = Math.hypot(nx - p.x, nz - p.z);
    if (dist > allowed) return this.correct(p);

    const step = CONFIG.player.stepHeight;
    const ground = this.field.heightAt(nx, nz);
    if (ground >= L.BLOCKED) return this.correct(p);
    if (ground > p.y + step + 0.35) return this.correct(p); // walked into a wall taller than a step
    const maxRise = CONFIG.player.jumpVelocity * dt + step + 0.3;
    let ny = Math.max(y, ground);
    if (ny - p.y > maxRise) ny = p.y + maxRise;

    p.x = nx;
    p.y = ny;
    p.z = nz;
    p.ry = ry;
    p.anim = L.clamp(anim | 0, 0, ANIM_MAX);

    if (dist > 0.02 && L.inTrack(nx, nz) && ny - ground < 0.3) {
      p.trackDist += dist;
      if (p.trackDist >= 10) {
        const reps = Math.floor(p.trackDist / 10);
        p.trackDist -= reps * 10;
        const gain = L.trackGain(p.stats, reps * 10);
        p.stats.speed += gain;
        p.selfDirty = true;
        p.socket.emit('trained', { stat: 'speed', gain: round2(gain) });
      }
    }
  }

  onPickup(p, ack) {
    const reply = typeof ack === 'function' ? ack : () => {};
    const t = now();
    if (t - p.lastPickupAt < 200) return reply({ ok: false, silent: true, reason: 'cooldown' });
    if (L.distanceToPile(p.x, p.z) > PILE.range + 0.5) return reply({ ok: false, reason: 'Get closer to the quarry pile.' });
    const capacity = L.carryCapacity(p.stats);
    const room = capacity - p.carry.length;
    if (room <= 0) return reply({ ok: false, reason: 'Your arms are full. Train Strength or buy a harness to carry more.' });
    if (this.pile.length === 0) return reply({ ok: false, reason: 'The pile is empty. Quarry workers are cutting more stone.' });
    p.lastPickupAt = t;
    const take = Math.min(room, this.pile.length);
    const moved = this.pile.splice(this.pile.length - take, take);
    p.carry.push(...moved);
    p.anim = 5;
    p.selfDirty = true;
    this.pileDirty = true;
    this.io.emit('carry', { k: 'p', id: p.id, b: p.carry.slice() });
    reply({ ok: true, taken: take, carry: p.carry.length });
  }

  onPlace(p, data, ack) {
    const reply = typeof ack === 'function' ? ack : () => {};
    const slot = data && data.slot;
    const t = now();
    if (!this.grid.isValidIndex(slot)) return reply({ ok: false, reason: 'Invalid slot.' });
    if (p.carry.length === 0) return reply({ ok: false, reason: 'You are not carrying any blocks.' });
    if (t - p.lastPlaceAt < 120) return reply({ ok: false, silent: true, reason: 'cooldown' });
    if (this.resetAt) return reply({ ok: false, reason: 'The pyramid is being consecrated. Hold on!' });
    if (this.grid.isPlaced(slot)) return reply({ ok: false, reason: 'Someone already set a block there.' });
    if (!this.grid.isSupported(slot)) return reply({ ok: false, reason: 'That block would have nothing to rest on.' });
    const pc = CONFIG.player;
    if (!L.canReachSlot(this.grid, slot, p.x, p.y, p.z, pc.handHeight, pc.reach + 0.5)) {
      return reply({ ok: false, reason: 'Too far away to set that block.' });
    }
    p.lastPlaceAt = t;
    p.anim = 4;
    const blockId = p.carry.pop();
    const reward = this.commitPlacement(slot, blockId, 'p', p.id, p, p.carry);
    reply({ ok: true, reward, carry: p.carry.length });
  }

  commitPlacement(slot, blockId, kind, carrierId, owner, carrierBlocks) {
    this.grid.place(slot, blockId);
    this.field.applyBlock(this.grid.box(slot));
    this.reservations.delete(slot);
    const layer = this.grid.layerOf[slot];
    const reward = L.blockReward(layer, owner.stats.upgrades.favor);
    const share = L.tribute(layer);
    owner.stats.gold += reward;
    owner.stats.placed += 1;
    owner.selfDirty = true;
    for (const other of this.players.values()) {
      if (other === owner) continue;
      other.stats.gold += share;
      other.selfDirty = true;
    }
    this.io.emit('placed', { s: slot, b: blockId, k: kind, id: carrierId, o: owner.id, r: reward, t: share });
    this.io.emit('carry', { k: kind, id: carrierId, b: carrierBlocks.slice() });
    this.boardDirty = true;
    this.worldDirty = true;
    this.profilesDirty = true;

    const front = this.grid.frontLayer();
    if (front > this.frontLayer && front < this.grid.layers) {
      this.systemChat(`Layer ${front} of ${this.grid.layers} is complete! The pyramid rises.`);
    }
    this.frontLayer = front;
    if (this.grid.isComplete()) this.onComplete();
    return reward;
  }

  onComplete() {
    this.completed++;
    this.resetAt = now() + CONFIG.economy.resetDelay * 1000;
    const bonus = CONFIG.economy.completionBonus + CONFIG.economy.completionBonusPerPyramid * (this.completed - 1);
    for (const p of this.players.values()) {
      p.stats.gold += bonus;
      p.selfDirty = true;
    }
    this.reservations.clear();
    for (const pet of this.pets.values()) {
      pet.target = -1;
      pet.path = null;
    }
    this.io.emit('complete', { n: this.completed, bonus, resetIn: CONFIG.economy.resetDelay });
    this.systemChat(`The great pyramid #${this.completed} is complete! Every builder receives ${bonus} gold.`);
    log(`Pyramid #${this.completed} completed.`);
  }

  resetPyramid() {
    this.resetAt = 0;
    this.grid.reset();
    this.field.rebuild(this.grid);
    this.frontLayer = 0;
    this.worldDirty = true;
    this.io.emit('reset', { completed: this.completed });
    this.systemChat('The sands are cleared. A new pyramid begins!');
  }

  onTrain(p, ack) {
    const reply = typeof ack === 'function' ? ack : () => {};
    const t = now();
    const r = L.strengthRepGain(p.stats, p.x, p.z, t, p.lastRepAt);
    if (!r.ok) return reply({ ok: false, reason: r.reason, silent: !!r.silent });
    p.lastRepAt = t;
    p.stats.strength += r.gain;
    p.anim = 3;
    p.selfDirty = true;
    reply({ ok: true, gain: r.gain, strength: round2(p.stats.strength), capacity: L.carryCapacity(p.stats) });
  }

  onBuy(p, data, ack) {
    const reply = typeof ack === 'function' ? ack : () => {};
    const item = data && data.item;
    const r = L.validatePurchase(p.stats, item, this.pets.size);
    if (!r.ok) return reply(r);
    L.applyPurchase(p.stats, item, r);
    if (r.kind === 'pet') {
      p.stats.pets.push(item);
      const pet = this.spawnPet(p, item, true);
      this.systemChat(`${p.name} adopted a ${PETS[item].name}!`);
      reply({ ok: true, kind: 'pet', item, pet: pet.id, gold: p.stats.gold });
    } else {
      reply({ ok: true, kind: 'upgrade', item, level: p.stats.upgrades[item], gold: p.stats.gold });
    }
    p.selfDirty = true;
    p.shopDirty = true;
    this.profilesDirty = true;
  }

  onRelease(p, data, ack) {
    const reply = typeof ack === 'function' ? ack : () => {};
    const pet = data && this.pets.get(data.pet);
    if (!pet || pet.owner !== p.id) return reply({ ok: false, reason: 'That pet is not yours.' });
    const refund = L.petRefund(pet.species);
    p.stats.gold += refund;
    const i = p.stats.pets.indexOf(pet.species);
    if (i >= 0) p.stats.pets.splice(i, 1);
    this.despawnPet(pet);
    p.selfDirty = true;
    p.shopDirty = true;
    this.profilesDirty = true;
    reply({ ok: true, refund, gold: p.stats.gold });
  }

  onChat(p, text) {
    const clean = L.sanitizeChat(text);
    if (!clean) return;
    const t = now();
    p.chatTimes = p.chatTimes.filter((ts) => t - ts < 5000);
    if (p.chatTimes.length >= 4) {
      p.socket.emit('chat', { sys: true, t: 'You are sending messages too quickly.', ts: t });
      return;
    }
    p.chatTimes.push(t);
    this.pushChat({ n: p.name, c: p.color, t: clean, ts: t });
  }

  systemChat(text) {
    this.pushChat({ sys: true, t: text, ts: now() });
  }

  pushChat(msg) {
    this.chatLog.push(msg);
    if (this.chatLog.length > 40) this.chatLog.shift();
    this.io.emit('chat', msg);
  }

  // ----- pets ---------------------------------------------------------------

  spawnPet(owner, species, announce) {
    let x = owner.x;
    let z = owner.z;
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const tx = owner.x + Math.cos(a) * 2;
      const tz = owner.z + Math.sin(a) * 2;
      const h = this.field.heightAt(tx, tz);
      if (h < L.BLOCKED && Math.abs(h - owner.y) <= CONFIG.player.stepHeight) {
        x = tx;
        z = tz;
        break;
      }
    }
    const pet = new Pet(this.nextPetId++, owner.id, species, x, this.field.heightAt(x, z), z);
    if (pet.y >= L.BLOCKED) pet.y = owner.y;
    this.pets.set(pet.id, pet);
    owner.petIds.add(pet.id);
    owner.selfDirty = true;
    this.boardDirty = true;
    if (announce) this.io.emit('qs', this.publicPet(pet));
    return pet;
  }

  despawnPet(pet) {
    if (!pet) return;
    this.releaseReservation(pet);
    this.returnToPile(pet.carry);
    pet.carry = [];
    this.pets.delete(pet.id);
    const owner = this.players.get(pet.owner);
    if (owner) {
      owner.petIds.delete(pet.id);
      owner.selfDirty = true;
    }
    this.boardDirty = true;
    this.io.emit('qr', { id: pet.id });
  }

  releaseReservation(pet) {
    if (pet.target >= 0 && this.reservations.get(pet.target) === pet.id) this.reservations.delete(pet.target);
    pet.target = -1;
  }

  planPath(pet, isGoal, heuristic) {
    if (this.pathBudget <= 0) return 'deferred';
    this.pathBudget--;
    const path = this.paths.find(pet.x, pet.z, isGoal, heuristic, 15000);
    if (!path) return null;
    pet.path = path;
    pet.pathIdx = 1; // the first waypoint is the pet's own cell
    return path;
  }

  planToPile(pet) {
    const f = this.field;
    const range = PILE.range - 0.4;
    return this.planPath(
      pet,
      (c) => L.distanceToPile(f.cellCenterX(c), f.cellCenterZ(c)) <= range,
      (c) => Math.max(0, L.distanceToPile(f.cellCenterX(c), f.cellCenterZ(c)) - range),
    );
  }

  planToSlot(pet, slot) {
    const f = this.field;
    const b = this.grid.box(slot);
    const reach = CONFIG.pet.reach - 0.25;
    const hand = CONFIG.pet.handHeight;
    return this.planPath(
      pet,
      (c) => {
        if (L.cellInBox(f, c, b)) return false;
        return L.aabbDistance(f.cellCenterX(c), f.h[c] + hand, f.cellCenterZ(c), b) <= reach;
      },
      (c) => Math.max(0, L.rectDistanceXZ(f.cellCenterX(c), f.cellCenterZ(c), b.x0, b.z0, b.x1, b.z1) - reach),
    );
  }

  chooseTarget(pet, t) {
    const g = this.grid;
    const maxLayer = this.frontLayer + 1;
    let best = -1;
    let bestScore = Infinity;
    for (let idx = 0; idx < g.total; idx++) {
      const k = g.layerOf[idx];
      if (k > maxLayer) break; // slots are ordered by layer
      if (g.slots[idx] !== 0 || !g.isSupported(idx)) continue;
      const owner = this.reservations.get(idx);
      if (owner !== undefined && owner !== pet.id) continue;
      const until = pet.skip.get(idx);
      if (until !== undefined) {
        if (until > t) continue;
        pet.skip.delete(idx);
      }
      const dx = g.cxs[idx] - pet.x;
      const dz = g.czs[idx] - pet.z;
      const score = Math.sqrt(dx * dx + dz * dz) + k * 6;
      if (score < bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    if (best >= 0) {
      this.releaseReservation(pet);
      pet.target = best;
      this.reservations.set(best, pet.id);
    }
    return best;
  }

  petCanReach(pet, slot) {
    return L.canReachSlot(this.grid, slot, pet.x, pet.y, pet.z, CONFIG.pet.handHeight, CONFIG.pet.reach);
  }

  followPath(pet, dt, speed) {
    if (!pet.path || pet.pathIdx >= pet.path.length) return true;
    const wp = pet.path[pet.pathIdx];
    const dx = wp.x - pet.x;
    const dz = wp.z - pet.z;
    const dist = Math.hypot(dx, dz);
    const step = speed * dt;
    let nx;
    let nz;
    if (dist <= step) {
      nx = wp.x;
      nz = wp.z;
      pet.pathIdx++;
    } else {
      nx = pet.x + (dx / dist) * step;
      nz = pet.z + (dz / dist) * step;
    }
    const ground = this.field.heightAt(nx, nz);
    if (ground >= L.BLOCKED || ground > pet.y + CONFIG.player.stepHeight + 0.05) {
      pet.path = null; // the world changed under the path (a block was set); re-plan
      return false;
    }
    if (dist > 1e-4) {
      const targetRy = Math.atan2(dx, dz);
      let d = targetRy - pet.ry;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      pet.ry += d * Math.min(1, dt * 10);
      pet.ry = Math.atan2(Math.sin(pet.ry), Math.cos(pet.ry));
    }
    pet.x = nx;
    pet.z = nz;
    return pet.pathIdx >= pet.path.length;
  }

  updatePetHeight(pet, dt) {
    const ground = this.field.heightAt(pet.x, pet.z);
    if (ground >= L.BLOCKED) return;
    if (ground > pet.y) pet.y = Math.min(ground, pet.y + 9 * dt);
    else if (ground < pet.y) pet.y = Math.max(ground, pet.y - 14 * dt);
  }

  updatePet(pet, dt, t) {
    const owner = this.players.get(pet.owner);
    if (!owner) return this.despawnPet(pet);
    const spec = PETS[pet.species];
    const speed = spec.speed * L.loadFactor(pet.carry.length, spec.capacity);
    pet.code = PET_IDLE;

    switch (pet.state) {
      case 'toPile': {
        if (pet.carry.length >= spec.capacity) {
          pet.state = 'toPyramid';
          pet.path = null;
          break;
        }
        if (L.distanceToPile(pet.x, pet.z) <= PILE.range) {
          pet.state = 'loading';
          pet.timer = spec.loadTime;
          pet.path = null;
          break;
        }
        if (!pet.path) {
          if (t < pet.retryAt) break;
          const res = this.planToPile(pet);
          if (res === 'deferred') break;
          if (!res) {
            pet.retryAt = t + 1500;
            break;
          }
        }
        pet.code = PET_MOVING;
        if (this.followPath(pet, dt, speed) && pet.path) {
          pet.path = null;
          if (L.distanceToPile(pet.x, pet.z) <= PILE.range) {
            pet.state = 'loading';
            pet.timer = spec.loadTime;
          }
        }
        break;
      }
      case 'loading': {
        pet.code = PET_LOADING;
        pet.timer -= dt;
        if (pet.timer > 0) break;
        const room = spec.capacity - pet.carry.length;
        if (room > 0 && this.pile.length > 0) {
          const take = Math.min(room, this.pile.length);
          pet.carry.push(...this.pile.splice(this.pile.length - take, take));
          this.pileDirty = true;
          this.io.emit('carry', { k: 'q', id: pet.id, b: pet.carry.slice() });
        }
        if (pet.carry.length >= spec.capacity || (pet.carry.length > 0 && this.pile.length === 0)) {
          pet.state = 'toPyramid';
          pet.path = null;
        } else {
          pet.timer = 0.5; // wait for the quarry to restock
          pet.code = PET_IDLE;
        }
        break;
      }
      case 'toPyramid': {
        if (pet.carry.length === 0) {
          this.releaseReservation(pet);
          pet.state = 'toPile';
          pet.path = null;
          break;
        }
        if (this.resetAt) break;
        const targetValid =
          pet.target >= 0 && this.grid.canPlace(pet.target) && this.reservations.get(pet.target) === pet.id;
        if (!targetValid) {
          pet.path = null;
          if (t < pet.retryAt) break;
          if (this.chooseTarget(pet, t) < 0) {
            pet.retryAt = t + 1000;
            break;
          }
        }
        if (this.petCanReach(pet, pet.target)) {
          pet.state = 'placing';
          pet.timer = 0.55;
          pet.path = null;
          break;
        }
        if (!pet.path) {
          const res = this.planToSlot(pet, pet.target);
          if (res === 'deferred') break;
          if (!res) {
            pet.skip.set(pet.target, t + 15000);
            this.releaseReservation(pet);
            break;
          }
        }
        pet.code = PET_MOVING;
        if (this.followPath(pet, dt, speed) && pet.path) {
          pet.path = null;
          if (this.petCanReach(pet, pet.target)) {
            pet.state = 'placing';
            pet.timer = 0.55;
          }
        }
        break;
      }
      case 'placing': {
        pet.code = PET_PLACING;
        pet.timer -= dt;
        if (pet.timer > 0) break;
        const slot = pet.target;
        if (slot >= 0 && pet.carry.length > 0 && this.grid.canPlace(slot) && this.petCanReach(pet, slot)) {
          const blockId = pet.carry.pop();
          this.releaseReservation(pet);
          this.commitPlacement(slot, blockId, 'q', pet.id, owner, pet.carry);
        } else {
          this.releaseReservation(pet);
        }
        pet.state = pet.carry.length > 0 ? 'toPyramid' : 'toPile';
        pet.path = null;
        break;
      }
      default:
        pet.state = 'toPile';
    }

    this.updatePetHeight(pet, dt);

    // Stuck detection: a moving pet that makes no progress re-plans, then gets rescued.
    if (pet.code === PET_MOVING) {
      const moved = Math.hypot(pet.x - pet.lastX, pet.z - pet.lastZ);
      pet.stuck = moved < speed * dt * 0.2 ? pet.stuck + dt : Math.max(0, pet.stuck - dt);
    } else {
      pet.stuck = Math.max(0, pet.stuck - dt);
    }
    pet.lastX = pet.x;
    pet.lastZ = pet.z;
    if (pet.stuck > 4) pet.path = null;
    if (pet.stuck > 10) {
      pet.stuck = 0;
      pet.x = owner.x;
      pet.z = owner.z;
      pet.y = owner.y;
      pet.path = null;
    }
  }

  // ----- main loop ----------------------------------------------------------

  tick() {
    const t = now();
    const dt = Math.min(0.25, (t - this.lastTick) / 1000);
    this.lastTick = t;

    if (this.resetAt && t >= this.resetAt) this.resetPyramid();

    // Quarry regeneration.
    this.pileTimer += dt;
    while (this.pileTimer >= PILE.regenSeconds) {
      this.pileTimer -= PILE.regenSeconds;
      if (this.pile.length < PILE.maxStock) {
        this.pile.push(this.nextBlockId++);
        this.pileDirty = true;
      }
    }

    this.pathBudget = 4;
    for (const pet of this.pets.values()) this.updatePet(pet, dt, t);

    if (this.players.size > 0) {
      const p = [];
      for (const pl of this.players.values()) {
        p.push([pl.id, round2(pl.x), round2(pl.y), round2(pl.z), round2(pl.ry), pl.anim, pl.carry.length]);
      }
      const q = [];
      for (const pet of this.pets.values()) {
        q.push([pet.id, round2(pet.x), round2(pet.y), round2(pet.z), round2(pet.ry), pet.code, pet.carry.length]);
      }
      this.io.volatile.emit('s', { t, p, q });
    }

    if (this.pileDirty) {
      this.pileDirty = false;
      this.io.emit('pile', this.pile.length);
      this.worldDirty = true;
    }
    if (this.boardDirty && t - this.lastBoardAt > 1000) {
      this.boardDirty = false;
      this.lastBoardAt = t;
      this.io.emit('board', this.boardView());
    }
    for (const pl of this.players.values()) {
      if (pl.selfDirty) {
        pl.selfDirty = false;
        pl.socket.emit('self', this.selfView(pl));
      }
    }
  }

  stats() {
    return {
      status: 'ok',
      uptime: Math.round((now() - this.startedAt) / 1000),
      players: this.players.size,
      maxPlayers: CONFIG.maxPlayers,
      pets: this.pets.size,
      placed: this.grid.placed,
      total: this.grid.total,
      completed: this.completed,
      pile: this.pile.length,
    };
  }

  shutdown() {
    clearInterval(this.tickHandle);
    clearInterval(this.saveHandle);
    this.saveSync();
  }
}

async function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, contents);
  await fs.promises.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// HTTP + Socket.io bootstrap
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 32 * 1024,
  pingInterval: 10000,
  pingTimeout: 12000,
  perMessageDeflate: false,
  serveClient: false,
});
const game = new GameServer(io);

app.get('/health', (_req, res) => res.json(game.stats()));

// Optional: serve the web build of the client so the game can also be opened in a browser.
const clientDir = path.resolve(__dirname, '..', 'client');
if (SERVE_WEB_CLIENT && fs.existsSync(path.join(clientDir, 'src', 'index.html'))) {
  const modules = path.join(clientDir, 'node_modules');
  app.use('/node_modules/three', express.static(path.join(modules, 'three'), { fallthrough: false }));
  app.use(
    '/node_modules/socket.io-client/dist',
    express.static(path.join(modules, 'socket.io-client', 'dist'), { fallthrough: false }),
  );
  app.use(express.static(path.join(clientDir, 'src')));
}

httpServer.listen(PORT, HOST, () => {
  log(`Dunebound server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) log(`  LAN players can connect to http://${a.address}:${PORT}`);
    }
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, saving world and shutting down.`);
  game.shutdown();
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, io, game };
