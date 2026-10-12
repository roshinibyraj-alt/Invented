# Paper bot runbook

1. Verify the 5m and 15m cards show independent $10,000 bankrolls and live UP/DOWN quotes.
2. The prior candle body is `abs(close-open)`; thresholds are measured from its close.
3. A green prior candle triggers 100 UP shares on a 25% fall in minute 1, then 200 UP shares if price returns to the prior close in minute 2. A red candle mirrors this for DOWN.
4. Entry attempts expire at the end of their designated minute if full visible ask depth in the $0.05-$0.60 band is unavailable. Confirm entry and exit prices in the trade list.
5. No sell orders or stop-loss/take-profit exits are used. Open shares remain until Polymarket's official result. All state resets if Railway restarts.
