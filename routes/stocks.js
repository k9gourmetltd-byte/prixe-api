'use strict';

/**
 * Stock Routes — Yahoo Finance backend
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET /api/v1/stock/price/:ticker       → v8/finance/chart  (snapshot)
 *   GET /api/v1/stock/historical/:ticker  → v8/finance/chart  (OHLCV range)
 *   GET /api/v1/stock/search?q=           → v1/finance/search
 *   GET /api/v1/balance                   → session / key quota check
 *
 * No API key required — Yahoo Finance is a public endpoint.
 * x402 payment flow and free tier are fully preserved.
 */

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const { requestLog }                        = require('../db/database');
const { x402Middleware, getSessionBalance } = require('../middleware/x402');
const { apiKeyMiddleware, freeTierGate }    = require('../middleware/auth');
const { rateLimitMiddleware }               = require('../middleware/rateLimit');

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo Finance HTTP client
// ─────────────────────────────────────────────────────────────────────────────
// Yahoo blocks requests without a browser-like User-Agent.
// The crumb / cookie approach is only needed for authenticated endpoints;
// chart and search are open — a realistic UA is sufficient.
const yahoo = axios.create({
  baseURL: 'https://query1.finance.yahoo.com',
  timeout: 12_000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json',
    // Some regions need an explicit language header to get English field values
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

// Fallback mirror — query2 is load-balanced alongside query1
const yahooFallback = axios.create({
  ...yahoo.defaults,
  baseURL: 'https://query2.finance.yahoo.com',
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware stack applied to all stock endpoints
// ─────────────────────────────────────────────────────────────────────────────
// Order is important:
//   1. Parse API key (optional — attaches req.apiKey / req.apiKeyRow)
//   2. x402 check   (optional — attaches req.isPaid / req.paymentSession)
//   3. Free-tier gate (blocks if neither paid nor has free quota)
//   4. Rate limiter
const paidStack = [
  apiKeyMiddleware({ required: false }),
  x402Middleware({ required: false }),
  freeTierGate,
  rateLimitMiddleware(),
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Validate ticker: uppercase letters, digits, dots, hyphens, 1–10 chars */
function validateTicker(t) {
  return typeof t === 'string' && /^[A-Z0-9.\-]{1,10}$/.test(t);
}

/** Attach paid/free meta to every successful response */
function freeMeta(req) {
  if (req.isPaid) return { paid: true, remaining_free: null };
  return { paid: false, remaining_free: req.freeRemaining ?? 0 };
}

/** Non-fatal request audit log */
function logRequest(req, { endpoint, ticker, statusCode, latencyMs }) {
  try {
    requestLog.insert({
      ip:           req.ip,
      apiKey:       req.apiKey                            || null,
      sessionToken: req.paymentSession?.session_token     || null,
      endpoint,
      ticker:       ticker || null,
      method:       req.method,
      statusCode,
      latencyMs,
      paid:         !!req.isPaid,
      freeUsed:     !!req.freeUsed,
    });
  } catch (_) { /* never let logging crash a response */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo Finance data fetchers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a single-bar chart snapshot from Yahoo Finance v8.
 * Returns the raw result[0] object.
 */
async function fetchYahooChart(ticker, params = {}) {
  const path = `/v8/finance/chart/${encodeURIComponent(ticker)}`;
  let res;
  try {
    res = await yahoo.get(path, { params });
  } catch (err) {
    // Try mirror on network error (not on 4xx — those are definitive)
    if (!err.response) {
      res = await yahooFallback.get(path, { params });
    } else {
      throw err;
    }
  }

  const chart = res.data?.chart;
  if (chart?.error) {
    const e = new Error(chart.error.description || 'Yahoo returned an error');
    e.yahooCode = chart.error.code;
    // Map Yahoo's "Not Found" to a 404-like signal
    if (chart.error.code === 'Not Found') e.status = 404;
    throw e;
  }

  const result = chart?.result?.[0];
  if (!result) throw new Error('Yahoo Finance returned an empty result');
  return result;
}

/**
 * Map days → Yahoo's range + interval params.
 * 1d uses intraday interval so we still get today's bar.
 */
const DAYS_TO_PARAMS = {
  1:   { range: '1d',  interval: '5m'  },
  7:   { range: '5d',  interval: '1d'  },
  30:  { range: '1mo', interval: '1d'  },
  90:  { range: '3mo', interval: '1d'  },
  365: { range: '1y',  interval: '1wk' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Response parsers / normalisers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse Yahoo v8 chart meta into our price snapshot shape.
 *
 * Yahoo meta fields used:
 *   regularMarketPrice          — current last price
 *   chartPreviousClose          — previous session close (most reliable for change calc)
 *   regularMarketChange         — provided directly; we also compute as fallback
 *   regularMarketChangePercent  — provided directly
 *   regularMarketVolume         — current volume
 *   regularMarketDayHigh/Low    — intraday range
 *   regularMarketTime           — unix timestamp of last price
 *   fiftyTwoWeekHigh/Low
 *   currency, exchangeName, fullExchangeName
 */
function parsePriceSnapshot(ticker, result) {
  const m = result.meta;

  const price    = m.regularMarketPrice         ?? m.postMarketPrice ?? null;
  const prevClose = m.chartPreviousClose        ?? m.previousClose   ?? null;

  // Prefer Yahoo's pre-computed change; fall back to manual calculation
  const change    = m.regularMarketChange
    ?? (price !== null && prevClose !== null ? price - prevClose : null);
  const changePct = m.regularMarketChangePercent
    ?? (change !== null && prevClose ? (change / prevClose) * 100 : null);

  return {
    ticker,
    price:          fmtPrice(price),
    change:         fmtChange(change),
    change_percent: fmtChangePct(changePct),
    volume:         fmtVolume(m.regularMarketVolume),
    // Extended fields (bonus — same contract, just more data)
    open:           fmtPrice(m.regularMarketOpen    ?? m.chartPreviousClose),
    day_high:       fmtPrice(m.regularMarketDayHigh),
    day_low:        fmtPrice(m.regularMarketDayLow),
    week_52_high:   fmtPrice(m.fiftyTwoWeekHigh),
    week_52_low:    fmtPrice(m.fiftyTwoWeekLow),
    previous_close: fmtPrice(prevClose),
    currency:       m.currency         || 'USD',
    exchange:       m.fullExchangeName || m.exchangeName || null,
    market_state:   m.marketState      || null,   // REGULAR | PRE | POST | CLOSED
    timestamp:      m.regularMarketTime
      ? new Date(m.regularMarketTime * 1000).toISOString()
      : new Date().toISOString(),
    source: 'yahoo-finance',
  };
}

/**
 * Parse Yahoo v8 chart timestamps + indicators into OHLCV rows.
 * Skips bars where close is null (gaps / market-closed bars).
 */
function parseOHLCV(result) {
  const timestamps = result.timestamp              || [];
  const quote      = result.indicators?.quote?.[0] || {};
  const opens      = quote.open   || [];
  const highs      = quote.high   || [];
  const lows       = quote.low    || [];
  const closes     = quote.close  || [];
  const volumes    = quote.volume || [];

  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    // Skip null / weekend bars
    if (closes[i] == null) continue;
    rows.push({
      date:   new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open:   round4(opens[i]),
      high:   round4(highs[i]),
      low:    round4(lows[i]),
      close:  round4(closes[i]),
      volume: volumes[i] ?? null,
    });
  }
  return rows;
}

/**
 * Parse Yahoo v1 search quotes into our search result shape.
 */
function parseSearchResults(quotes) {
  return (quotes || []).map((q) => ({
    ticker:   q.symbol                      || null,
    name:     q.longname || q.shortname     || null,
    exchange: q.exchDisp                    || null,
    type:     q.typeDisp                    || q.quoteType || null,
    score:    q.score != null ? Math.round(q.score) : null,
    currency: 'USD', // Yahoo search doesn't return currency; assume USD
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function toNum(v)     { const n = parseFloat(v); return isNaN(n) ? null : n; }
function round4(v)    { const n = toNum(v); return n !== null ? Math.round(n * 10000) / 10000 : null; }

/** "182.50"  (no $ — matches the requested response format exactly) */
function fmtPrice(v)  {
  const n = toNum(v);
  return n !== null ? n.toFixed(2) : null;
}

/** "+1.25" or "-3.00" */
function fmtChange(v) {
  const n = toNum(v);
  if (n === null) return null;
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

/** "+0.69%" or "-1.23%" */
function fmtChangePct(v) {
  const n = toNum(v);
  if (n === null) return null;
  return n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
}

/** "45,123,456" */
function fmtVolume(v) {
  const n = toNum(v);
  if (n === null) return null;
  return Math.round(n).toLocaleString('en-US');
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /stock/price/:ticker ──────────────────────────────────────────────────
router.get('/stock/price/:ticker', ...paidStack, async (req, res) => {
  const ticker  = req.params.ticker?.toUpperCase().trim();
  const started = Date.now();

  if (!validateTicker(ticker)) {
    return res.status(400).json({
      error:   'invalid_ticker',
      message: 'Ticker must be 1–10 uppercase letters, digits, dots, or hyphens (e.g. AAPL, BRK.B)',
    });
  }

  try {
    // interval=1d + range=1d gives a single intraday bar with all meta fields populated
    const result  = await fetchYahooChart(ticker, { interval: '1d', range: '1d' });
    const latency = Date.now() - started;

    logRequest(req, { endpoint: 'price', ticker, statusCode: 200, latencyMs: latency });

    return res.json({
      success: true,
      data:    parsePriceSnapshot(ticker, result),
      ...freeMeta(req),
      latency_ms: latency,
    });
  } catch (err) {
    const latency = Date.now() - started;
    logRequest(req, { endpoint: 'price', ticker, statusCode: err.status || 502, latencyMs: latency });
    return handleYahooError(res, err, ticker);
  }
});

// ── GET /stock/historical/:ticker ─────────────────────────────────────────────
router.get('/stock/historical/:ticker', ...paidStack, async (req, res) => {
  const ticker  = req.params.ticker?.toUpperCase().trim();
  const days    = parseInt(req.query.days || '7', 10);
  const started = Date.now();

  if (!validateTicker(ticker)) {
    return res.status(400).json({
      error:   'invalid_ticker',
      message: 'Ticker must be 1–10 uppercase letters, digits, dots, or hyphens',
    });
  }

  const allowedDays = [1, 7, 30, 90, 365];
  if (!allowedDays.includes(days)) {
    return res.status(400).json({
      error:   'invalid_days',
      message: `days must be one of: ${allowedDays.join(', ')}`,
    });
  }

  try {
    const yahooParams = DAYS_TO_PARAMS[days];
    const result      = await fetchYahooChart(ticker, yahooParams);
    const latency     = Date.now() - started;

    logRequest(req, { endpoint: 'historical', ticker, statusCode: 200, latencyMs: latency });

    const history = parseOHLCV(result);

    return res.json({
      success: true,
      data: {
        ticker,
        days,
        interval: yahooParams.interval,
        count:    history.length,
        history,
        source:   'yahoo-finance',
      },
      ...freeMeta(req),
      latency_ms: latency,
    });
  } catch (err) {
    const latency = Date.now() - started;
    logRequest(req, { endpoint: 'historical', ticker, statusCode: err.status || 502, latencyMs: latency });
    return handleYahooError(res, err, ticker);
  }
});

// ── GET /stock/search ─────────────────────────────────────────────────────────
router.get('/stock/search', ...paidStack, async (req, res) => {
  const q       = String(req.query.q || '').trim();
  const started = Date.now();

  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'q parameter is required' });
  }
  if (q.length > 60) {
    return res.status(400).json({ error: 'query_too_long', message: 'q must be 60 characters or fewer' });
  }

  try {
    // Yahoo Finance v1 search — returns up to quotesCount matching instruments
    let res2;
    try {
      res2 = await yahoo.get('/v1/finance/search', {
        params: { q, quotesCount: 10, newsCount: 0, enableFuzzyQuery: false },
      });
    } catch (err) {
      if (!err.response) {
        res2 = await yahooFallback.get('/v1/finance/search', {
          params: { q, quotesCount: 10, newsCount: 0, enableFuzzyQuery: false },
        });
      } else {
        throw err;
      }
    }

    const latency = Date.now() - started;
    logRequest(req, { endpoint: 'search', ticker: null, statusCode: 200, latencyMs: latency });

    const quotes  = res2.data?.finance?.result?.[0]?.documents   // older shape
                 ?? res2.data?.quotes                             // v1 shape
                 ?? [];
    const results = parseSearchResults(quotes);

    return res.json({
      success: true,
      data: {
        query:   q,
        count:   results.length,
        results,
        source:  'yahoo-finance',
      },
      ...freeMeta(req),
      latency_ms: latency,
    });
  } catch (err) {
    const latency = Date.now() - started;
    logRequest(req, { endpoint: 'search', ticker: null, statusCode: err.response?.status || 502, latencyMs: latency });
    return handleYahooError(res, err, null);
  }
});

// ── GET /balance ──────────────────────────────────────────────────────────────
router.get('/balance', (req, res) => {
  const sessionToken = req.headers['x-402-session'] || req.query.session_token;
  const apiKey       = req.headers['x-api-key']     || req.query.api_key;

  if (sessionToken) {
    const balance = getSessionBalance(sessionToken);
    if (!balance) {
      return res.status(404).json({
        error:   'session_not_found',
        message: 'Session not found or expired',
      });
    }
    return res.json({
      success:       true,
      type:          'payment_session',
      seconds_left:  Math.max(0, balance.seconds_left),
      requests_used: balance.requests_used,
      paid:          true,
    });
  }

  if (apiKey) {
    const { apiKeys: db } = require('../db/database');
    const row = db.findByKey(apiKey);
    if (!row) {
      return res.status(401).json({ error: 'invalid_api_key', message: 'API key not found' });
    }
    return res.json({
      success:        true,
      type:           'api_key',
      tier:           row.tier,
      free_remaining: row.free_remaining,
      total_requests: row.total_requests,
      paid:           row.tier === 'paid',
    });
  }

  return res.status(400).json({
    error:   'missing_credentials',
    message: 'Provide an X-402-Session or X-API-Key header',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Upstream error handler
// ─────────────────────────────────────────────────────────────────────────────
function handleYahooError(res, err, ticker) {
  // Yahoo-specific "Not Found" signal set above in fetchYahooChart
  if (err.status === 404 || err.yahooCode === 'Not Found') {
    return res.status(404).json({
      error:   'ticker_not_found',
      message: ticker
        ? `Yahoo Finance has no data for ticker "${ticker}". Check the symbol and try again.`
        : 'Resource not found',
    });
  }

  if (err.response) {
    const s = err.response.status;

    if (s === 429) {
      return res.status(429).json({
        error:       'upstream_rate_limited',
        message:     'Yahoo Finance is temporarily rate-limiting this server. Retry in a few seconds.',
        retry_after: 10,
      });
    }

    if (s === 404) {
      return res.status(404).json({
        error:   'ticker_not_found',
        message: ticker ? `No data found for "${ticker}"` : 'Not found',
      });
    }

    return res.status(502).json({
      error:   'upstream_error',
      message: `Yahoo Finance responded with HTTP ${s}`,
    });
  }

  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ETIME') {
    return res.status(504).json({
      error:   'upstream_timeout',
      message: 'Yahoo Finance did not respond in time. Try again.',
    });
  }

  console.error('[stocks] Yahoo Finance error:', err.message);
  return res.status(502).json({
    error:   'upstream_unavailable',
    message: 'Could not reach Yahoo Finance. Try again later.',
  });
}

module.exports = router;
