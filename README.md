# BTC 5m Contrarian Trader

This bot trades Polymarket BTC 5-minute UP/DOWN markets from the most recently
closed Binance BTCUSDT 5-minute candle:

- green candle → buy DOWN
- red candle → buy UP
- doji or missing candle → skip the window

## Real trading

The default mode is `live`. It uses the supplied Polymarket signer pattern,
derives CLOB credentials at startup, and submits **FOK limit orders**. FOK
orders are takers, while the explicit limit price prevents fills beyond the
slippage ceiling.

Required runtime secret:

```text
POLYMARKET_PRIVATE_KEY
```

Never commit this value. The private key funds the wallet used by the trader;
verify the wallet, collateral balance, and allowance before enabling live mode.

## Dollar sizing

The strategy uses a dollar budget rather than a fixed share count:

- starts at `$1`
- a loss moves the next budget up by `$1`
- a win moves the next budget down by `$1`
- the budget is clamped between `$1` and `$8`

Each entry is a taker FOK order with a `±$0.30` token-price slippage ceiling.
The order size is calculated from the worst accepted price, so the requested
dollar budget is a spending ceiling.

## Exits and settlement

The bot attempts a taker FOK exit when the live bid reaches `0.99`. If the
position remains open at the window boundary, it settles according to the
official Polymarket resolution. New entries remain paused until that result is
published; the bot never infers a real-money winner from a midpoint.

The existing `$500` session target and three-window sleep behavior are retained.
All state is held in memory; restart the service only when no position is at
risk or after confirming the open position state on Polymarket.

## Run

```bash
npm install
pip install -r requirements.txt
TRADING_MODE=live POLYMARKET_PRIVATE_KEY=... uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The dashboard is at `/`, health is at `/healthz`, and JSON state is at
`/api/state`.