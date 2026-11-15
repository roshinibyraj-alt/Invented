# Invented BTC 5-minute order-flow accumulation paper bot

This service runs a paper-only strategy for Polymarket BTC 5-minute UP/DOWN markets. It combines Binance BTCUSDT aggregate trades with Polymarket CLOB trade flow, top-of-book depth, and microprice. It does not submit live orders.

## Strategy

- Measure aggressive Binance buy/sell notional, trade count, and short-term price movement over a rolling five-second window.
- Measure Polymarket trade pressure and the top three levels of each UP/DOWN book.
- Check once per second. Binance and Polymarket must agree, each source must meet its minimum pressure, and the combined directional score must reach the configured threshold for three consecutive checks.
- Each newly confirmed direction requests 100 shares from visible ask depth. It does not repeat while that same signal remains active; a later re-confirmation can add another 100. UP and DOWN positions accumulate independently, with no per-side share cap other than available paper cash and visible asks.
- An opposite signal only buys the newly signalled side; it never sells existing shares. Each side's full accumulated current-window position closes at a $0.99 best-bid take-profit trigger, counted as $1 per share, or at a $0.01-or-lower best-bid stop trigger, counted as $0 per share. The limit take-profit has no modeled sell fee and can receive a modeled maker rebate.
- Positions that hit neither threshold by window end leave the current UP/DOWN boxes and wait separately for the official resolution of their original market. Entry taker fees are modeled in paper P&L; results are estimates and profits are not guaranteed.

The combined pressure signal is a heuristic, not a prediction guarantee. Paper fills use currently visible order-book depth and cannot guarantee real-world execution, latency, fees, or slippage.

## Dashboard and runtime

The dashboard shows both pressure scores, confirmation progress, feed freshness, UP/DOWN books, separate current-window position boxes, and a separate list of positions waiting for resolution. It also shows paper equity, modeled fees, recent buys and TP/SL exits. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for signal confirmation, Binance flow parsing, independent-side accumulation, TP/SL exits, window-end resolution handling, stale-feed rejection, market-stream updates, and dashboard checks.
