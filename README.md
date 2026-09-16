# Dip-Recovery Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Single
engine. Demo capital: $4,500.

## Strategy

1. After a 5-second wait following window open, watch both sides' mid prices.
2. Whichever side's mid first dips below 0.30 is flagged.
3. When the flagged side's mid returns to 0.48, place a resting
   **limit buy order at 0.48** for 500 shares. The limit price
   guarantees no fill worse than 0.48.
4. Fill is confirmed by price walk-through: once the flagged side's ask
   trades at or below 0.48, the order is booked filled at 0.48.
5. No stop loss. TP at 0.99 redeems $1.00/share (fee-free). If neither
   TP nor fill is reached before the window closes, settle by the
   inferred CLOB winner.
6. Max one trade per window. No martingale.

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode. `TRADING_MODE=paper` is the default.

## Dashboard
Live BTC UP/DOWN CLOB bid/ask, limit order pending indicator, position
card with uPnL, equity curve, and full trade log with green/red P&L coloring.
