# BTC/ETH cross-pair arbitrage paper bot

This service runs a demo-only strategy on aligned Polymarket BTC and ETH 5-minute Up/Down markets. It never submits live orders.

## Strategy

Two combinations are monitored independently:

1. BTC UP + ETH DOWN
2. ETH UP + BTC DOWN

When a combination's fresh best asks sum to **less than $0.90**, the bot simulates a market buy for **200 shares on each leg**. Each leg is priced only from visible ask depth; partial fills and unfilled remainders are recorded honestly, and market taker fees are applied.

Once a pair has filled shares, when its fresh best bids sum to **$1.10 or more**, the bot simulates market sells from visible bid depth. Partial sells are tracked without reusing unchanged displayed depth. The pair cannot rearm until every filled leg is fully sold; after that it can enter another cycle during the same window.

Unsold shares at window end move to resolution and are settled only against the confirmed outcome of each leg's exact original BTC or ETH market. No old signal, stop-loss, or take-profit rule is used.

## Dashboard and runtime

The dashboard shows both markets' UP/DOWN asks and bids, each pairing's combined prices and state, per-leg inventory, account performance, and recent positions. Demo account history is held in process memory and resets when the Railway service restarts.

Run `npm test` to verify market alignment, both pairings, strict entry and exit thresholds, visible-depth fills, partial-exit handling, exact-market resolution, and dashboard content.
