# Invented independent rung paper bot

Paper-only BTC and ETH five-minute UP/DOWN ladders. No real CLOB orders or wallet credentials are used.

Each of the four outcome sides has independent limit buys, initially 100 shares:

| Entry | Initial take-profit | Fixed stop trigger (best bid) |
| --- | --- | --- |
| $0.40 | $0.50 | $0.30 |
| $0.35 | $0.45 | $0.25 |
| $0.30 | $0.40 | $0.20 |

Each asset/side/entry rung progresses independently. An SL increases its next-window TP by $0.10, capped at $0.99, with entry and SL unchanged. A filled final $0.99 attempt that hits SL or expires before full TP doubles that rung's next-window size and resets TP distance to +$0.10. A completed TP resets size to 100 and distance to +$0.10. Unfilled orders do not advance. At nonfinal expiry, progression stays unchanged; later official resolution only settles money and does not change progression. This avoids late settlements overwriting newer rung settings.

SL is a market-style bid sweep, not a guaranteed fixed-price fill: partial exits and gaps apply. Once triggered it keeps trying to sell remaining shares on later fresh ticks; entry remainder cancels immediately. SL taker fees follow the market fee schedule (BTC fallback 0.05, ETH 0.01), with `shares * rate * price * (1-price)`. No SL rebates are estimated. At partial TP then SL, the rung follows SL progression.

Orders are created when the current market is loaded after its window opens. Entry simulation uses visible asks at or below each limit, accounting at the limit price (no favorable price improvement). TP simulation uses visible bids at or above its target, accounting at the target. Only available depth fills; partial fills are possible. Higher buy limits receive depth first. Liquidity is shared across rungs and cannot be reused by repeated unchanged snapshots; only observed replenishment adds capacity.

Once TP begins on a partially filled entry, its unfilled buy remainder is cancelled. After the purchased quantity has all sold at its own TP, that rung is completed and cannot rearm in that window. Each rung trades at most once per side per window; fresh ladders start next window. Cash is reserved for unfilled quantity and unfunded orders wait rather than overspend.

At window end all unfilled buys cancel, while unclosed shares wait for their own exact market's official result. There is no pair exit, cross-pair signal, or blocker from earlier unresolved windows. Official resolution is checked every five seconds and pays $1/$0. Subsequent windows use each rung's saved progression. Repeated failed final attempts double risk without a user-defined cap; orders wait for sufficient actual cash rather than create credit. Numeric overflow blocks that rung instead of creating invalid orders.

## Simulation limitations

Depth-backed touch is not proof of exchange execution or queue priority. Visible liquidity may cancel before a real order arrives, and this paper model is not a live maker/taker matching engine. Buy/TP limit-price accounting assumes passive execution with zero taker fee; SL sweeps include taker fees. Real marketable limits may execute as takers and incur fees.

### Price-dependent maker rebate estimates

The dashboard estimates rebates on filled buy quantities and filled TP sell quantities using `shares × market fee rate × price × (1 − price) × assumed maker rebate rate`. The official schedule checked on 2026-11-25 uses 0.05 for BTC 5m/15m and 0.01 for other crypto, including ETH. Rates can change; see [fees](https://docs.polymarket.com/trading/fees) and [maker rebates](https://docs.polymarket.com/programs/maker-rebates).

The rate selector defaults to **unverified / 0%**. Eligible tier scenarios are 3%, 7%, 10%, and 15%; campaigns can override these. This bot has no verified wallet tier or campaign. Scenarios are estimates, not confirmed income, and are excluded from cash, equity and trading P&L. Unfilled orders, cancellations and resolution payouts generate no rebate. Totals are reconstructed from the full persisted order ledger so partial fills and restarts do not duplicate rewards.

## Dashboard

Phone-first dashboard with account equity/cash/reserves, large live bid/ask/mid prices, rung fill/TP progress, current shares and floating P&L, pending resolution, colored closed-trade outcomes, and strategy details at the bottom. Quotes come from the existing Polymarket CLOB WebSocket; metadata/outcomes from Gamma. Missing/stale feeds do not create fills.

## Persistence

`PAPER_LEDGER_PATH` must point into the Railway mounted persistent volume. On the first strategy migration, the previous ledger is archived alongside the active ledger before a clean strategy ledger is saved; startup fails rather than silently overwrite it if archival fails. Subsequent restarts restore this strategy's cash, positions, orders, reservations, history, and consumed liquidity. Expired orders are not carried into new markets.

## Run

```sh
npm test
npm start
```
