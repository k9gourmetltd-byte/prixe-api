'use strict';

/**
 * Auth Routes
 * ────────────────────────────────────────────────────────────────────────────
 *   POST /api/v1/register          — Create a free API key
 *   GET  /api/v1/key/status        — Check quota / tier for current key
 */

const express   = require('express');
const crypto    = require('crypto');
const router    = express.Router();

const { apiKeys }            = require('../db/database');
const { registrationLimiter } = require('../middleware/rateLimit');
const { apiKeyMiddleware }    = require('../middleware/auth');

const FREE_REQUESTS = parseInt(process.env.FREE_REQUESTS_PER_IP || '3', 10);

// ── POST /register ────────────────────────────────────────────────────────────
router.post(
  '/register',
  registrationLimiter,
  (req, res) => {
    const ip    = req.ip;
    const label = sanitize(req.body?.label) || null;

    // Prevent a single IP from accumulating many free keys
    const existing = apiKeys.findByIp(ip);
    if (existing.length >= 5) {
      return res.status(429).json({
        error:   'too_many_keys',
        message: `Maximum 5 API keys per IP. You already have ${existing.length}.`,
        keys:    existing.map((k) => ({
          key:            k.key,
          free_remaining: k.free_remaining,
          created_at:     k.created_at,
        })),
      });
    }

    // Generate a cryptographically random key: "prixe_" + 32-byte hex
    const key = `prixe_${crypto.randomBytes(24).toString('hex')}`;

    try {
      apiKeys.create({ key, ip, label });
    } catch (e) {
      // Extremely unlikely collision on the random key
      return res.status(500).json({ error: 'key_creation_failed', message: e.message });
    }

    return res.status(201).json({
      success:        true,
      api_key:        key,
      tier:           'free',
      free_remaining: FREE_REQUESTS,
      message:        `Your API key has been created. You have ${FREE_REQUESTS} free requests.`,
      usage: {
        include_header: `X-API-Key: ${key}`,
        or_query_param: `?api_key=${key}`,
      },
      upgrade: {
        message:         'After your free requests are used up, send an x402 USDC payment.',
        price_per_call:  process.env.PRICE_PER_REQUEST_USDC || '0.002',
        currency:        'USDC',
        network:         'base-sepolia',
        payment_address: process.env.X402_PAYMENT_ADDRESS,
      },
    });
  }
);

// ── GET /key/status ───────────────────────────────────────────────────────────
router.get(
  '/key/status',
  apiKeyMiddleware({ required: true }),
  (req, res) => {
    const row = req.apiKeyRow;
    return res.json({
      success:        true,
      key:            row.key,
      tier:           row.tier,
      free_remaining: row.free_remaining,
      total_requests: row.total_requests,
      created_at:     row.created_at,
      last_used_at:   row.last_used_at,
    });
  }
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitize(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[^\w\s\-]/g, '').slice(0, 64);
}

module.exports = router;
