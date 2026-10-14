# BTC 5-minute CLOB Paper Bot

Polymarket-only BTC UP/DOWN paper trading. The bot has one 5-minute market loop and a $10,000 demo bankroll. It sends no live orders and holds no wallet credentials.

## Strategy

- Compare the current BTC window with the previous completed 5-minute candle. Use the previous candle's body (`abs(close - open)`) and measure thresholds from its close.
- Green previous candle: adverse drops trigger UP. Red previous candle: adverse rises trigger DOWN. A doji has no signal.
- Rungs: 25% / 100 shares, 50% / 200, 75% / 300, and 90% / 400. Crossed rungs queue in order; paper fills are separated by at least 2 seconds. Three or more rung take-profits in one window skip entries for the next two windows, after which normal signalling resumes.
- No new entry signal or fill after 240 seconds into a window. Paper buys require visible ask depth within the configured $0.05–$0.60 band.
- Deduct the Polymarket BTC taker fee from each paper buy using the market fee schedule and simulated fill price.
- During the window, any fresh bid, ask, or midpoint for the position's own side at $0.99 or higher triggers a simulated take-profit and credits exactly $1 per share. If no quote reaches the target before window close, use the official Gamma market result to credit $1 or $0 per share, retrying until resolved.

The bot polls CLOB quotes every 500 ms and Kraken 1-minute candles every second; the dashboard refreshes every 2 seconds. TP detection uses fresh own-side CLOB quotes. If no quote reaches TP, use the official Gamma result and retry while it is pending. Dashboard win rate is calculated over settled individual rung trades; total trades includes open and settled positions. Stale marks are excluded from floating P&L/equity. Paper state is in memory and resets on process restart.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
