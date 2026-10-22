# BTC 5m CLOB Timed-Entry Paper Bot

Polymarket BTC 5-minute UP/DOWN paper trading only. The bot has a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- Wait 30 seconds after each 5-minute window starts. Then, at any time (not on a fixed 30-second schedule), open one 500-share paper position when a fresh UP or DOWN best ask is above $0.70 and at most $0.75. If both qualify at once, choose the lower ask.
- Immediately after that initial fill, monitor the opposite side on every fresh quote. When its best ask reaches $0.70 or higher, open one 1,000-share martingale position. At most one martingale is allowed per 5-minute window.
- Stop opening entries at 270 seconds. Existing take-profit, stop-loss, and official settlement rules remain in effect.
- Entries are modeled as taker market buys at the current best ask and use the configured crypto taker fee. They do not earn maker rebates; the rebate dashboard remains for any eligible historical maker fills.
- During the window, a fresh own-side CLOB bid, ask, or midpoint at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower it settles as a $0/share loss. Otherwise, use the official Gamma market result at window close, retrying until resolved.

The strategy uses Polymarket market metadata and CLOB quotes only; candle patterns and external BTC feeds do not drive entries. The dashboard shows the 5-minute market, both-side prices, timed entries, positions, equity, fees, and estimated rebates. Paper history resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
