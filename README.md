# Invented BTC 5-minute fair-value accumulation paper bot

This service simulates Polymarket BTC 5-minute UP/DOWN entries using Binance BTCUSDT ticks, the two most recent completed 5-minute candles, and Polymarket's public CLOB market stream. It does not submit live orders.

## Strategy

- Estimate UP and DOWN payout probabilities from the Binance model.
- At each 10-second check, buy 100 shares on a side only if that side's model probability is strictly above 50%.
- Require a fresh best ask below $0.40 and enough visible ask depth to fill the full 100 shares strictly below $0.40. A partial entry is not recorded.
- Repeat the 100-share buy at every later qualifying check, with no fixed per-side share cap. Available paper cash and visible ask liquidity are the practical limits.
- Entry orders use ask-book sweeps and include modeled taker fees. Passive sell orders remain available only for shares already owned; their fills use fresh trade prints and a conservative queue estimate.
- Stop posting passive sell orders in the final 30 seconds. Any shares still held wait for official resolution of their original market.

Paper fills are estimates, not guaranteed exchange executions. Public data does not reveal actual queue priority, and profits are not guaranteed.

## Dashboard and runtime

The dashboard shows raw fair values, the next 10-second check, signal qualification per side, Polymarket prices and visible depth, positions, modeled taker fees, passive sell orders, and official settlements. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for signal thresholds, check cadence, full-size ask depth, passive sell fills, settlement, WebSocket, and dashboard checks.
