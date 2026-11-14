# CLOB midpoint maker paper-bot runbook

1. The bot is paper-only and does not submit live orders.
2. UP and DOWN each use their own fresh Polymarket CLOB best bid and ask; Binance is not part of the strategy.
3. Every second, each side posts a 5-share passive buy at midpoint minus $0.02, provided the book is fresh, two-sided, and the paper account has enough unreserved cash.
4. Any unfilled entry remainder is cancelled after two seconds. A book touch or timeout is never treated as a fill.
5. A fill requires a fresh opposing CLOB trade print at or through the limit and estimated queue clearance. Partial fills keep the filled shares and cancel only the remainder at expiry.
6. Each side's held shares get a passive $0.99 take-profit sell, resized after additional buys. A $0.99 fill is credited as $0.99/share; official resolution may instead pay $1.00 for a winning share.
7. All resting orders are cancelled at window end. Unsold shares wait for confirmed resolution of their original market. Estimated maker rebates are not guaranteed exchange credits.
