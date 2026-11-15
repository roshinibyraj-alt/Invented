# Paper order-flow bot runbook

1. The bot is paper-only and does not submit wallet or live trading orders.
2. It reads Binance BTCUSDT aggregate trades and Polymarket's CLOB books and public trade stream continuously.
3. On each one-second evaluation, it calculates five-second pressure scores. Both sources must agree, each must exceed its minimum, and the combined score must pass threshold for three consecutive checks.
4. Every new confirmed signal places a 100-share resting maker buy three cents below the signalled side's current best ask. A new confirmed signal cancels any still-unfilled maker buy before placing the new order. Orders also cancel at window end.
5. A fresh best ask touching or crossing the limit counts as a full paper fill at the current ask. Queue position and displayed size are not simulated, so paper fills may be optimistic. Maker entries have no modeled taker fee and receive an estimated rebate when the market's fee schedule supports it.
6. An opposite signal never sells the other side. Each current-window position is closed in the paper ledger when its fresh best bid reaches $0.99 (payout counted as $1/share) or falls to $0.01 or below (payout counted as $0/share).
7. Shares that hit neither threshold by window end move out of the current UP/DOWN boxes and wait for the official resolution of their original market.
8. The dashboard shows feed freshness, component and combined scores, confirmation count, independent current-window positions, pending-resolution positions, orders, the global equity curve, completed-window win rate, and estimated rebates. Railway restarts reset the in-memory paper ledger.
