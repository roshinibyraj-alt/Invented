# Polymarket BTC 5-Minute Paper Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Gamma supplies market metadata and token IDs; the public Polymarket CLOB supplies every quote, simulated fill, and paper close classification.

## Strategy

- UP and DOWN are independent: each side has its own paper order, position, and consecutive-loss counter. Both use one shared $1,000 demo cash pool.
- When the current market is available, place one resting paper limit buy on each side at $0.40. Each starts at 10 shares. An order fills only against visible CLOB asks at or below $0.40; unfilled size remains reserved and resting through the window.
- After a side's finalized losing trade, only that side's next order grows by 1.8×: `10 × 1.8^consecutive_losses` shares. A finalized win resets only that side to 10 shares. A pending or unfilled order is not a loss. If the shared cash pool cannot reserve the full order, that side is skipped; the target is not silently reduced.
- When the CLOB best bid reaches $0.99, the paper position sells against visible bids at or above $0.99. Proceeds use the actual simulated CLOB fill price, and estimated fees are deducted. There is no stop loss and no forced sale before expiry.
- At window close, any unfilled limit remainder is cancelled. Remaining shares are paper-settled at $1/$0 using the final three seconds of CLOB best bids: if exactly one side is above $0.98, it wins; otherwise the higher bid wins. If a final-three-second quote is unavailable, the latest in-window CLOB bid is used. A quote tie is broken by the fresher quote, then deterministically by UP if timestamps also tie or both quotes are missing. There is no pending-resolution state, so closed positions cannot hold the bot idle. Martingale results include earlier TP fills.

## Safety and limitations

`DemoTrader` reads public CLOB books and simulates fills locally. It has no wallet, signer, authentication, or live order methods. `LIVE_TRADING=true` is rejected at startup. No private API credentials or order-writing endpoints are used.

The CLOB close rule is an internal paper classification, **not Polymarket's official settlement** and not a claim about the actual token payout. A three-second quote proxy can disagree with the venue's resolution, especially during stale data, a price gap, or a thin book; every trade records the observed bids and fallback source. The $1,000 cash balance, side loss streaks, positions, and trade history are in memory and reset on restart. The dashboard distinguishes cash, resting-order reserves, and available cash. Estimated fees and paper fills are not evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000`. The mobile-friendly dashboard shows UP and DOWN in separate columns, a shared global equity curve, independent order states and loss streaks, fills, P&L, and the CLOB close-price paper outcome.
