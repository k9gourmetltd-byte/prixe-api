'use strict';

/**
 * x402 Payment Middleware
 * ────────────────────────────────────────────────────────────────────────────
 * Implements the x402 / L402 payment-required flow on top of USDC (Base Sepolia).
 *
 * Request lifecycle
 * ─────────────────
 *   1.  No payment header  →  Return 402 with invoice
 *   2.  X-402-Payment: <txHash>  →  Verify on-chain  →  Issue session token
 *   3.  X-402-Session: <token>   →  Validate session  →  Pass through
 *   4.  Active session already in DB for this IP  →  Pass through (session reuse)
 *
 * Headers sent by client
 * ──────────────────────
 *   X-402-Payment : <transaction_hash>   (first call after paying)
 *   X-402-Session : <session_token>      (subsequent calls in same window)
 */

const { ethers }   = require('ethers');
const crypto       = require('crypto');
const { sessions, requestLog } = require('../db/database');

// ── Constants ─────────────────────────────────────────────────────────────────
const USDC_ABI = [
  // Transfer event
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  // balanceOf
  'function balanceOf(address owner) view returns (uint256)',
  // decimals
  'function decimals() view returns (uint8)',
];

const USDC_DECIMALS = 6; // USDC always has 6 decimals

// ── Lazy provider singleton ────────────────────────────────────────────────────
let _provider;
function getProvider() {
  if (_provider) return _provider;
  const rpc = process.env.BASE_SEPOLIA_RPC_URL;
  if (!rpc) throw new Error('BASE_SEPOLIA_RPC_URL not set');
  _provider = new ethers.JsonRpcProvider(rpc);
  return _provider;
}

// ── Price helper ──────────────────────────────────────────────────────────────
function getPriceInUnits() {
  const usd = parseFloat(process.env.PRICE_PER_REQUEST_USDC || '0.002');
  // USDC has 6 decimals → multiply by 1e6
  return BigInt(Math.round(usd * 1_000_000));
}

// ── Build a 402 response body ─────────────────────────────────────────────────
function build402Body() {
  const price   = parseFloat(process.env.PRICE_PER_REQUEST_USDC || '0.002');
  const address = process.env.X402_PAYMENT_ADDRESS;
  return {
    error:   'payment_required',
    message: `This endpoint costs $${price} USDC on Base Sepolia`,
    invoice: {
      amount:          String(price),
      currency:        'USDC',
      network:         'base-sepolia',
      payment_address: address,
      usdc_contract:   process.env.USDC_CONTRACT_ADDRESS,
      expires_in:      300,   // seconds before this invoice should be considered stale
    },
    instructions: {
      step1: `Send exactly ${price} USDC to ${address} on Base Sepolia`,
      step2: 'Retry your request with header: X-402-Payment: <your_tx_hash>',
      step3: 'Save the returned X-402-Session token for subsequent requests (valid 60s)',
    },
  };
}

// ── Verify a USDC Transfer on-chain ───────────────────────────────────────────
async function verifyUsdcPayment(txHash) {
  const provider      = getProvider();
  const usdcAddress   = process.env.USDC_CONTRACT_ADDRESS;
  const targetAddress = process.env.X402_PAYMENT_ADDRESS?.toLowerCase();
  const requiredUnits = getPriceInUnits();
  const minConf       = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);

  if (!usdcAddress || !targetAddress) {
    throw new Error('USDC_CONTRACT_ADDRESS or X402_PAYMENT_ADDRESS not configured');
  }

  // 1. Fetch receipt
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (e) {
    throw new Error(`RPC error fetching receipt: ${e.message}`);
  }

  if (!receipt) {
    throw new Error('Transaction not found or not yet mined');
  }
  if (!receipt.status) {
    throw new Error('Transaction reverted on-chain');
  }

  // 2. Confirmation check
  const currentBlock = await provider.getBlockNumber();
  const confirmations = currentBlock - Number(receipt.blockNumber) + 1;
  if (confirmations < minConf) {
    throw new Error(`Only ${confirmations}/${minConf} confirmations so far`);
  }

  // 3. Verify it's to the correct USDC contract
  const usdcLower = usdcAddress.toLowerCase();
  if (receipt.to?.toLowerCase() !== usdcLower) {
    throw new Error('Transaction was not sent to the USDC contract');
  }

  // 4. Parse Transfer events from logs
  const iface = new ethers.Interface(USDC_ABI);
  let transferFound = false;
  let payerAddress  = null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcLower) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== 'Transfer') continue;

    const to    = parsed.args.to.toLowerCase();
    const value = BigInt(parsed.args.value.toString());

    if (to === targetAddress && value >= requiredUnits) {
      transferFound = true;
      payerAddress  = parsed.args.from;
      break;
    }
  }

  if (!transferFound) {
    throw new Error(
      `No qualifying USDC Transfer to ${targetAddress} for ≥${requiredUnits} units found in tx`
    );
  }

  return { verified: true, payerAddress };
}

// ── Create a new session after successful payment ─────────────────────────────
function createSession({ ip, txHash, payerAddress }) {
  const sessionToken  = crypto.randomBytes(32).toString('hex');
  const windowSeconds = parseInt(process.env.PAYMENT_SESSION_SECONDS || '60', 10);
  const expiresAt     = new Date(Date.now() + windowSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const amountUsdc    = process.env.PRICE_PER_REQUEST_USDC || '0.002';

  // Guard against tx replay
  if (sessions.isTxHashUsed(txHash)) {
    throw new Error('This transaction hash has already been used');
  }

  sessions.create({ sessionToken, ip, txHash, amountUsdc, payerAddress, expiresAt });
  sessions.markTxHashUsed(txHash, sessionToken);

  return { sessionToken, expiresAt, windowSeconds };
}

// ── Validate an existing session ──────────────────────────────────────────────
function validateSession(token) {
  if (!token || typeof token !== 'string' || token.length < 60) return null;
  const row = sessions.findByToken(token);
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) return null; // expired
  return row;
}

// ── Main middleware factory ────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {boolean} [opts.required=true]  If false, payment is optional (for free-tier endpoints)
 */
function x402Middleware(opts = {}) {
  const required = opts.required !== false;

  return async function (req, res, next) {
    const ip             = req.ip;
    const paymentHeader  = req.headers['x-402-payment'];  // tx hash
    const sessionHeader  = req.headers['x-402-session'];  // session token

    // ── Path A: Client sends a session token ─────────────────────────────────
    if (sessionHeader) {
      const session = validateSession(sessionHeader);
      if (session) {
        sessions.incrementUsage(sessionHeader);
        req.paymentSession = session;
        req.isPaid         = true;
        return next();
      }
      // Invalid / expired session — fall through to require payment
    }

    // ── Path B: Check for an active session by IP (cookie-less reuse) ────────
    if (!paymentHeader) {
      const activeSession = sessions.findActiveByIp(ip);
      if (activeSession) {
        sessions.incrementUsage(activeSession.session_token);
        req.paymentSession = activeSession;
        req.isPaid         = true;
        // Echo session token so client can cache it
        res.setHeader('X-402-Session', activeSession.session_token);
        return next();
      }
    }

    // ── Path C: Client sends a tx hash (first payment) ────────────────────────
    if (paymentHeader) {
      const txHash = paymentHeader.trim();

      // Basic hash validation
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return res.status(400).json({
          error:   'invalid_payment_header',
          message: 'X-402-Payment must be a valid 0x-prefixed transaction hash (66 chars)',
        });
      }

      // Replay attack guard
      if (sessions.isTxHashUsed(txHash)) {
        return res.status(400).json({
          error:   'tx_already_used',
          message: 'This transaction has already been redeemed for a session',
        });
      }

      try {
        const { payerAddress } = await verifyUsdcPayment(txHash);
        const { sessionToken, expiresAt, windowSeconds } = createSession({ ip, txHash, payerAddress });

        // Attach to request and reply headers
        const session = sessions.findByToken(sessionToken);
        req.paymentSession = session;
        req.isPaid         = true;
        res.setHeader('X-402-Session', sessionToken);
        res.setHeader('X-402-Session-Expires', expiresAt);
        res.setHeader('X-402-Session-Window', String(windowSeconds));

        return next();
      } catch (err) {
        const status = err.message.includes('not yet mined') ||
                       err.message.includes('confirmations') ? 202 : 402;
        return res.status(status).json({
          error:   'payment_verification_failed',
          message: err.message,
          ...(status === 202 && {
            retry_after: 5,
            hint: 'Transaction is pending. Retry in a few seconds.',
          }),
        });
      }
    }

    // ── Path D: No payment at all ─────────────────────────────────────────────
    if (!required) {
      req.isPaid = false;
      return next();
    }

    // Set standard 402 headers
    const address = process.env.X402_PAYMENT_ADDRESS;
    const price   = process.env.PRICE_PER_REQUEST_USDC || '0.002';
    res.setHeader('X-402-Price',    price);
    res.setHeader('X-402-Currency', 'USDC');
    res.setHeader('X-402-Network',  'base-sepolia');
    if (address) res.setHeader('X-402-Address', address);

    return res.status(402).json(build402Body());
  };
}

// ── Session balance helper (used by /balance endpoint) ────────────────────────
function getSessionBalance(token) {
  return sessions.getBalance(token);
}

module.exports = {
  x402Middleware,
  validateSession,
  verifyUsdcPayment,
  getSessionBalance,
  build402Body,
};
