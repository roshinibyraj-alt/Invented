# Polymarket BTC 5m / 15m Scheduled Paper Bot

Polymarket BTC 5-minute and 15-minute paper trading with $10,000 total demo capital, allocated $5,000 to each timeframe. The bot sends no live orders and holds no wallet credentials.

## Strategy

- The 5-minute bot trades BTC 5-minute markets; the 15-minute bot trades BTC 15-minute markets. Their schedules are independent.
- During minutes 0–1, buy the side with the lower current ask every 10 seconds, starting at 10 shares. During minutes 1–3, buy the side with the higher current ask every 20 seconds, starting at 50 shares.
- Within each phase and window, each scheduled order grows by 1.5× from the previous interval's size. The progression restarts at the phase's base size in every new window. Fractional paper shares are retained to six decimal places.
- The 15-minute schedule scales all timing by 3: the cheap-side phase is 0–3 minutes with 30-second intervals; the expensive-side phase is 3–9 minutes with 60-second intervals.
- Simulated buys are taker orders consuming displayed ask depth. Entry fees are calculated using the market's fee schedule (or the configured crypto taker formula); available depth can produce a partial fill, and insufficient demo cash rejects an order.
- Each filled position receives a resting $0.99 limit take-profit. When the best bid reaches $0.99, the demo records proceeds as $1 per share. If TP does not fill before the market window ends, the position waits for the original market's official Polymarket resolution.
- No stop-loss is used. Taker fees are included in cost and realized P&L; passive TP sells and official resolution have no taker fee. Maker rebate is shown as an estimate only, not credited to cash.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
