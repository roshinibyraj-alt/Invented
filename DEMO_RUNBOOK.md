# Paper bot runbook

1. Confirm the dashboard shows BTC 5-minute and 15-minute demo windows, $10,000 total demo capital, and live UP/DOWN CLOB quotes.
2. The 5-minute bot buys the cheaper ask every 10 seconds from 0–1 minute (10-share base), then the more expensive ask every 20 seconds from 1–3 minutes (50-share base).
3. Each scheduled order within a phase is 1.5× the prior interval size. The 15-minute bot uses the same phases and sizes with all timings multiplied by 3.
4. Taker buys consume displayed ask depth and include fees. Filled shares get a resting $0.99 TP; a fresh best bid at or above $0.99 records $1 per share in proceeds.
5. Positions without a TP fill by their own market's window end wait for official Polymarket resolution. No stop-loss or live orders are used.
6. The bots have separate $5,000 paper balances; paper history resets on process restart or redeployment.
