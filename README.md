# BTC 15-minute Wick Demo Bot

This replaces the previous cross-venue arbitrage strategy. It is a **Polymarket-only, paper-trading** bot for the BTC 15-minute UP/DOWN markets. It sends no orders; market data is read-only.

## Current rules

- Demo bankroll: $10,000; one position at most per 15-minute window; 300 shares.
- Lower-wick rejection maps to UP; upper-wick rejection maps to DOWN.
- A wick is unusual relative to recent 15-minute candles. The threshold is the 75th percentile of normalized wick sizes for similar observations: same 15-minute block of the UTC hour and RSI band when there are at least 12 samples; otherwise it falls back to that hour block, then the full sample.
- Confirmation requires a 50% retrace from the candle extreme and the latest one-minute close moving in the reversal direction. The wick extreme must not cross the previous 15-minute candle's close.
- Missed signals are latched and may be chased during that same window, but only if the full 300-share paper fill is available at asks no higher than $0.65/share. Insufficient depth or a higher ask means no entry.
- Open positions are held to the official Polymarket market result. P&L is realized only when the market result is confirmed.

## Inputs and caveats

Signal candles use Kraken XBT/USD one-minute OHLC, aggregated into 15-minute and one-hour context; RSI is computed from completed 15-minute closes. Kraken and Polymarket's official resolution reference can differ. Polymarket CLOB asks model the paper entry, and Polymarket market outcomes settle it. The dashboard labels this basis risk. The 15-minute hour block, RSI, hourly direction, comparable-candle count, wick/ATR, and signal score are visible for inspection.

The wick threshold is adaptive and explainable, not a guarantee of predictive accuracy. The current 75th-percentile and confirmation rules are initial model choices; judge them with out-of-sample paper results. Unresolved official market results remain pending and are not counted as wins or losses.

Demo state is kept in memory and resets on process restart. Do not treat paper fills or results as actual trading performance.

## Run

```sh
npm test
npm start
```

The dashboard shows live Polymarket UP and DOWN best bids/asks with visible size and quote age, plus the three latest completed Kraken 15-minute candles. Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway retains its existing `node index.js` start command.
