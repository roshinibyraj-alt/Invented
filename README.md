# BTC 15m Pattern Paper Bot

Polymarket BTC 15-minute UP/DOWN paper trading only. The bot has a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- Follow the detected side of every directional candle pattern. Never reverse a signal. Neutral patterns do not trigger entries; historical win rates are informational only.
- The bot reads completed 15-minute candles, waits 9 seconds after the window starts, and stops placing new entries after 810 seconds.
- At most one paper order is posted per window. It is a passive limit buy at $0.45 on the signalled side. If the best ask is already at or below $0.45, posting would cross the book and act as a taker, so the bot waits instead.
- Each base order reserves 5% of current capital. After a settled loss, the next order doubles once; sizing resets to a new 5% base after that doubled order wins or loses. A single unresolved position blocks another entry.
- Paper orders reserve cash when posted, fill only if a later ask touches or crosses $0.45, and are refunded if still unfilled at window end. Maker fills have no trading fee.
- Polymarket's crypto maker rebate pool distributes 20% of eligible daily taker fees pro-rata to makers, with a $1 payout threshold. Paper fills record fee-equivalent contribution for audit, but do not fabricate a dollar rebate because the market-wide pool and competing maker volume are unavailable.
- During the window, a fresh own-side CLOB bid, ask, or midpoint at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower it settles as a $0/share loss. Otherwise, use the official Gamma market result at window close, retrying until resolved.

The Chainlink feed is aggregated into completed 15-minute candles. CLOB quotes supply the market data for passive paper fills and position monitoring. The dashboard shows the 15-minute account, order statuses, position history, equity curve, fee-equivalent rebate contribution, and sizing state. Paper trade history and sizing are in memory and reset on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
