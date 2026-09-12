# One-way re-arming trailing stop — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: one position at a time, entering whichever side first
reaches 0.60, trailing a stop on it, and — if that stop hits — going
right back to watching for the next 0.60 cross.

## Strategy

1. **Watch**: after window open, watch both sides' mid-price every
   tick — except the first **15 seconds**, where no entries are taken
   at all (the market is often thin/choppy right at window open).
2. **Entry**: the instant EITHER side's mid-price reaches 0.60 (and
   the 15s lockout has elapsed), buy that side — 300 shares, taker,
   priced against real book depth. The other side is not bought. (If
   both cross in the same tick, UP is checked first, same tie-break
   convention as the old ladder engine.)
   - **No chasing**: entries only fire while mid is inside
     `[0.60, 0.62]` (`TRAIL_ARM_PRICE` to `+ENTRY_MAX_CHASE`). If price
     gaps straight past that band — e.g. a fast move or a gap between
     polls jumps from 0.55 to 0.84 — that tick is skipped entirely, no
     buy. The bot keeps watching and only enters once that side's
     price comes back down into the band, i.e. a real pullback to
     ~0.60, never a chase of wherever price already ran to.
3. **Trailing stop**: since entry only ever happens right as price
   crosses 0.60, the stop loss is armed **immediately at entry** at
   0.50 (0.60 − 0.10). From there it trails up in 0.10 steps, only
   ever moving up, never back down:
   - entry at 0.60 → stop loss 0.50
   - price reaches 0.70 → stop loss 0.60
   - price reaches 0.80 → stop loss 0.70
   - ...and so on
4. **Take profit**: fixed at 0.99, active from the moment of entry.
5. **Time-based force sell**: if TP still hasn't hit by **270 seconds**
   into the window, any open position is force-closed immediately
   (same real-fill pricing as every other exit) instead of waiting on
   the trailing stop. Same as a TP hit, this also ends the window for
   re-entry — no more entries for the rest of that window once a
   time-based force sell has fired.
6. **One-way re-arm cycle**:
   - If the **trailing stop hits**, the position closes and, after a
     **10-second cooldown**, the bot goes right back to step 2 —
     watching **both** sides again from scratch for whichever one next
     reaches 0.60 (could be the same side recovering, or the other
     side). This can repeat any number of times within a single
     5-minute window. The cooldown exists because a trailing stop can
     itself fire exactly at 0.60 (ratcheted up from an earlier run to
     0.70+, then pulled back) — re-watching instantly would re-trigger
     on that same 0.60 cross the stop just exited on.
   - If **TP hits**, or a **time-based force sell** fires, the bot does
     **not** re-arm — no more entries for the rest of that window.
7. **Realistic fills**: every fill — entry, trailing SL, TP, time-based
   force sell, and the forced window-end close — is priced by walking
   the real order book depth needed to cover the full 300-share size,
   not just the single best bid/ask. A thin/illiquid book pulls the
   average fill price accordingly instead of assuming unlimited depth
   at the top quote. If the book is confirmed to have zero depth at
   all, no fill is invented — the bot waits for the next tick, or, if
   the window is closing right then, marks the position down to $0
   rather than assuming no loss at all.
8. **Window close**: force a taker close on any position still open.

Sizing is flat — 300 shares every entry, no progression or doubling.
"Rearm" here only means going back to watching for the next 0.60
cross, not a bigger size.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `SHARES_PER_SIDE`, `TRAIL_ARM_PRICE`, `TRAIL_STEP`, `TP_PRICE`
- `ENTRY_LOCKOUT_SECONDS` (15s no-entry window at window open)
- `ENTRY_MAX_CHASE` (0.02 — entry band above `TRAIL_ARM_PRICE`, no chasing past it)
- `REARM_COOLDOWN_SECONDS` (10s pause after a trailing-stop exit before re-watching)
- `FORCE_SELL_AFTER_SECONDS` (270s — force-close if TP hasn't hit by then)
- `STARTING_CAPITAL`, taker fee constants

## Notes / assumptions

- Only one position exists at a time. Entry, trailing-stop tracking,
  and the re-arm/done-for-window logic all live in a single
  `Engine.s.position` slot rather than tracking UP and DOWN
  separately.
- **Lifetime stats vs per-window state**: cumulative counters
  (`realized_pnl`, `wins`/`losses`, `total_entries`, `total_rearms`,
  fill counts, `no_trade_windows`, ...) live in `Engine.stats`
  (`SessionStats`), which persists for the life of the engine — the
  same lifetime as `Engine.capital` (`CapitalPool`). `Engine.s`
  (`EngineState`) is fully replaced by a blank instance on every
  `reset_for_window()` call, so only genuinely per-window fields
  (open position, `fills_this_window`, `last_window_pnl`,
  `entries_this_window`, `rearms_this_window`, ...) belong there.
  Mixing a cumulative counter into `EngineState` silently zeroes it
  out every ~5 minutes — that was a real bug (balance drifting away
  from displayed realized P&L) fixed by this split.
- Every fill in this engine is a taker order, priced by walking the
  real order book (`get_book_full` in `polymarket_client.py`) for the
  size being traded, not just reading the single best bid/ask.
  `Engine._realistic_fill_price` does the walk: known depth is
  consumed level by level, and if the visible book doesn't cover the
  full size, the shortfall is conservatively priced at the worst
  level seen.
- Trigger conditions (has price reached 0.60 for entry? has SL/TP been
  crossed?) still check the plain top-of-book bid/mid — only the price
  actually *recorded* as the fill is depth-weighted. The event log
  shows both when they differ (e.g. `triggered @ 0.60,
  book-depth-weighted real fill 0.4133`).
- If the book is fetched successfully but truly has nothing resting on
  a side (`bids: []`), that's treated as a real no-liquidity signal —
  a triggered SL/TP just waits for the next tick rather than inventing
  a fill, and a forced close at window end marks the position down to
  $0 instead of falling back to "no loss" at the entry price. If the
  book fetch itself fails (`None`, not `[]`), that's a genuine data
  gap and the old top-of-book/entry-price fallback is used instead.
- The 2-minute trailing-stop activation delay from an earlier version
  has been removed entirely — entry and trail-arming are now the same
  event (crossing 0.60), so there's nothing left to delay.
- A window where price never reaches 0.60 on either side simply never
  enters — counted as a no-trade window.
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py`'s `get_book_full()` (full depth) and
  `get_book()` (top-of-book wrapper) are unchanged from the previous
  version, and `state.py`/`main.py`'s orchestration loop is otherwise
  unchanged.
