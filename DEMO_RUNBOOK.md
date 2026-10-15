# Paper bot runbook

1. Verify the dashboard shows one 5-minute market, a $10,000 bankroll, and separate live UP/DOWN CLOB quotes.
2. Candle patterns in completed five-minute BTC candles select UP or DOWN. Neutral or conflicting patterns produce no entry.
3. Make one paper entry for the signalled side once the window is at least 3 seconds old. Start at 500 shares; after each settled loss add 100, after each win subtract 100, bounded by 500 and 1,000. Do not attempt a new entry after 150 seconds.
4. Demo entries fill the full requested share size at the best eligible ask in the $0.05–$0.60 band, even when displayed ask depth is short. The fill log labels shares simulated beyond visible depth. Simulated buys include the Polymarket BTC taker fee.
5. Any fresh bid, ask, or midpoint on the position's own side at $0.99 or higher immediately settles as a $1/share win; at $0.01 or lower immediately settles as a $0/share loss. If neither threshold is reached, query Polymarket's official Gamma result at close and retry until the official result is available.
6. Paper trades and account state reset on process restart. No live order placement is present.

The bot refreshes CLOB books every 500 ms and consumes the Polymarket RTDS Chainlink BTC/USD stream to build one-minute candles and completed five-minute candles; the dashboard refreshes every 2 seconds. Candle patterns select the side, while CLOB quotes continue to supply simulated entry and exit prices. Eligible asks remain limited to $0.05–$0.60; taker fees, bankroll checks, and CLOB settlement rules remain active. The equity chart and sizing progression reset on process restart.
