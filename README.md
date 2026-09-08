# Polymarket 4-Engine Pooled Bot (Paper / Demo Mode)

Four independent trading engines, each dedicated to one outcome of
Polymarket's 5-minute BTC/ETH Up/Down markets, running in parallel with a
shared profit/loss pooling rule across all four. **This bot is
paper-trading only** — it reads Polymarket's real, public order books but
never signs or submits a real order. All fills, fees, and P&L are
simulated against four virtual $1,000 bankrolls.

## The 4 engines

| Engine | Market | Side |
|---|---|---|
| E1_BTC_UP | BTC Up/Down | Up |
| E2_BTC_DOWN | BTC Up/Down | Down |
| E3_ETH_UP | ETH Up/Down | Up |
| E4_ETH_DOWN | ETH Up/Down | Down |

Each engine:
- Starts with **$1,000** (`STARTING_CAPITAL_PER_ENGINE`), independent of
  the other three.
- Fires **exactly one entry per 5-minute window** — no threshold, no
  condition: it buys `ENTRY_DOLLARS` (default **$100**) worth of its
  assigned token as soon as that window's market is discovered, which is
  as close to window-open (and therefore closest to a $0.50 coin-flip
  price) as the poll cadence allows.
- Is watched for a symmetric **take-profit at $0.70 / stop-loss at
  $0.30** (`TAKE_PROFIT_PRICE` / `STOP_LOSS_PRICE`, ±40% from the ~$0.50
  entry).
- If neither TP nor SL triggers before the window closes, the position
  is held and resolved via **"time decay"** — the price naturally
  converges toward $0 or $1 as the window resolves, confirmed by
  Polymarket's own official resolution (see below).

Because there's no directional signal at entry (price starts near a
coin-flip), and a symmetric TP/SL around that entry, each engine's raw
win rate should land close to 50% over time — the edge (or lack of one)
here isn't from prediction, it's from how the profit/loss pooling below
reshapes what each engine actually keeps.

## The pooling rule — the important, unusual part

This is **not** a simple shared pool where everyone keeps their own
result and also gets a cut of the others'. Instead, for every single
trade, in both directions:

- **If an engine's trade is a profit**, that engine does **not** keep
  the profit. It's split three ways and given entirely to the other
  three engines.
- **If an engine's trade is a loss**, that engine does **not** absorb
  the loss. The other three each cover exactly a third of it, making the
  losing engine whole.

Concretely: an engine is credited back **exactly what it spent** (entry
cost + entry fee) when its position closes, regardless of whether the
trade won or lost — net effect on its **own** balance from its **own**
trade is always zero. The trade's actual raw P&L (which can be positive
or negative) is what gets split three ways to the *other* three engines'
balances. So each engine's balance only moves because of what the other
three did — never directly because of its own trade's outcome.

This happens once per window, as a single **redistribution event**,
triggered the moment **all four engines'** positions for that window are
fully finalized (via TP, SL, or resolution) — which may span into a
later window if one engine's resolution lags. The next window's entries
aren't gated on this; every engine still fires its flat $100 entry every
window regardless of whether older windows have finished redistributing.

### Worked example

Say in one window: E1 wins $30, E2 loses $20, E3 wins $10, E4 loses $15.

- E1 is credited back its own $100 stake; its $30 profit is split
  three ways: +$10 to each of E2, E3, E4.
- E2 is credited back its own $100 stake (its $20 loss doesn't touch its
  own balance); the other three each pay a third of that $20 loss:
  -$6.67 to each of E1, E3, E4.
- E3 similarly: credited its own $100 back, its $10 profit split as
  +$3.33 to each of E1, E2, E4.
- E4 similarly: credited its own $100 back, its $15 loss split as
  -$5 to each of E1, E2, E3.

Net balance change per engine = its own $100 restored, plus/minus its
share of the other three's results. The total dollars moved across all
four always equals the sum of the four raw P&Ls — redistribution moves
money between engines, it never creates or destroys it. This is checked
by a runtime assertion in `app/engine.py` (`redistribute_cohort`) that
raises immediately if that invariant is ever violated.

## Resolution: Polymarket's own official result, primary; CLOB as a bounded fallback

If TP/SL never triggers, a position is held and resolved using
**Polymarket's own official resolution** (Gamma's `closed` +
`outcomePrices` fields — the real oracle-based settlement), not any
CLOB-derived price. In practice, Gamma's fields can lag or sometimes
never populate promptly for these short-dated events, so if a position
hasn't gotten Gamma confirmation within `GAMMA_RESOLUTION_TIMEOUT_SECONDS`
(default 90s) of its window closing, it falls back to the CLOB's actual
**last-traded price** (a real executed trade — never bid/ask/midpoint,
which are unsafe right at window close: liquidity can vanish on one
side, and Polymarket's own docs confirm `/midpoint` is literally
`(best_bid + best_ask) / 2`, so it inherits the same problem). Gamma is
always tried first, every poll; the fallback only engages for a position
that's specifically timed out, and logs a clear warning every time it
fires.

## Execution model

- **Taker only**, capped by a slippage ceiling on buys (never pay more
  than `BUY_SLIPPAGE_CEILING`, default 0.99) and a slippage floor on
  sells (never accept less than `SELL_SLIPPAGE_FLOOR`, default 0.01).
- Entries are sized by **dollar notional** ($100), not a fixed share
  count — the actual number of shares bought depends on the ask price at
  entry, simulated by walking the real order book.
- Fees use Polymarket's real dynamic crypto taker-fee formula:
  `fee = shares * fee_rate * price * (1 - price)`, with the rate read
  live per-market from Gamma.

## Running locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

Then open `http://localhost:8080` for the dashboard, or `GET /status`
for raw JSON.

## Deploying on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**. Railway will
   detect the `Dockerfile` automatically.
3. Set any env vars you want to override (see `.env.example`) in the
   Railway **Variables** tab. None are required — sensible defaults ship
   in `app/config.py`.
4. **Attach a Volume mounted at `/data`** if you want balances/history to
   survive redeploys — otherwise the SQLite file resets on every
   redeploy.
5. Deploy. Railway exposes a public URL serving the dashboard on
   `$PORT`.

## Project layout

```
app/
  config.py     # engines, thresholds, sizing, resolution config
  gamma.py      # Gamma API market discovery
  clobbook.py   # public CLOB order book + last-trade-price fetch
  fills.py      # simulated taker fills, sized by $ notional for entries
  fees.py       # Polymarket's dynamic crypto taker-fee formula
  engine.py     # PoolLedger: balances, positions, the redistribution math
  strategy.py   # PoolBot: the main loop -- entries, TP/SL, resolution, redistribution
  storage.py    # SQLite persistence (balances, trades, redistributions)
  server.py     # FastAPI dashboard + /status JSON + /health
main.py         # runs the bot loop and web server together, colored per-engine logs
```

## Going from paper to real trading (not included)

This build intentionally stops short of real order signing. If/when you
want that: swap `fills.py`'s simulated walk for real order submission via
`py-clob-client`, add wallet funding/allowance checks, an on-chain
redemption step for resolved positions, and real risk controls (a kill
switch / max-daily-loss check) beyond what exists here for paper trading.

## Disclaimer

This is trading-adjacent software provided for experimentation. Nothing
here is financial advice. The profit/loss pooling scheme is an unusual,
deliberately-requested design — it does not represent a risk-free
arbitrage or a "guaranteed" smoothing mechanism; the four engines are
still exposed, in aggregate, to whatever this simple TP/SL/time-decay
strategy actually earns or loses on Polymarket's real markets.
