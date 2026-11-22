// auth.js — REST: register, login, me, leaderboard + helper token
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './config.js';
import { db } from './db.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function signToken(user) {
  return jwt.sign({ uid: user.id, un: user.username }, JWT_SECRET, { expiresIn: '14d' });
}
export function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Rate limit sederhana per IP (memori)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    if (process.env.DISABLE_RATE_LIMIT === '1') return next();   // hanya untuk tes otomatis
    const key = req.ip + '|' + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi nanti.' });
    arr.push(now); hits.set(key, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) { if (!arr.some(t => now - t < 600000)) hits.delete(k); }
}, 60000).unref();

function validate(body) {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) return { error: 'ID harus 3-16 karakter: huruf, angka, atau _' };
  if (password.length < 4 || password.length > 64) return { error: 'Password harus 4-64 karakter' };
  return { username, password };
}

export function authRouter() {
  const r = express.Router();

  r.post('/register', rateLimit(10, 10 * 60 * 1000), async (req, res) => {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const hash = await bcrypt.hash(v.password, 10);
      const user = await db.createUser(v.username, hash);
      if (!user) return res.status(409).json({ error: 'ID sudah dipakai, pilih yang lain' });
      res.json({ token: signToken(user), user });
    } catch (e) {
      console.error('[auth] register:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  r.post('/login', rateLimit(20, 10 * 60 * 1000), async (req, res) => {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: 'ID atau password salah' });
    try {
      const rec = await db.findAuth(v.username);
      const ok = rec && await bcrypt.compare(v.password, rec.passHash);
      if (!ok) return res.status(401).json({ error: 'ID atau password salah' });
      db.touchLogin(rec.user.id).catch(() => {});
      res.json({ token: signToken(rec.user), user: rec.user });
    } catch (e) {
      console.error('[auth] login:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  r.get('/me', async (req, res) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const p = m && verifyToken(m[1]);
    if (!p) return res.status(401).json({ error: 'Sesi tidak valid' });
    const user = await db.getUser(p.uid);
    if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan' });
    res.json({ user });
  });

  r.get('/leaderboard', async (_req, res) => {
    try { res.json({ players: await db.leaderboard(10) }); }
    catch { res.status(500).json({ error: 'Server error' }); }
  });

  return r;
}
