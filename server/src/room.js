// room.js — satu room survival (maks 3 pemain). Server = otoritas untuk zombie, wave, HP, skor, drop.
// Logika angka-angka disalin dari versi single-player (zombies.js / game.js).
import { SURVIVAL as S, WEAPONS } from './config.js';

const PI = Math.PI, PI2 = PI * 2;
const r2 = v => Math.round(v * 100) / 100;
const num = (v, lo, hi, def = 0) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

const TYPE_CODE = { normal: 0, tank: 1, boss: 2 };

export class Room {
  /**
   * @param {string} id
   * @param {Array<{socket, user}>} members
   * @param {{io, saveRun:(uid,run)=>Promise<any>, onEmpty:(room)=>void}} hooks
   */
  constructor(id, members, hooks) {
    this.id = id;
    this.hooks = hooks;
    this.io = hooks.io;
    this.players = new Map();     // socket.id -> player
    this.zombies = new Map();     // zid -> zombie
    this.drops = new Map();       // did -> drop
    this.nextZid = 1; this.nextDid = 1;

    this.wave = 0; this.wavesCleared = 0;
    this.waveActive = false; this.intermission = 0;
    this.regularCount = 0; this.waveCount = 0; this.spawnedRegular = 0; this.killed = 0;
    this.isBossWave = false; this.bossSpawned = false; this.bossTimer = 0; this.bossTier = 0;
    this.spawnTimer = 1;
    this.startDelay = 3;          // detik persiapan sebelum wave 1
    this.over = false;
    this.createdAt = Date.now();

    members.forEach((m, i) => {
      const ang = (i / members.length) * PI2;
      const p = {
        pid: i + 1, socket: m.socket, user: m.user, name: m.user.username,
        x: Math.cos(ang) * 2.5, y: 1.7, z: Math.sin(ang) * 2.5,
        yaw: 0, pitch: 0, weapon: 'rifle',
        hp: S.maxHp, alive: true, score: 0, kills: 0,
        lastShot: {}, lastMoveAt: 0, saved: false,
      };
      this.players.set(m.socket.id, p);
      m.socket.join(id);
    });
  }

  // ───────── info untuk klien ─────────
  startPayload(forSocketId) {
    const me = this.players.get(forSocketId);
    return {
      roomId: this.id,
      pid: me.pid,
      spawn: { x: r2(me.x), y: 1.7, z: r2(me.z) },
      players: [...this.players.values()].map(p => ({ pid: p.pid, name: p.name })),
      maxHp: S.maxHp,
    };
  }

  emit(event, payload) { this.io.to(this.id).emit(event, payload); }
  ev(k, extra = {}) { this.emit('room:ev', { k, ...extra }); }

  // ───────── input pemain ─────────
  onMove(sid, d) {
    const p = this.players.get(sid); if (!p) return;
    const now = performance.now();
    if (now - p.lastMoveAt < 15) return;
    p.lastMoveAt = now;
    if (!p.alive) return;     // yang mati tidak bergerak (spectator)
    p.x = num(d.x, -170, 170, p.x);
    p.y = num(d.y, 0, 80, p.y);
    p.z = num(d.z, -170, 170, p.z);
    p.yaw = num(d.yaw, -100, 100, p.yaw);
    p.pitch = num(d.pitch, -2, 2, p.pitch);
    if (typeof d.w === 'string' && WEAPONS[d.w]) p.weapon = d.w;
  }

  onHit(sid, d) {
    const p = this.players.get(sid);
    if (!p || !p.alive || this.over) return;
    const wdef = WEAPONS[d?.w]; if (!wdef) return;
    const z = this.zombies.get(d.zid); if (!z) return;
    const now = performance.now();
    const last = p.lastShot[d.w] || 0;
    if (now - last < wdef.minInterval * 1000) return;       // terlalu cepat
    p.lastShot[d.w] = now;
    const dist = Math.hypot(z.x - p.x, z.z - p.z);
    if (dist > wdef.range + 4) return;                      // terlalu jauh (toleransi lag)

    z.hp -= wdef.damage;
    p.score += z.scoreValue;
    if (z.hp <= 0) this.killZombie(z, p);
  }

  onPickup(sid, did) {
    const p = this.players.get(sid);
    const d = this.drops.get(did);
    if (!p || !p.alive || !d) return;
    if (Math.hypot(d.x - p.x, d.z - p.z) > 2.8) return;
    this.drops.delete(did);
    if (d.type === 'health') p.hp = Math.min(S.maxHp, p.hp + d.value);
    p.socket.emit('room:pickup', { type: d.type, value: d.value, hp: p.hp });
    this.emit('room:ev', { k: 'dropgone', id: did });
  }

  // ───────── wave ─────────
  startWave(n) {
    this.wave = n;
    const np = this.players.size;
    const scale = 1 + 0.5 * (np - 1);
    this.isBossWave = n % S.bossEvery === 0;
    this.regularCount = Math.round((S.waveBase + n * S.waveInc) * scale);
    this.waveCount = this.regularCount + (this.isBossWave ? 1 : 0);
    this.spawnedRegular = 0; this.killed = 0;
    this.bossSpawned = false; this.bossTier = Math.floor(n / S.bossEvery);
    this.bossTimer = this.isBossWave ? 2 : 0;
    this.waveActive = true; this.intermission = 0; this.spawnTimer = 1;

    // pemain yang mati hidup lagi di awal wave baru
    if (S.reviveOnWave && n > 1) {
      const living = [...this.players.values()].filter(p => p.alive);
      for (const p of this.players.values()) {
        if (p.alive) continue;
        p.alive = true; p.hp = Math.round(S.maxHp * S.revivePct);
        const ref = living[0];
        if (ref) { p.x = ref.x + 1.5; p.z = ref.z + 1.5; p.y = ref.y; }
        p.socket.emit('room:ev', { k: 'revive', hp: p.hp, x: r2(p.x), y: r2(p.y), z: r2(p.z) });
      }
    }
    this.ev('wave', { n });
  }

  maxAlive() { return 8 + 4 * this.players.size; }

  spawnZombie() {
    const type = Math.random() < 0.2 ? 'tank' : 'normal';
    const ang = Math.random() * PI2, dist = 20 + Math.random() * 40;
    const z = this.makeZombie(type, Math.cos(ang) * dist, Math.sin(ang) * dist);
    this.zombies.set(z.id, z);
  }

  makeZombie(type, x, zpos) {
    const z = {
      id: this.nextZid++, type, x, z: zpos, ry: 0,
      attackCd: 0, attackTimer: 0, pendingDmg: false, target: null,
    };
    if (type === 'tank') {
      Object.assign(z, { hp: 300, maxHp: 300, speed: 0.8 + Math.random() * 0.6, range: 2.4, damage: 15,
        scoreValue: 100, killScore: 200, attackDur: 0.6, attackGap: 1.0 });
    } else if (type === 'boss') {
      const tier = this.bossTier, hp = 400 + tier * 300;
      Object.assign(z, { hp, maxHp: hp, speed: Math.min(0.8 + tier * 0.2, 2.5), range: 3, damage: 10 + tier * 5,
        scoreValue: 50 + tier * 50, killScore: 500 + tier * 200, attackDur: 1.0, attackGap: 2.0, tier });
    } else {
      Object.assign(z, { hp: 100, maxHp: 100, speed: 1.5 + Math.random() * 2.5, range: 1.6, damage: 10,
        scoreValue: 10, killScore: 50, attackDur: 0.6, attackGap: 1.0 });
    }
    return z;
  }

  spawnBoss() {
    const z = this.makeZombie('boss', 0, 0);
    this.zombies.set(z.id, z);
    this.bossSpawned = true;
    this.ev('boss', { id: z.id });
  }

  killZombie(z, killer) {
    this.zombies.delete(z.id);
    killer.kills++;
    killer.score += z.killScore;
    this.killed++;
    this.ev('zdie', { id: z.id, t: z.type, x: r2(z.x), z: r2(z.z), by: killer.pid });
    if (z.type === 'boss') { this.spawnDrop(z.x, z.z); this.spawnDrop(z.x, z.z); }
    else if (Math.random() < 0.6) this.spawnDrop(z.x, z.z);
  }

  spawnDrop(x, z) {
    const isHealth = Math.random() < 0.5;
    const d = {
      id: this.nextDid++, type: isHealth ? 'health' : 'ammo', value: isHealth ? 30 : 15,
      x: x + (Math.random() - 0.5) * 0.8, z: z + (Math.random() - 0.5) * 0.8, age: 0,
    };
    this.drops.set(d.id, d);
    this.ev('drop', { id: d.id, t: d.type, x: r2(d.x), z: r2(d.z) });
  }

  hurt(p, dmg) {
    if (!p.alive || p.removed || this.over) return;
    p.hp = Math.max(0, p.hp - dmg);
    p.socket.emit('room:hurt', { hp: p.hp, dmg });
    if (p.hp <= 0) {
      p.alive = false;
      this.ev('pdie', { pid: p.pid });
      this.checkWipe();
    }
  }

  checkWipe() {
    if (this.over) return;
    if (this.players.size > 0 && [...this.players.values()].every(p => !p.alive)) this.endGame();
  }

  // ───────── loop ─────────
  tick(dt) {
    if (this.players.size === 0) { this.hooks.onEmpty(this); return; }
    if (this.over) return;

    if (this.startDelay > 0) {
      this.startDelay -= dt;
      if (this.startDelay <= 0) this.startWave(1);
      this.sendSnapshot(); return;
    }

    // wave logic
    if (this.waveActive) {
      if (this.isBossWave && !this.bossSpawned) {
        this.bossTimer -= dt;
        if (this.bossTimer <= 0) this.spawnBoss();
      }
      if (this.spawnedRegular < this.regularCount) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0 && this.zombies.size < this.maxAlive()) {
          this.spawnZombie(); this.spawnedRegular++;
          this.spawnTimer = (2 + Math.random() * 3) / (1 + 0.4 * (this.players.size - 1));
        }
      }
      if (this.spawnedRegular >= this.regularCount && (!this.isBossWave || this.bossSpawned) &&
          this.killed >= this.waveCount) {
        this.waveActive = false; this.intermission = S.intermission; this.wavesCleared++;
        this.ev('wavedone', { n: this.wave });
      }
    } else if (this.intermission > 0) {
      this.intermission -= dt;
      if (this.intermission <= 0) this.startWave(this.wave + 1);
    }

    this.updateZombies(dt);

    // drop kedaluwarsa
    for (const d of this.drops.values()) {
      d.age += dt;
      if (d.age > S.dropLifetime) { this.drops.delete(d.id); this.ev('dropgone', { id: d.id }); }
    }

    this.sendSnapshot();
  }

  updateZombies(dt) {
    const alive = [...this.players.values()].filter(p => p.alive);
    for (const z of this.zombies.values()) {
      let best = null, bd = Infinity;
      for (const p of alive) {
        const dx = p.x - z.x, dz = p.z - z.z, d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = p; }
      }
      if (!best) { z.attackTimer = 0; continue; }
      const dist = Math.sqrt(bd);
      const nx = dist > 1e-4 ? (best.x - z.x) / dist : 0;
      const nz = dist > 1e-4 ? (best.z - z.z) / dist : 0;
      z.ry = Math.atan2(nx, nz) + PI;
      z.attackCd -= dt;

      if (z.attackTimer > 0) {
        z.attackTimer -= dt;
        if (z.pendingDmg && z.attackTimer <= z.attackDur * 0.5) {
          z.pendingDmg = false;
          const t = z.target;
          if (t && t.alive && Math.hypot(t.x - z.x, t.z - z.z) < z.range + 0.8) this.hurt(t, z.damage);
        }
      } else if (dist < z.range) {
        if (z.attackCd <= 0) {
          z.attackTimer = z.attackDur; z.attackCd = z.attackGap;
          z.pendingDmg = true; z.target = best;
        }
      } else {
        const spd = dist < 10 ? z.speed : z.speed * 0.7;
        z.x += nx * spd * dt; z.z += nz * spd * dt;
      }

      // terlalu jauh dari semua pemain → pindahkan (HP dipulihkan sesuai tipe)
      if (z.type !== 'boss' && dist > S.respawnDist) {
        const a = Math.random() * PI2, d = 20 + Math.random() * 30;
        z.x = Math.cos(a) * d; z.z = Math.sin(a) * d; z.hp = z.maxHp;
      }
    }
  }

  sendSnapshot() {
    let boss = 0;
    const zs = [];
    for (const z of this.zombies.values()) {
      zs.push([z.id, r2(z.x), r2(z.z), r2(z.ry), Math.max(0, Math.round(z.hp)), z.maxHp,
               TYPE_CODE[z.type], z.attackTimer > 0 ? 1 : 0, z.type === 'boss' ? (z.tier || 1) : 0]);
      if (z.type === 'boss') boss = [Math.max(0, Math.round(z.hp)), z.maxHp];
    }
    const ps = [];
    for (const p of this.players.values()) {
      ps.push({ i: p.pid, n: p.name, x: r2(p.x), y: r2(p.y), z: r2(p.z), r: r2(p.yaw), t: r2(p.pitch),
                h: Math.round(p.hp), a: p.alive ? 1 : 0, w: p.weapon, s: p.score, k: p.kills });
    }
    this.emit('room:snap', {
      w: { n: this.wave, c: this.waveCount, k: this.killed, a: this.waveActive ? 1 : 0,
           i: Math.ceil(Math.max(0, this.intermission)), b: boss, d: Math.ceil(Math.max(0, this.startDelay)) },
      p: ps, z: zs,
    });
  }

  // ───────── selesai / keluar ─────────
  endGame() {
    if (this.over) return;
    this.over = true; this.waveActive = false;
    const results = [...this.players.values()].map(p => ({ pid: p.pid, name: p.name, score: p.score, kills: p.kills }));
    this.emit('room:over', { wave: this.wave, cleared: this.wavesCleared, results });
    for (const p of this.players.values()) this.savePlayer(p);
  }

  async savePlayer(p) {
    if (p.saved || this.wave < 1) return;
    p.saved = true;
    try {
      const user = await this.hooks.saveRun(p.user.id, { score: p.score, kills: p.kills, wavesCleared: this.wavesCleared });
      if (user) p.socket.emit('me:stats', { user });
    } catch (e) { console.error('[room] gagal simpan statistik:', e.message); p.saved = false; }
  }

  /** pemain keluar (kembali ke lobby / disconnect). Mengembalikan true jika room kosong. */
  removePlayer(sid) {
    const p = this.players.get(sid); if (!p) return this.players.size === 0;
    this.savePlayer(p);
    p.alive = false; p.removed = true;       // zombie yang masih menargetkan dia tidak boleh melukai lagi
    this.players.delete(sid);
    p.socket.leave(this.id);
    if (this.players.size > 0) {
      this.ev('pleave', { pid: p.pid, name: p.name });
      this.checkWipe();
    }
    return this.players.size === 0;
  }
}
