# Trigger Hedge Strategy

Demo-only Polymarket BTC 5-minute UP/DOWN bot.

## Strategy

After an active five-minute window opens, the first UP or DOWN **best ask at or above $0.69** triggers a marketable demo BUY for the current fixed-dollar primary stake. The strategy starts at **$100** and doubles the next primary stake after a primary loss (`$100 → $200 → $400 → …`); a primary win resets it to `$100`.

If a primary from an earlier window is still awaiting settlement, the next primary trigger waits for that result so the correct doubled or reset stake is used.

After the primary entry, the bot buys the opposite side **only if its best ask reaches $0.70**. That stop-loss hedge is 45% of the primary stake (`$45`, `$90`, `$180`, …). The opposite buy does not close the primary position; both positions remain open for settlement. Only the primary position's result changes the stake progression.

Orders are simulated locally from public CLOB books using fixed USDC budgets and a limit at the best ask observed when the trigger fires, so the bot does not chase a later higher quote. Visible depth can produce partial fills, and the average execution price can differ from the trigger. Before window close, CLOB settlement requires a paired confirmation: one side's midpoint at or above `$0.99` and the opposite side's best bid at or below `$0.01`. If those thresholds are still inconclusive at close, the bot provisionally uses the side with the higher CLOB midpoint to settle positions and advance the primary stake ladder. This can misclassify the winner and produce the wrong next stake. If either close-time midpoint is missing or tied, Gamma's official result remains the fallback and the next primary entry waits. Demo capital is **$10,000**.

## Safety and limits

The active entry point instantiates only `DemoTrader`, which never signs or submits exchange orders. `LIVE_TRADING=true` exits before wallet authentication. Demo cash, current stake, and trade history are in memory and reset when the process restarts. Estimated taker fees and simulated fills are illustrative only; they are not live execution or profitability evidence.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000` to view the demo dashboard. For the review checklist and settlement behavior, see [`DEMO_RUNBOOK.md`](./DEMO_RUNBOOK.md).