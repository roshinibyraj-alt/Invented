# Breakout entry, fixed TP/SL, anti-martingale — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: watch both sides for a breakout past 0.70, buy
whichever side gets there first, exit at a fixed take-profit or
stop-loss, and size the next window's trade up after a win using an
anti-martingale ladder.

## Strategy

1. **Entry trigger**: from the instant a window opens, watch both
   sides' mid price every tick. The moment **either** side's mid
   reaches **0.70**, immediately attempt a buy on that side only —
   whichever side triggers first takes the window's one and only trade
   slot. The other side is ignored for the rest of the window, even if
   it later reaches 0.70 too.
2. **Fill / slippage cap**: the entry is priced by walking real ask
   depth (not just top-of-book), but capped at 0.70 + 0.10 = **0.80**.
   If the market has already moved past that cap by the time the
   trigger fires, the entry is skipped entirely — logged as
   `MISSED_ENTRY`, no position taken, no capital risked — rather than
   chasing an arbitrarily bad price.
3. **Exit**: once filled, every tick checks that side's bid against
   two fixed absolute levels — **take-profit 0.99** and **stop-loss
   0.40**. Whichever is reached first closes the whole position as a
   taker sell, priced by walking real bid depth. If the window closes
   before either level is reached, the position is force-closed at
   whatever the market will pay, and still counts as a win or loss for
   sizing purposes.
4. **Sizing — anti-martingale**: position size is
   `BASE_ORDER_SHARES * 2.1 ** martingale_step`. The step **persists
   across windows** (it's not part of a window's state):
   - a **win** steps it up by one, capped at 2 steps — except a win
     that was already *at* the cap resets back to step 0
   - a **loss** resets it to step 0 immediately
   - a window where 0.70 was never reached, or the entry was skipped
     for slippage, leaves the step unchanged

   With the defaults (2.1x, cap 2) the ladder is:
   `100sh (1x) → 210sh (2.1x) → 441sh (4.41x) → win resets to 100sh`

At most one trade is open per window, on one side only — a position
never exists on both sides simultaneously, so there's no fee-free CTF
merge mechanic here (that only applies when holding both complementary
outcome tokens at once).

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `ENTRY_TRIGGER_PRICE` (0.70), `ENTRY_SLIPPAGE` (0.10), `TP_PRICE` (0.99), `SL_PRICE` (0.40)
- `BASE_ORDER_SHARES` (100), `ANTI_MARTINGALE_MULTIPLIER` (2.1), `MAX_MARTINGALE_STEPS` (2)
- `STARTING_CAPITAL`, taker fee constants (both entry and exit are taker fills here — reactive/triggered orders, not resting maker orders)

## Notes / assumptions

- Both the entry and the exit are modeled as **taker** fills, priced
  by walking real order-book depth rather than assuming unlimited size
  at the top-of-book quote. Entry additionally enforces the 0.80
  slippage cap; if the walked fill price would exceed it, no trade is
  taken.
- The cost of every fill is debited from the capital balance the
  instant it fills, and every exit's proceeds are credited back —
  `starting_capital + total_pnl` should match the final balance
  exactly across any sequence of trades.
- A win/loss for anti-martingale purposes is decided purely by realized
  P&L sign on the close (`TP_HIT`, `SL_HIT`, or `FORCED_CLOSE` at
  window end all count).
- If the book is fetched successfully but truly has nothing resting on
  the held side at exit time (`bids: []`), that's treated as a real
  no-liquidity signal — the position is marked down to $0 rather than
  assuming no loss. If the book fetch itself fails (`None`, not `[]`),
  that's a genuine data gap and the last known price is used instead.
- A window where 0.70 is never reached on either side is counted as a
  no-trade window and does not affect the martingale step.
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py` (full order-book depth via `get_book_full()`)
  and `state.py`/`main.py`'s orchestration loop are unchanged from the
  previous version.
