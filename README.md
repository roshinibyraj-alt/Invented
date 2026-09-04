# Polymarket BTC 5m Up/Down Bot — paper trading

Two independent strategy engines trading Polymarket's `btc-updown-5m-*`
markets, running in **paper mode** (simulated $5,000 balance, no real
orders) with a live dashboard.

## Strategy

**Engine A** — 100 base shares
1. On window open, place resting limit buys at **0.30** on both Up and Down.
2. Whichever fills first wins; cancel the other resting order.
3. No stop loss.
4. If the held side's price touches **0.60+**, arm a guard. If it then
   retraces to **0.50**, market-sell immediately.
5. Otherwise hold to expiry. A 0.90+ price in the last 2 seconds before
   close is logged as the resolution signal but triggers no action.

**Engine B** — 200 base shares, martingale
1. Watch both sides after open. The first side to touch **0.70** is
   skipped for the window.
2. If the *other* side then reaches 0.70, market-buy it.
3. Stop loss at **0.50**.
4. Same logging-only 0.90+ resolution rule as Engine A.
5. A stop-loss loss **doubles** next window's size (200 → 400 → 800…).
   A win resets size back to 200.

Both engines share one balance/ledger but trade independently — they
often land on the same side by construction, but neither is hard-wired
to follow the other.

## Project layout

```
app/
  config.py            strategy + runtime parameters
  models.py             shared dataclasses/enums
  polymarket_client.py  Gamma (market discovery) + CLOB (pricing) API client
  paper_broker.py        simulated wallet / fills / PnL
  engine_a.py / engine_b.py   the two strategies
  state.py               background polling loop + orchestration
  main.py                 FastAPI app (serves API + dashboard)
static/index.html         dashboard UI
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
   git commit -m "Initial commit: BTC 5m paper trading bot"
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

## Important: verify the Polymarket API responses once live

`app/polymarket_client.py` isolates all HTTP calls to Polymarket's
public Gamma (metadata) and CLOB (pricing) APIs. Field names on these
endpoints have shifted before. After your first deploy:

- Confirm `fetch_market_by_slug` is returning a market for the current
  `btc-updown-5m-<closeTimestamp>` slug (check the dashboard header —
  if it says "waiting for market..." the slug/lookup needs a tweak).
- Confirm `get_price` is returning sane 0–1 values (check the Up/Down
  price readouts and the sparkline).

If either is off, the fix is contained entirely to that one file — the
engines, broker, and dashboard don't touch raw API responses.

## Going live (real orders)

This build intentionally stops at paper trading. To route real orders:
- Add `py-clob-client`, an EOA wallet with USDC/MATIC on Polygon, and
  Polymarket API credentials (key/secret/passphrase).
- Replace the `buy`/`sell` calls in `paper_broker.py` with real
  `create_order` / `post_order` calls, and replace the simulated fill
  checks in `engine_a.py`/`engine_b.py` with real order-status polling
  (limit fills aren't guaranteed at your exact 0.30 print the way the
  paper sim assumes).
- Add slippage/fee handling and a kill switch before risking capital.
