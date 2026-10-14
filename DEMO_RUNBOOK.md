# Paper bot runbook

1. Verify the dashboard shows one 5-minute market, a $10,000 bankroll, and separate live UP/DOWN CLOB quotes.
2. The previous completed 5-minute candle's body is `abs(close-open)`. For green candles, a fall from the previous close buys UP; for red candles, a rise buys DOWN.
3. Rungs: 25%/100 shares, 50%/200, 75%/300, 90%/400. No new trigger or fill after 240 seconds; fills are spaced at least 2 seconds apart.
4. Demo entries fill the full requested share size at the best eligible ask in the $0.05–$0.60 band, even when displayed ask depth is short. The fill log labels shares simulated beyond visible depth. Simulated buys include the Polymarket BTC taker fee.
5. Any fresh bid, ask, or midpoint on the position's own side at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower immediately settles as a $0/share loss. If neither threshold is reached, query Polymarket's official Gamma result at close and retry until the official result is available.
6. Paper trades and account state reset on process restart. No live order placement is present.

The bot refreshes CLOB books every 500 ms and Kraken candles every second; the dashboard refreshes every 2 seconds. Three or more settled rung wins or losses arm one 500-share trade on the signal side in the next window. After that window, regular signalling resumes regardless of trade result.
