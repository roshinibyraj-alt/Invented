# Kronos BTC 5m paper bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Each five-minute
window uses the Kronos time-series model to select UP or DOWN, then enters on
the first live ask for that selected side.

## Strategy

1. **Forecast**: maintain a rolling buffer of real 1-minute BTC/USDT candles
   from Binance. At each new window, Kronos forecasts the next five candles.
2. **Signal**: take the forecast direction only when its confidence is at
   least `KRONOS_MIN_CONFIDENCE`; otherwise skip the window.
3. **Entry**: once a side is selected, buy on the first tick with a live ask.
   There is no entry-price ceiling.
4. **Take profit**: resting maker sell at 0.99, booked as $1.00/share.
5. **Settlement**: positions still open at the window boundary settle at the
   observed winning side's $1.00/$0.00 outcome.
6. **Sizing ladder**: start at 500 shares, step down 100 shares after wins and
   step up 100 shares after losses, with the configured floor and cap.

Inference is cached for 15 seconds by default (`KRONOS_REFRESH_SECONDS`) so a
transformer forward pass is not repeated on every one-second poll.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `KRONOS_MODEL_ID`, `KRONOS_TOKENIZER_ID`, `KRONOS_DEVICE`
- `KRONOS_CONTEXT_BARS`, `KRONOS_PRED_LEN`, `KRONOS_REFRESH_SECONDS`
- `KRONOS_MOVE_SCALE`, `KRONOS_MIN_CONFIDENCE`
- `STARTING_CAPITAL`, fee/rebate constants

## Notes / assumptions

- Kronos's `model/` package is vendored in this repository under the MIT
  license. The first inference downloads model weights from Hugging Face.
- If candle data, the model, or inference is unavailable, the window is
  skipped rather than trading without a signal.
- This is paper trading; no live order placement is implemented.
