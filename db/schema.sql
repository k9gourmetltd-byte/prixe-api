-- ── API Keys ──────────────────────────────────────────────────────────────────
-- Free API keys for testing (first 3 requests free per key)
CREATE TABLE IF NOT EXISTS api_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT    NOT NULL UNIQUE,
  ip              TEXT    NOT NULL,
  label           TEXT,                          -- optional user-supplied label
  tier            TEXT    NOT NULL DEFAULT 'free', -- 'free' | 'paid'
  total_requests  INTEGER NOT NULL DEFAULT 0,
  free_remaining  INTEGER NOT NULL DEFAULT 3,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_ip  ON api_keys(ip);

-- ── Payment Sessions ──────────────────────────────────────────────────────────
-- Each x402 payment unlocks a 60-second session window
CREATE TABLE IF NOT EXISTS payment_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token   TEXT    NOT NULL UNIQUE,
  ip              TEXT    NOT NULL,
  tx_hash         TEXT    NOT NULL UNIQUE,
  amount_usdc     TEXT    NOT NULL,              -- stored as string to avoid float issues
  payer_address   TEXT,                          -- from-address of the payment tx
  requests_used   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT    NOT NULL,
  is_valid        INTEGER NOT NULL DEFAULT 1     -- 0 if revoked/double-spent
);

CREATE INDEX IF NOT EXISTS idx_sessions_token    ON payment_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_ip       ON payment_sessions(ip);
CREATE INDEX IF NOT EXISTS idx_sessions_tx_hash  ON payment_sessions(tx_hash);

-- ── Request Log ───────────────────────────────────────────────────────────────
-- Audit trail for all proxied requests
CREATE TABLE IF NOT EXISTS request_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ip              TEXT    NOT NULL,
  api_key         TEXT,
  session_token   TEXT,
  endpoint        TEXT    NOT NULL,
  ticker          TEXT,
  method          TEXT    NOT NULL DEFAULT 'GET',
  status_code     INTEGER,
  latency_ms      INTEGER,
  paid            INTEGER NOT NULL DEFAULT 0,    -- 1 if request was paid
  free_used       INTEGER NOT NULL DEFAULT 0,    -- 1 if free quota was consumed
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_log_ip         ON request_log(ip);
CREATE INDEX IF NOT EXISTS idx_log_created_at ON request_log(created_at);

-- ── Rate Limit Buckets ────────────────────────────────────────────────────────
-- Persistent minute/day counters per IP (supplement in-memory limiting)
CREATE TABLE IF NOT EXISTS rate_limits (
  ip              TEXT    NOT NULL,
  window          TEXT    NOT NULL,              -- 'minute' | 'day'
  bucket          TEXT    NOT NULL,              -- ISO timestamp of window start
  count           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window, bucket)
);

-- ── Used Tx Hashes ────────────────────────────────────────────────────────────
-- Prevent replay attacks (same tx hash used twice)
CREATE TABLE IF NOT EXISTS used_tx_hashes (
  tx_hash         TEXT    PRIMARY KEY,
  session_token   TEXT    NOT NULL,
  used_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
