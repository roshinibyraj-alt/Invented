# Paper strategy runbook

1. Confirm the BTC and ETH 5-minute markets have the same window start.
2. Monitor BTC UP + ETH DOWN and ETH UP + BTC DOWN independently throughout the window.
3. Start with $1,000 paper capital. At combined asks of $0.80, $0.70, $0.60, $0.50, and $0.40 or lower, buy 100 shares per leg for each tier.
4. Each tier is one-shot per pair/window and latches once qualified. If one scan crosses several thresholds, try each newly qualified tier. Require full visible depth on both legs at or below $0.99 per share; reserve consumed ask depth so another tier cannot reuse it. If a tier cannot fully fill, book zero and retry it.
5. Do not sell during the window. At window close, move all filled shares into the BTC UP, BTC DOWN, ETH UP, or ETH DOWN awaiting-resolution box. Check each exact original market for confirmed resolution every 5 seconds; do not settle from an unconfirmed price. The service is paper-only; a process restart clears its in-memory account and history.
