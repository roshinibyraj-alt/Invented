# Opening-range breakout paper runbook

1. Keep the bot in demo mode. Live order execution is not available.
2. For each aligned 5-minute BTC and ETH window, wait until two one-minute Binance candles have closed.
3. A valid setup requires two same-direction candles, a second-candle close beyond the first candle's high/low, and a second-candle body at least 1.25 times the prior 20-candle median body.
4. From 2:02 through 3:00, enter only if the signaled-side ask is $0.35–$0.65, the spread is at most $0.04, and the quote is fresh. Size each asset to at most $15 total debit including fees.
5. Require full visible ask depth for the complete risk-sized order at or below $0.65. Do not record partial fills, add to positions, martingale, or sell during the window.
6. Hold filled shares for confirmed resolution of their exact original market. Demo account state is held in process memory and resets when the Railway service restarts.
