# Paper bot runbook

1. Verify the dashboard shows a single 15-minute market, a $10,000 paper bankroll, and UP/DOWN CLOB quotes.
2. Completed 15-minute BTC candle patterns select UP or DOWN. Neutral or conflicting patterns do not trade.
3. After the 9-second signal delay, submit one paper market buy on the signalled side; stop new entries after 810 seconds. The fill uses the current best ask with no $0.45 price cap.
4. Budget the base entry at 5% of current capital. Following a loss, double the next budget once, then reset to a new 5% base after that entry settles, win or lose. Calculate shares from the current ask and estimated taker fee so the budget is not exceeded.
5. Deduct the estimated crypto taker fee from the paper ledger. Market entries fill immediately in the paper model; no maker rebate is assumed.
7. Any fresh own-side quote at $0.99 or higher settles a $1/share win; at $0.01 or lower settles a zero payout. Otherwise, retry the official Gamma result at market close.
8. Paper trades and account state reset on process restart. No live order placement is present.

The bot refreshes CLOB books every 500 ms and consumes Polymarket RTDS Chainlink BTC/USD to build one-minute candles and completed 15-minute candles. The dashboard refreshes every 2 seconds. Paper order state, account history, and martingale progression reset on process restart.
