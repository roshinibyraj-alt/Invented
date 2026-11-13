# Invented BTC 5-minute mispricing paper bot

This service runs the Pumpfun BTC 5-minute Binance mispricing strategy with a two-closed-candle volatility lookback. It is BTC-only, paper-only, and never submits live orders.

## Strategy

- There is no fixed delay after a BTC 5-minute window starts. It can enter as soon as the Binance window open, a fresh model, and the Polymarket book are ready.
- Binance BTCUSDT ticks and the current candle open feed a probability model. Volatility uses the two latest closed 5-minute candles.
- The bot compares UP and DOWN probabilities with fresh Polymarket asks, including entry fees. It buys **100 shares** on the higher qualifying side only when the estimated net edge is at least $0.05 per share.
- Entry fills require all 100 shares in fresh, visible ask depth. Partial fills are not recorded.
- It can make one opposite-side flip per window, but only when selling all current shares into visible bids is profitable after fees and the opposite entry has at least **$0.10 net edge per share after fees**.
- The opposite signal must persist across **two fresh Binance updates 500–2,000 ms apart**. A flip sells all shares and buys a full 100-share opposite position; partial fills are not recorded.
- There is no take-profit, stop-loss, or fixed entry delay. Without an eligible profitable flip, the position stays tied to its original market through official resolution. New 5-minute windows start independently; unresolved older positions do not block them.

## Dashboard and runtime

The dashboard shows model probabilities, two-candle volatility, Binance stream status, Polymarket UP/DOWN quotes, flip confirmation, position, paper account totals, trades, and activity. Paper history is held in process memory and resets when Railway restarts.

Run `npm test` to verify probability and volatility calculations, full-depth entries, profitable flip eligibility and confirmation, fee accounting, one-flip-per-window limits, resolution behavior, WebSocket subscriptions, and dashboard content.
