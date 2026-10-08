# Polymarket BTC 5-Minute Paper Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Gamma supplies market metadata and official final outcomes; Polymarket's public CLOB supplies quotes and order books.

## Strategy

- UP and DOWN are independent: each side has its own paper order, position, and consecutive-loss counter. Both use one shared $1,000 demo cash pool.
- When the current market is available, place one resting paper limit buy on each side at $0.40. Each starts at 10 shares. An order fills only against visible CLOB asks at or below $0.40; unfilled size remains reserved and resting through the window.
- After a side's finalized losing trade, only that side's next order grows by 1.8×: `10 × 1.8^consecutive_losses` shares. A finalized win resets only that side to 10 shares. A pending or unfilled order is not a loss. If the shared cash pool cannot reserve the full order, that side is skipped; the target is not silently reduced.
- When the CLOB best bid reaches $0.99, the paper position sells against visible bids at or above $0.99. Proceeds use the actual simulated CLOB fill price, and estimated fees are deducted. There is no stop loss and no forced sale before expiry.
- At the five-minute close, any unfilled limit remainder is cancelled. Any shares still held wait for Gamma to confirm the official binary $1/$0 outcome, then settle at that payout. Martingale results are calculated from the entire finalized side trade, including any earlier TP fills.

## Safety and limitations

`DemoTrader` reads public CLOB books and simulates fills locally. It has no wallet, signer, authentication, or live order methods. `LIVE_TRADING=true` is rejected at startup. No private API credentials or order-writing endpoints are used.

The $1,000 cash balance, side loss streaks, positions, and trade history are in memory and reset on restart. The dashboard distinguishes actual cash, cash reserved for resting paper orders, and available cash. Gamma settlement is never guessed; positions remain pending until the official binary outcome is final. The estimated fee model is conservative and paper fills are not evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000`. The dashboard and `[bot]` stdout events show both CLOB sides, independent order states and loss streaks, fills, P&L, and positions awaiting official resolution.
