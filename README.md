# Dual-Strategy Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Two
independent strategies with alternating activation. Demo capital: $4,500.

## Strategy A — Dip Recovery
- After 5s wait, flag whichever side first dips below **0.30**
- When flagged side returns to **0.48** → limit buy at **0.48**, **500 shares**
- Fill confirmed by ask walk-through at/below 0.48
- TP at **0.99** (redeem $1.00/share, fee-free), no SL

## Strategy B — Spike Reversal (opposite of A)
- After 5s wait, flag whichever side first spikes above **0.70**
- When flagged side returns to **0.50** → limit buy at **0.48**, **500 shares**
- Fill confirmed by ask walk-through at/below 0.48
- TP at **0.99**, no SL

## Alternation
- **A starts active**
- **Win** (TP or resolution) → winning strategy sleeps, other activates next window
- **Loss** → same strategy stays active next window

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode.

## Dashboard
Live BTC UP/DOWN CLOB bid/ask, active strategy indicator, per-strategy
win/loss tracking, equity curve, and full trade log.
