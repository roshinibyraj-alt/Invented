# Breakout @ 0.70 — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a single
breakout strategy with anti-martingale sizing.

## Strategy

### Breakout taker entry @ 0.70
1. **Enter**: watches both sides' mid-price every tick. Whichever side's
   mid-price reaches 0.70 first triggers a one-time taker market BUY of
   that side for $30 notional (crosses the spread, pays the taker fee).
   Fires at most once per window.
2. **Take profit**: resting maker TP sell at 0.99.
3. **Stop loss (time-tightened)**: starts at 0.29 and steps up the
   longer the position stays open:
   - 0:00–2:00 since entry → 0.29 (base)
   - 2:00–3:00 since entry → 0.40
   - 3:00–4:00 since entry → 0.45
   - 4:00+ since entry → 0.50 (final minute of the window)

   The moment the bid drops to/through whichever level is currently
   active, immediately taker-sell (market order, pays taker fee) to
   guarantee the exit.
4. **Forced close**: if the window closes with the position still open
   (no TP, no SL hit), force a taker close (market sell) right at window
   end.
5. **Anti-martingale**: base size $30. A win doubles the size for the
   next window (2x → $60, 4x → $120, 8x → $240 — up to 3 doublings),
   pressing size only with prior winnings. A loss (SL hit, or a forced
   close that lost money), or completing the 3rd press level, resets
   size back to base. This bounds the *percentage* lost on any single
   trade (the stop-loss distance) but not the dollar amount, which
   scales with whatever level the streak had pressed to.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `ENGINE2_TRIGGER_PRICE`, `ENGINE2_TP_PRICE`, `ENGINE2_SL_SCHEDULE`, `ENGINE2_BASE_USD`, `ENGINE2_MAX_MARTINGALE_LEVEL`
- `STARTING_CAPITAL`, fee/rebate constants

## Notes / assumptions

- The breakout trigger reads CLOB best bid/ask **mid-price**, checked every tick.
- Entry, the stop loss, and any forced window-end close are all taker orders and pay the taker fee for real; TP is still a resting maker order.
- A forced close at window end counts as a win for anti-martingale purposes if its realized P&L is ≥ $0, and a loss otherwise — there's no explicit TP/SL trigger to key off of in that case.
- This reuses `polymarket_client.py`, `models.py`, `paper_broker.py`, and the `main.py`/`state.py` orchestration loop unchanged in behavior.
