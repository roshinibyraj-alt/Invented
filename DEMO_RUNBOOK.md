# Paper order-flow bot runbook

1. The bot is paper-only and does not submit wallet or live trading orders.
2. It reads Binance BTCUSDT aggregate trades and Polymarket's CLOB books and public trade stream continuously.
3. At window open, the bot places 100-share resting limit buys at $0.20 on both UP and DOWN.
4. A fresh best ask at or below $0.20 confirms a full fill at that ask, capped at the $0.20 limit. The other side's resting order is cancelled immediately; remaining unfilled orders expire at window end.
5. After the first fill, if that side's fresh midpoint is $0.10 or lower, the bot submits one 200-share market buy on the opposite side. Partial fills are allowed, the remainder is cancelled, and taker fees are modeled.
6. There are no sells, take-profits, or stop-losses. All filled shares wait for official resolution of their original market.
7. Resting limit entries have no modeled taker fee or maker rebate. Only the 200-share market reversal buy models taker fees.
8. The dashboard shows fresh CLOB quotes, resting-order states, current positions, reversal status, pending-resolution positions, recent orders, paper balance, and completed-window statistics. Railway restarts reset the in-memory paper ledger.
