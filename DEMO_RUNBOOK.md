# Demo runbook

The app runs one BTC 5-minute paper strategy and one $10,000 paper account.

1. During the final 10 seconds before a window opens, the bot scans the upcoming BTC market.
2. At T−3 seconds, it compares live BTC with the previous closed 1-minute candle close. The comparison represents the final 57 seconds: higher selects UP; equal or lower selects DOWN.
3. At window open, it submits a simulated $0.45 limit buy for 500 shares on the selected side.
4. Fresh visible asks at or below $0.45 fill at the actual better price. Any remaining shares are simulated at exactly $0.45 one second after the order was placed.
5. No taker fee is charged in the paper model. Estimated maker rebates for entry and TP fills are credited to the account and included in P&L.
6. After an entry fill, the bot places a $0.99 limit sell, with the ledger paying $1 per share when it fills. There is no stop loss.
7. Positions not sold by the end of the market window wait for official Polymarket resolution.

The one-second fill is a paper simulation rule, not a claim that a live limit order would fill. Account history is process-local and clears on restart or redeployment.

Run checks with `npm test`; start the app with `npm start`.
