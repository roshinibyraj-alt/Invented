# Polymarket BTC 5m Up/Down Bot — paper trading

Engine B runs an **instant limit-order ladder** against Polymarket's
`btc-updown-5m-*` markets, in **paper mode** (simulated $5,000 balance,
no real orders) with a live dashboard.

## Strategy — Engine B (ladder)

At window open, place resting limit buy orders on **both** sides — Up
and Down — at every **0.01 increment from 0.49 down to 0.02** (48
rungs per side, 96 orders total), **10 shares** each, all placed in one
shot as fast as possible.

- **Fills:** as a side's price falls through the ladder, each rung it
  crosses fills (a big move between polls fills every rung it swept
  through, not just the nearest one).
- **No stop loss.**
- **Take profit:** if a side's price reaches **0.75+**, everything
  currently held on that side is sold immediately **and all remaining
  unfilled rungs on that side are cancelled** — once a side has taken
  profit, it never re-enters for the rest of the window.
- **At window close:** anything still held settles against
  Polymarket's real outcome — $1/share if that side won, $0 if it
  lost. Unfilled rungs simply expire.

## Fees / Maker Rebates

Every order in this strategy is a resting limit order — the maker side
of the fill. Polymarket charges **$0 to makers**. Instead, makers earn
a rebate:

```
matched_fee = shares * TAKER_FEE_RATE * price * (1 - price)   # TAKER_FEE_RATE = 0.07
rebate      = matched_fee * MAKER_REBATE_SHARE                 # 20% for Crypto
```

E.g. 100 shares filled at 0.50 → $1.75 matched fee → $0.35 rebate.
Credited on every buy and every TP sell. Redemption at expiry isn't a
matched trade and earns no rebate. Verify both numbers at
docs.polymarket.com/market-makers/maker-rebates before relying on this
for real capital — Polymarket sets the rebate share at its discretion
and it's changed before.

## Dashboard

- Live Up/Down prices + sparkline.
- **Ladder visualization** for each side: all 48 rungs from 0.49 to
  0.02, colored in when filled (green for Up, red for Down), showing
  live shares/avg entry/cost/unrealized P&L for that side.
- Balance / total P&L / fees strip and full trade log.

## Project layout

```
app/
  config.py             strategy + runtime parameters
  models.py              shared dataclasses/enums
  polymarket_client.py   Gamma (market discovery) + CLOB (pricing) + resolution API client
  paper_broker.py         simulated wallet / fills / PnL / fees
  engine_b.py              the ladder strategy
  state.py                 background polling loop + orchestration
  main.py                  FastAPI app (serves API + dashboard)
static/index.html          dashboard UI
```

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

Open http://localhost:8000

## Deploy: GitHub → Railway

1. Push this folder to a new GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Instant limit-order ladder strategy"
   git branch -M main
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway auto-detects Python via Nixpacks and uses the `Procfile` /
   `railway.json` start command — no manual build config needed.
3. Under **Variables**, set any of the values from `.env.example` you
   want to override (defaults work out of the box for paper mode).
4. Deploy. Railway assigns a public URL — that's your dashboard.

## Verify the Polymarket API responses once live

`app/polymarket_client.py` isolates all HTTP calls to Polymarket's
public Gamma (metadata) and CLOB (pricing) APIs. After your first
deploy, confirm the dashboard header shows a real slug, prices
populate, and fills settle correctly at window close (check the trade
log for `RESOLVE_WIN`/`RESOLVE_LOSS` or `RESOLUTION_FALLBACK` rows).

## Going live (real orders)

This build intentionally stops at paper trading. Note that in real
order-book conditions, queue priority at each rung matters (this is
what "bot must be at the highest acceptable price, faster" in the
original brief refers to) — paper mode simulates fills purely against
polled prices and doesn't model queue position, so real fills may
differ from the simulation, especially at the top of the ladder near
0.49 where competition for that price level is highest.
