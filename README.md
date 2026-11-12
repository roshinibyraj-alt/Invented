# Invented BTC 5-minute mispricing paper bot

This service runs a BTC-only, demo-only strategy on Polymarket 5-minute Up/Down markets. It never submits live orders.

## Strategy

- It waits **10 seconds** after each BTC 5-minute window starts.
- Binance BTCUSDT ticks and the current candle open feed a probability model. Volatility uses the three latest closed 5-minute candles.
- The bot compares UP and DOWN probabilities with fresh Polymarket asks, including entry fees. It buys **100 shares** on the higher qualifying side only when the estimated net edge is at least $0.05 per share.
- Entry fills require all 100 shares in fresh, visible ask depth. Partial fills are not recorded.
- After entry, it rests a paper limit sell priced for at least **50% net return after entry and exit fees**. A take-profit fill also requires all shares to be available in visible bid depth; partial exits are not recorded.
- It does not flip on an opposite signal. If take-profit does not fill, that position stays tied to its original market through official resolution. Each new 5-minute window starts independently after its own 10-second wait; unresolved older positions do not block it.
- After a take-profit fill or official settlement, it can rearm for another qualifying signal.

## Dashboard and runtime

The dashboard mirrors the colorful BTC mispricing dashboard and shows the model probabilities, Binance candle/stream status, Polymarket UP/DOWN quotes, position and take-profit order, paper account totals, trades, and activity. Paper history is held in process memory and resets when Railway restarts.

Run `npm test` to verify probability and volatility calculations, the 10-second delay, full-depth entries and take-profits, fee-aware 50% return targets, no partial fills or signal flips, WebSocket subscriptions, re-entry, and dashboard content.
