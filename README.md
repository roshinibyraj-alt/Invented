# Dip-Recovery Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Single
engine. Demo capital: $4,500.

## Strategy

1. From window open, watch both sides' mid prices.
2. Whichever side's mid first dips below 0.45 is flagged as "dipped".
   The minimum price reached during the dip is tracked.
3. When the dipped side's mid recovers to 0.50, buy shares based on
   dip depth: below 0.40 → 100sh, below 0.30 → 200sh, below 0.20 →
   400sh, below 0.10 → 800sh. Taker fill at current ask.
5. Manage the position: SL at 0.10 (taker sell at bid depth, taker
   fee) or TP at 0.99 (redeem $1.00/share, fee-free). If neither is
   hit before the window closes, settle by the inferred CLOB winner.
6. Max one trade per window. No re-entry after SL or TP.

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode. `TRADING_MODE=paper` is the default.

## Dashboard
Live BTC UP/DOWN CLOB mid + bid/ask, dip timers for both sides with
progress bars, dipped-side badge, position card with uPnL, equity
curve, and a full trade log.
