# Invented BTC 5-minute mispricing paper bot

This service runs a BTC 5-minute Binance mispricing strategy with a two-closed-candle volatility lookback. It is BTC-only, paper-only, and never submits live orders.

## Strategy

- There is no fixed delay after a BTC 5-minute window starts. It can enter as soon as the Binance window open, a fresh model, and the Polymarket book are ready.
- Binance BTCUSDT ticks and the current candle open feed a probability model. Volatility uses the two latest closed 5-minute candles.
- UP and DOWN entries are evaluated independently from the Binance model. Either or both sides may be open in the same 5-minute window.
- Every fresh qualifying signal adds **100 shares**, even if that side already has a position. One add is allowed per qualifying signal cycle; the edge must fall below its threshold before a later signal can add again. The first entry and later same-side signals require at least **$0.05 net model edge per share**; the first opposite-side entry may bypass that edge filter.
- Entries require a complete 100-share visible ask sweep, but there is **no fixed entry-price ceiling**. The model-edge rule still applies where noted, and partial fills are not recorded.
- After each add, replace the side’s resting limit sell for **all accumulated shares** at **$0.90**. In the paper simulation, a fresh best bid at or above $0.90 fills the whole position without checking bid depth or charging a sell fee. The configured maker rebate is an estimate, not a guaranteed credit.
- Because the sell target is fixed, an entry above $0.90 can close below its cost and lose money. No take-profit before window end means the order is cancelled and the position waits for official resolution.
- If a take-profit has not filled by window end, it is cancelled and the position remains tied to its original market through official resolution. New 5-minute windows start independently; unresolved older positions do not block them.

## Dashboard and runtime

The dashboard shows model probabilities, two-candle volatility, Binance stream status, Polymarket UP/DOWN quotes, each side’s open position and take-profit, entry counts, paper account totals, trades, and activity. Paper history is held in process memory and resets when Railway restarts.

Run `npm test` to verify probability and volatility calculations, uncapped entry prices with full ask depth, signal-cycle accumulation, opposite-side edge bypass, aggregate $0.90 limit sells without depth sweeps or sell fees, maker-rebate estimates, resolution behavior, WebSocket subscriptions, and dashboard content.
