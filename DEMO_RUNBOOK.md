# Demo runbook

The app runs one BTC 5-minute paper strategy and one $10,000 paper account.

1. During the final 10 seconds before a window opens, the bot scans the upcoming BTC market.
2. At T−3 seconds, it compares live BTC with the previous closed 1-minute candle close. The comparison represents the final 57 seconds: higher selects UP; equal or lower selects DOWN.
3. At window open, it submits a simulated $0.45 limit buy for 100 shares on the side opposite the signal.
4. The $0.45 buy cannot fill above its limit. Asks below $0.45 already present at submission may fill at their lower prices; if the order rests first, subsequent resting-order fills are recorded at $0.45. Count only newly observed depth, not the same unchanged book on every poll. There is no timeout fill. The remaining order stays pending and is cancelled at window end.
5. No taker fee is charged in the paper model. Estimated maker rebates for entry and TP fills are credited to the account and included in P&L.
6. Filled positions have no take-profit or stop-loss order.
7. Positions remain open through window end and wait for official Polymarket resolution.

Paper fills are simulated from visible order-book depth and are not confirmation of a real order or trade. Account history is process-local and clears on restart or redeployment.

Run checks with `npm test`; start the app with `npm start`.
