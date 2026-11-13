# Paper market-maker runbook

1. The bot is paper-only. It sends no wallet or live order instructions.
2. It calculates UP/DOWN fair values from the latest Binance BTCUSDT tick, the current 5-minute window open, and two completed 5-minute candles.
3. It places passive 20-share bid quotes on both outcome tokens, capped at 100 unresolved shares per outcome. As inventory is acquired, it posts passive sell quotes only for shares it owns.
4. Quote prices stay at least one tick from the opposing visible best price. Volatility widens the spread; inventory imbalance skews the fair values to reduce the heavy side.
5. A book touch is not a fill. Paper fills require a fresh public trade print from the opposite taker side at or through the order price, after the estimated queue ahead is cleared.
6. Quotes stop and are cancelled during the final 30 seconds of the window. Remaining inventory is held for confirmed resolution of its original market.
7. The dashboard reports estimated maker rebates, not guaranteed credits. Public data does not reveal actual queue priority, so simulated fills remain estimates.
