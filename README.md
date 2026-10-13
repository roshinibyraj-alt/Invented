# BTC 5m + 15m Candle-Move Demo Bots

Polymarket-only, paper-trading BTC UP/DOWN bots. The 5-minute and 15-minute bots run independently: each has its own market/window, trigger state, paper positions, and $10,000 demo bankroll ($20,000 combined). No order placement or wallet execution code is used.

## Strategy (both timeframes)

- Each bot compares its active window with the immediately preceding completed candle of the same duration. Candle body is `abs(previous close - previous open)`; each move threshold is measured from the previous close using that body size.
- The four independent rungs are 25% → 100 shares, 50% → 200 shares, 75% → 300 shares, and 90% → 400 shares. Rungs can trigger any time during the window and fire once per rung per window.
- The entries buy the reversal side: if the previous candle is green, downward moves trigger UP buys; if it is red, upward moves trigger DOWN buys. A doji produces no entries.
- If a price jump crosses multiple thresholds, every crossed rung can fire. Each paper buy requires full visible ask depth within $0.05-$0.60/share; unfilled rungs remain eligible until the window ends.
- No sell orders, take-profit, or stop-loss are placed. Filled shares remain open through the window and settle on Polymarket's official result.
- The 5m and 15m strategies run independently with separate $10,000 demo bankrolls.

Signals use Kraken XBT/USD one-minute OHLC, including the current minute's high/low, refreshed every three seconds. Kraken's reference may differ from Polymarket's official resolution source. Paper state is in memory and resets if the service restarts. Dashboard unrealized P&L marks open shares to best bid; missing/stale marks are labeled. Realized P&L updates only on official settlement.

## Run

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
