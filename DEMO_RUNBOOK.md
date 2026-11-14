# Fixed-price ladder runbook

1. Confirm the dashboard shows PAPER ONLY and a live Polymarket connection.
2. At the start of each BTC 5-minute window, the bot posts 100-share UP and DOWN limit buys at $0.40, $0.35, $0.30, $0.25, $0.20, $0.15, $0.10, and $0.05.
3. Each rung expires at its matching elapsed-window deadline: 10s, 50s, 160s, 200s, 220s, 230s, 250s, and 270s. The bot cancels any unfilled remainder.
4. Fresh opposing-side trade prints can fill a resting order. At the exact limit, the estimated queue ahead must be consumed first. Book touches do not create fills.
5. Filled shares remain open until the official resolution of their original market. There are no take-profit sells, stop-losses, or automatic merges.
6. The paper ledger is in memory and resets when Railway restarts the service.
