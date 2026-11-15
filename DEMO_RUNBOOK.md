# Fixed-price ladder runbook

1. Confirm the dashboard shows PAPER ONLY and a live Polymarket connection.
2. At the start of each BTC 5-minute window, the bot posts 100-share UP and DOWN limit buys at $0.40, $0.35, $0.30, $0.25, $0.20, $0.15, $0.10, and $0.05.
3. Each rung expires at its matching elapsed-window deadline: 10s, 50s, 160s, 200s, 220s, 230s, 250s, and 270s. The bot cancels any unfilled remainder.
4. A fresh best ask at or below a resting limit, or an opposing sell trade print at or below it, counts the full 100-share rung as filled. The paper model ignores queue depth and print size, so fills are optimistic and are not confirmed exchange executions.
5. Each rung posts a resting limit sell at the opposite-side equivalent price (`$1.01 - rung price`): $0.40→$0.61, $0.35→$0.66, $0.30→$0.71, $0.25→$0.76, $0.20→$0.81, $0.15→$0.86, $0.10→$0.91, and $0.05→$0.96.
6. A fresh best bid or BUY trade print at or above a rung target counts the full 100-share paper sell as filled. That rung can buy again only before its original window-start deadline; re-arming does not reset the timer.
7. A best bid of $0.01 exits remaining shares at $0 per share. Positions that hit neither their rung target nor the stop-loss remain open until official resolution; positions awaiting resolution use their latest available CLOB mark.
8. The paper ledger is in memory and resets when Railway restarts the service.
