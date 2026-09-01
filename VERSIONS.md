# Version History

## v4.0 — 3-Check CheapHunter (current)
- Three independent checks: C1 ≤ 0.35 @ 9s, C2 ≤ 0.25 @ 17s, C3 ≤ 0.20 @ 30s
- Each check fires independently if condition met within its timeout
- Up to 3 trades per window, all on the cheapest/underdog side
- Dollar-based sizing: 5% of capital / fill price = shares
- TP at 0.50 — hold to resolution if TP not hit
- No stop loss, no martingale, no re-entries
- Dashboard shows 3-check status bar and live BTC UP/DOWN prices
- Config: $300 demo, 5% base, taker fees included
