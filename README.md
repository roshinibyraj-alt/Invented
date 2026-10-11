# BTC 15-minute Candle-Move Demo Bot

This replaces the previous cross-venue arbitrage strategy. It is a **Polymarket-only, paper-trading** bot for the BTC 15-minute UP/DOWN markets. It sends no orders; market data is read-only.

## Current rules

- Demo bankroll: $10,000; at most two 100-share entries per 15-minute window.
- Compare the previous completed 15-minute candle with the forming current candle. Previous candle size is its full high-low range; measure current move from the previous candle close.
- If the previous candle is red and current price rises from that close by 25% of the previous range, trigger a 100-share DOWN entry. At 50%, trigger a second 100-share DOWN entry. If price jumps directly past 50%, both rungs trigger.
- Mirror rule: if the previous candle is green and current price falls from that close by 25% or 50% of its range, trigger 100-share UP entries at each rung.
- Each rung triggers at most once per window. A triggered rung remains eligible for a paper fill during the window while the full 100-share depth is available at asks from $0.05 through $0.60/share. No fill occurs outside that band or with insufficient depth.
- Open positions are held to the official Polymarket market result. P&L is realized only when the market result is confirmed.

## Inputs and caveats

Signal prices use Kraken XBT/USD one-minute OHLC aggregated into 15-minute candles. Kraken and Polymarket's official resolution reference can differ. Polymarket CLOB asks model the paper entry, and Polymarket market outcomes settle it.

This candle-move rule is a simple paper strategy, not a guarantee of predictive accuracy. Unresolved official market results remain pending and are not counted as wins or losses.

Demo state is kept in memory and resets on process restart. Do not treat paper fills or results as actual trading performance.

## Run

```sh
npm test
npm start
```

The dashboard shows live Polymarket UP and DOWN best bids/asks with visible size and quote age, plus the three latest completed Kraken 15-minute candles. Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway retains its existing `node index.js` start command.
