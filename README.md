# BTC 5-minute CLOB Paper Bot

Polymarket-only BTC UP/DOWN paper trading. The bot has one 5-minute market loop and a $10,000 demo bankroll. It sends no live orders and holds no wallet credentials.

## Strategy

- Vote UP or DOWN from the signs of recent 1-, 3-, and 5-minute BTC returns and EMA5/EMA13 slopes over the recent one-minute closes. A tie uses the 5-minute return, then EMA13 slope, then 1-minute return.
- Make one paper entry on the selected side after the window has been open for 3 seconds. Size starts at 500 shares, rises by 100 after each loss, and falls by 100 after each win; clamp the next size to 500–1,000 shares.
- Do not attempt a new entry after 150 seconds into a window. Demo buys fill the full requested size at the best eligible ask within $0.05–$0.60, regardless of displayed ask quantity. The fill record shows visible depth and simulated shortfall; this is for strategy testing, not realistic execution.
- Deduct the Polymarket BTC taker fee from each paper buy using the market fee schedule and simulated fill price.
- During the window, any fresh bid, ask, or midpoint for the position's own side at $0.99 or higher immediately settles it as a $1/share win; at $0.01 or lower immediately settles it as a $0/share loss. If neither threshold is reached, use the official Gamma market result at window close, retrying until resolved.

The bot polls CLOB quotes every 500 ms and consumes Polymarket RTDS Chainlink BTC/USD updates to build 1-minute candles; the dashboard refreshes every 2 seconds. CLOB quotes remain the simulated entry and exit prices. TP/SL detection uses fresh own-side CLOB quotes. If neither threshold is reached, use the official Gamma result and retry while it is pending. The dashboard shows settled-trade equity, wins, maximum consecutive losses, and peak-to-trough drawdown. These metrics and the adaptive size history are in memory and reset on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
