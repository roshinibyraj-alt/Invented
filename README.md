# Invented FreqAI BTC 5-minute paper bot

This service uses Freqtrade's FreqAI LightGBM classifier to estimate whether the current BTC 5-minute candle will close UP or DOWN. The model runs on Binance spot 1-minute OHLCV features: recent returns, candle shape, relative volume, realized volatility, and minute-in-window. It does not use Polymarket order-book pressure as a prediction feature.

Freqtrade runs with `dry_run: true` and an entry/exit strategy that never submits exchange orders. It exists only to retrieve Binance candles, train/retrain the classifier, and write model probabilities to a small JSON file. The Node service reads those probabilities and remains the only component that simulates Polymarket paper trades.

## Paper execution

- BTC 5-minute markets only.
- Wait for the first 1-minute candle to close; enter no earlier than 80 seconds into a window.
- Pick whichever model probability is higher. There is no minimum-confidence or edge filter.
- If the model has no current-window prediction by 80 seconds, use the fresh live Binance window direction and mark the trade as a warm-up fallback.
- Attempt one 10-share taker-style paper sweep per window, consuming visible asks through the $1.00 maximum outcome price. Partial fills and modeled taker fees are recorded; no executable liquidity means retry on the next fresh book update.
- Hold filled shares to the exact Polymarket market's official resolution. No take-profit or stop-loss is used.
- No live orders or wallet signing are enabled.

“At least one trade per window” means the strategy does not reject a side for low predicted edge. A fill still cannot be guaranteed if Binance/Polymarket data is stale, the market is unavailable, or there are no executable asks at or below the sweep cap.

## Dashboard

The phone-first dashboard shows paper equity, current BTC market quotes, FreqAI's UP/DOWN probabilities and readiness, the selected source (model or warm-up), open-position floating P&L, pending resolutions, colored closed trades, and recent activity. Strategy details are at the bottom.

## Persistence and run

`PAPER_LEDGER_PATH` should point into the Railway persistent volume. When the strategy ID changes, the prior paper ledger is archived and a fresh ledger starts at the configured paper capital. FreqAI's user data and latest prediction are stored separately under the mounted volume so model files do not mix with the paper ledger.

```sh
npm test
npm start
```
