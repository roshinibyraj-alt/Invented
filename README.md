# BTC 5m Breakout Limit-Buy Bot — paper trading

A paper-trading bot for Polymarket's `btc-updown-5m-*` markets.

## Strategy

1. **Wait 60 seconds** after each 5-min window opens. No action before that.
2. **Monitor** both sides (UP / DOWN) for a breakout above **0.75**.
3. The first side to tick above 0.75 becomes the **tracked side** for the rest of the window.
4. **Place resting BUY limit orders** at (current price − 0.10), accumulating rungs as price ticks up:
   - Price hits 0.75 → limit buy at **0.65** (100 shares)
   - Price ticks to 0.85 → limit buy at **0.75** (100 shares)
   - Price ticks to 0.95 → limit buy at **0.85** (100 shares)
5. **Stop loss** at **0.50** — fires immediately when a position's exit price hits 0.50 (market sell).
6. **Take profit** at **0.99** — resting limit sell on each filled position.
7. Any position still open at window close settles at **Polymarket's real outcome** ($1/share win, $0/share loss).

All orders are **100 shares** per rung. Each rung is independent — multiple fills can occur in one window.

## Deploy: GitHub → Railway

1. Push to a new GitHub repo
2. Railway → New Project → Deploy from GitHub repo
3. Set `STARTING_CAPITAL` under Variables (default $2,000)
4. Deploy — Railway auto-detects Python via Nixpacks
