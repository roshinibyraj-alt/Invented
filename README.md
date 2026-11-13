# Invented BTC 5-minute mispricing paper bot

This service runs a BTC 5-minute Binance mispricing strategy with a two-closed-candle volatility lookback. It is BTC-only, paper-only, and never submits live orders.

## Strategy

- There is no fixed delay after a BTC 5-minute window starts. It can enter as soon as the Binance window open, a fresh model, and the Polymarket book are ready.
- Binance BTCUSDT ticks and the current candle open feed a probability model. Volatility uses the two latest closed 5-minute candles.
- UP and DOWN entries are evaluated independently from the Binance model. Either or both sides may be open in the same 5-minute window.
- Every entry needs a complete 100-share visible ask sweep at or below **$0.66**. The first entry in a window and same-side re-entries also require at least **$0.05 net model edge per share**. The first entry on the opposite side may bypass that edge filter. Partial fills are not recorded.
- Each position immediately gets its own resting limit take-profit at **1.5× its average entry price** (50% price gain before exit fees). The paper order fills only when the visible bids at or above the target can cover all shares.
- After a take-profit fills, that side re-arms for another qualified signal; the other side is unaffected. Only one position per side may be open at a time, but a side may re-enter multiple times in one window after take-profit fills.
- If a take-profit has not filled by window end, it is cancelled and the position remains tied to its original market through official resolution. New 5-minute windows start independently; unresolved older positions do not block them.

## Dashboard and runtime

The dashboard shows model probabilities, two-candle volatility, Binance stream status, Polymarket UP/DOWN quotes, each side’s open position and take-profit, entry counts, paper account totals, trades, and activity. Paper history is held in process memory and resets when Railway restarts.

Run `npm test` to verify probability and volatility calculations, the inclusive $0.66 entry ceiling, the opposite-side edge bypass, independent UP/DOWN entries, full-depth take-profit fills, per-side re-entry, fee accounting, resolution behavior, WebSocket subscriptions, and dashboard content.
