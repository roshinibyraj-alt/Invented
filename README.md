# Invented BTC 5-minute fixed-price ladder

This is a paper-only Polymarket BTC 5-minute bot. It places independent resting buy orders on both UP and DOWN at eight fixed prices. It does not use a Binance prediction signal and does not submit live orders.

## Strategy

At the start of each 5-minute window, the bot posts 100-share post-only limit buys for both sides at each price below. Every cancellation deadline is measured from the window start. An unfilled remainder is cancelled at that deadline.

| Buy rung | Initial take-profit | Cancel/re-arm deadline |
|---:|---:|---:|
| $0.40 | $0.61 | 10 seconds |
| $0.35 | $0.66 | 50 seconds |
| $0.30 | $0.71 | 160 seconds |
| $0.25 | $0.76 | 200 seconds |
| $0.20 | $0.81 | 220 seconds |
| $0.15 | $0.86 | 230 seconds |
| $0.10 | $0.91 | 250 seconds |
| $0.05 | $0.96 | 270 seconds |

The bot waits for a fresh Polymarket book before posting. If a limit would immediately match rather than rest, it is rejected as marketable instead of being counted as a resting order. Each side and price rung is independent.

For this paper simulation, a fresh best ask at or below a resting buy limit, or an opposing sell trade print at or below it, counts the full 100-share rung as filled. It deliberately ignores queue depth and print size, so it is an optimistic simulation rather than a prediction of actual exchange fills. Each rung's take-profit is a resting limit sell at `$1.01 - buy price`, matching the opposite-side equivalent in the user's examples. A fresh best bid or a BUY trade print at or above that target counts the full sell as filled.

If a rung is still open when its own window-start deadline expires before its initial take-profit fills, the bot replaces that TP limit with `$0.99`; a paper fill at that level books `$1.00` per share. This timeout fallback does not re-arm the rung. When an initial rung take-profit fills before the deadline, that same rung can place another 100-share buy only until its original deadline; re-arming does not restart or extend the timer. The best-bid `$0.01` stop-loss books `$0` per share; otherwise, shares remain open for official resolution. Open positions are marked to the current best bid, floating P&L is included in paper equity, and positions awaiting resolution retain their latest available CLOB mark. The paper ledger is held in memory and resets when Railway restarts the service.

## Dashboard and checks

The dashboard summarizes the active window, Polymarket connection and books, current UP/DOWN shares and average cost, account results, each rung's buy and current take-profit prices, re-arm cycle, and original deadline. State is available at `/api/state`; health is available at `/api/healthz`.

Run `node --test test/*.test.js` to verify rung placement, fixed-window cancellation deadlines, full-rung crossing fills, rung-specific take-profits, deadline fallback payouts and re-arming, stop-loss exits, live P&L marking, and dashboard rendering.
