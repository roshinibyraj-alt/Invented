# BTC 5m Candle Contrarian Demo + Live Orders

The **demo strategy** is the original candle-contrarian simulation from the
attached archive. It reads the most recently closed Binance BTCUSDT 5-minute
candle: red buys UP, green buys DOWN, and a doji or missing candle skips the
window. It simulates **500 shares** on the first available ask. Its balance,
position, P&L, wins, losses, and sleep cycle remain simulated.

The demo models a maker take-profit when the bid reaches $0.99, booking
$1/share plus its modeled rebate. Otherwise it settles at the next window
using the higher **last-observed UP/DOWN CLOB midpoint**. Missing quotes are a
wash. It does not use the exchange's official resolution. At $500 of session
profit it sleeps for three windows, then resumes with session P&L reset.

## Separate real orders

`TRADING_MODE=live` starts a separate Polymarket order worker.
Each demo `CANDLE_BUY` event queues **one** real FAK market buy for that
window, denominated in USDC:

- The first real buy is **$1**.
- A demo loss increases the *next* real buy by $1; a demo win decreases it by
  $1. A wash leaves it unchanged. The range is **$1–$8**.
- The real amount is never increased to meet a market minimum. An order
  rejected by the exchange stays rejected; the demo still runs normally.
- FAK fills any immediately available amount up to the requested USDC budget
  and cancels the rest. It can partially fill or fail to fill.
- The FAK market buy accepts available asks up to **$0.99 per share**, even if
  that is much higher than the demo ask. It can still fail if there is no
  matching liquidity. It is a market-order request in **USDC**, not a request
  for 500 real shares. Real sells retain the $0.30 adverse-price limit.

On a demo take-profit, the worker attempts a real FAK sell **only if it knows
the real buy filled and how many shares it received**. Otherwise it logs that
there were no confirmed shares to sell. Positions not sold before expiry are
left for Polymarket resolution; a partially filled sell can also leave shares
for resolution. This app does not redeem or reconcile them.

Real fills, rejections, errors, and eventual exchange outcomes **never change
the demo balance, position, result, or $1–$8 sizing sequence**. Real-order
attempts and results are printed to service logs and shown in the JSON state
as `real_trading`. Each process uses SQLite to reserve a market window
*before* a real buy is submitted. With only `PRIVATE_KEY` configured, the bot
uses a **temporary local guard** and skips any window already open when it
starts. This allows a single instance to trade from the next full window
without another Railway variable. Temporary storage is not durable:
restarts, redeployments, or multiple instances can still produce duplicate
real buys, potentially repeatedly, and the real budget may reach $8.
Run **one instance** in this mode.

For durable duplicate prevention, set `LIVE_ORDER_GUARD_DB` to an **absolute
path on a persistent volume shared by every instance** (for example
`/data/live_orders.sqlite`). Restarting or running another instance with
the same database will then not submit another buy for a reserved window,
even if the first order was rejected or its outcome is unknown. On a prior
reservation the worker checks authenticated exchange trade history for
diagnostics; an empty or unavailable response never permits a retry. If an
explicitly configured guard path fails, real buys are blocked and errors are
logged; the demo continues. Independent per-instance volumes or a shared
filesystem without reliable SQLite file locking cannot prevent duplicates.
Keep the persistent file when redeploying, and check exchange history
manually before migrating an existing live service to the guard. The app
does not reconcile unsold real positions.

The real worker requires a fresh, private `PRIVATE_KEY` runtime
secret, adequate collateral and allowance. **Never commit or paste a signing
key into source code.** If the key has ever been shared, move funds to a new
wallet and replace the deployment secret before live deployment. Without a
valid key, the demo continues but the worker reports a live startup error.

The default is `TRADING_MODE=paper`, which runs the unchanged demo without
sending real orders. In either mode, the dashboard's 500-share trades remain
simulations.

## Run

Install `requirements.txt` and `package.json` dependencies, then start
`uvicorn app.main:app --host 0.0.0.0 --port 8000`. Configure the key in the
runtime secret manager for live mode; do not put it on the command line.
The dashboard is at `/`, health at `/healthz`, and JSON state at `/api/state`.