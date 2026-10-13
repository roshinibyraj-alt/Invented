# Paper bot runbook

1. Verify the dashboard shows one 5-minute market, a $10,000 bankroll, and separate live UP/DOWN CLOB quotes.
2. The previous completed 5-minute candle's body is `abs(close-open)`. For green candles, a fall from the previous close buys UP; for red candles, a rise buys DOWN.
3. Rungs: 25%/100 shares, 50%/200, 75%/300, 90%/400. No new trigger or fill after 240 seconds; fills are spaced at least 2 seconds apart.
4. Entry fills require complete displayed ask depth in the $0.05–$0.60 band. Simulated buys include the Polymarket BTC taker fee.
5. Fresh UP/DOWN CLOB bids, asks, or midpoints captured in the final 3 seconds decide the winner. A quote at least $0.98 identifies the winner; a quote at or below $0.02 identifies the opposite side. If neither side has a terminal quote, the higher available quote wins. A win pays $1/share; a loss pays $0/share.
6. Paper trades and account state reset on process restart. No live order placement is present.

The bot refreshes CLOB books every 500 ms and Kraken candles every second; the dashboard refreshes every 2 seconds. After all four rung positions in one window settle as wins, the following window reverses the signalled side once. After that window settles, normal signal direction resumes.
