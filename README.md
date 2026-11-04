# Polymarket BTC 5-Minute OCO Paper Bot

Polymarket BTC 5-minute paper trading with a $300 demo bankroll. The bot sends no live orders and holds no wallet credentials.

## Strategy

- At each 5-minute window start, place resting limit buy orders for 30 shares on both UP and DOWN at $0.25.
- The first order filled cancels the opposite-side order. A fill is simulated from a fresh best ask at or below $0.25; when both sides qualify on the same poll, the lower ask is selected.
- There is no stop-loss. A fresh own-side best bid at $0.99 or higher triggers the take-profit, credited at $1 per share.
- If take-profit does not fill before the window ends, cancel any unfilled buys and hold filled shares until the official Polymarket market resolution. Unfilled orders do not count as wins or losses and do not change share size.
- A resolved loss increases the next window's share size by 1.4×, through seven multiplier levels. A win resets to 30 shares; a loss at level seven also resets to 30 shares.
- Limit buys and take-profit limits use the paper maker-fee model. Maker-rebate estimates are illustrative and are not added to cash or P&L.
- Dashboard streak records show the highest consecutive resolved wins and losses in the current in-memory history.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
