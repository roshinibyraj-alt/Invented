# Cross-Venue Arbitrage Paper Bot

Invented is now a **demo-only** scanner for open binary markets on Polymarket and Predict.fun. It excludes markets whose title, category, description, or tags identify crypto.

## Strategy

- Shared simulated bankroll: **$10,000**.
- Each paper arbitrage requires **500 shares on each venue**.
- It compares both complementary directions and qualifies only when the visible asks cover both 500-share legs and the estimated **after-fee edge is at least $0.03/share**.
- Market matching is deliberately strict: exact normalized title plus the same two binary outcome labels. Unmatched, multi-outcome, stale/error, or unrecognized Predict orderbooks are skipped rather than guessed.
- Current scanner cycles through 24 matched pairs every 10 seconds and refreshes market discovery every 60 seconds.
- Open paper pairs remain pending until both venue outcomes can be verified. Their cost is removed from available demo cash; no unrealized estimate is reported as realized P&L.

## Data and safety

Polymarket market discovery uses Gamma and its public CLOB ask books. Predict.fun uses its read-only `/v1/markets` and market orderbook endpoints. The Predict API key is read only from the server-side `PREDICT_API_KEY` environment variable; set it in Railway Variables, never in client code. No API key is returned by `/api/state`, dashboard HTML, or logs.

The bot has no wallet, signing, authentication-for-orders, or order-writing path. `LIVE_TRADING=true` is rejected at startup. Orders and balances are simulated only.

The $0.03 threshold is a model, not guaranteed arbitrage. Book depth can disappear; venue market wording, rules, fee schedules, and settlement may differ. Predict taker fees are modeled using the base fee curve; Polymarket fees use the rate advertised in market metadata and default to zero when metadata does not advertise a rate. Exact-title matching may miss valid opportunities and cannot prove identical resolution rules. Open pairs are not settled or credited until verified resolution handling is available.

Demo state is in memory and resets to $10,000 on process restart. Do not interpret paper fills or modeled edges as real execution or expected profit.

## Run and test

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.

Railway retains the existing `node index.js` startup command. Configure `PREDICT_API_KEY` as a server-side Railway variable for Predict.fun reads.
