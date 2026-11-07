# Polymarket BTC 5-Minute Paired Market-Buy Paper Bot

Polymarket BTC 5-minute paper trading with $10,000 demo capital. The bot sends no live orders and holds no wallet credentials.

## Strategy

- The bot waits until 4:00 into each 5-minute window, then checks every 500ms.
- If either fresh best ask is strictly above $0.42 and below $0.59, the bot makes one paired entry: market-buy 300 UP shares and 300 DOWN shares.
- Market buys sweep displayed ask depth. Actual average fills can be better or worse than the trigger price; partial fills are recorded and entry taker fees are included in cost.
- Every filled share receives a resting $0.80 limit sell. When either side's TP fills, the opposite side's remaining TP is moved to $0.99. A $0.99 fill records proceeds as $1 per share; a $0.80 fill records $0.80 per share.
- Any position without a TP fill by the market window's end waits for that market's official Polymarket resolution.
- Limit sells have no taker fee; maker rebate is shown as an estimate only and is not credited to cash. Resolution payouts have no fee.
- The dashboard shows accumulated UP and DOWN shares and fee-inclusive average cost for the active 5-minute window. It does not show order activity.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
