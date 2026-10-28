# Polymarket BTC Paper Bot

Polymarket BTC 5-minute and 15-minute paper trading. Each timeframe has its own $10,000 demo bankroll. The bot sends no live orders and holds no wallet credentials.

## Strategy

- Signal from the latest completed candle: green is UP and red is DOWN. A doji reverses after at least two consecutive prior candles of the same color; otherwise it waits for a directional signal.
- Submit two signal-side paper limit orders per window: $0.30 and $0.20, 500 shares each. Unfilled orders expire at 180 seconds in 5-minute windows and 540 seconds in 15-minute windows.
- Fresh own-side CLOB bids at $0.99 or above pay $1/share; bids at $0.01 or below pay $0/share and complete the window. Close other positions at their own bid or $0 if no bid is available. No shares carry across windows and no official outcome is used.
- A take-profit on either rung arms one opposite-signal market paper buy in the next window at the current best ask. It starts at 500 shares, doubles after losses up to the configured maximum, resets after a win, and returns to 500 after the maximum losing level.
- Maker-rebate estimates are illustrative and are not added to cash or P&L.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
