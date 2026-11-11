# BTC/ETH next-candle signal paper bot

This service runs a demo-only strategy on aligned Polymarket BTC and ETH 5-minute Up/Down markets. It never submits live orders.

## Strategy

At the start of each 5-minute window, the bot loads the five most recent **completed Binance 5-minute candles** for BTC and ETH independently. The WickyWackyTrader Next Candle Predictor calculation uses candle body, wick size, and volume relative to the five-candle average. Defaults are a five-candle lookback, body weight 0.5, wick weight 0.1, volume weight 0.5, and sensitivity 0.05. The output is a directional score, not a probability. A neutral or unavailable signal does not trade.

Each asset follows its own signal and enters independently:

- As soon as its directional signal is ready and a fresh quote is available, the bot buys the signaled side. There is **no entry-price filter**.
- At most one **100-share** paper position is opened per asset per window.

An entry is booked only when the complete requested size is available in fresh, visible ask depth at valid prices. Partial or timeout fills are never recorded. Market taker fees are applied. The bot does **not sell during a window**; shares wait for confirmed resolution of their exact original BTC or ETH market.

## Dashboard and runtime

The dashboard shows each asset's predicted side, directional score, the five candles and indicator factors, Binance candle freshness, Polymarket UP/DOWN asks, signal entry status, account totals, positions, fills, and activity. Demo account state is held in process memory and resets when the Railway service restarts.

Run `npm test` to verify indicator scoring, closed-candle filtering, independent BTC/ETH signals, immediate no-price-filter entries, full-depth paper fills, fee accounting, no duplicate entries, exact-market settlement, and dashboard content.
