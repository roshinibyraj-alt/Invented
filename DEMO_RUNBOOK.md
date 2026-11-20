# Paper order-flow bot runbook

1. The bot is paper-only and does not submit wallet or live trading orders.
2. It reads Binance BTCUSDT aggregate trades and Polymarket's CLOB books and public trade stream continuously.
3. On each one-second evaluation, it calculates five-second pressure scores. Both sources must agree, each must exceed its minimum, and the combined score must pass threshold for three consecutive checks.
4. Each newly confirmed UP signal sweeps asks for 100 DOWN shares; each newly confirmed DOWN signal sweeps asks for 100 UP shares. There is no entry-price floor or ceiling, but fills require a fresh valid ask book and available paper cash. Market taker fees are modeled and partial fills are allowed.
5. Each newly confirmed signal episode can add another 100 shares on its reversed side. Opposite signals do not cancel or sell existing positions.
6. There are no early sells. Opposite signals only add the reversed-side buy; they never sell current shares. No take-profit or stop-loss orders are created.
7. Filled shares stay open for the full five-minute window, then move out of the current UP/DOWN boxes and wait for the official resolution of their original market. Resolution alone settles the position and returns any payout to demo cash.
8. The dashboard shows feed freshness, component and combined scores, confirmation count, independent current-window positions, pending-resolution positions, market-buy orders, modeled entry fees, the global equity curve, and completed-window win rate. Railway restarts reset the in-memory paper ledger.
