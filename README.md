# Invented BTC 5-minute two-sided limit-entry paper bot

This service runs a paper-only strategy for Polymarket BTC 5-minute UP/DOWN markets. Entry and reversal decisions use Polymarket CLOB quotes only. Binance remains connected for telemetry but is not part of this strategy. It does not submit live orders.

## Strategy

- At each 5-minute window open, place two resting limit buys: 100 UP shares at $0.20 and 100 DOWN shares at $0.20.
- A fresh best ask at or below $0.20 confirms a full 100-share fill at the best ask, with a maximum fill price of $0.20. The other side's resting order is cancelled immediately. Unfilled orders expire at window end.
- If the filled side's midpoint reaches $0.10 or below, immediately submit one 200-share market buy on the opposite side. This trigger can happen once per window; visible ask liquidity controls the market fill, partial fills are allowed, unfilled remainder is cancelled, and taker fees are modeled.
- There are no sells, take-profits, or stop-losses. All filled shares stay open until the official result for their original market settles them. Resting limit fills have no modeled taker fee or maker rebate.

The price triggers are paper assumptions, not predictions or guaranteed real-world executions. The simulated 100-share limit fill is confirmed from the best ask crossing the limit; the separate 200-share reversal buy uses visible ask depth but does not model latency or book changes during a sweep.

## Dashboard and runtime

The compact dashboard shows both UP/DOWN books and limit-order states, the filled-side midpoint and reversal status, current positions, paper equity, realized P&L, cash, recent orders, and positions waiting for official resolution. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for two-sided resting entries, first-fill cancellation, midpoint-triggered opposite buys, maker/taker accounting, expiry at window end, resolution-only settlement, completed-window statistics, CLOB-only entry behavior, market-stream updates, and dashboard checks.
