# Multi-asset dip-and-bounce paper bot runbook

1. This service is paper-only. It never submits live CLOB orders.
2. The bot scans BTC, ETH, SOL, and DOGE 5m/15m markets, then listens to active UP/DOWN tokens through the Polymarket market WebSocket.
3. A side arms when its midpoint is below $0.40 and places one 100-share simulated limit at $0.48 when the midpoint later reaches $0.50.
4. A later book update with that side's best bid at or below $0.47 confirms the full paper fill at the fixed $0.48 limit.
5. A best bid at or above $0.99 triggers a modeled $1-per-share take-profit. There is no stop-loss.
6. Unfilled limits are canceled at their window end. Other positions remain pending until Polymarket reports the official market result.
7. The paper ledger is in memory; a restart clears prior history and begins at the configured starting capital.
