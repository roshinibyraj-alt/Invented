# BTC-confirmed ETH 5-minute paper bot

This repository runs a single paper-only strategy for Polymarket ETH Up/Down 5-minute markets. BTC Up/Down prices provide the signal; the bot buys the corresponding ETH side. It never submits live orders.

## Entry strategy

- Watch the BTC and ETH markets with the same 5-minute window start.
- After waiting 60 seconds, during seconds 60–299, buy once if one matching side qualifies: BTC best ask is at least $0.80 and the matching ETH best ask is below $0.50.
- Buy 100 ETH shares on that same UP or DOWN side using a simulated taker market order.
- Simulated fills sweep only fresh, visible ETH ask depth. Entry prices are depth-weighted, taker fees use that ETH market's published fee schedule, and any unfilled market-order remainder is cancelled rather than invented or retried.
- No entry is allowed during the first minute or after the 5-minute window ends; there is no final-minute cutoff.

## Exits and settlement

- A resting paper take-profit is modeled at $0.99 and credited as $1.00 per share when fresh visible bids at $0.99 or better support the fill. Partial fills reduce the open share count and cost basis; unchanged visible depth is not reused on later polls.
- No stop loss is used.
- Any remaining shares move to pending settlement after the ETH window closes and settle only against the confirmed result of that exact original ETH market.

## Dashboard and runtime

The dashboard presents the current ETH window, BTC/ETH UP and DOWN asks, entry cutoff, signal status, account summary, equity history, and recent positions. Account history is process-memory state and resets when the Railway service restarts.

Run `npm test` to verify the market mapping, signal thresholds and side mapping, time cutoff, visible-depth taker fills, TP accounting, exact-market resolution, and dashboard contract.
