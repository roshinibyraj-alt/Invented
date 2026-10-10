# Demo arbitrage runbook

1. Keep `LIVE_TRADING` unset; the project contains no live order executor.
2. In Railway Variables, configure `PREDICT_API_KEY` server-side. Never paste it in the dashboard or source.
3. Run `npm test`, then `npm start`.
4. Check `/api/healthz` and `/api/state`. A missing key or market API failure appears as an error; the dashboard and Railway logs must not show the key.
5. The scanner refreshes venue markets every 60 seconds and cycles 24 exact-title binary matches every 10 seconds.
6. It only records a paper pair when both visible ask books contain 500 shares and the estimated all-in edge is at least $0.03 per share, within the shared $10,000 cash balance.

## Limits

Crypto is excluded by title/category/description/tag keywords. The current scanner only handles exact-title, two-outcome markets with recognized outcome labels and Predict YES/NO book semantics. It intentionally skips markets it cannot map safely. Cross-venue resolution rules may differ; open trades remain pending and do not count as realized profit.
