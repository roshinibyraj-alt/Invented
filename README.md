# Candle-Pattern Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Demo
capital: $4,500. CLOB-only pricing, no fallback.

## Strategy

The 5-minute window is divided into 5 one-minute candles. Candle color
is determined by the real Binance BTCUSDT spot price (spot rising over
the minute = green, spot falling = red) -- NOT the CLOB probability
price, which drifts with time decay.

Two independent signals per window (up to 2 trades):

**Trade #1 — after candle 2 closes (~120s):**

| C1 → C2 | Action |
|---|---|
| red → green (RG) | buy **UP** (taker at ask, 500sh) |
| green → red (GR) | buy **DOWN** (taker at ask, 500sh) |
| same color (or flat) | no first trade |

**Trade #2 — after candle 3 closes (~180s, existing setup):**

| C2 → C3 | Action |
|---|---|
| red → green | buy **UP** (taker at ask, 500sh) |
| green → red | buy **DOWN** (taker at ask, 500sh) |
| same color (or flat) | no second trade |

- Up to 2 trades per window (one per signal), 500 shares each
- No stop-loss
- TP at 0.99 (redeem $1.00/share, fee-free)
- Otherwise settle by the inferred CLOB winner at window close

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode.

## Dashboard
Live BTC UP/DOWN CLOB bid/ask, 1-minute candle tracker (first 3), signal
status, equity curve, and full trade log.
