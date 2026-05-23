'use strict';

/**
 * API Key Authentication Middleware
 * ────────────────────────────────────────────────────────────────────────────
 * Validates keys sent via:
 *   - Header:       X-API-Key: <key>
 *   - Query param:  ?api_key=<key>
 *
 * Sets on req:
 *   req.apiKey      — the raw key string
 *   req.apiKeyRow   — the full DB row for the key
 *   req.isFreeKey   — true if this is a free-tier API key
 *   req.freeRemaining — how many free calls remain
 */

const { apiKeys, freeUsage } = require('../db/database');

const FREE_REQUESTS_PER_IP = parseInt(process.env.FREE_REQUESTS_PER_IP || '3', 10);

// ── Extract key from request ──────────────────────────────────────────────────
function extractKey(req) {
  return (
    req.headers['x-api-key'] ||
    req.query.api_key         ||
    null
  );
}

// ── API key validator ─────────────────────────────────────────────────────────
/**
 * @param {object}  opts
 * @param {boolean} [opts.required=false]  If true, reject requests with no valid key.
 *                                         If false, attach key info but still allow through.
 */
function apiKeyMiddleware(opts = {}) {
  const required = opts.required === true;

  return function (req, res, next) {
    const key = extractKey(req);

    if (!key) {
      if (required) {
        return res.status(401).json({
          error:   'api_key_required',
          message: 'Provide your API key via the X-API-Key header or ?api_key= query param',
          hint:    'POST /api/v1/register to get a free key with 3 trial requests',
        });
      }
      req.apiKey = null;
      return next();
    }

    const row = apiKeys.findByKey(key);

    if (!row) {
      return res.status(401).json({
        error:   'invalid_api_key',
        message: 'The provided API key is not recognised',
      });
    }

    req.apiKey      = key;
    req.apiKeyRow   = row;
    req.isFreeKey   = row.tier === 'free';
    req.freeRemaining = row.free_remaining;

    next();
  };
}

// ── Free-tier gate ────────────────────────────────────────────────────────────
/**
 * Placed after apiKeyMiddleware + x402Middleware.
 * Allows the request to proceed if ANY of:
 *   1. req.isPaid          — valid x402 payment session
 *   2. req.apiKeyRow with free_remaining > 0  — consumes one free call
 *   3. No API key but raw-IP free quota not exhausted
 *
 * Adds req.freeUsed = true when a free quota slot is consumed.
 */
function freeTierGate(req, res, next) {
  // Already paid via x402 — nothing to do
  if (req.isPaid) return next();

  const ip = req.ip;

  // ── API key path ────────────────────────────────────────────────────────────
  if (req.apiKeyRow) {
    if (req.apiKeyRow.free_remaining > 0) {
      const ok = apiKeys.consumeFree(req.apiKey);
      if (ok) {
        req.freeUsed = true;
        req.freeRemaining = req.apiKeyRow.free_remaining - 1;
        return next();
      }
    }
    // Key exists but quota exhausted
    return res.status(402).json({
      error:         'free_quota_exhausted',
      message:       'Your free request quota is used up. Make an x402 payment to continue.',
      free_remaining: 0,
      ..._buildPaymentHint(),
    });
  }

  // ── No API key — fall back to raw-IP free quota ───────────────────────────
  const usedByIp = freeUsage.countForIp(ip);
  if (usedByIp < FREE_REQUESTS_PER_IP) {
    req.freeUsed      = true;
    req.freeRemaining = FREE_REQUESTS_PER_IP - usedByIp - 1;
    return next();
  }

  // No quota remaining at all
  return res.status(402).json({
    error:         'payment_required',
    message:       `Free quota exhausted (${FREE_REQUESTS_PER_IP} requests per IP). Register an API key or make an x402 payment.`,
    free_remaining: 0,
    ..._buildPaymentHint(),
  });
}

function _buildPaymentHint() {
  const price   = process.env.PRICE_PER_REQUEST_USDC || '0.002';
  const address = process.env.X402_PAYMENT_ADDRESS;
  return {
    invoice: {
      amount:          price,
      currency:        'USDC',
      network:         'base-sepolia',
      payment_address: address,
      expires_in:      300,
    },
  };
}

module.exports = { apiKeyMiddleware, freeTierGate, extractKey };
