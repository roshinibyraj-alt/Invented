# Polymarket BTC 5-Minute Independent Paper Strategies

Polymarket BTC 5-minute paper trading with two independent strategies. Each strategy has its own $10,000 demo account ($20,000 total demo capital). The bot sends no live orders and holds no wallet credentials.

## Strategy A: 4-minute paired market-buy

- The bot waits until 4:00 into each 5-minute window, then checks every 500ms.
- If either fresh best ask is strictly above $0.42 and below $0.59, the bot makes one paired entry: market-buy 300 UP shares and 300 DOWN shares.
- Market buys sweep displayed ask depth. Actual average fills can be better or worse than the trigger price; partial fills are recorded and entry taker fees are included in cost.
- Every filled share receives a resting $0.80 limit sell. When either side's TP fills, the opposite side's remaining TP is moved to $0.99. A $0.99 fill records proceeds as $1 per share; a $0.80 fill records $0.80 per share.
- Any position without a TP fill by the market window's end waits for that market's official Polymarket resolution.
- Limit sells have no taker fee; maker rebate is shown as an estimate only and is not credited to cash. Resolution payouts have no fee.
- The dashboard shows accumulated UP and DOWN shares and fee-inclusive average cost for the active 5-minute window. It does not show order activity.

## Strategy B: 10-second paired pre-buy

- This strategy runs in a separate bot instance with its own $10,000 demo balance, positions, win rate, and equity curve.
- It discovers the upcoming BTC 5-minute market and, during the 10 seconds before that window opens, attempts one market buy for 500 UP shares and 500 DOWN shares.
- If both fresh order books are not available before the window opens, it skips that window rather than buying late.
- One second after the window opens, it creates $0.70 limit take-profit orders for the shares that filled on both sides.
- When either side's take-profit fills, the other side's remaining take-profit moves to $0.99, booked as $1 per share.
- Market buys sweep visible ask depth and incur taker fees. Limit sells have no taker fee; the estimated maker rebate is displayed but is not added to demo cash.
- Shares still open at window end wait for the original market's official Polymarket resolution.

The dashboard displays two distinct account panels with separate balances, performance, and equity curves. Combined totals are shown separately and do not feed back into either strategy's account.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
