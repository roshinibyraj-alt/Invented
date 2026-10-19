# BTC 5m CLOB Timed-Entry Paper Bot

Polymarket BTC 5-minute UP/DOWN paper trading only. The bot has a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- Every 30 seconds, check both sides independently. If a side's fresh CLOB best ask is strictly above $0.70, paper-buy at that ask.
- Entry size doubles at each checkpoint: 100 shares at 30 seconds, 200 at 60 seconds, 400 at 90 seconds, and so on. A side can accumulate multiple entries, and both sides can enter during the same checkpoint.
- No new entries at or after 270 seconds into the window. Filled positions remain open for the existing TP/SL or official-result handling.
- Entries are modeled as taker market buys at the current best ask and use the configured crypto taker fee. They do not earn maker rebates; the rebate dashboard remains for any eligible historical maker fills.
- During the window, a fresh own-side CLOB bid, ask, or midpoint at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower it settles as a $0/share loss. Otherwise, use the official Gamma market result at window close, retrying until resolved.

The strategy uses Polymarket market metadata and CLOB quotes only; candle patterns and external BTC feeds do not drive entries. The dashboard shows the 5-minute market, both-side prices, timed entries, positions, equity, fees, and estimated rebates. Paper history resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
