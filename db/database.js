'use strict';

const path      = require('path');
const fs        = require('fs');
const Database  = require('better-sqlite3');

// ── Resolve DB path ────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'prixe.db');
const DATA_DIR = path.dirname(DB_PATH);

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Open database (singleton) ─────────────────────────────────────────────────
let _db;

function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH, {
    verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
  });

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous  = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('cache_size   = -16000'); // 16 MB

  // Apply schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);

  return _db;
}

// ── Prepared-statement cache ───────────────────────────────────────────────────
const _stmts = {};

function stmt(sql) {
  if (!_stmts[sql]) {
    _stmts[sql] = getDb().prepare(sql);
  }
  return _stmts[sql];
}

// ── API Keys ───────────────────────────────────────────────────────────────────
const apiKeys = {
  create({ key, ip, label }) {
    return stmt(`
      INSERT INTO api_keys (key, ip, label)
      VALUES (@key, @ip, @label)
    `).run({ key, ip, label: label || null });
  },

  findByKey(key) {
    return stmt(`SELECT * FROM api_keys WHERE key = ?`).get(key);
  },

  findByIp(ip) {
    return stmt(`SELECT * FROM api_keys WHERE ip = ? ORDER BY created_at DESC`).all(ip);
  },

  /** Atomically decrement free_remaining and increment total_requests */
  consumeFree(key) {
    return getDb().transaction(() => {
      const row = stmt(`SELECT free_remaining FROM api_keys WHERE key = ?`).get(key);
      if (!row || row.free_remaining <= 0) return false;
      stmt(`
        UPDATE api_keys
        SET free_remaining = free_remaining - 1,
            total_requests = total_requests + 1,
            last_used_at   = datetime('now')
        WHERE key = ?
      `).run(key);
      return true;
    })();
  },

  incrementUsage(key) {
    stmt(`
      UPDATE api_keys
      SET total_requests = total_requests + 1,
          last_used_at   = datetime('now')
      WHERE key = ?
    `).run(key);
  },
};

// ── Payment Sessions ───────────────────────────────────────────────────────────
const sessions = {
  create({ sessionToken, ip, txHash, amountUsdc, payerAddress, expiresAt }) {
    return stmt(`
      INSERT INTO payment_sessions
        (session_token, ip, tx_hash, amount_usdc, payer_address, expires_at)
      VALUES
        (@sessionToken, @ip, @txHash, @amountUsdc, @payerAddress, @expiresAt)
    `).run({ sessionToken, ip, txHash, amountUsdc, payerAddress, expiresAt });
  },

  findByToken(token) {
    return stmt(`
      SELECT * FROM payment_sessions
      WHERE session_token = ? AND is_valid = 1
    `).get(token);
  },

  /** Returns a valid, unexpired session for this IP */
  findActiveByIp(ip) {
    return stmt(`
      SELECT * FROM payment_sessions
      WHERE ip = ? AND is_valid = 1 AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).get(ip);
  },

  isTxHashUsed(txHash) {
    return !!stmt(`SELECT 1 FROM used_tx_hashes WHERE tx_hash = ?`).get(txHash);
  },

  markTxHashUsed(txHash, sessionToken) {
    stmt(`
      INSERT OR IGNORE INTO used_tx_hashes (tx_hash, session_token)
      VALUES (?, ?)
    `).run(txHash, sessionToken);
  },

  incrementUsage(token) {
    stmt(`
      UPDATE payment_sessions
      SET requests_used = requests_used + 1
      WHERE session_token = ?
    `).run(token);
  },

  getBalance(token) {
    const row = stmt(`
      SELECT requests_used,
             CAST((julianday(expires_at) - julianday('now')) * 86400 AS INTEGER) AS seconds_left
      FROM payment_sessions
      WHERE session_token = ? AND is_valid = 1
    `).get(token);
    return row || null;
  },
};

// ── Request Log ────────────────────────────────────────────────────────────────
const requestLog = {
  insert({ ip, apiKey, sessionToken, endpoint, ticker, method, statusCode, latencyMs, paid, freeUsed }) {
    stmt(`
      INSERT INTO request_log
        (ip, api_key, session_token, endpoint, ticker, method, status_code, latency_ms, paid, free_used)
      VALUES
        (@ip, @apiKey, @sessionToken, @endpoint, @ticker, @method, @statusCode, @latencyMs, @paid, @freeUsed)
    `).run({
      ip,
      apiKey:       apiKey       || null,
      sessionToken: sessionToken || null,
      endpoint,
      ticker:       ticker       || null,
      method:       method       || 'GET',
      statusCode:   statusCode   || null,
      latencyMs:    latencyMs    || null,
      paid:         paid         ? 1 : 0,
      freeUsed:     freeUsed     ? 1 : 0,
    });
  },

  /** Count requests by IP in a rolling window (minutes ago) */
  countByIpSince(ip, minutesAgo) {
    return stmt(`
      SELECT COUNT(*) AS cnt FROM request_log
      WHERE ip = ? AND created_at >= datetime('now', ? || ' minutes')
    `).get(ip, String(-minutesAgo)).cnt;
  },

  /** Count requests by IP today */
  countByIpToday(ip) {
    return stmt(`
      SELECT COUNT(*) AS cnt FROM request_log
      WHERE ip = ? AND date(created_at) = date('now')
    `).get(ip).cnt;
  },
};

// ── Free-request tracker (by raw IP, no API key) ───────────────────────────────
const freeUsage = {
  /** Count how many free (no api_key, no session) requests this IP has made */
  countForIp(ip) {
    return stmt(`
      SELECT COUNT(*) AS cnt FROM request_log
      WHERE ip = ? AND paid = 0 AND free_used = 1
    `).get(ip).cnt;
  },
};

// ── Cleanup helpers ────────────────────────────────────────────────────────────
function cleanup() {
  // Delete expired sessions older than 24 h
  stmt(`DELETE FROM payment_sessions WHERE expires_at < datetime('now', '-24 hours')`).run();
  // Delete request log older than 30 days
  stmt(`DELETE FROM request_log WHERE created_at < datetime('now', '-30 days')`).run();
}

// Run cleanup every hour
setInterval(cleanup, 60 * 60 * 1000);

// ── CLI init ───────────────────────────────────────────────────────────────────
if (require.main === module && process.argv.includes('--init')) {
  getDb(); // triggers schema creation
  console.log(`✅  Database initialised at ${DB_PATH}`);
  process.exit(0);
}

module.exports = { getDb, apiKeys, sessions, requestLog, freeUsage, cleanup };
