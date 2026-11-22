// Tes alur jaringan tambahan: antrean sendirian, batal antre, disconnect/kick saat di room, kebersihan room.
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import assert from 'node:assert/strict';

const PORT = 3998, BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0; const ok = n => { passed++; console.log('  ✓', n); };
const srv = spawn('node', ['src/index.js'], { env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', JWT_SECRET: 't', PORTAL_COUNTDOWN: '2', DISABLE_RATE_LIMIT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
let out = ''; srv.stdout.on('data', d => out += d);
const stop = () => { try { srv.kill(); } catch {} }; process.on('exit', stop);
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await sleep(100); }

const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const health = async () => (await fetch(BASE + '/health')).json();
async function mk(name) {
  const r = await post('/api/register', { username: name, password: 'pw1234' });
  const s = io(BASE, { auth: { token: r.token }, transports: ['websocket'], reconnection: false });
  s.log = {}; s.onAny((e, d) => (s.log[e] ||= []).push(d)); s.token = r.token;
  await new Promise(res => s.once('lobby:init', d => { s.init = d; res(); }));
  return s;
}
const until = async (fn, ms = 6000, l = '') => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(30); } throw new Error('timeout ' + l); };
const goPortal = async (s, i) => { const p = s.init.portals[i]; s.emit('lobby:move', { x: p.x, y: 1.7, z: p.z + 1, yaw: 0 }); await sleep(120); s.emit('portal:join', i); };
const qOf = (s, i) => s.log['lobby:state']?.at(-1)?.q[i];

try {
  // 1. sendirian di portal: room mulai setelah countdown dengan 1 pemain
  const A = await mk('FlowA');
  await goPortal(A, 1);
  await until(() => qOf(A, 1)?.[0] === 1, 2000, 'masuk antrean');
  const m = await until(() => A.log['match:start']?.[0], 6000, 'match:start sendirian');
  assert.equal(m.players.length, 1); ok('portal: 1 pemain mulai sendiri setelah countdown');
  assert.equal((await health()).rooms, 1);

  // 2. disconnect saat di room → room dibersihkan
  A.disconnect(); await sleep(500);
  let h = await health(); assert.equal(h.rooms, 0); assert.equal(h.online, 0); ok('disconnect di room: room & sesi dibersihkan');

  // 3. batal antre: portal:leave dan menjauh (server memvalidasi sendiri)
  const B = await mk('FlowB');
  await goPortal(B, 0); await until(() => qOf(B, 0)?.[0] === 1, 2000, 'antre');
  B.emit('portal:leave'); await until(() => qOf(B, 0)?.[0] === 0, 2000, 'keluar antre'); ok('portal:leave mengosongkan antrean');
  await goPortal(B, 0); await until(() => qOf(B, 0)?.[0] === 1, 2000, 'antre lagi');
  B.emit('lobby:move', { x: 0, y: 1.7, z: 14, yaw: 0 });     // jalan menjauh tanpa mengirim portal:leave
  await until(() => qOf(B, 0)?.[0] === 0, 2000, 'auto keluar antrean'); 
  assert.ok(B.log['match:start'] === undefined); ok('menjauh dari portal: server otomatis mengeluarkan dari antrean');
  assert.equal(B.log['lobby:state'].at(-1).p.find(p => p.n === 'FlowB').g, -1); ok('status antrean per pemain (g) sinkron');

  // 4. portal berbeda = antrean berbeda
  const C = await mk('FlowC');
  await goPortal(B, 0); await goPortal(C, 2);
  await until(() => qOf(B, 0)?.[0] === 1 && qOf(B, 2)?.[0] === 1, 2000, 'dua antrean berbeda');
  ok('3 portal memiliki antrean terpisah');
  await until(() => B.log['match:start'] && C.log['match:start'], 6000, 'dua room terpisah');
  assert.notEqual(B.log['match:start'][0].roomId, C.log['match:start'][0].roomId); ok('portal berbeda → room berbeda');
  assert.equal((await health()).rooms, 2);

  // 5. login ganda saat berada di room: sesi lama ditendang, room dibersihkan, sesi baru masuk lobby
  const B2 = io(BASE, { auth: { token: B.token }, transports: ['websocket'], reconnection: false });
  B2.log = {}; B2.onAny((e, d) => (B2.log[e] ||= []).push(d));
  await until(() => B.log['kicked'], 3000, 'B ditendang');
  await until(() => B2.log['lobby:init'], 3000, 'B2 masuk lobby');
  assert.equal((await health()).rooms, 1); ok('login ganda di dalam room: sesi lama keluar, room-nya bersih, sesi baru ke lobby');

  // 6. keluar room sendiri (room:leave) lalu masuk portal lagi
  C.emit('room:leave'); await until(() => C.log['lobby:init']?.length === 1 + 1, 3000, 'C kembali lobby');
  assert.equal((await health()).rooms, 0);
  await goPortal(C, 1); await until(() => C.log['match:start']?.length === 2, 6000, 'C main lagi');
  ok('keluar room lalu masuk portal lagi berfungsi (room lama bersih)');

  // 7. server tidak crash karena payload sampah
  for (const ev of ['lobby:move', 'portal:join', 'portal:leave', 'room:move', 'room:hit', 'room:pickup', 'chat:send']) {
    for (const bad of [null, undefined, 1, 'x', [], {}, { x: {} }, '\u0000'.repeat(500)]) C.emit(ev, bad);
  }
  await sleep(400);
  assert.equal((await health()).ok, true); ok('payload sampah pada semua event tidak membuat server error');

  console.log(`\nTES ALUR LULUS (${passed})`); stop(); process.exit(0);
} catch (e) { console.error('\n✗ GAGAL:', e.message, '\n', out); stop(); process.exit(1); }
