# Delayed cheap-side entry, tightening trail, single trade — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: 10 seconds after a window opens, buy whichever side
is cheaper if it's within a defined price zone, then manage the exit
with a continuous trailing stop that tightens once the position gets
deep in the money, or a fixed take-profit. At most one trade per
window — no re-entry after a stop-out.

## Strategy

1. **Entry**: wait **10s** after the window opens, then look at both
   sides' mid price once. Buy whichever side is cheaper ("the cheap
   side") — but only if that price is inside the entry zone
   **0.20–0.80**. This is a single check at t=10s, not a rearmed
   watch; if the cheap side is outside the zone at that moment, no
   trade is taken this window.
2. **Exit**: once filled, every tick checks that side's mid against a
   take-profit level and a continuous trailing stop:
   - **Take-profit (0.99)**: treated as a certain win and **redeemed**,
     not sold — credited at a flat **$1.00/share, fee-free** (a CTF
     resolution redemption, not an orderbook trade), instead of
     taker-selling at ~0.99 and losing a sliver of edge to fee/slippage.
   - **Trailing stop**: recomputed every tick as
     `high_water_mark − trail_distance`, rounded to the cent. It only
     ever moves up, since it's driven off the position's monotonic
     high-water mark (best mid seen since entry), never the raw
     current price:
     - trail distance is **0.20** while the high-water mark is at or
       below 0.85
     - once the high-water mark climbs **above 0.85**, the trail
       narrows to **0.10** — tightening the stop as the position gets
       deep in the money

     A stop exit is a real taker sell, priced by walking real bid
     depth — unlike TP, it isn't a guaranteed-resolution redemption.
   - **A stop-out ends the window.** There's no flip into the opposite
     side and no re-entry — at most one trade per window.

   If the window closes before either TP or the stop is reached, the
   position is force-closed at whatever the market will pay (also a
   real taker sell).
3. **Sizing**: flat. Every entry is exactly `BASE_ORDER_SHARES`
   (100), no martingale, no cross-window sizing memory — every window
   starts fresh.

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

- `ENTRY_WAIT_SECONDS` (10), `ENTRY_ZONE_LOW` / `ENTRY_ZONE_HIGH` (0.20 / 0.80), `TP_PRICE` (0.99)
- `TRAIL_DISTANCE` (0.20), `TRAIL_DISTANCE_TIGHT` (0.10), `TRAIL_TIGHTEN_PRICE` (0.85) — trail
  narrows from 0.20 to 0.10 once the position's high-water mark climbs above 0.85
- `BASE_ORDER_SHARES` (100) — flat size, no martingale
- `STARTING_CAPITAL`, taker fee constants (entry, stop, and forced-close are taker fills; TP is a fee-free redemption at $1.00, not a trade)

## Notes / assumptions

- TP being modeled as a flat $1.00 redemption assumes a token sitting
  at 0.99 is a settled win — it does not model the (small) chance the
  window still resolves against it before the redemption actually
  happens on-chain.
- The trailing stop only ever moves up. It's driven by the position's
  high-water mark, not the current price, so a spike to 0.90 followed
  by a pullback to 0.85 does **not** trigger a stop by itself — only a
  further drop through the (possibly now-tightened) stop level would.
- A stop-out is terminal for the window: no flip into the opposite
  side, no re-entry. At most one trade is taken per window.
- Both the entry and the exit are modeled as **taker** fills, priced
  by walking real order-book depth rather than assuming unlimited size
  at the top-of-book quote.
- The cost of every fill is debited from the capital balance the
  instant it fills, and every exit's proceeds are credited back —
  `starting_capital + total_pnl` should match the final balance
  exactly across any sequence of trades.
- If the book is fetched successfully but truly has nothing resting on
  the held side at exit time (`bids: []`), that's treated as a real
  no-liquidity signal — the position is marked down to $0 rather than
  assuming no loss. If the book fetch itself fails (`None`, not `[]`),
  that's a genuine data gap and the last known price is used instead.
- A window where the cheap side is outside the entry zone at the 10s
  check is counted as a no-trade window.
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py` (full order-book depth via `get_book_full()`)
  and `state.py`/`main.py`'s orchestration loop are unchanged.
