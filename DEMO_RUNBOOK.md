# Fair-value accumulation paper-bot runbook

1. The bot is paper-only and does not submit live orders.
2. It estimates UP/DOWN probabilities from the latest Binance BTCUSDT tick, the current 5-minute window open, and two completed 5-minute candles.
3. At each 10-second check, a side qualifies only when its fair value is strictly above 50% and its best ask is below $0.40.
4. A qualifying check simulates exactly 100 shares only when fresh visible asks cover all 100 shares strictly below $0.40. Partial entries are not recorded; modeled taker fees are deducted.
5. It can repeat buys on later checks without a fixed per-side share cap. Available paper cash and ask depth limit entries.
6. Passive sell orders remain available for owned inventory, stop during the final 30 seconds, and rely on fresh trade prints plus a conservative queue estimate.
7. Any shares left open at expiry wait for confirmed resolution of their original market. Paper fills and maker rebates are estimates, not guaranteed exchange outcomes.
