# Paper strategy runbook

1. Confirm the BTC and ETH 5-minute markets have the same window start.
2. Monitor BTC UP + ETH DOWN and ETH UP + BTC DOWN independently throughout the window.
3. Start with $3,000 paper capital. Trigger at combined asks below $0.90, then at $0.80, $0.70, $0.60, and $0.50 or lower. Buy 100 shares of only the cheaper leg at each trigger.
4. Each rung is one-shot per pair/window. The first pair to trigger a rung pauses the opposite pair on that rung; other rungs remain independent. Choose the cheaper leg from the asks at the first trigger, require full visible depth on that leg at or below $0.99 per share, and reserve consumed ask depth so another rung cannot reuse it. If the selected leg cannot fully fill, book zero and retry that same leg.
5. Do not sell during the window. At window close, move all filled shares into the BTC UP, BTC DOWN, ETH UP, or ETH DOWN awaiting-resolution box. Check each exact original market for confirmed resolution every 5 seconds; do not settle from an unconfirmed price. The service is paper-only; a process restart clears its in-memory account and history.
