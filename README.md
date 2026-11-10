# BTC/ETH cross-pair arbitrage paper bot

This service runs a demo-only strategy on aligned Polymarket BTC and ETH 5-minute Up/Down markets. It never submits live orders.

## Strategy

Two combinations are monitored independently:

1. BTC UP + ETH DOWN
2. ETH UP + BTC DOWN

The demo account starts with **$3,000**. Five one-shot entry rungs match the Pumpfun strategy: combined best asks **below $0.90**, then **$0.80, $0.70, $0.60, or $0.50 or lower**. Each qualifying pair/rung buys **100 shares per leg**. The first pair to trigger a rung pauses the opposite pair on that rung for the rest of the window; other rungs remain independent. Rung locks reset at the next 5-minute window.

The bot scans the complete 5-minute window, sweeps visible asks up to a **$0.99 per-share ceiling**, and books a rung only if it can fill the complete requested size on both legs. If either leg lacks depth, neither leg is booked and that rung retries; no partial or assumed entry fills are recorded. Ask depth consumed by one rung is not reused by another rung. Market taker fees are applied to completed fills.

The bot does **not sell during a window**. At window end, filled positions move from four current-window inventory boxes into four corresponding boxes awaiting resolution. They settle only against the exact original BTC or ETH market after Polymarket confirms its result. The resolver checks every **5 seconds** without blocking market scanning; it will not infer an outcome before the official result is available.

## Dashboard and runtime

The dashboard mirrors Pumpfun's cross-pair view, showing both markets' UP/DOWN prices, combined asks and rung states, realized and unrealized P&L, four current-window inventory boxes, four pending-resolution boxes, paired positions, and a plain-language activity feed. Demo account state is held in process memory and resets when the Railway service restarts.

Run `npm test` to verify market alignment, both pairings, all five entry rungs, same-rung opposite-pair pausing, full visible-depth paired fills without reuse, no intra-window sells, exact-market resolution, and dashboard content.
