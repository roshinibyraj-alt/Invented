# Paper strategy runbook

1. Confirm the BTC and ETH 5-minute markets have the same window start.
2. Monitor BTC UP + ETH DOWN and ETH UP + BTC DOWN independently throughout the window.
3. Enter 200 shares per leg when combined asks are below $0.90. Add 300 shares per leg at each combined-ask tier of $0.80, $0.70, $0.60, and $0.50 or lower.
4. Each tier is one-shot per pair/window and latches once qualified. If one scan crosses several thresholds, try each newly qualified tier. Require full visible depth on both legs at or below $0.99 per share; reserve consumed ask depth so another tier cannot reuse it. If a tier cannot fully fill, book zero and retry it.
5. Do not sell during the window. At window close, all filled shares wait for the exact original BTC or ETH market's confirmed result. The service is paper-only; a process restart clears its in-memory account and history.
