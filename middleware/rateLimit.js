'use strict';

/**
 * Rate Limiting Middleware
 * ────────────────────────────────────────────────────────────────────────────
 * Two-layer approach:
 *   1. In-memory sliding window (fast path, no DB hit)
 *   2. SQLite request_log counts (authoritative, survives restarts)
 *
 * Tiers:
 *   free  →   10 req/min,  100 req/day
 *   paid  →   10 req/min, 1000 req/day  (payment resets daily limit)
 */

const { requestLog } = require('../db/database');

// ── In-memory minute-window buckets ───────────────────────────────────────────
// Map<ip, { count, windowStart }>
const minuteBuckets = new Map();

// Purge stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, bucket] of minuteBuckets) {
    if (bucket.windowStart < cutoff) minuteBuckets.delete(ip);
  }
}, 5 * 60 * 1000);

function checkMinuteLimit(ip, maxPerMinute = 10) {
  const now    = Date.now();
  const bucket = minuteBuckets.get(ip) || { count: 0, windowStart: now };

  // Reset bucket if older than 1 minute
  if (now - bucket.windowStart > 60_000) {
    bucket.count       = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  minuteBuckets.set(ip, bucket);

  const remaining  = Math.max(0, maxPerMinute - bucket.count);
  const resetAfter = Math.ceil((bucket.windowStart + 60_000 - now) / 1000);

  return {
    allowed:    bucket.count <= maxPerMinute,
    remaining,
    resetAfter, // seconds until window resets
  };
}

// ── Daily limit (DB-backed) ───────────────────────────────────────────────────
function checkDailyLimit(ip, maxPerDay) {
  const count     = requestLog.countByIpToday(ip);
  const remaining = Math.max(0, maxPerDay - count);
  return {
    allowed:   count < maxPerDay,
    count,
    remaining,
  };
}

// ── Middleware factory ────────────────────────────────────────────────────────
/**
 * @param {object} [opts]
 * @param {number}  [opts.maxPerMinute=10]
 * @param {number}  [opts.freeMaxPerDay=100]
 * @param {number}  [opts.paidMaxPerDay=1000]
 * @param {boolean} [opts.trustPaidFlag=true]  Read req.isPaid to choose tier
 */
function rateLimitMiddleware(opts = {}) {
  const {
    maxPerMinute  = 10,
    freeMaxPerDay = 100,
    paidMaxPerDay = 1000,
    trustPaidFlag = true,
  } = opts;

  return function (req, res, next) {
    const ip     = req.ip;
    const isPaid = trustPaidFlag ? !!req.isPaid : false;
    const dayMax = isPaid ? paidMaxPerDay : freeMaxPerDay;

    // 1. Per-minute check (fast, in-memory)
    const minuteResult = checkMinuteLimit(ip, maxPerMinute);

    res.setHeader('X-RateLimit-Limit-Minute',     String(maxPerMinute));
    res.setHeader('X-RateLimit-Remaining-Minute', String(minuteResult.remaining));
    res.setHeader('X-RateLimit-Reset-Minute',     String(minuteResult.resetAfter));

    if (!minuteResult.allowed) {
      return res.status(429).json({
        error:       'rate_limit_exceeded',
        message:     `Too many requests. Limit: ${maxPerMinute} per minute.`,
        retry_after: minuteResult.resetAfter,
      });
    }

    // 2. Daily check (DB-backed)
    const dayResult = checkDailyLimit(ip, dayMax);

    res.setHeader('X-RateLimit-Limit-Day',     String(dayMax));
    res.setHeader('X-RateLimit-Remaining-Day', String(dayResult.remaining));

    if (!dayResult.allowed) {
      const message = isPaid
        ? `Daily limit of ${dayMax} requests reached.`
        : `Free daily limit of ${dayMax} reached. Make an x402 payment to unlock ${paidMaxPerDay}/day.`;

      return res.status(429).json({
        error:           'daily_limit_exceeded',
        message,
        tier:            isPaid ? 'paid' : 'free',
        paid_daily_limit: paidMaxPerDay,
        resets_at:       new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
      });
    }

    next();
  };
}

// ── Strict limiter for registration endpoint ──────────────────────────────────
// Map<ip, { count, windowStart }>
const registrationBuckets = new Map();

function registrationLimiter(req, res, next) {
  const ip     = req.ip;
  const now    = Date.now();
  const bucket = registrationBuckets.get(ip) || { count: 0, windowStart: now };

  if (now - bucket.windowStart > 60_000) {
    bucket.count       = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  registrationBuckets.set(ip, bucket);

  if (bucket.count > 5) {
    return res.status(429).json({
      error:       'registration_limit_exceeded',
      message:     'Too many registration attempts. Maximum 5 per minute.',
      retry_after: Math.ceil((bucket.windowStart + 60_000 - now) / 1000),
    });
  }

  next();
}

module.exports = { rateLimitMiddleware, registrationLimiter, checkMinuteLimit, checkDailyLimit };
