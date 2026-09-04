# Polymarket BTC 5m Up/Down Bot — paper trading

Engine B is the only strategy running (Engine A was removed). It trades
Polymarket's `btc-updown-5m-*` markets in **paper mode** (simulated
$5,000 balance, no real orders) with a live dashboard.

## Strategy — Engine B

1. Wait **45 seconds** after window open. No action before that.
2. At the 45s mark, buy the **cheaper** of the two sides, provided its
   price is below **0.70**.
3. Exit depends on the entry price tier:
   - entry **< 0.30** → take profit at **0.50**
   - entry **>= 0.60** → hold to resolution (no early exit)
   - entry **0.30–0.60** → not specified in the original brief; defaults
     to "hold to resolution" here, since a 0.50 TP would guarantee a
     loss for any entry above 0.50. Change `ENGINE_B_LOW_TIER_MAX` /
     add a rule in `engine_b.py` if you want different behavior.
4. **Stop loss** at entry price minus **0.15** (`ENGINE_B_STOP_LOSS_OFFSET`
   in config — the brief said 0.15–0.20, defaulted to the lower end).
5. After entering, wait another **45 seconds**, then watch the *other*
   side (not the one held). The first time it prints inside **0.70–0.72**,
   open a **second, fully independent leg** — buy the same share count
   again on the held side, at that side's current price. This leg gets
   its **own** entry price, stop loss (leg entry − 0.15), and TP tier —
   it is **not** blended into the primary leg's average. Fires at most
   once per window. Each leg is then tracked and exited independently
   (one can hit its own TP/SL while the other stays open).
6. A side printing **0.90+** in the last 2 seconds before close is
   logged for visibility but triggers no action — exits only happen via
   TP, SL, or expiry settlement.

Every window is settled against Polymarket's real outcome (via
`fetch_resolution`, with a short retry + price-based fallback — see the
"resolution" section below), which pays $1/share on the winning side
and $0 on the losing side, updating the shared balance.

## Project layout

```
app/
  config.py             strategy + runtime parameters
  models.py              shared dataclasses/enums
  polymarket_client.py   Gamma (market discovery) + CLOB (pricing) + resolution API client
  paper_broker.py         simulated wallet / fills / PnL
  engine_b.py              the strategy (45s entry, tiered exit, SL, doubling)
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
  checks in `engine_b.py` with real order-status polling (market orders
  aren't guaranteed to fill at the exact print you observed).
- Add slippage/fee handling and a kill switch before risking capital.
