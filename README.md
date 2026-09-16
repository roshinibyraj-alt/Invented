# Candle-Pattern Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Demo
capital: $4,500. CLOB-only pricing, no fallback.

## Strategy

The 5-minute window is divided into 5 one-minute candles. The UP-side
CLOB mid price is the candle basis (mid rising over the minute = green,
mid falling = red).

After the first 3 candles close:

| Pattern | Action |
|---|---|
| RRG, RGG, GRG | buy **UP** (taker at ask, 500sh) |
| GRR, GGR, RGR | buy **DOWN** (taker at ask, 500sh) |
| RRR, GGG, anything else | no trade this window |

- One trade max per window
- No stop-loss
- TP at 0.99 (redeem $1.00/share, fee-free)
- Otherwise settle by the inferred CLOB winner at window close

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode.

## Dashboard
Live BTC UP/DOWN CLOB bid/ask, 1-minute candle tracker (first 3), signal
status, equity curve, and full trade log.
