# BTC 5m + 15m Candle-Move Demo Bots

Polymarket-only, paper-trading BTC UP/DOWN bots. The 5-minute and 15-minute bots run independently: each has its own market/window, trigger state, paper positions, and $10,000 demo bankroll ($20,000 combined). No order placement or wallet execution code is used.

## Strategy (both timeframes)

- Each bot compares its active window with the immediately preceding completed candle of the same duration. Candle body is `abs(previous close - previous open)`; price movement is measured from the previous close.
- If the previous candle is green, a 25% fall from its close during minute 1 triggers a 100-share UP entry. If the previous candle is red, a 25% rise during minute 1 triggers a 100-share DOWN entry.
- During minute 2, a return to the previous close triggers 200 additional shares on the same side. The two entries are independent; the second can fire even if the first did not.
- Entry triggers are restricted to their designated minute. Orders need full visible ask depth within $0.05-$0.60/share before that minute ends; otherwise they expire unfilled.
- From 180 seconds into the window onward, if BTC is still at least 25% of the previous candle body against the signal direction, the bot sells all remaining shares against visible CLOB bids. If bid depth is insufficient, available shares are sold and the remainder is retried. Exit fills use the configured fee model.
- Shares remaining at expiry settle on Polymarket's official result. The 5m and 15m strategies run independently with separate $10,000 demo bankrolls.

Signals use Kraken XBT/USD one-minute OHLC, including the current minute's high/low, refreshed every three seconds. Kraken's reference may differ from Polymarket's official resolution source. Paper state is in memory and resets if the service restarts. Dashboard unrealized P&L marks open shares to best bid; missing/stale marks are labeled. Realized P&L updates on bid-side exits or official settlement.

## Run

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
