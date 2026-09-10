# BTC 5m Confused-Market Bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets, built on the
market-discovery/CLOB scaffolding of the reference ladder bot, with a new
engine implementing a "confused market" ladder + tiered take-profit
strategy.

## Strategy

1. **Detect**: after 4 minutes elapsed in the 5-minute window, watch UP and
   DOWN mid-price (CLOB best bid/ask midpoint — no Gamma price fallback,
   ever). If both sit in `[0.30, 0.60]` for 5 consecutive ticks in a row
   (a debounce against one noisy print — tune via `CONFUSED_CONFIRM_TICKS`
   in `app/config.py`, or set it to 1 for an immediate single-tick trigger),
   the market is "confused." Fires once per window.
2. **Enter**: place a 3-level resting buy ladder on **both** UP and DOWN
   simultaneously: 200sh@0.30, 100sh@0.20, 50sh@0.10 (6 orders total, all
   maker limit buys). None are ever proactively cancelled — they only stop
   resting when the window closes.
3. **First side / opposite side**: whichever side's *any* tranche fills
   first locks in as the "first side" for the rest of the window, even if
   its other tranches fill later. First-side fills use tiered TP
   (0.30→0.70, 0.20→0.80, 0.10→0.90). Every fill on the other side —
   which necessarily fills after — gets a flat TP of 0.99, regardless of
   entry price.
4. **Exit**: TP orders are resting maker sells. No stop loss. Anything
   still open at window close rides to resolution ($1/sh win, $0/sh loss),
   inferred from the last observed CLOB midpoint (see `state.py`).
5. **No re-arm**: each window gets at most one ladder.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `CONFUSED_AFTER_SECONDS`, `CONFUSED_LOW/HIGH`, `CONFUSED_CONFIRM_TICKS`
- `LADDER_LEVELS` (price, shares, first-side TP per tranche)
- `OPPOSITE_TP`
- `STARTING_CAPITAL`, fee/rebate constants

## Notes / assumptions carried over from the spec conversation

- The "bouncing 0.30–0.60" condition is read from CLOB best bid/ask
  midpoint, checked on every tick.
- A short confirm-tick debounce was added since "bouncing" implies some
  persistence, not a single instant read — adjustable/removable in config.
- This engine replaces the reference bot's merge-arbitrage engine
  entirely; it reuses `polymarket_client.py`, `models.py`, `paper_broker.py`,
  and the `main.py`/`state.py` orchestration loop unchanged in behavior.
