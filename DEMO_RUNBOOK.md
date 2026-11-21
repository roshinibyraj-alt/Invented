# BTC paired paper bot runbook

1. The bot is paper-only; it does not submit live trading orders or use wallet credentials.
2. Binance BTCUSDT and Polymarket CLOB WebSockets provide strategy prices. If required feed data is stale or missing, entries pause.
3. Only the first 5-minute segment of each active 15-minute market is eligible.
4. The beat-price model chooses which market receives UP and which receives DOWN. Enter one paired position only when the selected best asks sum to strictly less than $0.80.
5. Each entry requests 500 shares per leg. Both legs need enough visible ask depth below the $0.99 sweep ceiling and sufficient paper cash; modeled taker fees apply.
6. Each leg takes profit when its best bid reaches $0.99, booked at $1.00 per share. Otherwise, it stays open for that market's official resolution.
7. The dashboard displays paired trade history, current markets and feeds, positions, P&L, and strategy details. The ledger is memory-only; a Railway deployment resets it to the starting paper capital.
