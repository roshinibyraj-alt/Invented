# Invented BTC 5-minute order-flow accumulation paper bot

This service runs a paper-only strategy for Polymarket BTC 5-minute UP/DOWN markets. It combines Binance BTCUSDT aggregate trades with Polymarket CLOB trade flow, top-of-book depth, and microprice. It does not submit live orders.

## Strategy

- Measure aggressive Binance buy/sell notional, trade count, and short-term price movement over a rolling five-second window.
- Measure Polymarket trade pressure and the top three levels of each UP/DOWN book.
- Check once per second. Binance and Polymarket must agree, each source must meet its minimum pressure, and the combined directional score must reach the configured threshold for three consecutive checks.
- Each newly confirmed direction places a 100-share maker limit buy at the signalled side's current best ask minus $0.03. It does not repeat while that same signal remains active; a later re-confirmation can place another order. An unfilled order is cancelled by the next confirmed signal or at window end.
- An opposite signal only buys the newly signalled side; it never sells existing shares. Each side's full accumulated current-window position closes at a $0.99 best-bid take-profit trigger, counted as $1 per share, or at a $0.01-or-lower best-bid stop trigger, counted as $0 per share. The limit take-profit has no modeled sell fee and can receive a modeled maker rebate.
- A fresh best ask touching or crossing the paper limit marks the full order filled at the current ask, without modeling queue position or displayed quantity. The simulation charges no taker fee and estimates an eligible maker rebate; neither paper fill quality nor rebate is guaranteed in real trading.
- Positions that hit neither threshold by window end leave the current UP/DOWN boxes and wait separately for the official resolution of their original market.

The combined pressure signal is a heuristic, not a prediction guarantee. Paper fills trigger on a best-ask touch and do not model queue priority or available size, so they can overstate real fills. They cannot guarantee real-world execution, latency, fees, or slippage.

## Dashboard and runtime

The dashboard shows both pressure scores, confirmation progress, feed freshness, UP/DOWN books, separate current-window position boxes, and a separate list of positions waiting for resolution. It also shows the global equity curve, completed-trading-window win rate, estimated rebates, resting and filled buys, and TP/SL exits. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for signal confirmation, Binance flow parsing, maker-order pricing and fill/cancellation, estimated rebate accounting, independent-side accumulation, TP/SL exits, completed-window statistics, window-end resolution handling, stale-feed rejection, market-stream updates, and dashboard checks.
