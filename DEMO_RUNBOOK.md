# CLOB midpoint maker paper-bot runbook

1. The bot is paper-only and does not submit live orders.
2. UP and DOWN each use their own fresh Polymarket CLOB best bid and ask; Binance is not part of the strategy.
3. Every second, each side posts a 5-share passive buy at midpoint minus $0.05, provided the book is fresh, two-sided, and the paper account has enough unreserved cash.
4. Any unfilled entry remainder is cancelled after five seconds.
5. In paper mode, a fresh best ask at or below the entry limit confirms the full remaining order. This deliberately ignores displayed size and queue position, so it can overstate real fills.
6. Each side's held shares get a passive $0.99 take-profit sell, resized after additional buys. A $0.99 fill is credited as $0.99/share; official resolution may instead pay $1.00 for a winning share.
7. All resting orders are cancelled at window end. Unsold shares wait for confirmed resolution of their original market. Estimated maker rebates are not guaranteed exchange credits.
8. Top UP/DOWN inventory cards show the active window only. Holdings from ended windows appear in separate cards grouped by original window until sold or resolved.
