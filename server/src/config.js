// config.js — konfigurasi server & konstanta gameplay
import 'dotenv/config';
import crypto from 'node:crypto';

export const PORT = parseInt(process.env.PORT || '3001', 10);
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

let secret = process.env.JWT_SECRET || '';
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET kosong → dibuat acak sementara (semua login hilang tiap server restart). Isi JWT_SECRET di .env untuk produksi.');
}
export const JWT_SECRET = secret;

// ── Lobby ──
export const MAX_PLAYERS = 15;           // maksimal pemain online sekaligus (lobby + sedang di room)
export const LOBBY_RADIUS = 30;          // radius lantai lobby
export const LOBBY_WALK_RADIUS = 28.5;   // batas jalan pemain
export const LOBBY_SPAWN = { x: 0, z: 14 };
export const PORTAL_RADIUS = 3.2;        // radius zona portal
export const PORTALS = [                 // posisi 3 portal (busur di depan spawn)
  { id: 0, name: 'PORTAL 1', x: -9.2, z: -13.1, color: '#00d4ff' },
  { id: 1, name: 'PORTAL 2', x:  0.0, z: -16.0, color: '#ff44cc' },
  { id: 2, name: 'PORTAL 3', x:  9.2, z: -13.1, color: '#ffaa00' },
];
export const ROOM_SIZE = 3;              // pemain per room survival
export const PORTAL_COUNTDOWN = parseInt(process.env.PORTAL_COUNTDOWN || '20', 10); // detik menunggu pemain lain sebelum room mulai

// ── Survival (disalin dari logika game single-player) ──
export const SURVIVAL = {
  waveBase: 4, waveInc: 4,
  intermission: 12,
  bossEvery: 5,
  revivePct: 0.6,           // pemain yang mati hidup lagi saat wave baru dengan 60% HP
  reviveOnWave: true,
  maxHp: 100,
  dropLifetime: 20,
  respawnDist: 80,
  tickRate: 20,
};

export const WEAPONS = {
  pistol: { damage: 35, minInterval: 0.12, range: 135 },
  rifle:  { damage: 25, minInterval: 0.06, range: 135 },
  smg:    { damage: 15, minInterval: 0.04, range: 135 },
  katana: { damage: 60, minInterval: 0.30, range: 6   },
};
