-- Skema Neon/Postgres. Server juga membuat tabel ini otomatis saat start,
-- file ini hanya dokumentasi / untuk dijalankan manual di Neon SQL Editor.
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(16)  NOT NULL,
  username_lower VARCHAR(16)  NOT NULL UNIQUE,
  pass_hash      TEXT         NOT NULL,
  high_score     INTEGER      NOT NULL DEFAULT 0,
  best_wave      INTEGER      NOT NULL DEFAULT 0,   -- lantai (wave) tertinggi yang diselesaikan
  total_kills    INTEGER      NOT NULL DEFAULT 0,
  total_games    INTEGER      NOT NULL DEFAULT 0,
  total_score    BIGINT       NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_login     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS users_high_score_idx ON users (high_score DESC);
