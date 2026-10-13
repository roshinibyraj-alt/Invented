# BTC 5-minute CLOB Paper Bot

Polymarket-only BTC UP/DOWN paper trading. The bot has one 5-minute market loop and a $10,000 demo bankroll. It sends no live orders and holds no wallet credentials.

## Strategy

- Compare the current BTC window with the previous completed 5-minute candle. Use the previous candle's body (`abs(close - open)`) and measure thresholds from its close.
- Green previous candle: adverse drops trigger UP. Red previous candle: adverse rises trigger DOWN. A doji has no signal.
- Rungs: 25% / 100 shares, 50% / 200, 75% / 300, and 90% / 400. Crossed rungs queue independently; paper fills are separated by at least 2 seconds.
- No new entry signal or fill after 240 seconds into a window. Paper buys require visible ask depth within the configured $0.05–$0.60 band.
- Deduct the Polymarket BTC taker fee from each paper buy using the market fee schedule and simulated fill price.
- At window end, use the final 3-second CLOB UP/DOWN midpoints. A side at $0.98+ wins; if neither reaches that threshold, the side with the higher midpoint wins (an exact tie is assigned to UP). Winning shares receive $1 each; losing shares receive $0.

The bot polls CLOB quotes every 500 ms and Kraken 1-minute candles every second; the dashboard refreshes every 500 ms. Winner resolution uses Polymarket CLOB quotes, not Kraken or Gamma official settlement. If fresh CLOB quotes are unavailable, the position remains pending and is retried. An exact midpoint tie is resolved to UP. Paper state is in memory and resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
