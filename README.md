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
   until BOTH of these hold: its own price has reached 0.60, AND at
   least 2 minutes have passed since the window opened. Reaching 0.60
   in the first two minutes does not arm anything by itself — the
   trail only starts checking/advancing once the 2-minute filter has
   cleared, based on wherever price actually is at that point (not
   whatever peak it hit earlier).
3. **Trailing stop**: once armed, the stop loss sits at 0.50
   (0.60 − 0.10). From there it trails the price up in 0.10 steps,
   only ever moving up, never back down:
   - price reaches 0.60 → stop loss 0.50
   - price reaches 0.70 → stop loss 0.60
   - price reaches 0.80 → stop loss 0.70
   - ...and so on

   If a side never reaches 0.60 (or does, but only before the 2-minute
   filter clears and never again after), it never gets a stop loss at
   all — it rides fully exposed until TP or the forced window-end
   close.
4. **Take profit**: fixed at 0.99 for both sides from the moment
   they're bought, independent of whether the trailing stop has armed.
5. **Realistic exits**: every fill — entries, trailing SL, TP, and the
   forced window-end close — is priced by walking the real order book
   depth needed to cover the full 300-share size, not just the single
   best bid/ask. If a side has gone illiquid (thin or stale-looking top
   of book), the average fill price is pulled down (for a sell)
   instead of pretending the whole order clears at the top quote —
   that pretending is exactly what used to understate losses on a side
   that was clearly losing late in a window: a stop could trigger off
   a bid of, say, 0.48, but if only a handful of shares were actually
   resting there, 300 shares would realistically sell for much less.
   If the book is confirmed to have zero depth at all, no fill is
   invented — the bot waits for the next tick, or, if the window is
   closing right then, marks the position down to $0 rather than
   assuming no loss at all.
6. **Independence**: the two positions are tracked completely
   separately. If UP's trailing stop closes it out, DOWN is entirely
   unaffected — it keeps sitting unprotected below 0.60, or keeps
   trailing on its own once it gets there. Nothing about one side
   being closed changes how the other is handled.
7. **Window close**: force a taker close on any side(s) still open.

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

- `SHARES_PER_SIDE`, `TRAIL_ARM_PRICE`, `TRAIL_STEP`, `TRAIL_MIN_SECONDS`, `TP_PRICE`
- `STARTING_CAPITAL`, taker fee constants

## Notes / assumptions

- Every fill in this engine — both entries, both kinds of exit
  (trailing stop / TP), and any forced window-end close — is a taker
  order, priced by walking the real order book (`get_book_full` in
  `polymarket_client.py`) for the size being traded, not just reading
  the single best bid/ask. `Engine._realistic_fill_price` does the
  walk: known depth is consumed level by level, and if the visible
  book doesn't cover the full size, the shortfall is conservatively
  priced at the worst level seen (walking further out never gets
  *better*, only the same or worse).
- Trigger conditions (has price reached the trailing level? has SL/TP
  been crossed?) still check the plain top-of-book bid, same as
  before — only the price actually *recorded* as the fill is
  depth-weighted. The event log shows both when they differ (e.g.
  `triggered @ 0.60, book-depth-weighted real fill 0.4133`).
- If the book is fetched successfully but truly has nothing resting on
  a side (`bids: []`), that's treated as a real no-liquidity signal —
  a triggered SL/TP just waits for the next tick rather than inventing
  a fill, and a forced close at window end marks the position down to
  $0 instead of the old fallback of "no loss" at the entry price. If
  the book fetch itself fails (`None`, not `[]`), that's a genuine
  data gap and the old top-of-book/entry-price fallback behavior is
  used instead, since a fetch failure isn't confirmation of zero
  liquidity.
- The trailing-stop level check and the SL/TP trigger check both read
  the live **bid** for that side, so the trail only advances based on
  what a market sell could actually realize, not a possibly-stale mid.
- If price shoots straight through multiple 0.10 levels in one tick
  (e.g. 0.55 → 0.85), the trailing stop jumps straight to the
  appropriate level for the highest one crossed that tick, not
  step-by-step.
- A window where a side never gets a live ask at all (e.g. the book is
  empty right at open) simply retries entry on the next tick; the
  engine doesn't force a fill without a real quote to fill against.
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py` gained `get_book_full()` (full depth, used by
  the engine) alongside the existing `get_book()` (top-of-book only,
  now a thin wrapper around it), and `state.py`/`main.py`'s
  orchestration loop is otherwise unchanged.
