# Fixed-price ladder runbook

1. Confirm the dashboard shows PAPER ONLY and a live Polymarket connection.
2. At the start of each BTC 5-minute window, the bot posts 100-share UP and DOWN limit buys at $0.40, $0.35, $0.30, $0.25, $0.20, $0.15, $0.10, and $0.05.
3. Each rung expires at its matching elapsed-window deadline: 10s, 50s, 160s, 200s, 220s, 230s, 250s, and 270s. The bot cancels any unfilled remainder.
4. A fresh best ask at or below a resting limit, or an opposing sell trade print at or below it, counts the full 100-share rung as filled. The paper model ignores queue depth and print size, so fills are optimistic and are not confirmed exchange executions.
5. Open positions are marked to the current best bid; floating P&L is included in equity. A best bid of $0.99 exits at $1 per share, and $0.01 exits at $0 per share.
6. Positions that hit neither threshold remain open until official resolution. Positions awaiting resolution use their latest available CLOB mark.
7. The paper ledger is in memory and resets when Railway restarts the service.
