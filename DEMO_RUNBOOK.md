# Paper strategy runbook

1. Confirm both BTC and ETH 5-minute markets are available for the same window.
2. Wait 60 seconds after the window opens. From second 60 through second 299, a matching side triggers when BTC's best ask is at least $0.80 and the matching ETH best ask is below $0.50.
3. The bot submits one 100-share paper market buy on the matching ETH side, filling only against the currently visible ETH ask depth. It cancels any market-order remainder.
4. The TP is modeled at $0.99 and credited as $1/share, subject to newly observed bid depth at $0.99 or better. There is no stop loss.
5. At the ETH window end, unexited shares wait for confirmed Polymarket resolution of that exact ETH market.
6. There is no final-minute entry cutoff. The service is paper-only. A process restart clears its in-memory account and history.
