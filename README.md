# Polymarket BTC 5-Minute Threshold Ladder

Polymarket BTC 5-minute paper trading with a $300 demo bankroll. The bot sends no live orders and holds no wallet credentials.

## Strategy

- Wait 30 seconds after each 5-minute window opens. When either side's fresh midpoint reaches $0.77 or higher, place one resting limit buy on that side at $0.75.
- The order fills only when a newer fresh best ask reaches $0.75 or lower. It uses the best ask as the fill price; an unfilled order expires at window end without counting as a loss, and the stake carries forward unchanged.
- Base stake is 1.25% of the bankroll: $3.75 initially. A losing close advances the next stake by 5×, to $18.75 and then $93.75. After a loss at $93.75, allow two additional $93.75 stop-outs; stop new entries after both. Any profitable close resets the ladder and recalculates the base at 1.25% of current cash.
- After fill, a fresh own-side bid at $0.40 or lower triggers a simulated market sell at the available best bid. A bid at $0.99 or higher triggers take-profit and credits $1 per share. If neither threshold occurs before window end, sell at the current bid or settle at $0 when no bid is available.
- Resting limit buys and take-profit limits have zero maker fees. Market stop-loss and window-end sells use the market's taker-fee schedule. Maker-rebate estimates are illustrative and are not added to cash or P&L.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
