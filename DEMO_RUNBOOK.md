# Paper bot runbook

1. Confirm the dashboard shows two separate BTC 5-minute demo accounts, each funded with $10,000, and live UP/DOWN CLOB asks.
2. **4-minute paired strategy:** after 4:00, scan every 500ms. If either fresh best ask is strictly between $0.42 and $0.59, market-buy 300 shares on both UP and DOWN once for that window.
3. **10-second pre-buy strategy:** during the final 10 seconds before the upcoming window, attempt a paired market buy of 500 UP and 500 DOWN shares. If fresh books are unavailable before open, skip the window rather than entering late.
4. Market buys sweep displayed asks; record actual filled shares, average price, and taker fees. Unfilled remainders are canceled.
5. The first strategy places $0.80 resting limit sells at entry. The pre-buy strategy creates $0.70 limit sells one second after the new window opens. In either strategy, after one side's TP fills, move the opposite remaining TP to $0.99, booked as $1 per share.
6. Positions without a TP fill by window end wait for official Polymarket resolution. Neither strategy uses a stop-loss or live orders.
7. Each dashboard portfolio panel shows its own capital, results, equity curve, live quotes, and UP/DOWN inventory. Paper history resets on process restart or redeployment.
