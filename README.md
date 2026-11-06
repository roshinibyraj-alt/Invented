# Polymarket BTC 5-Minute Limit Ladder Paper Bot

Polymarket BTC 5-minute paper trading with a $300 demo bankroll. The bot sends no live orders and holds no wallet credentials.

## Strategy

- At each 5-minute window start, place four independent resting limit buys: 100 UP and 100 DOWN shares at $0.10, plus 100 UP and 100 DOWN shares at $0.05.
- Each buy is independent; a fill does not cancel any other side or rung. The paper fill model requires a fresh best ask at or below that order's limit.
- Each filled $0.10 buy immediately gets a resting $0.20 limit take-profit sell. Each filled $0.05 buy gets a resting $0.10 limit take-profit sell.
- A take-profit sell fills when a fresh best bid reaches its limit; the paper proceeds use the limit price or the better observed bid. There is no stop-loss.
- Cancel any unfilled buy 180 seconds after its placement. At window end, any unfilled buys are also cancelled, pending take-profit orders expire, and filled positions without a take-profit fill wait for the original Polymarket market's official resolution.
- Window-end positions without a take-profit fill count as strategy losses at that point; later resolution determines actual cash P&L and does not rewrite the strategy outcome. Unfilled orders do not count as wins or losses.
- Limit-order maker-rebate values are estimates only and are not added to cash or realized P&L.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
