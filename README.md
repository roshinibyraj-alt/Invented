# Paired Limits

Demo-only Polymarket BTC 5-minute UP/DOWN bot.

## Strategy

At the start of each active five-minute window, the bot posts a **500-share GTC BUY limit at $0.30 for UP and DOWN**. When it detects a fill on one side, it cancels the opposite resting order. If either position remains open at the window close, the bot watches the held-side CLOB threshold and then the official Gamma resolution. It does not use the old BTC momentum trigger, marketable orders, take-profit, or stop-loss rules.

The next pair starts at 500 shares per side. After a settled loss, the next pair grows by 250 shares; after a settled win it resets to 500. Demo capital is **$10,000**. Both orders are simulated locally from public order-book quotes; they are not exchange-native OCO orders. A fast market can fill both sides before cancellation is confirmed, and the dashboard/log records that race rather than hiding it.

## Safety and limits

The active entry point instantiates only `DemoTrader`, which never signs or submits exchange orders. `LIVE_TRADING=true` exits before wallet authentication. Demo cash, current stake, and trade history are in memory and reset when the process restarts. Rebate estimates and simulated fills are illustrative only; they are not live execution or profitability evidence.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000` to view the demo dashboard. For the review checklist and settlement behavior, see [`DEMO_RUNBOOK.md`](./DEMO_RUNBOOK.md).