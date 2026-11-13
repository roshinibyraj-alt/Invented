# Invented BTC 5-minute market-maker paper bot

This service runs a paper-only, inventory-aware market maker for Polymarket BTC 5-minute UP/DOWN markets. It uses Binance BTCUSDT ticks, the two most recent completed 5-minute candles, and Polymarket's public CLOB market stream. It does not submit live orders.

## Strategy

- Estimate fair values for UP and DOWN from the Binance model.
- Place one passive bid quote on each outcome. Once shares are held, place a passive ask against that inventory; the bot never shorts or sells shares it does not own.
- Keep quotes at least one tick away from the visible opposing best price. Reprice only when the target moves enough to avoid unnecessary queue resets.
- Start with a 2¢ half-spread and widen it with observed volatility, up to 8¢. Skew both fair values to encourage reducing the heavier UP/DOWN inventory.
- Quote 20 shares at a time and cap unresolved inventory at 100 shares per outcome, including positions waiting for older windows to resolve. Resting buy orders reserve available demo cash.
- Stop opening or repricing quotes in the final 30 seconds of a window. Cancel remaining quotes at the cutoff; any held shares wait for official resolution of their original market.
- Paper fills require a fresh Polymarket `last_trade_price` event from the opposite taker side at or through the limit. At the exact limit, the simulated trade volume must clear the visible queue plus an extra queue buffer. A price touch or book update alone does not fill an order.
- Maker orders pay no modeled taker fee. Any maker rebate is shown as an estimate only and is not treated as guaranteed.

The public trade feed cannot reveal the bot's actual queue position. Queue-buffer fills are therefore an estimate, not a guaranteed exchange fill. A maker quote can fill just before the fair value moves against the acquired inventory; profits are not guaranteed.

## Dashboard and runtime

The dashboard shows fair values, Binance and Polymarket feed status, order-book prices, each outcome's working bid/ask, queue estimate, inventory, account totals, fills, cancellations, and settlements. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for model, quote-safety, inventory cap, queue-aware trade-print fill, partial-fill, cancellation, settlement, WebSocket, and dashboard checks.
