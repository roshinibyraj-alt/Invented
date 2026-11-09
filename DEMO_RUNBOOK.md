# Paper strategy runbook

1. Confirm the BTC and ETH 5-minute markets have the same window start.
2. Monitor BTC UP + ETH DOWN and ETH UP + BTC DOWN independently throughout the window.
3. If a pair's fresh best asks sum to less than $0.90, sweep visible asks up to $0.99 per share. Book the entry only if both legs fully fill 200 shares; otherwise book nothing and retry.
4. When a held pair's fresh best bids sum to at least $1.10, simulate selling filled shares against visible bid depth. Track partial fills; do not rearm until every filled leg is fully sold.
5. At window close, any unsold shares wait for the exact original BTC or ETH market's confirmed result. The service is paper-only; a process restart clears its in-memory account and history.
