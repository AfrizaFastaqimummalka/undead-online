// lobby.js — satu lobby bersama (maks MAX_PLAYERS online), 3 portal dengan antrean masing-masing.
import { LOBBY_RADIUS, LOBBY_WALK_RADIUS, LOBBY_SPAWN, PORTAL_RADIUS, PORTALS, ROOM_SIZE, PORTAL_COUNTDOWN, MAX_PLAYERS } from './config.js';

const r2 = v => Math.round(v * 100) / 100;
const num = (v, lo, hi, def = 0) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

export class Lobby {
  /** @param {(members:Array<{socket,user}>)=>void} startRoom */
  constructor(io, startRoom, getOnline) {
    this.io = io;
    this.startRoom = startRoom;
    this.getOnline = getOnline;
    this.players = new Map();   // socket.id -> lp
    this.nextId = 1;
    this.portals = PORTALS.map(() => ({ members: new Set(), countdown: 0 }));
    this.accum = 0;
  }

  initPayload(sid) {
    const lp = this.players.get(sid);
    return {
      id: lp.id,
      spawn: { x: r2(lp.x), y: 1.7, z: r2(lp.z) },
      radius: LOBBY_RADIUS, walkRadius: LOBBY_WALK_RADIUS,
      portalRadius: PORTAL_RADIUS, roomSize: ROOM_SIZE, maxPlayers: MAX_PLAYERS,
      portals: PORTALS,
    };
  }

  add(socket, user) {
    const lp = {
      id: this.nextId++, socket, user, name: user.username,
      x: LOBBY_SPAWN.x + (Math.random() - 0.5) * 6, y: 1.7, z: LOBBY_SPAWN.z + (Math.random() - 0.5) * 3,
      yaw: 0, portal: null,
    };
    this.players.set(socket.id, lp);
    socket.join('lobby');
    return lp;
  }

  remove(sid) {
    const lp = this.players.get(sid); if (!lp) return;
    this.leavePortal(lp);
    this.players.delete(sid);
    lp.socket.leave('lobby');
  }

  onMove(sid, d) {
    const lp = this.players.get(sid); if (!lp) return;
    const now = performance.now();
    if (now - (lp.lastMoveAt || 0) < 30) return;      // batasi spam event gerak
    lp.lastMoveAt = now;
    let x = num(d.x, -60, 60, lp.x), z = num(d.z, -60, 60, lp.z);
    const len = Math.hypot(x, z), maxR = LOBBY_WALK_RADIUS + 1;
    if (len > maxR) { x = (x / len) * maxR; z = (z / len) * maxR; }
    lp.x = x; lp.z = z;
    lp.y = num(d.y, 0, 20, lp.y);
    lp.yaw = num(d.yaw, -100, 100, lp.yaw);
  }

  dist(lp, portalIdx) {
    const p = PORTALS[portalIdx];
    return Math.hypot(lp.x - p.x, lp.z - p.z);
  }

  portalJoin(sid, idx) {
    const lp = this.players.get(sid);
    if (!lp || !Number.isInteger(idx) || idx < 0 || idx >= PORTALS.length) return;
    if (lp.portal === idx) return;
    if (this.dist(lp, idx) > PORTAL_RADIUS + 1.5) return;     // harus benar-benar di zona portal
    this.leavePortal(lp);
    const q = this.portals[idx];
    q.members.add(sid); lp.portal = idx;
    if (q.members.size === 1) q.countdown = PORTAL_COUNTDOWN;
    if (q.members.size >= ROOM_SIZE) this.launch(idx);
  }

  portalLeave(sid) {
    const lp = this.players.get(sid);
    if (lp) this.leavePortal(lp);
  }

  leavePortal(lp) {
    if (lp.portal === null) return;
    const q = this.portals[lp.portal];
    q.members.delete(lp.socket.id);
    if (q.members.size === 0) q.countdown = 0;
    lp.portal = null;
  }

  launch(idx) {
    const q = this.portals[idx];
    const ids = [...q.members].slice(0, ROOM_SIZE);
    const members = [];
    for (const sid of ids) {
      const lp = this.players.get(sid);
      if (!lp) continue;
      members.push({ socket: lp.socket, user: lp.user });
    }
    for (const sid of ids) { const lp = this.players.get(sid); if (lp) { lp.portal = null; } }
    q.members.clear(); q.countdown = 0;
    for (const m of members) this.remove(m.socket.id);
    if (members.length > 0) this.startRoom(members);
  }

  tick(dt) {
    // validasi: pemain yang menjauh dari portal otomatis keluar antrean
    for (const lp of this.players.values()) {
      if (lp.portal !== null && this.dist(lp, lp.portal) > PORTAL_RADIUS + 3.5) this.leavePortal(lp);
    }
    for (let i = 0; i < this.portals.length; i++) {
      const q = this.portals[i];
      if (q.members.size === 0) continue;
      q.countdown -= dt;
      if (q.countdown <= 0) this.launch(i);
    }
    // broadcast 10 Hz
    this.accum += dt;
    if (this.accum < 0.1) return;
    this.accum = 0;
    if (this.players.size === 0) return;
    this.io.to('lobby').emit('lobby:state', {
      o: this.getOnline(),
      p: [...this.players.values()].map(p => ({ i: p.id, n: p.name, x: r2(p.x), y: r2(p.y), z: r2(p.z), r: r2(p.yaw), g: p.portal === null ? -1 : p.portal })),
      q: this.portals.map(q => [q.members.size, Math.max(0, Math.ceil(q.countdown))]),
    });
  }
}
