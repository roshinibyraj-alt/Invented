# Dip-Recovery Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Single
engine. Demo capital: $4,500.

## Strategy

1. From window open, watch both sides' mid prices.
2. Whichever side's mid first dips below 0.40 is flagged as "dipped".
3. When the dipped side's mid recovers to 0.50, buy `current_shares`
   at the current ask as a taker (immediate fill).
4. Position management:
   - **Stop loss** at 0.25: taker sell at bid if mid ≤ 0.25.
   - **Take profit** at 0.99: redeem $1.00/share if mid ≥ 0.99.
   - **Resolution**: if neither SL nor TP hit, settle by inferred
     CLOB winner at window close.
5. **Martingale**: after a loss (SL hit or resolution loss), shares
   double: 100 → 200 → 400 → 800 (capped at level 3). Resets to
   base 100 on any win (TP or resolution).

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode. `TRADING_MODE=paper` is the default.

## Dashboard
Live BTC UP/DOWN CLOB bid/ask, position card with uPnL, martingale
level, equity curve, and a full trade log with green/red P&L coloring.
