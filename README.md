# Dual-entry trailing stop — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: buy both sides immediately at window open, then trail
a stop independently on whichever side moves into its favor.

## Strategy

1. **Entry**: the instant a window is live, fire an immediate **taker**
   buy of 300 shares on **both** the UP token and the DOWN token. No
   cold start, no waiting on any price level — both sides go on right
   away, each becoming its own independent position.
2. **No stop loss to start**: each side sits completely unprotected
   until its own price first reaches 0.60.
3. **Trailing stop**: once a side's price reaches 0.60, its stop loss
   arms at 0.50 (0.60 − 0.10). From there it trails the price up in
   0.10 steps, only ever moving up, never back down:
   - price reaches 0.60 → stop loss 0.50
   - price reaches 0.70 → stop loss 0.60
   - price reaches 0.80 → stop loss 0.70
   - ...and so on

   If a side never reaches 0.60 in a window, it never gets a stop loss
   at all — it rides fully exposed until TP or the forced window-end
   close.
4. **Take profit**: fixed at 0.99 for both sides from the moment
   they're bought, independent of whether the trailing stop has armed.
5. **Independence**: the two positions are tracked completely
   separately. If UP's trailing stop closes it out, DOWN is entirely
   unaffected — it keeps sitting unprotected below 0.60, or keeps
   trailing on its own once it gets there. Nothing about one side
   being closed changes how the other is handled.
6. **Window close**: force a taker close on any side(s) still open.

Sizing is flat — 300 shares per side, every window, no progression,
doubling, or rearm logic of any kind.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `SHARES_PER_SIDE`, `TRAIL_ARM_PRICE`, `TRAIL_STEP`, `TP_PRICE`
- `STARTING_CAPITAL`, taker fee constants

## Notes / assumptions

- Every fill in this engine — both entries, both kinds of exit
  (trailing stop / TP), and any forced window-end close — is a taker
  order, priced off the **real** current ask (entries) or bid (exits)
  read at the moment it fires, not an assumed value.
- The trailing-stop level check and the SL/TP check both read the
  live **bid** for that side, so the stop only ratchets based on what
  a market sell could actually realize, not a possibly-stale mid.
- If price shoots straight through multiple 0.10 levels in one tick
  (e.g. 0.55 → 0.85), the trailing stop jumps straight to the
  appropriate level for the highest one crossed that tick, not
  step-by-step.
- A window where a side never gets a live ask at all (e.g. the book is
  empty right at open) simply retries entry on the next tick; the
  engine doesn't force a fill without a real quote to fill against.
- This reuses `polymarket_client.py`, `models.py`, `paper_broker.py`,
  and the `main.py`/`state.py` orchestration loop unchanged in
  behavior.
