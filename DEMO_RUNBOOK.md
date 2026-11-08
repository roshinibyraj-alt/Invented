# Paper strategy runbook

1. Confirm both BTC and ETH 5-minute markets are available for the same window.
2. During the first 180 seconds, a matching side triggers when BTC's best ask is at least $0.80 and ETH's best ask is below $0.60.
3. The bot submits one 100-share paper market buy on the matching ETH side, filling only against the currently visible ETH ask depth. It cancels any market-order remainder.
4. The TP is modeled at $0.99 and credited as $1/share, subject to newly observed bid depth at $0.99 or better. There is no stop loss.
5. At the ETH window end, unexited shares wait for confirmed Polymarket resolution of that exact ETH market.
6. The service is paper-only. A process restart clears its in-memory account and history.
