# Paper bot runbook

1. Confirm the dashboard shows one BTC 5-minute demo bot, a $300 demo bankroll, and live UP/DOWN CLOB quotes.
2. At each window start, verify four resting limit buys appear: UP and DOWN at $0.10 for 100 shares each, and UP and DOWN at $0.05 for 100 shares each.
3. A buy fills only when a fresh best ask is at or below its limit. Each filled rung immediately creates its own resting take-profit sell: $0.20 after a $0.10 buy or $0.10 after a $0.05 buy. Fills do not cancel other orders.
4. Unfilled buys remain active until window end, then are cancelled. Open positions without a filled take-profit wait for official resolution of that market.
5. The bot is demo-only and keeps state in process memory; paper history resets on restart. No live orders are placed.
