# BTC 5-minute CLOB Paper Bot

Polymarket-only BTC UP/DOWN paper trading. The bot has one 5-minute market loop and a $10,000 demo bankroll. It sends no live orders and holds no wallet credentials.

## Strategy

- Use the selected directional pattern from completed 5-minute candles. Follow the pattern side when its measured one-month win rate is above 50%; fade it when below 50%. Neutral, conflicting, uncalibrated, and exactly-50% signals produce no entry. Rates are Coinbase-based proxy results from the prior 30-day sample, not a guarantee of future performance.
- Make one paper entry on the selected side after the window has been open for 3 seconds. Size starts at 500 shares, rises by 100 after each loss, and falls by 100 after each win; clamp the next size to 500–1,000 shares.
- Do not attempt a new entry after 270 seconds into a window. A triggered entry waits for its signaled-side best ask to fall strictly below $0.49 (minimum $0.05), rechecking until the cutoff. Demo buys fill the full requested size at the best eligible ask from $0.05 to below $0.49, regardless of displayed ask quantity. The fill record shows visible depth and simulated shortfall; this is for strategy testing, not realistic execution.
- Deduct the Polymarket BTC taker fee from each paper buy using the market fee schedule and simulated fill price.
- During the window, any fresh bid, ask, or midpoint for the position's own side at $0.99 or higher immediately settles it as a $1/share win; at $0.01 or lower immediately settles it as a $0/share loss. If neither threshold is reached, use the official Gamma market result at window close, retrying until resolved.

The bot polls CLOB quotes every 500 ms and consumes Polymarket RTDS Chainlink BTC/USD one-minute updates to build completed 5-minute pattern bars; one-minute data is not a signal filter; the dashboard refreshes every 2 seconds. CLOB quotes remain the simulated entry and exit prices. TP/SL detection uses fresh own-side CLOB quotes. If neither threshold is reached, use the official Gamma result and retry while it is pending. The dashboard shows settled-trade equity, wins, maximum consecutive losses, and peak-to-trough drawdown. These metrics and the adaptive size history are in memory and reset on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
