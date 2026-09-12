# Ladder breakout — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single ladder-breakout strategy with immediate at-mid limit entries.

## Strategy

1. **Cold start**: do nothing for the first 60 seconds of each window —
   no monitoring, no orders.
2. **Arm**: after the cold start, watch both sides' mid-price every
   tick. Whichever side's mid-price first reaches 0.65 becomes the
   **armed side** for the rest of that window — the other side is no
   longer watched (they're complementary; once one is rallying the
   other's falling).
3. **Ladder**: every time the armed side's mid-price climbs through the
   next threshold (0.65 → 0.75 → 0.85), place one new resting limit BUY
   order (maker) *immediately, right at that tick's current mid price* —
   not offset below it:
   - crosses 0.65 → resting buy @ (mid at that tick, ~0.65)
   - crosses 0.75 → resting buy @ (mid at that tick, ~0.75)
   - crosses 0.85 → resting buy @ (mid at that tick, ~0.85)

   Each rung is placed once and stays resting — since a buy limit sits
   between the bid and ask, it still needs the ask to fall back down
   to/through it to fill (roughly half the spread), it just isn't
   waiting for a full pullback anymore. It is **not** cancelled just
   because price keeps climbing past it.
4. **Per fill**: every rung that fills becomes its own independent
   position of 100 shares with its own stop loss (0.50 — taker market
   sell the instant the bid drops to/through it) and take profit (0.99
   — resting maker sell). Up to 3 positions can be open at once in one
   window if all three rungs fill.
5. **Window close**: cancel any rungs that never filled; force a taker
   close on any positions still open.

Sizing is flat — 100 shares every rung, every window. No martingale or
anti-martingale progression.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `LADDER_ARM_DELAY_SECONDS`, `LADDER_THRESHOLDS`, `LADDER_SL_PRICE`, `LADDER_TP_PRICE`, `LADDER_SHARES_PER_RUNG`
- `STARTING_CAPITAL`, fee/rebate constants

## Notes / assumptions

- Arming and ladder-threshold crossings read the CLOB best bid/ask
  **mid-price**, checked every tick. Rung fills and SL/TP exits read the
  live **ask**/**bid** respectively (a resting buy needs a real ask to
  cross down into it; SL/TP read off the bid).
- Only one side ever trades per window — once armed, the other side is
  ignored entirely for the rest of that window.
- If price shoots straight through multiple thresholds in one tick
  (e.g. 0.60 → 0.86), every rung up to and including the one just
  crossed gets placed in that same tick, each at that tick's mid.
- A big-enough pullback can fill more than one rung in the same tick if
  the ask drops below multiple resting limit prices at once.
- Rung entries and TP exits are resting maker orders (no fee, earn the
  maker rebate); the stop loss and any forced window-end close are
  taker market orders and pay the fee for real.
- This reuses `polymarket_client.py`, `models.py`, `paper_broker.py`,
  and the `main.py`/`state.py` orchestration loop unchanged in behavior.
