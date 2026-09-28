# BTC 5m Fixed-Cycle Demo + Live Buys

The bot follows **UP → DOWN → SKIP → UP → DOWN → SKIP** on consecutive
Polymarket five-minute windows, regardless of Binance candle color. The phase
is derived from the five-minute UTC slot modulo three, so restarts and missed
windows do not shift it. A scheduled SKIP places no order, records no result,
and preserves the stake; a loss immediately before SKIP carries into the
following UP window.

The bot waits **3 seconds after the window opens** before entry. It checks
the selected side's CLOB
**ask** on every tick. It buys only when that ask is **strictly below $0.50**
and the current window is still open. At $0.50 or above, or without an ask, it
keeps waiting through the window. Binance candles do not affect the pattern.

If the ask never qualifies, the window counts as a **price-trigger skip**:
no demo or real buy is sent, no position opens, and no trade P&L is booked.
The signaled side's result still counts as a win or loss using the higher
last-observed UP/DOWN midpoint. It moves both next-trade sizing ladders just
like a traded outcome. When there is no observed winner, it remains a skip
without a win/loss or size change. Intentional pattern skips are counted
separately from price-trigger skips.

The demo buys at the first qualifying CLOB ask. Its stake starts at **$100**
including the modeled taker fee; simulated shares are calculated from the
stake and observed ask. Every scored loss doubles the next stake; every
scored win or simulated take-profit resets it to $100. There is **no configured
stake cap**. The demo starts with **$10,000** of simulated capital by default
and halts rather than buying when its next stake exceeds available capital.

The demo models a maker take-profit when the bid reaches $0.99, booking
$1/share plus its modeled rebate. Otherwise it settles at the next window
using the higher **last-observed UP/DOWN CLOB midpoint**. Missing or tied quotes
are a wash. It does not use the exchange's official resolution.

## Separate real orders

`TRADING_MODE=live` starts a separate Polymarket order worker.
Each demo `CANDLE_BUY` event from an UP or DOWN pattern window queues **one** real
FAK market buy for that window, denominated in USDC:

- The real budget starts at **$1**. Every scored demo loss doubles the next
  real buy; every scored demo win resets it to $1. Scheduled SKIP and unknown
  results leave it unchanged. There is **no configured stake maximum**:
  consecutive losses request $1, $2, $4, $8, $16 and so on until insufficient
  collateral or exchange rejection prevents a fill.
- The real amount is never increased to meet a market minimum. An order
  rejected by the exchange stays rejected; the demo still runs normally.
- FAK fills any immediately available amount up to the requested USDC budget
  and cancels the rest. It can partially fill or fail to fill.
- The FAK market buy accepts available asks up to **$0.99 per share**, even if
  that is much higher than the demo ask. The **$0.50 rule is a trigger on the
  observed ask, not a new real-order price cap**; the real quote may change
  before the order is filled. It can still fail if there is no
  matching liquidity. It is a market-order request in **USDC**, not a request
  for a fixed number of real shares.

The live worker **only buys on `CANDLE_BUY` signals**. Demo take-profits,
settlements, and scored price-trigger skips can change the next real buy
budget, but they never submit a real sell. Bought shares remain for
Polymarket resolution; this app does not sell, redeem, or reconcile real
positions.

Real fills, rejections, errors, and eventual exchange outcomes **never change
the demo balance, position, result, or sizing sequence**. Real-order
attempts and results are printed to service logs and shown in the JSON state
as `real_trading`. The dashboard also shows the live exchange's available
USDC collateral balance, refreshed every 30 seconds and after a buy. It
does not include the value of held shares. This dashboard and `/api/state`
are public, so visitors can see that balance. If the balance read fails,
the dashboard shows it as unavailable rather than a demo or stale value.
The public dashboard also has a Pause/Resume control, and any visitor can use
it. Pausing discards queued real buys and prevents future real buys while demo
trading continues; demo outcomes continue to update the real stake ladder. A
real order already submitted may still fill. Pause state is in memory and
resets on service restart, so live buys are enabled again after a restart.
Each process uses SQLite to reserve a market window
*before* a real buy is submitted. With only `PRIVATE_KEY` configured, the bot
uses a **temporary local guard** and skips any window already open when it
starts. This allows a single instance to trade from the next full window
without another Railway variable. Temporary storage is not durable:
restarts, redeployments, or multiple instances can still produce duplicate
real buys, potentially repeatedly. Stakes can grow without a preset ceiling.
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
does not reconcile unsold real positions. If a real buy's outcome is
uncertain, further real buys stop until the process restarts; check exchange
activity before restarting or resuming live mode.

The real worker requires a fresh, private `PRIVATE_KEY` runtime
secret, adequate collateral and allowance. **Never commit or paste a signing
key into source code.** If the key has ever been shared, move funds to a new
wallet and replace the deployment secret before live deployment. Without a
valid key, the demo continues but the worker reports a live startup error.

The default is `TRADING_MODE=live`. Set `TRADING_MODE=paper` to run the
reference demo without sending real orders. Demo shares remain simulations.

## Run

Install `requirements.txt` and `package.json` dependencies, then start
`uvicorn app.main:app --host 0.0.0.0 --port 8000`. Configure the key in the
runtime secret manager for live mode; do not put it on the command line.
The dashboard is at `/`, health at `/healthz`, and JSON state at `/api/state`.