# Paper order-flow bot runbook

1. The bot is paper-only and does not submit wallet or live trading orders.
2. It reads Binance BTCUSDT aggregate trades and Polymarket's CLOB books and public trade stream continuously.
3. On each one-second evaluation, it calculates five-second pressure scores. Both sources must agree, each must exceed its minimum, and the combined score must pass threshold for three consecutive checks.
4. A new confirmed signal sweeps up to 20 shares from visible asks. The same direction cannot add another clip until the signal changes; total unresolved inventory is capped at 100 shares per side across windows.
5. On confirmed opposite pressure, the bot tries to sell the old side and submits the new-side buy independently. Any remaining unsold shares are retried when fresh book depth arrives.
6. Remaining inventory waits for the official result of the exact market it belongs to. Paper taker fees and proceeds are included in the accounting.
7. The dashboard displays feed freshness, component and combined scores, confirmation count, positions, orders, and paper account totals. Railway restarts reset the in-memory paper ledger.
