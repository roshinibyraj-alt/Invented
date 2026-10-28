# Paper bot runbook

1. Confirm the dashboard shows separate 5m and 15m bots, $10,000 demo bankrolls, and live UP/DOWN CLOB quotes.
2. Each window uses the latest completed candle: green signals UP, red signals DOWN, and a doji reverses only after a run of at least two same-color candles. The bot waits when no valid direction exists.
3. Each signal window submits 500-share limit orders at $0.30 and $0.20. New fills stop at 180 seconds for 5m and 540 seconds for 15m.
4. Fresh own-side bids of at least $0.99 pay $1/share; bids of at most $0.01 pay $0/share and complete that window. Remaining positions close at their own bid or $0 if no bid is available.
5. A rung take-profit arms one opposite-side recovery buy for the next window, using its live best ask. Stake begins at 500 shares, doubles after losses to the configured limit, and resets to 500 after a win or maximum-level loss.
6. State is in memory and resets on process restart. No live order placement or official-market settlement is used.
