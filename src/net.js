// net.js — koneksi ke server: REST (akun) + Socket.IO (lobby & room). Tidak bergantung modul game lain.
import { SERVER_URL, SERVER_CONFIGURED, TOKEN_KEY } from './config.js';

const SIO_URL = 'https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.esm.min.js';

export const session = { token: null, user: null };
try { session.token = localStorage.getItem(TOKEN_KEY) || null; } catch {}

let socket = null;
const listeners = {};
const userListeners = [];

export function on(event, fn) { (listeners[event] ||= []).push(fn); }
function fire(event, ...args) { (listeners[event] || []).forEach(fn => { try { fn(...args); } catch (e) { console.error('[net]', event, e); } }); }
export function onUserChange(fn) { userListeners.push(fn); }
function setUser(u) { session.user = u; userListeners.forEach(f => f(u)); }

export function isConnected() { return !!(socket && socket.connected); }
export function emit(event, data) { if (socket && socket.connected) socket.emit(event, data); }

// ───────── REST ─────────
async function api(path, { method = 'GET', body, auth } = {}) {
  if (!SERVER_CONFIGURED) throw new Error('URL server belum diatur. Edit src/config.js (PRODUCTION_SERVER_URL).');
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && session.token) headers.Authorization = 'Bearer ' + session.token;
  let res;
  try {
    res = await fetch(SERVER_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Tidak bisa terhubung ke server. Coba lagi sebentar (server gratis bisa butuh ±30 detik untuk bangun).');
  }
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok) throw new Error(json.error || `Server error (${res.status})`);
  return json;
}

function saveSession(token, user) {
  session.token = token;
  try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  setUser(user);
}

export async function register(username, password) {
  const r = await api('/api/register', { method: 'POST', body: { username, password } });
  saveSession(r.token, r.user); return r.user;
}
export async function login(username, password) {
  const r = await api('/api/login', { method: 'POST', body: { username, password } });
  saveSession(r.token, r.user); return r.user;
}
/** Cek token tersimpan. Mengembalikan user atau null. */
export async function restoreSession() {
  if (!session.token || !SERVER_CONFIGURED) return null;
  try {
    const r = await api('/api/me', { auth: true });
    setUser(r.user); return r.user;
  } catch (e) {
    if (/Sesi|Akun/.test(e.message)) logout();
    return null;
  }
}
export function logout() {
  session.token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
  if (socket) { socket.disconnect(); socket = null; }
  setUser(null);
}
export async function fetchLeaderboard() { return (await api('/api/leaderboard')).players; }

// ───────── Socket ─────────
const ERR = {
  unauthorized: 'Sesi login tidak valid, silakan login ulang.',
  server_full: 'Server penuh (maksimal 15 pemain). Coba lagi nanti.',
  server_error: 'Server bermasalah, coba lagi.',
};

let connecting = null;
export function connect() {
  if (isConnected()) return Promise.resolve();
  if (!connecting) connecting = doConnect().finally(() => { connecting = null; });
  return connecting;
}

async function doConnect() {
  if (!SERVER_CONFIGURED) throw new Error('URL server belum diatur. Edit src/config.js.');
  const mod = await import(SIO_URL);
  const io = mod.io || mod.default;
  await new Promise((resolve, reject) => {
    const s = io(SERVER_URL, { auth: { token: session.token }, transports: ['websocket', 'polling'], reconnection: false, timeout: 20000 });
    socket = s;
    let settled = false;
    s.on('connect_error', e => {
      if (settled) return; settled = true;
      if (e.message === 'unauthorized') logout();
      reject(new Error(ERR[e.message] || 'Gagal terhubung ke server.'));
    });
    s.on('welcome', d => { if (!settled) { settled = true; resolve(); } setUser(d.user); fire('welcome', d); });
    s.on('server_full', () => { if (!settled) { settled = true; reject(new Error(ERR.server_full)); } });
    s.on('disconnect', reason => {
      if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
      fire('disconnect', reason);
    });
    s.on('me:stats', d => setUser(d.user));
    s.onAny((ev, ...args) => fire(ev, ...args));
  });
  startPingLoop();
}

export function disconnect() {
  if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
  if (socket) { socket.disconnect(); socket = null; }
}

// ───────── Ping ─────────
// Diukur menggunakan Socket.IO acknowledgement RTT dua arah murni
let _ping = 0;
let _pingInterval = null;

export function getPing() { return _ping; }

export function startPingLoop() {
  if (_pingInterval) return;
  _pingInterval = setInterval(() => {
    if (!socket || !socket.connected) return;
    const t0 = performance.now();
    socket.emit('net:ping', null, () => {
      _ping = Math.round(performance.now() - t0);
    });
  }, 2000);
}

// ───────── Helper pesan game ─────────
export const sendHit = (zid, w) => emit('room:hit', { zid, w });
export const sendPickup = id => emit('room:pickup', id);
export const sendChat = text => emit('chat:send', text);
