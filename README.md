# BTC/ETH opening-range breakout paper bot

This service runs a demo-only opening-range breakout strategy on aligned Polymarket BTC and ETH 5-minute Up/Down markets. It never submits live orders.

## Strategy

- BTC and ETH are evaluated independently in every aligned 5-minute market window.
- Wait until two one-minute Binance candles inside the window have closed. The first candle defines the opening high/low range.
- A setup needs both candles to move in the same direction, the second candle to close beyond the first candle's range, and its body to be at least **1.25× the median body of the prior 20 completed one-minute candles**.
- Entries are allowed from 2:02 through 3:00 of the market window. The signaled side's ask must be $0.35–$0.65, its spread no wider than $0.04, and its quote no more than two seconds old.
- Each asset has a **$15 maximum total debit, including taker fees**, with a minimum risk-sized order of 10 whole shares. At most one position is opened per asset per window; no adding or martingale.
- The complete calculated order size must be supported by fresh visible ask depth at or below $0.65 and fit inside the $15 cap. Partial or timeout fills are never recorded.
- The bot does **not sell during a window**. Filled shares wait for confirmed resolution of their exact original BTC or ETH market.

## Dashboard and runtime

The dashboard shows each asset's opening-range high/low, confirmation candle, body multiple, Polymarket asks, entry filters, risk-sized fill status, account totals, positions, and activity. The body multiple is a filter, not a probability. Demo account state is held in process memory and resets when the Railway service restarts.

Run `npm test` to verify candle alignment, breakout confirmation, quote and price filters, risk sizing, full-depth paper fills, fee accounting, one entry per asset/window, exact-market settlement, and dashboard content.
