# BTC 15m Pattern Paper Bot

Polymarket BTC 15-minute UP/DOWN paper trading only. The bot has a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- Follow the detected side of every directional candle pattern. Never reverse a signal. Neutral patterns do not trigger entries; historical win rates are informational only.
- The bot reads completed 15-minute candles, waits 9 seconds after the window starts, and stops placing new entries after 810 seconds.
- At most one paper market buy is made per window on the signalled side, after the 9-second delay. It executes at the current best ask with no $0.45 price cap.
- Each entry uses a cash budget of 5% of current capital. After a settled loss, the next budget doubles once; sizing resets to a new 5% base after that doubled order wins or loses. Market-buy shares are calculated from the current ask and estimated taker fee so the budget is not exceeded. A single unresolved position blocks another entry.
- Market entries fill immediately in the paper model at the current best ask. Estimated crypto taker fees are deducted from the ledger; no maker rebate is assumed.
- During the window, a fresh own-side CLOB bid, ask, or midpoint at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower it settles as a $0/share loss. Otherwise, use the official Gamma market result at window close, retrying until resolved.

The Chainlink feed is aggregated into completed 15-minute candles. CLOB asks supply the market data for paper market fills and position monitoring. The dashboard shows the 15-minute account, position history, equity curve, taker fees, and sizing state. Paper trade history and sizing are in memory and reset on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
