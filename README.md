# 9-Engine BTC 5m Bot (paper)

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Nine fully
independent engines share one live CLOB book per 5-minute window. Demo
capital: $4,500 total, split $500 per engine. No real orders, no private
keys — paper mode only.

## Strategies

### Engines 1-5 — resting limit buys on BOTH sides (0.10 / 0.20 / 0.30 / 0.40 / 0.50)
- After the window opens, a buy-limit order is placed on each side at the
  engine's price.
- Whichever side's best ask crosses the limit first is filled at exactly
  the limit price (maker fill: no slippage, no fee); the other side's
  order is cancelled.
- No stop loss. TP at 0.99 redeems at $1.00/share, fee-free. Positions
  still open at window close settle at the inferred winner ($1.00) or
  $0.00.
- **Skip rule:** after any win, the engine skips its next N windows
  (E1:5, E2:4, E3:3, E4:2, E5:1) but keeps monitoring. During a skipped
  window it records which side would have filled first; at window end,
  if that side would have won, the skip counter resets to the full N,
  otherwise it decrements. At zero it trades normally again.

### Engines 6-9 — taker triggers (0.60 / 0.70 / 0.80 / 0.90)
- Whichever side's mid first reaches the trigger is bought immediately as
  a taker, priced against real ask depth (VWAP fill + taker fee).
- No stop loss on any engine. TP at 0.99 redeems at $1.00/share, fee-free.
  Open at close -> settle at inferred winner. No skip logic, no re-entry
  after exit.

## Shared rules
- Flat 100 shares per engine, no martingale, isolated $500 bankroll each.
- Winner is inferred from the last observed CLOB midpoint at window roll
  (higher side wins) — no Gamma price fallback anywhere.
- CLOB-only live pricing: Gamma is used only for one-time window metadata
  (slug -> token ids).

## Deploy (Railway)
- Build: Nixpacks. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- No env vars required in paper mode. `TRADING_MODE=paper` is the default.

## Dashboard
Live BTC UP/DOWN CLOB prices, total equity/realized PnL tiles, nine
engine cards (balance, position, uPnL, skip state, per-engine equity
curve), and a full trade log.
