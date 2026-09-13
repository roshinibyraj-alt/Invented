# Dual-grid, profit-target exit — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: UP and DOWN each build their own fully independent
grid of resting limit buy orders for the first two minutes, then the
bot watches combined profit across both sides and sells everything the
moment it's up $100.

## Strategy

1. **Independent grids**: UP and DOWN are tracked completely
   separately — nothing about one side's orders or fills affects the
   other's.
2. **Grid building (first 120 seconds of the window)**: every tick, on
   each side, compute a candidate rung price = (current mid price) −
   0.05. If that candidate is at least 0.05 away from every order
   already placed on that side (resting, filled, or cancelled — a used
   price slot stays used), place a new resting limit buy there for 100
   shares. This produces a ladder of buy orders that's never closer
   than 0.05 apart and keeps extending as price explores new territory
   in either direction.
3. **Fills**: a resting limit buy is a real maker order — it fills at
   its own exact limit price (no slippage, no fee) the moment that
   side's best ask drops to or through it. Fills can happen any time
   the order is live, including after the 120-second grid-building
   window ends (only *placing new orders* stops after 120s; anything
   already resting stays live until it fills or the window closes).
4. **After 120 seconds**: no more new orders are placed on either
   side. The bot just watches. Every tick it totals the **unrealized**
   profit across every filled share on **both sides combined**
   (mark-to-market minus cost basis, UP + DOWN summed together). The
   instant that combined total reaches **+$100**, it sells everything
   on both sides — taker orders, priced by walking real book depth,
   not just top-of-book — and is done for the rest of that window: no
   more orders, no more monitoring.
5. **Window close**: if the $100 target is never hit, cancel any
   still-resting unfilled orders (no penalty) and force a taker close
   on any shares still held, same depth-aware pricing as the exit
   above.

Sizing is flat — 100 shares per rung, no progression or doubling.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `GRID_ORDER_SHARES`, `GRID_SPACING`, `GRID_DURATION_SECONDS`, `PROFIT_TARGET_USD`
- `STARTING_CAPITAL`, taker fee constants (entries are fee-free maker fills; only the exit and forced close pay a fee)

## Notes / assumptions

- Resting limit buys are simulated as filling **fully, at their exact
  limit price**, the instant the side's best ask reaches that price —
  no partial fills, no fee, no slippage modeled for the maker leg
  itself. The depth-aware realistic-fill-price logic only applies to
  the two TAKER legs (the profit-target sell-everything exit, and the
  forced window-end close).
- The $100 profit target is evaluated against **gross unrealized P&L**
  (mark value minus cost basis) — it does not pre-subtract the taker
  fee that the eventual exit will incur, so realized profit after
  exiting will be a little under $100 once that fee is paid.
- "No overlap" / "0.05 apart" is enforced against every order ever
  placed on that side, not just the most recent one — so the grid
  never has two rungs closer than 0.05, no matter how price moves
  around in between.
- If the book is fetched successfully but truly has nothing resting on
  a side at exit time (`bids: []`), that's treated as a real
  no-liquidity signal — the position on that side is marked down to
  $0 rather than assuming no loss. If the book fetch itself fails
  (`None`, not `[]`), that's a genuine data gap and the last known
  price is used instead.
- A window where price never moves enough to place a single order
  (extremely unlikely, but possible right at open) is counted as a
  no-trade window.
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py` (full order-book depth via `get_book_full()`)
  and `state.py`/`main.py`'s orchestration loop are unchanged from the
  previous version.
