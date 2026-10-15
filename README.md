# BTC 5-minute CLOB Paper Bot

Polymarket-only BTC UP/DOWN paper trading. The bot has one 5-minute market loop and a $10,000 demo bankroll. It sends no live orders and holds no wallet credentials.

## Strategy

- Use patterns in completed 5-minute candles to choose UP or DOWN. The detector recognizes doji variants, hammers and stars, marubozu, engulfing, tweezer, harami, morning/evening stars, and three-soldier/crow formations. Neutral, conflicting, or absent patterns produce no directional signal.
- Once a directional pattern is available, make one 500-share paper entry on that side after the window has been open for 3 seconds. Do not wait for an adverse move or use multiple size levels.
- Do not attempt a new entry after 150 seconds into a window. Demo buys fill the full requested size at the best eligible ask within $0.05–$0.60, regardless of displayed ask quantity. The fill record shows visible depth and simulated shortfall; this is for strategy testing, not realistic execution.
- Deduct the Polymarket BTC taker fee from each paper buy using the market fee schedule and simulated fill price.
- During the window, any fresh bid, ask, or midpoint for the position's own side at $0.99 or higher immediately settles it as a $1/share win; at $0.01 or lower immediately settles it as a $0/share loss. If neither threshold is reached, use the official Gamma market result at window close, retrying until resolved.

The bot polls CLOB quotes every 500 ms and consumes Polymarket RTDS Chainlink BTC/USD updates to build 1-minute candles; the dashboard refreshes every 2 seconds. RTDS provides a short recent replay on connection, so the scanner waits until it has rebuilt enough completed 5-minute candles for pattern analysis after a restart. CLOB quotes remain the simulated entry and exit prices. TP/SL detection uses fresh own-side CLOB quotes. If neither threshold is reached, use the official Gamma result and retry while it is pending. Dashboard win rate is calculated over settled trades; total trades includes open and settled positions. Stale marks are excluded from floating P&L/equity. Paper state is in memory and resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
