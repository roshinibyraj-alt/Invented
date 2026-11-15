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

For this paper simulation, a fresh best ask at or below a resting buy limit, or an opposing sell trade print at or below it, counts the full 100-share rung as filled. It deliberately ignores queue depth and print size, so it is an optimistic simulation rather than a prediction of actual exchange fills. Uncrossed orders are cancelled at their rung deadlines.

Open positions are marked to the current best bid. Floating P&L updates with live CLOB quotes and is included in paper equity. If the best bid reaches $0.99, the paper position exits at $1 per share; if it reaches $0.01, it exits at $0 per share. Otherwise, the position remains open for official resolution. Positions awaiting resolution retain their latest available CLOB mark. The paper ledger is held in memory and resets when Railway restarts the service.

## Dashboard and checks

The dashboard summarizes the active window, Polymarket connection and books, current UP/DOWN shares and average cost, account results, and each rung's status. State is available at `/api/state`; health is available at `/api/healthz`.

Run `node --test test/*.test.js` to verify rung placement, fixed-window cancellation deadlines, full-rung crossing fills, TP/SL exits, live P&L marking, and dashboard rendering.
