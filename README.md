# Momentum-continuation entry, tightening trail, single trade — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: 10 seconds after a window opens, lock onto whichever
side won the *previous* window — regardless of whether it's currently
cheap or expensive — and buy it either right away or after waiting for
it to dip to 0.50, as long as it's within a defined price zone at fire
time. Then manage the exit with a continuous trailing stop that arms
after a delay and tightens once the position gets deep in the money.
At most one trade per window — no re-entry after a stop-out.

## Strategy

1. **Entry**: wait **10s** after the window opens, then **lock in** the
   entry side as whichever side **won the previous window**, by last
   observed price (see `_infer_winner()` in `app/state.py`) — **not**
   whichever side is cheaper right now. If there's no previous-window
   result yet — the very first window after startup, or the winner
   couldn't be inferred (missing price data at rollover) — the window
   is skipped entirely right there, since there's nothing to follow;
   no side gets locked in and nothing is watched.

   Once a side is locked in, when it actually fires depends on its
   price at that moment:
   - if it's already **at or below 0.50**, the entry zone
     (**0.20–0.80**) is checked immediately and the trade fires (or is
     skipped if outside the zone) right there, same as before.
   - if it's **above 0.50**, the trade does **not** fire yet. The bot
     keeps watching that side every tick — no deadline — until it
     falls to or below 0.50. At that point the entry zone is checked
     and the trade fires (or is skipped if the zone check fails at
     that exact moment). If it never dips to 0.50 before the window
     closes, **no trade is taken that window at all**.

   Either way, the side is bought regardless of whether it's cheap or
   expensive in absolute terms — the 0.50 rule only decides *when* to
   fire, the entry zone is what decides *whether* to fire.
2. **Exit**: once filled, every tick checks that side's mid against a
   take-profit level, a trailing stop, and a hard-stop override.
   - **Take-profit (0.99)**: live immediately from entry, treated as a
     certain win and **redeemed**, not sold — credited at a flat
     **$1.00/share, fee-free** (a CTF resolution redemption, not an
     orderbook trade), instead of taker-selling at ~0.99 and losing a
     sliver of edge to fee/slippage.
   - **Trailing stop**: inactive until **3 minutes after the window
     opened** (not 3 minutes after entry — if entry happens later than
     the usual 10s mark, the stop still arms at the same
     window-relative moment). Before it arms, only TP can close the
     position; the high-water mark keeps tracking the whole time
     regardless, so once it arms it starts from wherever price has
     already gotten to, not from scratch. Once armed, recomputed every
     tick as `high_water_mark − trail_distance`, rounded to the cent.
     It only ever moves up, since it's driven off the position's
     monotonic high-water mark (best mid seen since entry), never the
     raw current price:
     - trail distance is **0.20** while the high-water mark is at or
       below 0.85
     - once the high-water mark climbs **above 0.85**, the trail
       narrows to **0.10** — tightening the stop as the position gets
       deep in the money
   - **Hard-stop override**: independent of the 3-minute trailing-arm
     delay above, the instant the position's high-water mark reaches
     **0.90**, the trailing stop is **permanently deactivated** for
     that position and replaced with a **fixed stop-loss at 0.60** —
     much wider than where the tightened trail would sit (e.g. a 0.95
     high-water mark would trail-stop at 0.85, but once the hard stop
     takes over it's 0.60 instead). This deliberately gives a
     deep-in-the-money position room to wobble near resolution instead
     of getting stopped out by a routine pullback, and it does **not**
     revert even if price later falls back under 0.90.

     A stop exit (trailing or hard) is a real taker sell, priced by
     walking real bid depth — unlike TP, it isn't a guaranteed-
     resolution redemption.
   - **A stop-out ends the window.** There's no flip into the opposite
     side and no re-entry — at most one trade per window.

   If the window closes before either TP or a stop is reached, the
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

- `ENTRY_WAIT_SECONDS` (10), `ENTRY_ZONE_LOW` / `ENTRY_ZONE_HIGH` (0.20 / 0.80), `ENTRY_DIP_THRESHOLD` (0.50), `TP_PRICE` (0.99)
- `TRAIL_START_DELAY_SECONDS` (180) — trailing stop is inactive until this long after **window open** (not entry); TP is live the whole time
- `TRAIL_DISTANCE` (0.20), `TRAIL_DISTANCE_TIGHT` (0.10), `TRAIL_TIGHTEN_PRICE` (0.85) — trail
  narrows from 0.20 to 0.10 once the position's high-water mark climbs above 0.85
- `HARD_STOP_TRIGGER_PRICE` (0.90), `HARD_STOP_PRICE` (0.60) — once the high-water mark reaches
  the trigger, trailing is permanently replaced by this fixed stop, independent of the arm delay
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
- During the first 3 minutes **after the window opens**, the trailing
  stop cannot fire at all, even if price craters — only TP is live.
  The high-water mark still updates during that window, so if price
  runs up and pulls back before the delay is over, the stop (once
  armed) reflects the peak it already saw, not the price at the
  moment of arming.
- The hard-stop override is a separate mechanism from the trailing-arm
  delay above and isn't gated by it: it can trigger in the first few
  seconds of a position if price runs to 0.90 fast enough. Once it
  triggers, the position no longer benefits from the tightened trail
  at all for the rest of the window — it's protected only by the fixed
  0.60 floor.
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
- A window is counted as a no-trade window whenever it ends without a
  fill: no prior-window result to follow, the entry zone check fails
  (whether at the 10s check or after a dip), or the dip to 0.50 simply
  never arrives before the window closes.
- The previous window's winner is inferred from the **last observed
  CLOB midpoint** at rollover (`_infer_winner()` in `app/state.py`),
  not from Polymarket's actual settled resolution — see
  `fetch_resolution()` in `polymarket_client.py` if real-resolution
  settlement is wanted instead. If that inference comes back `None`
  (missing price data right at rollover), the momentum signal is
  cleared and the next window is skipped rather than trading on stale
  information.
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py` (full order-book depth via `get_book_full()`)
  and `state.py`/`main.py`'s orchestration loop are unchanged.
