# Paper bot runbook

1. Verify the dashboard shows one 5-minute market, a $10,000 bankroll, and separate live UP/DOWN CLOB quotes.
2. The previous completed 5-minute candle's body is `abs(close-open)`. For green candles, a fall from the previous close buys UP; for red candles, a rise buys DOWN.
3. Rungs: 25%/100 shares, 50%/200, 75%/300, 90%/400. No new trigger or fill after 240 seconds; fills are spaced at least 2 seconds apart.
4. Entry fills require complete displayed ask depth in the $0.05–$0.60 band. Simulated buys include the Polymarket BTC taker fee.
5. The final 3 seconds' fresh UP/DOWN CLOB midpoints decide the winner: a midpoint at least $0.98 wins; otherwise the higher midpoint wins (an exact tie is UP). A win pays $1/share; a loss pays $0/share.
6. Paper trades and account state reset on process restart. No live order placement is present.
