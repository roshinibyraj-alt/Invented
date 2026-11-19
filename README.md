# Invented BTC 5-minute order-flow profit-exit paper bot

This service runs a paper-only strategy for Polymarket BTC 5-minute UP/DOWN markets. It combines Binance BTCUSDT aggregate trades with Polymarket CLOB trade flow, top-of-book depth, and microprice. It does not submit live orders.

## Strategy

- Measure aggressive Binance buy/sell notional, trade count, and short-term price movement over a rolling five-second window.
- Measure Polymarket trade pressure and the top three levels of each UP/DOWN book.
- Check once per second. Binance and Polymarket must agree, each source must meet its minimum pressure, and the combined directional score must reach the configured threshold for three consecutive checks.
- Each newly confirmed signal buys that same side. Same-side signal episodes add 100 shares. The buy limit uses the signalled side's current midpoint; a fresh midpoint reaching at least $0.01 below the limit counts as a full fill at the limit price. It does not repeat while that same signal remains active; a later re-confirmation can place another order.
- On an opposite confirmed signal, estimate liquidation P&L at the active side's fresh best bid, after modeled taker sell fee and entry fees and including entry rebate. Sell all current-side shares only when that projected net P&L is positive; otherwise keep holding and skip the signal. A profitable exit does not place a buy on the opposite side.
- Each side's full accumulated current-window position still closes at a $0.99 best-bid take-profit trigger, counted as $1 per share, or at a $0.01-or-lower best-bid stop trigger, counted as $0 per share. A take-profit may receive a modeled maker rebate.
- An unfilled entry is cancelled when a new confirmed signal arrives or its window ends. Price-walk fills assume the full requested size without modeling queue position or visible depth. No taker entry fee is modeled; eligible filled entries and take-profit orders may earn estimated maker rebates.
- Positions that hit neither threshold by window end leave the current UP/DOWN boxes and wait separately for the official resolution of their original market.

The combined pressure signal is a heuristic, not a prediction guarantee. Paper sweeps use the current displayed order book but do not model latency, book changes during order submission, or real-world execution quality.

## Dashboard and runtime

The dashboard shows both pressure scores, confirmation progress, feed freshness, UP/DOWN books, separate current-window position boxes, and a separate list of positions waiting for resolution. It also shows the global equity curve, completed-trading-window win rate, estimated maker rebates, resting entries, and TP/SL exits. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for signal confirmation, Binance flow parsing, midpoint resting-order placement, one-cent price-walk full fills, signal-based order replacement, estimated maker-rebate accounting, independent-side accumulation, TP/SL exits, completed-window statistics, window-end cancellation and resolution handling, stale-feed rejection, market-stream updates, and dashboard checks.
