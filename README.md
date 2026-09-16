# Dip-Recovery Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Single
engine. Demo capital: $4,500.

## Strategy

1. From window open, watch both sides' mid prices.
2. Whichever side's mid first dips below 0.40 is flagged as "dipped".
   The deepest mid reached during the dip is tracked.
3. When the flagged side's mid recovers to 0.50, buy shares sized
   **cumulatively** by dip depth — each tier the dip pierced stacks on
   top of the shallower ones:
   - below 0.40 → 100 shares
   - below 0.30 → 100 + 200 = 300 shares
   - below 0.20 → 100 + 200 + 400 = 700 shares
   - below 0.10 → 100 + 200 + 400 + 800 = 1500 shares

   Taker fill at the current ask (immediate fill, no limit waiting).
4. Position management: **no stop loss**. TP at 0.99 redeems $1.00/share
   (fee-free). If TP isn't hit before the window closes, settle by the
   inferred CLOB winner at window close.
5. Max one trade per window. No martingale.

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode. `TRADING_MODE=paper` is the default.

## Dashboard
Live BTC UP/DOWN CLOB bid/ask, position card with uPnL, tier info
(shares that will be bought on recovery), equity curve, and a full
trade log with green/red P&L coloring.
