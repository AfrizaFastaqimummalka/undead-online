// Tes integrasi: jalankan server (mode memori), lalu simulasikan beberapa klien Socket.IO.
//   npm test
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import assert from 'node:assert/strict';

const PORT = 3999, BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (name) => { results.push(name); console.log('  ✓', name); };

const srv = spawn('node', ['src/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', JWT_SECRET: 'test', PORTAL_COUNTDOWN: '3', DISABLE_RATE_LIMIT: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let srvOut = '';
srv.stdout.on('data', d => { srvOut += d; });
const stop = () => { try { srv.kill(); } catch {} };
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {} await sleep(100); }
  throw new Error('server tidak naik\n' + srvOut);
}
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
function client(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.log = {};
  s.onAny((ev, d) => { (s.log[ev] ||= []).push(d); });
  return s;
}
const once = (s, ev, ms = 8000) => new Promise((res, rej) => {
  if (s.log[ev]?.length) return res(s.log[ev][s.log[ev].length - 1]);
  const t = setTimeout(() => rej(new Error('timeout menunggu ' + ev)), ms);
  s.once(ev, d => { clearTimeout(t); res(d); });
});
async function until(fn, ms = 10000, label = 'kondisi') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40); }
  throw new Error('timeout: ' + label);
}

try {
  await waitUp();
  console.log('Server naik');

  // ── Auth ──
  let r = await post('/api/register', { username: 'ab', password: 'xxxx' });
  assert.equal(r.status, 400); ok('register: ID terlalu pendek ditolak');
  r = await post('/api/register', { username: 'Alice', password: 'pw1234' });
  assert.equal(r.status, 200); assert.ok(r.json.token); ok('register berhasil');
  r = await post('/api/register', { username: 'alice', password: 'other' });
  assert.equal(r.status, 409); ok('register: ID duplikat (case-insensitive) ditolak');
  r = await post('/api/login', { username: 'Alice', password: 'salah' });
  assert.equal(r.status, 401); ok('login: password salah ditolak');
  r = await post('/api/login', { username: 'ALICE', password: 'pw1234' });
  assert.equal(r.status, 200); ok('login berhasil');

  const tokens = {};
  for (const n of ['Alice', 'Bob', 'Cara', 'Dan']) {
    const rr = await post('/api/register', { username: n + '_t', password: 'pw1234' });
    const lg = rr.status === 200 ? rr : await post('/api/login', { username: n + '_t', password: 'pw1234' });
    tokens[n] = lg.json.token;
  }

  // ── Socket tanpa token ──
  const bad = client('bukan-token');
  await new Promise(res => bad.on('connect_error', e => { assert.equal(e.message, 'unauthorized'); res(); }));
  ok('socket tanpa token valid ditolak');

  // ── Lobby ──
  const A = client(tokens.Alice), B = client(tokens.Bob), C = client(tokens.Cara), D = client(tokens.Dan);
  const initA = await once(A, 'lobby:init');
  assert.equal(initA.portals.length, 3); assert.equal(initA.maxPlayers, 15);
  await Promise.all([B, C, D].map(s => once(s, 'lobby:init')));
  await until(() => (A.log['lobby:state']?.at(-1)?.p.length === 4), 4000, '4 pemain terlihat di lobby');
  ok('lobby: 4 pemain saling terlihat, ada 3 portal');

  A.emit('chat:send', 'halo <b>semua</b>');
  const msg = await once(B, 'chat:msg');
  assert.equal(msg.scope, 'lobby'); assert.ok(!/[<>]/.test(msg.text)); assert.equal(msg.name, 'Alice_t');
  ok('chat lobby terkirim & disanitasi');

  // ── Portal: join harus dekat ──
  const P0 = initA.portals[0];
  A.emit('portal:join', 0);
  await sleep(300);
  assert.equal(A.log['lobby:state'].at(-1).q[0][0], 0); ok('portal: join dari jauh ditolak');

  for (const s of [A, B, C]) { s.emit('lobby:move', { x: P0.x, y: 1.7, z: P0.z + 1, yaw: 0 }); }
  await sleep(150);
  A.emit('portal:join', 0); B.emit('portal:join', 0);
  await until(() => A.log['lobby:state']?.at(-1)?.q[0][0] === 2, 3000, 'antrean portal 1 = 2');
  ok('portal: antrean berisi 2 pemain, countdown jalan');
  C.emit('portal:join', 0);
  const [mA, mB, mC] = await Promise.all([once(A, 'match:start'), once(B, 'match:start'), once(C, 'match:start')]);
  assert.equal(mA.players.length, 3); assert.notEqual(mA.pid, mB.pid);
  ok('portal: 3 pemain terkumpul → room survival dibuat');

  // Dan masih di lobby, hanya melihat dirinya
  await until(() => D.log['lobby:state']?.at(-1)?.p.length === 1, 3000, 'lobby tinggal Dan');
  ok('lobby: pemain yang pindah room hilang dari lobby');

  // ── Dalam room ──
  const snap0 = await once(A, 'room:snap');
  assert.equal(snap0.p.length, 3);
  C.log['chat:msg'] = []; A.emit('chat:send', 'tim siap'); const rc = await once(C, 'chat:msg');
  assert.equal(rc.scope, 'room'); ok('chat room hanya untuk tim');
  assert.ok(!(D.log['chat:msg'] || []).some(m => m.text === 'tim siap')); ok('chat room tidak bocor ke lobby');

  const lastSnap = s => s.log['room:snap'].at(-1);
  const zSnap = await until(() => { const sn = lastSnap(A); return sn.z.length ? sn : null; }, 12000, 'zombie pertama muncul');
  assert.equal(lastSnap(A).w.n, 1); ok('wave 1 mulai & zombie di-spawn server');

  // A menembak zombie sampai mati (rifle 25 dmg; tank 300 hp butuh 12 tembakan)
  const target = zSnap.z[0]; const zid = target[0];
  for (let i = 0; i < 16; i++) {
    const z = lastSnap(A).z.find(x => x[0] === zid); if (!z) break;
    A.emit('room:move', { x: z[1] + 3, y: 1.7, z: z[2], yaw: 0, pitch: 0, w: 'rifle' });
    A.emit('room:hit', { zid, w: 'rifle' });
    await sleep(120);
  }
  const die = await until(() => A.log['room:ev']?.find(e => e.k === 'zdie' && e.id === zid), 3000, 'zombie mati');
  assert.equal(die.by, mA.pid);
  await until(() => lastSnap(A).p.find(p => p.i === mA.pid).k >= 1, 2000, 'kill tercatat');
  assert.ok(lastSnap(A).p.find(p => p.i === mA.pid).s >= 50); ok('hit tervalidasi server: zombie mati, skor & kill masuk');

  // anti-cheat dasar: tembak dari jauh tidak berefek
  const z2 = await until(() => lastSnap(A).z[0], 8000, 'zombie lain');
  const hpBefore = z2[4];
  A.emit('room:move', { x: 160, y: 1.7, z: 160, yaw: 0, pitch: 0, w: 'pistol' });
  await sleep(100);
  A.emit('room:hit', { zid: z2[0], w: 'pistol' });
  await sleep(200);
  const z2after = lastSnap(A).z.find(x => x[0] === z2[0]);
  assert.ok(!z2after || z2after[4] >= hpBefore); ok('anti-cheat: tembakan di luar jangkauan ditolak');

  // ── Biarkan zombie membunuh semua pemain (ikuti zombie terdekat) ──
  const players = [[A, mA], [B, mB], [C, mC]];
  let over = null;
  for (let i = 0; i < 1500 && !over; i++) {
    const sn = lastSnap(A);
    for (const [s] of players) {
      const z = sn.z[0];
      if (z) s.emit('room:move', { x: z[1] + 0.8, y: 1.7, z: z[2], yaw: 0, pitch: 0, w: 'rifle' });
    }
    over = A.log['room:over']?.[0];
    await sleep(50);
  }
  assert.ok(over, 'room:over tidak datang');
  assert.equal(over.results.length, 3);
  assert.ok(A.log['room:hurt']?.length > 0); ok('zombie menyerang & mengurangi HP pemain (server-side)');
  ok('semua pemain mati → game over tim');

  const stats = await once(A, 'me:stats');
  assert.equal(stats.user.totalGames, 1); assert.ok(stats.user.highScore >= 50); assert.ok(stats.user.totalKills >= 1);
  ok('statistik disimpan: high score, kill, total game');

  const lb = await (await fetch(BASE + '/api/leaderboard')).json();
  assert.equal(lb.players[0].username, 'Alice_t'); ok('leaderboard menampilkan skor');

  // kembali ke lobby
  A.emit('room:leave'); await until(() => A.log['lobby:init']?.length === 2, 3000, 'kembali ke lobby');
  ok('kembali ke lobby setelah game over');

  // ── Login ulang: statistik tetap ──
  const rl = await post('/api/login', { username: 'Alice_t', password: 'pw1234' });
  assert.ok(rl.json.user.highScore >= 50 && rl.json.user.totalGames === 1); ok('statistik persisten setelah login ulang');

  // ── Satu akun satu sesi ──
  const A2 = client(tokens.Alice);
  await once(A, 'kicked'); ok('login ganda: sesi lama ditendang');

  // ── Batas 15 pemain ──
  for (let i = 0; i < 14; i++) {
    const rr = await post('/api/register', { username: 'bot' + i, password: 'pw1234' });
    client(rr.json.token);
  }
  await sleep(1000);
  const online = (await (await fetch(BASE + '/health')).json()).online;
  const full = await post('/api/register', { username: 'terlambat', password: 'pw1234' });
  const late = client(full.json.token);
  const err = await new Promise(res => late.on('connect_error', e => res(e.message)));
  assert.equal(err, 'server_full'); ok(`batas 15 pemain: pemain ke-16 ditolak (online=${online})`);

  console.log(`\nSEMUA TES LULUS (${results.length})`);
  stop(); process.exit(0);
} catch (e) {
  console.error('\n✗ GAGAL:', e.message); console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  console.error('--- log server ---\n' + srvOut);
  stop(); process.exit(1);
}
