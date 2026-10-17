# Paper bot runbook

1. Verify the dashboard shows a single 15-minute market, a $10,000 paper bankroll, and UP/DOWN CLOB quotes.
2. Completed 15-minute BTC candle patterns select UP or DOWN. Neutral or conflicting patterns do not trade.
3. After the 9-second signal delay, post a passive $0.45 limit buy for the signalled side; stop posting new orders after 810 seconds. If the best ask is already at or below $0.45, wait rather than crossing as a taker.
4. Size the base order at 5% of current capital. Following a loss, double the next order once, then reset to a new 5% base after that order settles, win or lose.
5. Reserve paper cash when posting. Fill only when a later ask reaches $0.45; cancel and refund unfilled orders at the window close. Maker fees are zero.
6. Eligible crypto maker fills contribute to Polymarket's daily maker rebate pool (20% of eligible taker fees, allocated pro-rata). Paper mode records fee-equivalent volume but cannot know the actual wallet rebate, which depends on total per-market maker activity.
7. Any fresh own-side quote at $0.99 or higher settles a $1/share win; at $0.01 or lower settles a zero payout. Otherwise, retry the official Gamma result at market close.
8. Paper trades and account state reset on process restart. No live order placement is present.

The bot refreshes CLOB books every 500 ms and consumes Polymarket RTDS Chainlink BTC/USD to build one-minute candles and completed 15-minute candles. The dashboard refreshes every 2 seconds. Paper order state, account history, and martingale progression reset on process restart.
