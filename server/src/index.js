// index.js — entry server: HTTP (REST akun) + Socket.IO (lobby & room survival)
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { PORT, CLIENT_ORIGIN, MAX_PLAYERS, SURVIVAL } from './config.js';
import { db } from './db.js';
import { authRouter, verifyToken } from './auth.js';
import { Lobby } from './lobby.js';
import { Room } from './room.js';

const corsOrigin = CLIENT_ORIGIN.length ? CLIENT_ORIGIN : '*';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '4kb' }));
app.get('/', (_req, res) => res.type('text').send('Undead Kingdom server OK'));
app.get('/health', (_req, res) => res.json({ ok: true, online: sessions.size, rooms: rooms.size, db: db.kind }));
app.use('/api', authRouter());

const server = http.createServer(app);
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} sudah dipakai`);
  } else {
    console.error('[server] error:', err);
  }
  process.exit(1);
});
const io = new Server(server, {
  cors: { origin: corsOrigin },
  maxHttpBufferSize: 1e4,        // 10 KB per pesan sudah lebih dari cukup
  pingInterval: 15000, pingTimeout: 30000,   // toleran untuk HP yang sedang berat merender
});

const sessions = new Map();       // userId -> socket
const rooms = new Map();          // roomId -> Room
let roomSeq = 1;

// ───────── Lobby & Room manager ─────────
function startRoom(members) {
  const id = 'r' + (roomSeq++);
  const room = new Room(id, members, {
    io,
    saveRun: (uid, run) => db.recordRun(uid, run),
    onEmpty: r => rooms.delete(r.id),
  });
  rooms.set(id, room);
  for (const m of members) {
    m.socket.data.room = room;
    m.socket.emit('match:start', room.startPayload(m.socket.id));
  }
  console.log(`[room ${id}] mulai: ${members.map(m => m.user.username).join(', ')}`);
}

const lobby = new Lobby(io, startRoom, () => sessions.size);

function sendToLobby(socket) {
  lobby.add(socket, socket.data.user);
  socket.data.room = null;
  socket.emit('lobby:init', lobby.initPayload(socket.id));
}

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  try {
    lobby.tick(dt);
    for (const room of rooms.values()) room.tick(dt);
  } catch (e) { console.error('[tick] error:', e); }     // satu error tidak boleh mematikan semua room
}, 1000 / SURVIVAL.tickRate);

// Jaga proses tetap hidup jika ada error tak terduga di handler socket
process.on('uncaughtException', e => {
  console.error('[uncaughtException]', e);
  if (e && e.code === 'EADDRINUSE') process.exit(1);
});
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

// ───────── Auth socket ─────────
io.use(async (socket, next) => {
  try {
    const payload = verifyToken(socket.handshake.auth?.token);
    if (!payload) return next(new Error('unauthorized'));
    const user = await db.getUser(payload.uid);
    if (!user) return next(new Error('unauthorized'));
    if (!sessions.has(user.id) && sessions.size >= MAX_PLAYERS) return next(new Error('server_full'));
    socket.data.user = user;
    next();
  } catch (e) { next(new Error('server_error')); }
});

function cleanup(socket) {
  if (socket.data.cleaned) return;
  socket.data.cleaned = true;
  const room = socket.data.room;
  if (room) {
    const empty = room.removePlayer(socket.id);
    if (empty) rooms.delete(room.id);
    socket.data.room = null;
  } else {
    lobby.remove(socket.id);
  }
  const u = socket.data.user;
  if (u && sessions.get(u.id) === socket) sessions.delete(u.id);
}

// ───────── Chat ─────────
function cleanText(t) {
  if (typeof t !== 'string') return '';
  return t.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function chatAllowed(socket) {
  const now = Date.now();
  const arr = (socket.data.chatTimes || []).filter(t => now - t < 6000);
  if (arr.length >= 5) { socket.data.chatTimes = arr; return false; }
  arr.push(now); socket.data.chatTimes = arr; return true;
}

io.on('connection', socket => {
  const user = socket.data.user;

  // 1 akun = 1 sesi (login baru menendang yang lama)
  const old = sessions.get(user.id);
  if (!old && sessions.size >= MAX_PLAYERS) {       // cek ulang: beberapa koneksi bisa lolos middleware bersamaan
    socket.emit('server_full');
    socket.disconnect(true);
    return;
  }
  if (old && old !== socket) { old.emit('kicked'); cleanup(old); old.disconnect(true); }
  sessions.set(user.id, socket);

  socket.emit('welcome', { user, maxPlayers: MAX_PLAYERS });
  sendToLobby(socket);

  socket.on('net:ping', (_t, ack) => { if (typeof ack === 'function') ack(); });

  socket.on('lobby:move', d => { if (!socket.data.room && d) lobby.onMove(socket.id, d); });
  socket.on('portal:join', idx => { if (!socket.data.room) lobby.portalJoin(socket.id, idx); });
  socket.on('portal:leave', () => { if (!socket.data.room) lobby.portalLeave(socket.id); });

  socket.on('room:move', d => { const r = socket.data.room; if (r && d) r.onMove(socket.id, d); });
  socket.on('room:hit', d => { const r = socket.data.room; if (r && d) r.onHit(socket.id, d); });
  socket.on('room:pickup', did => { const r = socket.data.room; if (r) r.onPickup(socket.id, did); });
  // Broadcast suara tembakan ke pemain lain di room yang sama (Bug 3 fix)
  socket.on('room:shoot', w => {
    const r = socket.data.room;
    if (!r) return;
    const p = r.players.get(socket.id);
    if (!p || !p.alive) return;
    if (typeof w !== 'string') return;
    socket.to(r.id).emit('room:ev', { k: 'shoot', pid: p.pid, w });
  });
  socket.on('room:leave', () => {
    const r = socket.data.room; if (!r) return;
    const empty = r.removePlayer(socket.id);
    if (empty) rooms.delete(r.id);
    sendToLobby(socket);
  });

  socket.on('chat:send', text => {
    const t = cleanText(text);
    if (!t || !chatAllowed(socket)) return;
    const room = socket.data.room;
    const msg = { name: user.username, text: t, t: Date.now() };
    if (room) io.to(room.id).emit('chat:msg', { scope: 'room', ...msg });
    else io.to('lobby').emit('chat:msg', { scope: 'lobby', ...msg });
  });

  socket.on('disconnect', () => cleanup(socket));
});

// ───────── Start ─────────
async function main() {
  await db.init();
  console.log(`[db] ${db.kind === 'postgres' ? 'Terhubung ke Neon/Postgres' : 'MODE MEMORI — data TIDAK permanen (isi DATABASE_URL untuk Neon)'}`);
  server.listen(PORT, () => console.log(`[server] listening on :${PORT}  (maks ${MAX_PLAYERS} pemain)`));
}
main().catch(e => { console.error('[server] gagal start:', e); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await db.close().catch(() => {}); process.exit(0); });
}
