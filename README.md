# BTC 5m and 15m CLOB Paper Bots

Polymarket BTC UP/DOWN paper trading only. The two strategies run independently, each with its own $10,000 demo bankroll, position history, equity curve, and adaptive sizing progression. No live orders or wallet credentials are used.

## Strategy

- Follow the detected side of every directional candle pattern. Never reverse a signal. Neutral patterns do not trigger entries; historical win rates are informational only.
- The 5-minute bot reads completed 5-minute candles, waits 3 seconds, and stops opening entries after 270 seconds in its market window.
- The independent 15-minute bot reads completed 15-minute candles, waits 9 seconds, and stops opening entries after 810 seconds in its market window.
- Each bot makes at most one paper entry per window. A triggered entry waits for that bot's signaled-side best ask to fall strictly below $0.49 (minimum $0.05), rechecking until its cutoff. The bots use separate adaptive sizing: start at 500 shares, increase by 100 after a loss, decrease by 100 after a win, and clamp at 500–1,000 shares.
- Demo buys fill the full requested size at the best eligible ask, regardless of displayed ask quantity. The fill record shows visible depth and simulated shortfall; this is for strategy testing, not realistic execution.
- Deduct the Polymarket BTC taker fee from each paper buy using the market fee schedule and simulated fill price.
- During the window, a fresh own-side CLOB bid, ask, or midpoint at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower it settles as a $0/share loss. Otherwise, use the official Gamma market result at window close, retrying until resolved.

The shared one-minute Chainlink feed is aggregated into completed 5-minute and 15-minute candles. CLOB quotes remain the simulated entry and exit prices. The dashboard shows the combined account overview plus separate timeframe panels, trade histories, and equity charts. Paper trade history and adaptive sizing are in memory and reset on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
