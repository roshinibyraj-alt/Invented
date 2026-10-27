# BTC 5m Contrarian Candle Paper Bot

Polymarket BTC 5-minute UP/DOWN paper trading only. The bot uses a single $10,000 demo bankroll and never submits live orders or uses wallet credentials.

## Strategy

- Use the previous complete 5-minute Chainlink BTC/USD candle to determine the signal: green means UP, red means DOWN, and dojis follow the source candle rule.
- For each valid signal, immediately submit one 500-share paper market buy on the opposite outcome side at the fresh best ask. No limit rungs or conditional flip cycles are used.
- If the signal or fresh ask is not available at window open, wait until it is available; cancel any unfilled market entry at window rollover.
- A fresh own-side best bid at $0.99 or higher pays $1/share; at $0.01 or lower pays $0/share and completes the window. Otherwise positions close at their own bid (or $0 if no bid) when the window rolls over. No official market results are used.

The BTC regime display is informational and does not block entries. Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Paper history resets on process restart.

## Run and verify

```sh
npm test
npm start
```
