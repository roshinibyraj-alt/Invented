# Gabagool Grid Bot v9 — Polymarket BTC 5m Momentum

Real-time momentum grid bot trading BTC Up/Down binary markets on Polymarket.

## Strategy

- **Markets:** BTC 5m Up/Down binary windows
- **Levels:** 0.15 / 0.25 / 0.35 / 0.45 / 0.55 / 0.65 / 0.75 / 0.85
- **Entry:** BUY when mid price RISES to level (momentum confirmation)
- **Take Profit:** entry + 0.15
- **Runner:** 0.99 (near max payout)
- **Stop:** entry − 0.15
- **Budget:** $4.50 per level per window
- **Pull-Stop:** full exit if mid ever hits 0.75+ then drops back to 0.40

## Railway Deployment

### Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `POLYMARKET_PRIVATE_KEY` | ✅ Yes | Your wallet private key (hex, with or without 0x prefix) |
| `DRY_RUN` | ✅ Yes | Set to `false` for live trading. Defaults to `true` (simulation). |
| `PORT` | Auto | Set automatically by Railway — do not set manually |

### Optional Environment Variables

| Variable | Description |
|---|---|
| `FUNDER_ADDRESS` | Your Polymarket deposit wallet address. Auto-derived from private key if not set. |
| `HTTPS_PROXY` | HTTP/SOCKS5 proxy for geo-routing. Required if Railway servers are geo-blocked by Polymarket CLOB (set to a EU proxy, e.g. `socks5://user:pass@host:port`). |
| `DRY_RUN_BALANCE` | Starting simulated balance in dry-run mode. Default: `2000`. |

### Deploy Steps

1. Connect this repo to Railway
2. Set `POLYMARKET_PRIVATE_KEY` and `DRY_RUN=false` in Railway Variables
3. Deploy — Railway auto-detects Node.js and runs `node index.js`
4. Open the Railway public URL to see the live dashboard

### Dashboard

The web dashboard shows:
- Live balance, PnL, equity curve
- All active grid levels per market
- Recent fills and activity log
- Toggle button to switch between dry-run and live trading at runtime

## Local Development

```bash
npm install
DRY_RUN=true node index.js
```

Open `http://localhost:3000`
