# Paper order-flow bot runbook

1. The bot is paper-only and does not submit wallet or live trading orders.
2. It reads Binance BTCUSDT aggregate trades and Polymarket's CLOB books and public trade stream continuously.
3. On each one-second evaluation, it calculates five-second pressure scores. Both sources must agree, each must exceed its minimum, and the combined score must pass threshold for three consecutive checks.
4. Every new confirmed signal places a 100-share paper resting limit buy at that side's current midpoint. It remains open until a fresh midpoint reaches at least $0.01 below its limit; then the paper ledger marks all 100 shares filled at the limit price, regardless of displayed depth or queue position.
5. A pending entry is cancelled when another confirmed signal arrives or its five-minute window ends. A replacement signal gets a new midpoint limit on the newly signalled side. Entries model no taker fee; eligible filled entries receive an estimated maker rebate based on the market fee schedule and configured rebate rate. The estimate is not guaranteed.
6. An opposite signal never sells the other side. Each current-window position is closed in the paper ledger when its fresh best bid reaches $0.99 (payout counted as $1/share) or falls to $0.01 or below (payout counted as $0/share).
7. Shares that hit neither threshold by window end move out of the current UP/DOWN boxes and wait for the official resolution of their original market.
8. The dashboard shows feed freshness, component and combined scores, confirmation count, independent current-window positions, pending-resolution positions, resting limit orders, modeled fees and estimated maker rebates, the global equity curve, and completed-window win rate. Railway restarts reset the in-memory paper ledger.
