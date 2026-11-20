# Invented BTC 5-minute independent-side order-flow paper bot

This service runs a paper-only strategy for Polymarket BTC 5-minute UP/DOWN markets. It combines Binance BTCUSDT aggregate trades with Polymarket CLOB trade flow, top-of-book depth, and microprice. It does not submit live orders.

## Strategy

- Measure aggressive Binance buy/sell notional, trade count, and short-term price movement over a rolling five-second window.
- Measure Polymarket trade pressure and the top three levels of each UP/DOWN book.
- Check once per second. Binance and Polymarket must agree, each source must meet its minimum pressure, and the combined directional score must reach the configured threshold for three consecutive checks.
- Each newly confirmed UP pressure signal buys DOWN; each newly confirmed DOWN signal buys UP. Each new signal episode requests 100 shares. There is no entry-price floor or ceiling. Paper market orders sweep all valid visible asks; partial fills are allowed, and any unfilled remainder is cancelled immediately. Taker fees are modeled at each fill price. It does not repeat while that same signal remains active; a later re-confirmation can place another order.
- Opposite signals never sell existing positions. Each new signal episode buys its reversed side independently; positions on both sides can accumulate in the same window.
- There are no take-profit orders, stop-losses, or signal-triggered exits. Filled shares remain open for the full window, then wait for official resolution of their original market. Only confirmed resolution pays out and updates realized P&L and cash.
- Market entries are immediate, never left resting, and only execute against ask depth visible in the current book. Paper execution does not model latency or book changes during a sweep. Only entry taker fees are modeled; no sell orders or sell fees are created.

The combined pressure signal is a heuristic, not a prediction guarantee. Paper sweeps use the current displayed order book but do not model latency, book changes during order submission, or real-world execution quality.

## Dashboard and runtime

The compact dashboard shows the active signal, both UP/DOWN books and positions, paper equity, realized P&L, cash, completed-window win rate, current pressure scores, recent orders, and positions waiting for official resolution. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for signal confirmation, reversed-side entries, Binance flow parsing, visible-ask market sweeps, partial fills without entry price gates, taker-fee accounting, independent-side accumulation, no-early-sell behavior, resolution-only settlement, completed-window statistics, stale-feed rejection, market-stream updates, and dashboard checks.
