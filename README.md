# Trigger Hedge Strategy

Demo-only Polymarket BTC 5-minute UP/DOWN bot.

## Strategy

After an active five-minute window opens, the first UP or DOWN **best ask at or above $0.69** triggers a marketable demo BUY for the current fixed-dollar primary stake. The strategy starts at **$100** and doubles the next primary stake after a primary loss (`$100 → $200 → $400 → …`); a primary win resets it to `$100`.

If a primary from an earlier window is still awaiting settlement, the next primary trigger waits for that result so the correct doubled or reset stake is used.

After the primary entry, the bot buys the opposite side **only if its best ask reaches $0.70**. That stop-loss hedge is 45% of the primary stake (`$45`, `$90`, `$180`, …). The opposite buy does not close the primary position; both positions remain open for settlement. Only the primary position's result changes the stake progression.

Orders are simulated locally from public CLOB books using fixed USDC budgets. A `$100` BUY at `$0.69` targets about **144.93 shares** when enough depth is available; cheaper fills buy more shares, while thin depth can leave part of the budget unfilled. The `$0.69` / `$0.70` prices are triggers, not fill-price ceilings: execution may be above or below the triggering ask, with **100000% configured slippage** (effectively any valid binary-contract ask through `$1`). A one-tick jump from `$0.65` to `$0.75` still triggers the BUY. If the REST book is unavailable or has no usable asks, the simulator uses the cached ask only while it is fresh (no older than 2.5 seconds). Settlement uses actual filled shares: each winning share pays `$1`, and each losing share pays `$0`. At any point while a five-minute window is active, a fresh UP or DOWN best-ask tick at or above `$0.97` declares that side the winner and the opposite side the loser. There is no official-result or close-time leader fallback; if neither ask reaches the threshold, positions remain unresolved and the next primary waits for the prior primary. Demo capital is **$10,000**.

## Safety and limits

The active entry point instantiates only `DemoTrader`, which never signs or submits exchange orders. `LIVE_TRADING=true` exits before wallet authentication. Demo cash, current stake, and trade history are in memory and reset when the process restarts. Estimated taker fees and simulated fills are illustrative only; they are not live execution or profitability evidence.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000` to view the demo dashboard. For the review checklist and settlement behavior, see [`DEMO_RUNBOOK.md`](./DEMO_RUNBOOK.md).