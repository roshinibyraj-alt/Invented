# Invented BTC 5-minute order-flow paper bot

This service runs a paper-only strategy for Polymarket BTC 5-minute UP/DOWN markets. It combines Binance BTCUSDT aggregate trades with Polymarket CLOB trade flow, top-of-book depth, and microprice. It does not submit live orders.

## Strategy

- Measure aggressive Binance buy/sell notional, trade count, and short-term price movement over a rolling five-second window.
- Measure Polymarket trade pressure and the top three levels of each UP/DOWN book.
- Check once per second. Binance and Polymarket must agree, each source must meet its minimum pressure, and the combined directional score must reach the configured threshold for three consecutive checks.
- A newly confirmed direction sweeps up to 20 shares from visible ask depth. It does not add again while that same signal remains active. Outstanding inventory is capped at 100 shares per outcome, including unresolved positions from earlier windows.
- A confirmed opposite signal attempts to sell the held side against visible bids and independently opens a 20-share clip on the new side. Partial exit inventory is retried as fresh bid depth becomes available.
- Shares that remain open at window end wait for official resolution of their original market. Taker fees are modeled in paper P&L; results are estimates and profits are not guaranteed.

The combined pressure signal is a heuristic, not a prediction guarantee. Paper fills use currently visible order-book depth and cannot guarantee real-world execution, latency, fees, or slippage.

## Dashboard and runtime

The dashboard shows both pressure scores, confirmation progress, feed freshness, UP/DOWN books and positions, paper equity, modeled fees, recent orders, and resolution history. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for signal confirmation, Binance flow parsing, reversal entries/exits, partial-sale retries, stale-feed rejection, position caps, market-stream updates, and dashboard checks.
