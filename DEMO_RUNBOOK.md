# Paper bot runbook

1. Confirm the dashboard shows only the BTC 5-minute window, $10,000 demo capital, and live UP/DOWN CLOB asks.
2. The bot waits 4 minutes, then checks every 500ms until window end. If either fresh best ask is strictly between $0.42 and $0.59, it market-buys 300 shares on both UP and DOWN.
3. Market buys sweep displayed asks; record actual filled shares, average price, and taker fees. Unfilled remainder is canceled.
4. Filled shares get $0.80 resting limit sells. After either side's TP fills, move the opposite side's remaining TP to $0.99, booked as $1 per share.
5. Positions without a TP fill by window end wait for official Polymarket resolution. No stop-loss or live orders are used.
6. The active-window dashboard boxes show accumulated UP/DOWN shares and fee-inclusive average costs. Paper history resets on process restart or redeployment.
