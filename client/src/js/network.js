/**
 * Dunebound - Socket.io client.
 *
 * Connects to the authoritative server over WebSocket, performs the join
 * handshake, keeps a server clock estimate, streams local movement at the
 * server tick rate and buffers snapshots so remote players and pets can be
 * rendered with ~110 ms of interpolation delay.
 */
import { io } from 'socket.io-client';

/** Network protocol version; must match the server's CONFIG.version (it rejects mismatches with a reason). */
export const PROTOCOL_VERSION = 2;

const RELAYED_EVENTS = [
  'pj', // player joined
  'pl', // player left
  'qs', // pet spawned
  'qr', // pet removed
  'carry', // a player or pet's carried blocks changed
  'placed', // a block was set into the pyramid
  'pile', // quarry pile stock
  'self', // private stats / gold / shop
  'chat',
  'board',
  'complete',
  'reset',
  'trained',
  'kicked',
];

export function normalizeServerUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) url = 'http://localhost:3000';
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/^ws(s?):\/\//i, 'http$1://');
  return url.replace(/\/+$/, '');
}

function shortestAngle(a, b, t) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}

export class NetworkClient {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.snapshots = [];
    this.offset = 0;
    this.offsetReady = false;
    this.rtt = 0;
    this.cid = 0;
    this.profile = null;
    this.url = '';
    this.joined = false;
    this.renderDelay = 110;
    this.pingTimer = null;
    this.lastSnapshotAt = 0;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }

  emitLocal(event, data) {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const fn of list) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[net] handler for "${event}" failed`, err);
      }
    }
  }

  get connected() {
    return !!(this.socket && this.socket.connected && this.joined);
  }

  /** Connects and joins. Resolves with the welcome payload; later reconnects emit 'welcome'. */
  connect(url, profile) {
    this.disconnect();
    this.url = normalizeServerUrl(url);
    this.profile = profile;
    const socket = io(this.url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
      timeout: 6000,
    });
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.disconnect();
        reject(err);
      };
      socket.on('connect', async () => {
        try {
          const welcome = await this.join();
          if (!settled) {
            settled = true;
            resolve(welcome);
          } else {
            this.emitLocal('welcome', welcome);
          }
        } catch (err) {
          if (!settled) fail(err);
          else this.emitLocal('fatal', err.message);
        }
      });
      socket.on('connect_error', (err) => {
        if (!settled) fail(new Error(`Could not reach ${this.url} (${err.message}).`));
      });
      socket.on('disconnect', (reason) => {
        this.joined = false;
        if (settled) this.emitLocal('disconnected', reason);
      });
      socket.io.on('reconnect_attempt', (n) => this.emitLocal('reconnecting', n));
      socket.on('correction', (c) => {
        if (c && Number.isFinite(c.cid)) this.cid = c.cid;
        this.emitLocal('correction', c);
      });
      socket.on('s', (snap) => this.pushSnapshot(snap));
      for (const ev of RELAYED_EVENTS) socket.on(ev, (data) => this.emitLocal(ev, data));
    });
  }

  async join() {
    const welcome = await this.request('join', { ...this.profile, protocol: PROTOCOL_VERSION }, 6000);
    if (!welcome || !welcome.ok) throw new Error((welcome && welcome.reason) || 'The server refused to let you join.');
    this.joined = true;
    this.cid = 0;
    this.snapshots = [];
    this.offset = welcome.serverTime - Date.now();
    this.offsetReady = false;
    this.startPing();
    return welcome;
  }

  disconnect() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.joined = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.io.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  request(event, data, timeout = 4000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to the server.'));
        return;
      }
      this.socket.timeout(timeout).emit(event, data, (err, response) => {
        if (err) reject(new Error('The server did not respond in time.'));
        else resolve(response);
      });
    });
  }

  sendMove(state) {
    if (!this.connected) return;
    state.push(this.cid);
    this.socket.volatile.emit('m', state);
  }

  sendChat(text) {
    if (this.connected) this.socket.emit('chat', text);
  }

  startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.ping(), 2000);
    this.ping();
  }

  ping() {
    if (!this.socket || !this.socket.connected) return;
    const t0 = Date.now();
    this.socket.timeout(3000).emit('tping', t0, (err, serverTime) => {
      if (err || !Number.isFinite(serverTime)) return;
      const t1 = Date.now();
      const rtt = t1 - t0;
      this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
      const offset = serverTime + rtt / 2 - t1;
      this.offset = this.offsetReady ? this.offset * 0.85 + offset * 0.15 : offset;
      this.offsetReady = true;
    });
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  pushSnapshot(snap) {
    if (!snap || !Array.isArray(snap.p) || !Array.isArray(snap.q)) return;
    const players = new Map();
    for (const a of snap.p) players.set(a[0], a);
    const pets = new Map();
    for (const a of snap.q) pets.set(a[0], a);
    this.snapshots.push({ t: snap.t, players, pets });
    if (this.snapshots.length > 60) this.snapshots.shift();
    this.lastSnapshotAt = performance.now();
  }

  /**
   * Interpolated entity states at (server time - render delay):
   * { players: Map<id, state>, pets: Map<id, state> } where state is
   * { x, y, z, ry, anim, carry, speed }.
   */
  sample() {
    const out = { players: new Map(), pets: new Map() };
    const snaps = this.snapshots;
    if (snaps.length === 0) return out;
    const rt = this.serverNow() - this.renderDelay;
    let a = snaps[0];
    let b = snaps[0];
    if (rt <= snaps[0].t) {
      a = b = snaps[0];
    } else if (rt >= snaps[snaps.length - 1].t) {
      a = snaps[Math.max(0, snaps.length - 2)];
      b = snaps[snaps.length - 1];
    } else {
      for (let i = snaps.length - 2; i >= 0; i--) {
        if (snaps[i].t <= rt) {
          a = snaps[i];
          b = snaps[i + 1];
          break;
        }
      }
    }
    const span = Math.max(1, b.t - a.t);
    const alpha = a === b ? 1 : Math.min(1.25, Math.max(0, (rt - a.t) / span));
    this._blend(a.players, b.players, alpha, span, out.players);
    this._blend(a.pets, b.pets, alpha, span, out.pets);
    return out;
  }

  _blend(ma, mb, alpha, span, out) {
    for (const [id, eb] of mb) {
      const ea = ma.get(id);
      if (!ea) {
        out.set(id, { x: eb[1], y: eb[2], z: eb[3], ry: eb[4], anim: eb[5], carry: eb[6], speed: 0 });
        continue;
      }
      const dx = eb[1] - ea[1];
      const dz = eb[3] - ea[3];
      out.set(id, {
        x: ea[1] + dx * alpha,
        y: ea[2] + (eb[2] - ea[2]) * alpha,
        z: ea[3] + dz * alpha,
        ry: shortestAngle(ea[4], eb[4], Math.min(1, alpha)),
        anim: eb[5],
        carry: eb[6],
        speed: (Math.hypot(dx, dz) / span) * 1000,
      });
    }
  }
}
