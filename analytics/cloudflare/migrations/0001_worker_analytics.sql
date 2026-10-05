-- Worker-owned tables deliberately do not collide with the Python SQLite schema.
-- Safe to run again in the D1 Console. No PRAGMA journal_mode or credentials.
CREATE TABLE IF NOT EXISTS wa_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pageview', 'cv_download')),
  path TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'ZZ',
  region_code TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS wa_events_day ON wa_events(day);
CREATE TABLE IF NOT EXISTS wa_sessions (
  token TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_sessions_expires ON wa_sessions(expires);
CREATE TABLE IF NOT EXISTS wa_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_limits_expires ON wa_limits(expires);
CREATE TABLE IF NOT EXISTS wa_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
