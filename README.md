# BTC/ETH cross-pair arbitrage paper bot

This service runs a demo-only strategy on aligned Polymarket BTC and ETH 5-minute Up/Down markets. It never submits live orders.

## Strategy

Two combinations are monitored independently:

1. BTC UP + ETH DOWN
2. ETH UP + BTC DOWN

Each combination has five entry tiers. When fresh best asks sum to **less than $0.90**, the base tier buys **200 shares per leg**. Additional tiers buy **300 shares per leg** when combined asks reach **$0.80, $0.70, $0.60, and $0.50 or lower**. Each tier can fill once per pair per window; if price skips past multiple tiers, every newly qualified tier is attempted. A qualified tier stays latched and retries until it fills or the window ends.

The bot sweeps visible asks up to a **$0.99 per-share ceiling** and books a tier only if it can fill the complete requested size on both legs. If either leg lacks depth, neither leg is booked and that tier retries; no partial or assumed entry fills are recorded. Ask depth consumed by one tier is not reused by another tier. Market taker fees are applied to completed fills.

The bot does **not sell during a window**. All filled positions remain open until the exact original BTC or ETH market resolves, then settle against that market's confirmed result.

## Dashboard and runtime

The dashboard shows both markets' UP/DOWN prices, each pairing's combined asks, tier progress and inventory, account performance, recent positions, and a plain-language activity feed for tier triggers, full fills, waits, and resolutions. Demo account history is held in process memory and resets when the Railway service restarts.

Run `npm test` to verify market alignment, both pairings, all five entry tiers, latching across skipped prices, complete visible-depth fills without reuse, no intra-window sells, exact-market resolution, and dashboard content.
