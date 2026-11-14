# Invented BTC 5-minute CLOB midpoint maker paper bot

This service simulates independent Polymarket BTC 5-minute UP and DOWN maker strategies using only the public CLOB books and trade stream. It does not submit live orders or use Binance signals.

## Strategy

- Once per second, each side independently posts a 5-share passive buy limit at its fresh best-bid/best-ask midpoint minus $0.05.
- Cancel any unfilled entry remainder after five seconds. There is no fixed inventory cap; available paper cash is the limit.
- An entry fills in the paper simulation when a fresh best ask reaches or falls below its limit, without checking displayed size, trade prints, or queue position. This touch-based rule can overstate real fills.
- After a fill, post or resize a passive sell for the held shares at $0.99. The paper ledger records actual sell proceeds at $0.99; $1.00 is paid only by official resolution of a winning share.
- Cancel all resting orders at the end of the 5-minute window. Unsold positions wait for confirmed resolution of their original market.
- Maker rebates are estimates in paper mode, not guaranteed exchange credits. Passive orders model zero trading fees.

Paper fills are estimates, not guaranteed exchange executions. Public data does not reveal actual queue priority, and profits are not guaranteed.

## Dashboard and runtime

The dashboard shows both CLOB books, each side's midpoint and next limit, active and expiring orders, filled inventory, take-profit sells, account totals, estimated rebates, and the order/activity ledgers. The UP and DOWN summary cards at the top show only the current window; held shares from ended windows move into separate cards grouped by their original window. The paper ledger is held in process memory and resets when Railway restarts.

Run `npm test` for midpoint pricing, independent one-second order cadence, five-second expiry, ask-touch entry fills, take-profit accounting, WebSocket, and dashboard checks.
