# Prixe x402 Stock API Gateway

A production-ready API gateway that proxies the [Prixe Stock API](https://prixe.com) and gates access behind the **x402** HTTP payment protocol — accepting **USDC on Base Sepolia** per request.

---

## Architecture

```
Client
  │
  ├── Free (first 3 req/IP)  ─────────────────────────────┐
  │                                                         │
  ├── API Key (free tier, 3 req/key)  ──────────────────── ┤
  │                                                         ▼
  └── x402 Payment (USDC → Base Sepolia) ──► Session token (60s window)
                                                         │
                                                    Express API
                                                         │
                                                   Prixe API Proxy
```

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Configure environment
cp .env.example .env
# Fill in PRIXE_API_KEY, X402_PAYMENT_ADDRESS, BASE_SEPOLIA_RPC_URL, etc.

# 3. Initialise SQLite
node db/database.js --init

# 4. Start
npm start         # production
npm run dev       # development (nodemon)
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port (default: 3000) |
| `PRIXE_API_KEY` | **Yes** | Your Prixe API key |
| `PRIXE_BASE_URL` | No | Prixe API base URL (default: https://api.prixe.com) |
| `X402_PRIVATE_KEY` | No | Your wallet private key (future signing use) |
| `X402_PAYMENT_ADDRESS` | **Yes** | Wallet address clients pay USDC to |
| `PRICE_PER_REQUEST_USDC` | No | Price per request in USDC (default: 0.002) |
| `PAYMENT_SESSION_SECONDS` | No | Session window after payment (default: 60) |
| `BASE_SEPOLIA_RPC_URL` | **Yes** | Base Sepolia JSON-RPC endpoint |
| `USDC_CONTRACT_ADDRESS` | **Yes** | USDC contract on Base Sepolia |
| `MIN_CONFIRMATIONS` | No | Block confirmations needed (default: 1) |
| `FREE_REQUESTS_PER_IP` | No | Free requests per IP (default: 3) |
| `DB_PATH` | No | SQLite DB path (default: ./data/prixe.db) |

**Base Sepolia USDC Contract:** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

---

## API Reference

### `POST /api/v1/register` — Get a free API key

```bash
curl -X POST http://localhost:3000/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{"label": "my-app"}'
```

```json
{
  "success": true,
  "api_key": "prixe_a1b2c3d4...",
  "tier": "free",
  "free_remaining": 3,
  "message": "Your API key has been created. You have 3 free requests."
}
```

---

### `GET /api/v1/stock/price/:ticker`

```bash
# With API key
curl http://localhost:3000/api/v1/stock/price/AAPL \
  -H "X-API-Key: prixe_a1b2c3..."

# With x402 session
curl http://localhost:3000/api/v1/stock/price/AAPL \
  -H "X-402-Session: <session_token>"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "ticker": "AAPL",
    "price": "$182.50",
    "ask": "$182.52",
    "bid": "$182.48",
    "volume": "45,123,456",
    "change": "+1.25",
    "change_percent": "+0.69%",
    "real_time": true,
    "timestamp": "2024-01-15T14:30:00Z"
  },
  "paid": false,
  "remaining_free": 2
}
```

---

### `GET /api/v1/stock/historical/:ticker?days=7`

Valid `days` values: `1`, `7`, `30`, `90`, `365`

```bash
curl "http://localhost:3000/api/v1/stock/historical/TSLA?days=30" \
  -H "X-402-Session: <session_token>"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "ticker": "TSLA",
    "days": 30,
    "count": 22,
    "history": [
      { "date": "2024-01-15", "open": 245.10, "high": 249.80, "low": 242.30, "close": 248.50, "volume": 98234567 }
    ]
  }
}
```

---

### `GET /api/v1/stock/search?q=Apple`

```bash
curl "http://localhost:3000/api/v1/stock/search?q=Apple" \
  -H "X-API-Key: prixe_a1b2c3..."
```

**Response:**
```json
{
  "success": true,
  "data": {
    "query": "Apple",
    "count": 3,
    "results": [
      { "ticker": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ", "type": "equity", "currency": "USD" }
    ]
  }
}
```

---

### `GET /api/v1/balance`

Check remaining quota for a session or API key:

```bash
curl http://localhost:3000/api/v1/balance \
  -H "X-402-Session: <session_token>"
```

```json
{
  "success": true,
  "type": "payment_session",
  "seconds_left": 42,
  "requests_used": 3,
  "paid": true
}
```

---

## x402 Payment Flow

When your free quota runs out, every paid request returns a `402`:

```json
{
  "error": "payment_required",
  "message": "This endpoint costs $0.002 USDC on Base Sepolia",
  "invoice": {
    "amount": "0.002",
    "currency": "USDC",
    "network": "base-sepolia",
    "payment_address": "0xYourAddress",
    "usdc_contract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "expires_in": 300
  }
}
```

**To pay and get a session:**

```bash
# 1. Send 0.002 USDC to X402_PAYMENT_ADDRESS on Base Sepolia
#    (use MetaMask, ethers.js, wagmi, etc.)

# 2. Retry your request with the tx hash
curl http://localhost:3000/api/v1/stock/price/AAPL \
  -H "X-402-Payment: 0xYourTxHashHere"

# Response includes X-402-Session header
# → X-402-Session: <64-char token>

# 3. Use the session token for subsequent requests (valid 60 seconds)
curl http://localhost:3000/api/v1/stock/price/MSFT \
  -H "X-402-Session: <token>"
```

### Client Example (JavaScript / ethers.js)

```javascript
import { ethers } from 'ethers';

const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO      = '0xYourPaymentAddress';
const API_BASE    = 'http://localhost:3000/api/v1';

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
];

async function fetchWithPayment(endpoint) {
  // 1. Try the request
  let resp = await fetch(`${API_BASE}${endpoint}`);

  if (resp.status !== 402) return resp.json();

  const invoice = (await resp.json()).invoice;

  // 2. Pay via USDC transfer
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer   = await provider.getSigner();
  const usdc     = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);

  const amount = ethers.parseUnits(invoice.amount, 6); // USDC = 6 decimals
  const tx     = await usdc.transfer(PAY_TO, amount);
  const receipt = await tx.wait();

  // 3. Retry with tx hash
  resp = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'X-402-Payment': receipt.hash },
  });

  const sessionToken = resp.headers.get('X-402-Session');
  if (sessionToken) localStorage.setItem('x402Session', sessionToken);

  return resp.json();
}
```

---

## Rate Limits

| Tier | Per Minute | Per Day |
|---|---|---|
| Free | 10 | 100 |
| Paid (x402) | 10 | 1,000 |

Headers returned on every response:
- `X-RateLimit-Limit-Minute`
- `X-RateLimit-Remaining-Minute`
- `X-RateLimit-Reset-Minute`
- `X-RateLimit-Limit-Day`
- `X-RateLimit-Remaining-Day`

---

## Database Schema

| Table | Purpose |
|---|---|
| `api_keys` | Free API keys with quota tracking |
| `payment_sessions` | x402 sessions (60-second windows) |
| `request_log` | Audit trail for all requests (30-day retention) |
| `rate_limits` | Persistent rate limit buckets |
| `used_tx_hashes` | Replay-attack prevention |

---

## Security Notes

- **Never commit `.env`** — it contains your private key and API credentials
- `X402_PRIVATE_KEY` is stored securely — never logged or exposed via API
- All tx hashes are tracked in `used_tx_hashes` to prevent replay attacks
- SQLite WAL mode enabled for concurrent read performance
- `helmet` middleware adds security headers automatically
- Ticker inputs are validated against `/^[A-Z0-9.\-]{1,10}$/`
- IP registration capped at 5 keys per IP to prevent abuse

---

## Deploying to Production

```bash
# Railway / Render / Fly.io — set env vars in dashboard
NODE_ENV=production npm start

# PM2
pm2 start server.js --name prixe-api
```

For production, consider:
- Setting `MIN_CONFIRMATIONS=2` for stronger payment finality
- Tightening `cors()` origin to your frontend domain
- Adding a reverse proxy (nginx) in front for TLS termination
- Rotating `DB_PATH` to a persistent volume mount
