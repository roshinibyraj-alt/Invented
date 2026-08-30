# Polymarket BTC 5m Flip Bot (paper) — Invented repo

Paper/demo trading bot for the Polymarket **BTC Up/Down 5-minute** market. No wallet, no private key — every fill is simulated on the live CLOB order book.

## Strategy (intra-window stop-loss martingale, no carry)
- **Demo capital:** $1,000 (configurable via `START_BANKROLL`).
- **Wait gate:** after a window opens the bot waits **7s** before any order.
- **Entry:** once the wait elapses, whichever side's **ask reaches 0.70** fires immediately (no previous-tick-below requirement). **Slippage ceiling 0.99**: the fill is taken at the actual observed ask, never above 0.99.
- **Sizing / base:** start size = **base = 10% of current capital** in shares (at 0.70). At $1,000 that is 143 shares.
- **Stop loss:** while holding, if the held side's price drops to **0.50**, the bot sells immediately at 0.50.
- **Martingale (capped at 2 per window):** after each stop-loss the bot waits for **any side** to reach **0.65** and fires with **2× the previous position's shares**. Capped at **2 martingale steps per window** — max 3 entries per window: `S → 2S → 4S`. If the 3rd bet also stop-losses, the window simply ends.
- **No carry-over:** every window starts fresh at base (10% of current capital). A losing window does **not** escalate the next window's size.
- **Hold to resolution (win):** if a position never hits the stop-loss it is held until the window resolves; the winning side pays 1.0, the losing side 0.
- **Next window:** base is recalculated as 10% of the updated capital.

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `ENTRY_PRICE` | `0.70` | First entry fires when any side's ask reaches this |
| `SL_PRICE` | `0.50` | Stop-loss level (market sell) |
| `REENTRY_PRICE` | `0.65` | Re-entry fires when any side's ask reaches this |
| `WAIT_SECONDS` | `7` | Wait after window open before trading |
| `MAX_MARTINGALE` | `2` | Max martingale steps per window (base + 2 = 3 entries max) |
| `SLIP_CEILING` | `0.99` | Max accepted fill price (slippage ceiling) |
| `BASE_PCT` | `0.10` | Base = 10% of capital (in shares at entry price) |
| `MARTINGALE_X` | `2` | Each re-entry = previous shares × this |
| `START_BANKROLL` | `1000` | Demo starting capital |
| `CLOB_POLL_MS` | `300` | CLOB polling interval |

## Pricing
Gamma is used only to resolve the slug into the UP/DOWN CLOB token IDs; all prices come from the CLOB order book (`POST /books`). Fires use the actual observed ask (slippage accepted up to 0.99); the stop-loss sells at 0.50. Polymarket taker fees are modelled: `fee = C × TAKER_FEE_RATE × p × (1 − p)` (default TAKER_FEE_RATE=0.07 for Crypto, makers 0), applied on every buy and sell fill and deducted from bankroll/P&L; total fees shown on the dashboard.

## Run
```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # engine+index syntax + internal window simulation
```

## Dashboard
Live BTC 5m UP/DOWN bid/ask/mid, window countdown, wait countdown, base (10%), martingale steps used / max, entry/status, next shares, open positions (entry/mark/unrealized), bankroll/equity/realized PnL, wins/losses, drawdown, trade feed, logs, lifetime equity chart.
