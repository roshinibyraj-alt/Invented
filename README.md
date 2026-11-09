# BTC/ETH cross-pair arbitrage paper bot

This service runs a demo-only strategy on aligned Polymarket BTC and ETH 5-minute Up/Down markets. It never submits live orders.

## Strategy

Two combinations are monitored independently:

1. BTC UP + ETH DOWN
2. ETH UP + BTC DOWN

The demo account starts with **$1,000**. Each combination has five one-shot entry tiers: buy **100 shares per leg** when fresh best asks sum to **$0.80, $0.70, $0.60, $0.50, or $0.40 or lower**. If price skips past multiple tiers, every newly qualified tier is attempted. A qualified tier stays latched and retries until it fills or the window ends.

The bot sweeps visible asks up to a **$0.99 per-share ceiling** and books a tier only if it can fill the complete requested size on both legs. If either leg lacks depth, neither leg is booked and that tier retries; no partial or assumed entry fills are recorded. Ask depth consumed by one tier is not reused by another tier. Market taker fees are applied to completed fills.

The bot does **not sell during a window**. At window end, filled positions move from four current-window inventory boxes into four corresponding boxes awaiting resolution. They settle only against the exact original BTC or ETH market after Polymarket confirms its result. The resolver checks every **5 seconds** without blocking market scanning; it will not infer an outcome before the official result is available.

## Dashboard and runtime

The dashboard shows both markets' UP/DOWN prices, tier progress, realized and unrealized P&L, four current-window inventory boxes, four pending-resolution boxes, recent positions, and a plain-language activity feed. Demo account state is held in process memory and resets when the Railway service restarts.

Run `npm test` to verify market alignment, both pairings, all five entry tiers, latching across skipped prices, complete visible-depth fills without reuse, no intra-window sells, exact-market resolution, and dashboard content.
