# Demo runbook

1. Keep `LIVE_TRADING` unset. There is no live order execution or wallet-signing code.
2. Confirm Railway starts with `node index.js`.
3. Check `/api/healthz` and `/api/state`; confirm mode is `DEMO ONLY`, market is the active BTC 15-minute Polymarket window, and Kraken candle refreshes are current.
4. Review the dashboard's adaptive threshold, similar-candle count, RSI, 1-hour bias, hour block, previous close boundary, confirmation state, and entry ask.
5. A signal may chase within the same window only at asks up to $0.65 and only with full visible depth for 300 shares.
6. Positions are held to official Polymarket settlement; unresolved results remain pending and do not create realized P&L.

Railway redeploys or restarts reset the in-memory $10,000 demo balance and paper history.
