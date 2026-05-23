'use strict';

/**
 * Prixe x402 API Gateway
 * ────────────────────────────────────────────────────────────────────────────
 * Entry point. Boots Express, registers all middleware and routes.
 */

// ── Environment ───────────────────────────────────────────────────────────────
require('dotenv').config();

const REQUIRED_ENV = [
  'PRIXE_API_KEY',
  'X402_PAYMENT_ADDRESS',
  'USDC_CONTRACT_ADDRESS',
  'BASE_SEPOLIA_RPC_URL',
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌  Missing required environment variables:', missing.join(', '));
  console.error('    Copy .env.example → .env and fill in the values.');
  process.exit(1);
}

// ── Imports ───────────────────────────────────────────────────────────────────
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');

const stockRoutes = require('./routes/stocks');
const authRoutes  = require('./routes/auth');
const { getDb }   = require('./db/database');

// ── App setup ─────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin:  '*',              // tighten for production
    methods: ['GET', 'POST'],
    allowedHeaders: [
      'Content-Type',
      'X-API-Key',
      'X-402-Payment',
      'X-402-Session',
    ],
    exposedHeaders: [
      'X-402-Price',
      'X-402-Currency',
      'X-402-Network',
      'X-402-Address',
      'X-402-Session',
      'X-402-Session-Expires',
      'X-402-Session-Window',
      'X-RateLimit-Limit-Minute',
      'X-RateLimit-Remaining-Minute',
      'X-RateLimit-Reset-Minute',
      'X-RateLimit-Limit-Day',
      'X-RateLimit-Remaining-Day',
    ],
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Request logging ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(
    morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev')
  );
}

// ── Trust proxy (for correct req.ip behind nginx / Railway / Render) ──────────
app.set('trust proxy', 1);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    version: require('./package.json').version,
    time:    new Date().toISOString(),
    db:      (() => { try { getDb(); return 'ok'; } catch { return 'error'; } })(),
  });
});

// ── API info ──────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name:        'Prixe x402 Stock API',
    version:     require('./package.json').version,
    description: 'Production-ready API wrapper for Prixe Stock API with x402 crypto payments',
    endpoints: {
      register:   'POST /api/v1/register',
      key_status: 'GET  /api/v1/key/status',
      price:      'GET  /api/v1/stock/price/:ticker',
      historical: 'GET  /api/v1/stock/historical/:ticker?days=7',
      search:     'GET  /api/v1/stock/search?q=Apple',
      balance:    'GET  /api/v1/balance',
    },
    payment: {
      protocol:  'x402',
      currency:  'USDC',
      network:   'base-sepolia',
      price:     `$${process.env.PRICE_PER_REQUEST_USDC || '0.002'} per request`,
      address:   process.env.X402_PAYMENT_ADDRESS,
    },
    free_tier: {
      requests: parseInt(process.env.FREE_REQUESTS_PER_IP || '3', 10),
      note:     'First N requests per IP or API key are free',
    },
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1', authRoutes);
app.use('/api/v1', stockRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:   'not_found',
    message: `${req.method} ${req.path} is not a valid endpoint`,
    docs:    'GET / for available endpoints',
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[global error]', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error:   'internal_error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  const line = '─'.repeat(60);
  console.log(line);
  console.log(`  🚀  Prixe x402 API Gateway`);
  console.log(`  📡  http://localhost:${PORT}`);
  console.log(`  💰  x402 address : ${process.env.X402_PAYMENT_ADDRESS}`);
  console.log(`  💵  Price/request: $${process.env.PRICE_PER_REQUEST_USDC || '0.002'} USDC`);
  console.log(`  🎁  Free requests: ${process.env.FREE_REQUESTS_PER_IP || '3'} per IP`);
  console.log(`  🌐  Network       : Base Sepolia`);
  console.log(line);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    try {
      getDb().close();
      console.log('SQLite connection closed.');
    } catch (_) {}
    process.exit(0);
  });

  // Force-quit if still open after 10 s
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app; // for testing
