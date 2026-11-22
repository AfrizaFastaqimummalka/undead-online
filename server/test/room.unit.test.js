// Tes unit logika Room (tanpa jaringan): waktu disimulasikan dengan memanggil tick() manual.
import assert from 'node:assert/strict';
import { Room } from '../src/room.js';

let passed = 0;
const ok = n => { passed++; console.log('  ✓', n); };

function fakeSocket(id) {
  const s = { id, events: [], joined: new Set(),
    join(r) { s.joined.add(r); }, leave(r) { s.joined.delete(r); },
    emit(ev, d) { s.events.push([ev, d]); } };
  s.last = ev => { for (let i = s.events.length - 1; i >= 0; i--) if (s.events[i][0] === ev) return s.events[i][1]; };
  s.count = ev => s.events.filter(e => e[0] === ev).length;
  return s;
}
function makeRoom(n = 2) {
  const saves = [], roomEvents = [];
  const io = { to: () => ({ emit: (ev, d) => roomEvents.push([ev, d]) }) };
  const members = Array.from({ length: n }, (_, i) => ({ socket: fakeSocket('s' + i), user: { id: i + 1, username: 'P' + i } }));
  const room = new Room('rT', members, { io, saveRun: async (uid, run) => { saves.push([uid, run]); return { id: uid, ...run }; }, onEmpty: () => {} });
  room.t = (sec) => { for (let i = 0; i < Math.round(sec / 0.05); i++) room.tick(0.05); };
  room.evs = k => roomEvents.filter(e => e[0] === 'room:ev' && e[1].k === k).map(e => e[1]);
  return { room, members, saves, roomEvents };
}
const P = (room, i) => [...room.players.values()][i];
function killAll(room, p) {            // bunuh semua zombie yang ada dengan hit (reset cooldown tembak)
  for (const z of [...room.zombies.values()]) {
    p.x = z.x; p.z = z.z; p.lastShot = {};
    for (let i = 0; i < 20 && room.zombies.has(z.id); i++) { p.lastShot = {}; room.onHit(p.socket.id, { zid: z.id, w: 'rifle' }); }
  }
}
const keepSafe = room => { for (const p of room.players.values()) p.hp = 100; };

// 1. wave selesai → intermission → wave 2 (jumlah naik)
{
  const { room } = makeRoom(2);
  room.t(3.2);
  assert.equal(room.wave, 1);
  assert.equal(room.waveCount, Math.round((4 + 4) * 1.5));          // 12 untuk 2 pemain
  const p = P(room, 0);
  for (let i = 0; i < 400 && !room.evs('wavedone').length; i++) { room.t(0.5); keepSafe(room); killAll(room, p); }
  assert.equal(room.evs('wavedone').length, 1);
  assert.equal(room.wavesCleared, 1);
  room.t(12.5);
  assert.equal(room.wave, 2);
  assert.equal(room.waveCount, Math.round((4 + 8) * 1.5));
  ok('wave 1 selesai → intermission 12s → wave 2 dengan jumlah zombie naik');
}

// 2. wave boss (5): wave tidak selesai sebelum boss mati, boss drop 2 item
{
  const { room } = makeRoom(1);
  room.t(3.2);
  room.startWave(5);
  assert.equal(room.isBossWave, true);
  assert.equal(room.waveCount, room.regularCount + 1);
  const p = P(room, 0);
  const killRegulars = () => { for (const z of [...room.zombies.values()]) if (z.type !== 'boss') { p.x = z.x; p.z = z.z; for (let i = 0; i < 20 && room.zombies.has(z.id); i++) { p.lastShot = {}; room.onHit(p.socket.id, { zid: z.id, w: 'rifle' }); } } };
  for (let i = 0; i < 2000 && !(room.spawnedRegular >= room.regularCount && room.bossSpawned); i++) { room.t(0.5); keepSafe(room); killRegulars(); }
  killRegulars();
  const boss = [...room.zombies.values()].find(z => z.type === 'boss');
  assert.ok(boss, 'boss muncul'); assert.equal(boss.hp, 400 + 1 * 300);
  room.t(1);
  assert.equal(room.evs('wavedone').length, 0, 'wave belum boleh selesai selama boss hidup');
  const dropsBefore = room.drops.size;
  p.x = boss.x; p.z = boss.z;
  for (let i = 0; i < 40 && room.zombies.has(boss.id); i++) { p.lastShot = {}; room.onHit(p.socket.id, { zid: boss.id, w: 'rifle' }); }
  assert.ok(!room.zombies.has(boss.id));
  assert.ok(room.drops.size >= dropsBefore + 2);
  room.t(1);
  assert.equal(room.evs('wavedone').length, 1);
  ok('wave boss: tidak selesai sebelum boss mati, boss menjatuhkan 2 drop');
}

// 3. pemain mati hidup lagi di wave berikutnya (60% HP), dekat teman
{
  const { room, members } = makeRoom(2);
  room.t(3.2);
  const a = P(room, 0), b = P(room, 1);
  room.hurt(a, 1000);
  assert.equal(a.alive, false); assert.equal(room.over, false);
  assert.equal(members[0].socket.count('room:hurt'), 1);
  room.startWave(2);
  assert.equal(a.alive, true); assert.equal(a.hp, 60);
  assert.equal(members[0].socket.last('room:ev').k, 'revive');
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 3);
  ok('pemain mati hidup lagi saat wave baru dengan 60% HP');
}

// 4. semua mati → game over sekali, statistik tersimpan sekali, keluar sesudahnya tidak menyimpan lagi
{
  const { room, members, saves, roomEvents } = makeRoom(2);
  room.t(3.2);
  const a = P(room, 0), b = P(room, 1);
  a.score = 300; a.kills = 5; b.score = 120; b.kills = 2;
  room.hurt(a, 1000); room.hurt(b, 1000);
  assert.equal(room.over, true);
  assert.equal(roomEvents.filter(e => e[0] === 'room:over').length, 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(saves.length, 2);
  assert.deepEqual(saves.find(s => s[0] === 1)[1], { score: 300, kills: 5, wavesCleared: 0 });
  room.removePlayer(members[0].socket.id); room.removePlayer(members[1].socket.id);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(saves.length, 2, 'tidak boleh simpan dua kali');
  ok('game over tim: 1 event, statistik tersimpan tepat sekali per pemain');
}

// 5. pemain keluar di tengah main: statistik tersimpan, tidak lagi dilukai zombie, sisa tim tetap lanjut
{
  const { room, members, saves } = makeRoom(2);
  room.t(3.2);
  const a = P(room, 0), b = P(room, 1);
  a.score = 77; a.kills = 3;
  // zombie sedang menyerang a
  room.spawnZombie(); const z = [...room.zombies.values()][0];
  z.x = a.x + 1; z.z = a.z; z.attackTimer = 0.2; z.pendingDmg = true; z.target = a;
  const hurtsBefore = members[0].socket.count('room:hurt');
  const empty = room.removePlayer(members[0].socket.id);
  assert.equal(empty, false);
  room.t(1);
  assert.equal(members[0].socket.count('room:hurt'), hurtsBefore, 'pemain yang sudah keluar tidak boleh menerima damage');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(saves.length, 1); assert.equal(saves[0][1].score, 77);
  assert.equal(room.players.size, 1); assert.equal(room.over, false);
  room.hurt(b, 1000);
  assert.equal(room.over, true, 'sisa pemain mati → game over');
  ok('pemain keluar saat main: statistik tersimpan, tidak terkena damage, tim sisa lanjut');
}

// 6. drop: validasi jarak, heal dibatasi 100, ammo dikirim ke pemain
{
  const { room, members } = makeRoom(1);
  room.t(3.2);
  const p = P(room, 0);
  room.drops.set(901, { id: 901, type: 'health', value: 30, x: p.x + 20, z: p.z, age: 0 });
  room.onPickup(p.socket.id, 901);
  assert.ok(room.drops.has(901), 'terlalu jauh → ditolak');
  p.hp = 90; room.drops.set(902, { id: 902, type: 'health', value: 30, x: p.x + 1, z: p.z, age: 0 });
  room.onPickup(p.socket.id, 902);
  assert.equal(p.hp, 100); assert.ok(!room.drops.has(902));
  room.drops.set(903, { id: 903, type: 'ammo', value: 15, x: p.x, z: p.z, age: 0 });
  room.onPickup(p.socket.id, 903);
  assert.equal(members[0].socket.last('room:pickup').type, 'ammo');
  room.onPickup(p.socket.id, 903);
  assert.equal(members[0].socket.count('room:pickup'), 2, 'drop yang sama tidak bisa diambil dua kali');
  room.drops.set(904, { id: 904, type: 'ammo', value: 15, x: 0, z: 0, age: 0 });
  room.t(21);
  assert.ok(!room.drops.has(904)); 
  ok('drop: jarak divalidasi, heal maks 100, tidak bisa diambil ganda, kedaluwarsa 20s');
}

// 7. validasi tembakan
{
  const { room } = makeRoom(1);
  room.t(4);
  room.spawnZombie();
  const p = P(room, 0), z = [...room.zombies.values()][0];
  z.hp = z.maxHp = 100; p.x = z.x; p.z = z.z;
  room.onHit(p.socket.id, { zid: z.id, w: 'laser' }); assert.equal(z.hp, 100);             // senjata tak dikenal
  room.onHit(p.socket.id, { zid: 99999, w: 'rifle' });                                      // zombie tak ada
  room.onHit(p.socket.id, { zid: z.id, w: 'rifle' }); assert.equal(z.hp, 75);
  room.onHit(p.socket.id, { zid: z.id, w: 'rifle' }); assert.equal(z.hp, 75, 'terlalu cepat ditolak');
  p.lastShot = {}; p.x = z.x + 500; room.onHit(p.socket.id, { zid: z.id, w: 'rifle' }); assert.equal(z.hp, 75);   // terlalu jauh
  p.x = z.x; p.lastShot = {}; p.alive = false; room.onHit(p.socket.id, { zid: z.id, w: 'rifle' }); assert.equal(z.hp, 75); // sudah mati
  p.alive = true; p.lastShot = {}; p.x = z.x + 100; room.onHit(p.socket.id, { zid: z.id, w: 'katana' }); assert.equal(z.hp, 75, 'katana jarak jauh ditolak');
  ok('validasi tembakan: senjata/zombie tidak valid, terlalu cepat, terlalu jauh, pemain mati, katana jarak jauh');
}

// 8. input aneh tidak membuat server error
{
  const { room } = makeRoom(1);
  const sid = P(room, 0).socket.id;
  for (const bad of [null, undefined, 5, 'x', {}, { x: NaN, y: 'a', z: Infinity, yaw: {}, w: 7 }, { x: 1e9, z: -1e9 }]) { room.onMove(sid, bad ?? {}); }
  const p = P(room, 0);
  assert.ok(Number.isFinite(p.x) && Math.abs(p.x) <= 170 && Math.abs(p.z) <= 170);
  room.onHit(sid, {}); room.onHit(sid, { zid: 'a', w: {} }); room.onPickup(sid, 'zzz'); room.onPickup(sid, null);
  ok('input aneh/NaN/ekstrem tidak merusak state & tidak melempar error');
}

console.log(`\nTES UNIT ROOM LULUS (${passed})`);
