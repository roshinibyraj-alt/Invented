# Invented BTC 5-minute fixed-price ladder

This is a paper-only Polymarket BTC 5-minute bot. It places independent resting buy orders on both UP and DOWN at eight fixed prices. It does not use a Binance prediction signal and does not submit live orders.

## Strategy

At the start of each 5-minute window, the bot posts 100-share post-only limit buys for both sides at each price below. Every cancellation deadline is measured from the window start. An unfilled remainder is cancelled at that deadline.

| Limit price | Cancel after |
|---:|---:|
| $0.40 | 10 seconds |
| $0.35 | 50 seconds |
| $0.30 | 160 seconds |
| $0.25 | 200 seconds |
| $0.20 | 220 seconds |
| $0.15 | 230 seconds |
| $0.10 | 250 seconds |
| $0.05 | 270 seconds |

The bot waits for a fresh Polymarket book before posting. If a limit would immediately match rather than rest, it is rejected as marketable instead of being counted as a resting order. Each side and price rung is independent.

Paper fills require fresh opposing-side Polymarket trade prints at or through the resting limit. At the exact limit, the simulated queue estimate is consumed first; partial fills are allowed and any remaining quantity is cancelled at the rung's deadline. A book touch by itself never creates a fill.

Filled shares remain open for the official result of their original market. This strategy places no take-profit sells, stop-losses, or automatic merges. The paper ledger is held in memory and resets when Railway restarts the service.

## Dashboard and checks

The dashboard summarizes the active window, Polymarket connection and books, current UP/DOWN shares and average cost, account results, and each rung's status. State is available at `/api/state`; health is available at `/api/healthz`.

Run `node --test test/*.test.js` to verify rung placement, fixed-window cancellation deadlines, queue-aware paper fills, and dashboard rendering.
