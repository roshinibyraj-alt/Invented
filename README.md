# BTC 5m + 15m Candle-Move Demo Bots

Polymarket-only, paper-trading BTC UP/DOWN bots. The 5-minute and 15-minute bots run independently: each has its own market/window, trigger state, paper positions, and $10,000 demo bankroll ($20,000 combined). No order placement or wallet execution code is used.

## Strategy (both timeframes)

- Compare each active window with the immediately previous completed window of the same duration.
- Previous candle direction is close versus open. Candle body size is `abs(previous close - previous open)`. Measure the current window's live move from the previous close.
- Previous candle red + current move upward: buy DOWN. Previous candle green + current move downward: buy UP. Doji: no signal.
- At 25% of the prior body, trigger 200 shares. At 50%, trigger a separate 100 shares. If the live move jumps past 50%, both rungs trigger.
- If the last three completed candles in that timeframe are the same colour, skip both entries for the next window. Resume when a completed candle closes the other colour. The two timeframes track this independently.
- In the first window after a 3+ candle same-colour streak is broken by one opposite-colour close, use recovery-only mode: the opposite candle direction signals UP (green) or DOWN (red), the normal rungs are suppressed, and the bot waits for a 300-share ask fill strictly below $0.50. It keeps waiting only within that recovery window; all positions still settle on the official market result.
- Each rung triggers once per window. Paper fills require full visible ask depth within $0.05-$0.60/share; otherwise the triggered rung retries while its window remains open. Entries are depth-priced and use the existing fee model.
- Positions settle only from Polymarket's official market outcome. Each timeframe's P&L and cash are tracked separately.

Signal candles use Kraken XBT/USD one-minute OHLC aggregated independently into five- and fifteen-minute windows. Kraken's reference may differ from Polymarket's official resolution source. Paper state is in memory and resets if the service restarts. Dashboard unrealized P&L marks open shares to the venue's best bid; missing/stale marks are labeled rather than treated as zero. Realized P&L changes only on official settlement.

## Run

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`. Railway's existing `node index.js` start command remains valid.
