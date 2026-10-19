# BTC 5m CLOB Ladder Paper Bot

Polymarket BTC 5-minute UP/DOWN paper trading only. The bot has a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- At each 5-minute market start, place paper limit orders on both UP and DOWN at $0.40, $0.35, $0.30, $0.25, $0.20, $0.15, and $0.10, with 100 shares at each rung.
- Both sides can fill and accumulate independently. A rung fills in the paper model when its side's fresh CLOB best ask is at or below that limit price; the fill is recorded at the rung price.
- Cancel all unfilled resting rungs 130 seconds after the window starts. Filled positions remain open for the existing TP/SL or official-result handling.
- Post-only paper orders that would cross the ask are rejected; maker fills have zero fees.
- The dashboard credits an estimated crypto maker rebate using the published 20% fee-equivalent rate. Actual Polymarket rebates are shared by market and paid daily in pUSD; paper estimates are not account payouts.
- During the window, a fresh own-side CLOB bid, ask, or midpoint at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower it settles as a $0/share loss. Otherwise, use the official Gamma market result at window close, retrying until resolved.

The strategy uses Polymarket market metadata and CLOB quotes only; candle patterns and external BTC feeds do not drive entries. The dashboard shows the 5-minute market, both-side quote ladder, resting/filled/cancelled orders, positions, equity, zero maker fees, and estimated rebates. Paper history resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
