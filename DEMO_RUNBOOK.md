# Paper order-flow bot runbook

1. The bot is paper-only and does not submit wallet or live trading orders.
2. It reads Binance BTCUSDT aggregate trades and Polymarket's CLOB books and public trade stream continuously.
3. On each one-second evaluation, it calculates five-second pressure scores. Both sources must agree, each must exceed its minimum, and the combined score must pass threshold for three consecutive checks.
4. Every new confirmed signal requests 100 shares on its indicated side. A still-confirmed signal does not repeat, but a later re-confirmation can add another 100. UP and DOWN accumulate independently without a per-side share cap; available paper cash and visible asks constrain fills.
5. An opposite signal never sells the other side. Each current-window position is closed in the paper ledger when its fresh best bid reaches $0.99 (payout counted as $1/share) or falls to $0.01 or below (payout counted as $0/share). Entry taker fees are modeled; the limit take-profit has no modeled sell fee.
6. Shares that hit neither threshold by window end move out of the current UP/DOWN boxes and wait for the official resolution of their original market.
7. The dashboard shows feed freshness, component and combined scores, confirmation count, independent current-window positions, pending-resolution positions, orders, and paper account totals. Railway restarts reset the in-memory paper ledger.
