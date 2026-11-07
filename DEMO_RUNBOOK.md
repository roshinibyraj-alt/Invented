# Paper bot runbook

1. Confirm the dashboard shows two separate BTC 5-minute demo accounts, each funded with $10,000, and live UP/DOWN CLOB asks.
2. **4-minute two-rung strategy:** after 4:00, place limit buys for 300 shares per side at $0.20 and $0.10. Match visible ask liquidity only at or below the limit; record actual filled shares at the fixed limit price, and cancel each unfilled remainder after a partial fill or at window end.
3. Place each filled rung's limit sell immediately: $0.20 entry → $0.80 TP; $0.10 entry → $0.90 TP.
4. **Candle pre-buy strategy:** discover the next market during the final 10 seconds. Read the latest fully closed one-minute candle at T−5s; green signals UP, red signals DOWN, doji skips. Buy 500 shares on the indicated side at T−2s only with a fresh book.
5. One second after open, place a $0.70 TP for the pre-buy fill. On the four-minute strategy, when any TP fills, move the other side's pending TPs to $0.99, booked as $1/share.
6. Market buys incur market fees. Maker limit buys and sells have no taker fee; estimated maker rebates are displayed but not added to cash.
7. Positions without a TP fill by window end wait for official Polymarket resolution. Neither strategy uses a stop-loss or live orders.
8. Each dashboard portfolio panel shows its own capital, results, equity curve, live quotes, and UP/DOWN inventory. Paper history resets on process restart or redeployment.
