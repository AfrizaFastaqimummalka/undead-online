// db.js — penyimpanan akun & statistik.
// Produksi: Neon (Postgres) via DATABASE_URL.
// Dev tanpa DATABASE_URL: memori (data hilang saat server restart).
import pg from 'pg';
import { DATABASE_URL } from './config.js';

const COLS = 'id, username, high_score, best_wave, total_kills, total_games, total_score';

function publicUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    highScore: Number(r.high_score),
    bestWave: Number(r.best_wave),
    totalKills: Number(r.total_kills),
    totalGames: Number(r.total_games),
    totalScore: Number(r.total_score),
  };
}

// ───────────── Postgres (Neon) ─────────────
function createPgStore() {
  const ssl = /sslmode=/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false };
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', e => console.error('[db] pool error:', e.message));

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id             SERIAL PRIMARY KEY,
          username       VARCHAR(16)  NOT NULL,
          username_lower VARCHAR(16)  NOT NULL UNIQUE,
          pass_hash      TEXT         NOT NULL,
          high_score     INTEGER      NOT NULL DEFAULT 0,
          best_wave      INTEGER      NOT NULL DEFAULT 0,
          total_kills    INTEGER      NOT NULL DEFAULT 0,
          total_games    INTEGER      NOT NULL DEFAULT 0,
          total_score    BIGINT       NOT NULL DEFAULT 0,
          created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
          last_login     TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS users_high_score_idx ON users (high_score DESC);
      `);
    },
    async createUser(username, passHash) {
      try {
        const r = await pool.query(
          `INSERT INTO users (username, username_lower, pass_hash, last_login)
           VALUES ($1, $2, $3, now()) RETURNING ${COLS}`,
          [username, username.toLowerCase(), passHash]);
        return publicUser(r.rows[0]);
      } catch (e) {
        if (e.code === '23505') return null; // username sudah dipakai
        throw e;
      }
    },
    async findAuth(username) {
      const r = await pool.query(
        `SELECT ${COLS}, pass_hash FROM users WHERE username_lower = $1`, [username.toLowerCase()]);
      if (!r.rows[0]) return null;
      return { user: publicUser(r.rows[0]), passHash: r.rows[0].pass_hash };
    },
    async touchLogin(id) { await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [id]); },
    async getUser(id) {
      const r = await pool.query(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
      return publicUser(r.rows[0]);
    },
    async recordRun(id, { score, kills, wavesCleared }) {
      const r = await pool.query(
        `UPDATE users SET
           high_score  = GREATEST(high_score, $2),
           best_wave   = GREATEST(best_wave, $3),
           total_kills = total_kills + $4,
           total_games = total_games + 1,
           total_score = total_score + $2
         WHERE id = $1 RETURNING ${COLS}`,
        [id, score | 0, wavesCleared | 0, kills | 0]);
      return publicUser(r.rows[0]);
    },
    async leaderboard(limit = 10) {
      const r = await pool.query(
        `SELECT ${COLS} FROM users WHERE total_games > 0
         ORDER BY high_score DESC, best_wave DESC LIMIT $1`, [limit]);
      return r.rows.map(publicUser);
    },
    async close() { await pool.end(); },
  };
}

// ───────────── Memori (dev/test) ─────────────
function createMemoryStore() {
  const users = new Map(); // id -> row
  let nextId = 1;
  const rowOf = u => ({
    id: u.id, username: u.username, high_score: u.high_score, best_wave: u.best_wave,
    total_kills: u.total_kills, total_games: u.total_games, total_score: u.total_score,
  });
  return {
    kind: 'memory',
    async init() {},
    async createUser(username, passHash) {
      for (const u of users.values()) if (u.username.toLowerCase() === username.toLowerCase()) return null;
      const u = { id: nextId++, username, pass_hash: passHash, high_score: 0, best_wave: 0,
                  total_kills: 0, total_games: 0, total_score: 0 };
      users.set(u.id, u);
      return publicUser(rowOf(u));
    },
    async findAuth(username) {
      for (const u of users.values()) {
        if (u.username.toLowerCase() === username.toLowerCase()) {
          return { user: publicUser(rowOf(u)), passHash: u.pass_hash };
        }
      }
      return null;
    },
    async touchLogin() {},
    async getUser(id) { const u = users.get(id); return u ? publicUser(rowOf(u)) : null; },
    async recordRun(id, { score, kills, wavesCleared }) {
      const u = users.get(id); if (!u) return null;
      u.high_score = Math.max(u.high_score, score | 0);
      u.best_wave = Math.max(u.best_wave, wavesCleared | 0);
      u.total_kills += kills | 0; u.total_games += 1; u.total_score += score | 0;
      return publicUser(rowOf(u));
    },
    async leaderboard(limit = 10) {
      return [...users.values()].filter(u => u.total_games > 0)
        .sort((a, b) => b.high_score - a.high_score || b.best_wave - a.best_wave)
        .slice(0, limit).map(u => publicUser(rowOf(u)));
    },
    async close() {},
  };
}

export const db = DATABASE_URL ? createPgStore() : createMemoryStore();
