# Polymarket BTC 5-Minute OCO Paper Bot

Polymarket BTC 5-minute paper trading with a $300 demo bankroll. The bot sends no live orders and holds no wallet credentials.

## Strategy

- At each 5-minute window start, place resting limit buy orders for 30 shares on both UP and DOWN at $0.25.
- The first order filled cancels the opposite-side order. A fill is simulated from a fresh best ask at or below $0.25; when both sides qualify on the same poll, the lower ask is selected.
- There is no stop-loss. A fresh own-side best bid at $0.99 or higher triggers the take-profit, credited at $1 per share.
- If take-profit does not fill before the window ends, immediately count the window as a strategy loss and increase the next window's size by 1.4×. Hold only that filled, non-TP position until official Polymarket resolution; unfilled orders do not count as wins or losses and do not change share size.
- A $0.99 take-profit hit counts as a strategy win and resets to 30 shares immediately. Missed-TP losses advance through seven multiplier levels; a loss at level seven resets to 30 shares.
- Limit buys and take-profit limits use the paper maker-fee model. Maker-rebate estimates are illustrative and are not added to cash or P&L.
- Dashboard streak records show highest consecutive strategy wins (TP hit) and losses (TP missed by window end), including positions awaiting resolution. Actual realized P&L and cash still follow the eventual TP or official payout, so a position can be a strategy loss but later produce a positive payout.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
