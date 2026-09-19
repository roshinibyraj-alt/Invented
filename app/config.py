"""
Central configuration for ALPHASTRIKE -- BTC 5-min up/down bot.

One strategy, one entry per window, and the bot trades WITH the signal
(buys the side the engine predicts), always as a TAKER -- no resting
limit orders:

  1. At each window open, snapshot the market on four timeframes -- 1D,
     4H, 1H, 15m -- with nine indicators each (RSI, MACD, EMA trend,
     Bollinger, Stochastic, ADX, volume, last candle, price vs the
     forming candle's open) plus time of day.
  2. The multi-timeframe engine (app/mtf_engine.py), pre-backtested on
     the last MTF_BACKTEST_DAYS (7) days, matches that snapshot against
     the situations that were historically right and calls UP or DOWN,
     with the exact situations, hit rates, sample sizes and times of day
     behind the call. Every window gets a call: noise-validated
     situations first, then strong-looking-but-unvalidated ("weak
     pattern") ones, then a naive-Bayes "baseline" over all readings --
     the tier is reported with each call (MTF_ALLOW_FALLBACK=0 = trade
     validated situations only).
  3. ENTRY_DELAY_SECONDS (2s) after the window opens, buy the predicted
     side at market (taker) -- priced by walking real ask depth, taker
     fee paid -- provided that side's best ask is BELOW ENTRY_MAX_PRICE
     (0.60). If the ask is 0.60 or higher it keeps checking every tick
     until the window closes and buys the first tick it is below; if it
     never is, no trade that window.
  4. No stop-loss. Take profit is fixed at TP_PRICE (0.99) -- a real
     taker sell, priced by walking actual book depth, the moment the bid
     reaches it. If TP never hits, the position is force-closed at
     window end (taker, real depth-weighted price).
  5. One entry, one trade max per window. Every resolved window is fed
     back into the engine's history and the situations are re-mined
     periodically, so it keeps tracking the most recent week.

Windows can be skipped for three reasons only: market data unavailable
(Binance REST unreachable / a timeframe missing candles), the engine has
no history yet (pre-backtest failed), or the predicted side's ask stayed
at/above ENTRY_MAX_PRICE all window. (With MTF_ALLOW_FALLBACK=0 a window
with no validated situation is also skipped.)
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
# CLOB only -- no Gamma price fallback anywhere in this app. Gamma is
# used purely for one-time window metadata (slug -> token ids) in
# polymarket_client.py; every live price/book read goes to CLOB.
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Entry sizing / pricing (traded WITH the signal, taker only) -----------
ORDER_SHARES = 200.0
ENTRY_DELAY_SECONDS = float(os.getenv("ENTRY_DELAY_SECONDS", "2.0"))   # buy this long after the window opens
ENTRY_MAX_PRICE = float(os.getenv("ENTRY_MAX_PRICE", "0.60"))         # only buy while the predicted side's best ask is strictly BELOW this (set 1.0 to remove the cap)
TP_PRICE = 0.99

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Market data (Binance public REST, no API key) -------------------------
# Used ONLY for analysis (indicators + window outcomes in the backtest);
# every order is priced/filled against Polymarket's CLOB. If your host is
# geo-blocked from api.binance.com, point this at a mirror
# (e.g. https://api.binance.us/api/v3/klines) -- same response format.
BINANCE_KLINES_URL = os.getenv("BINANCE_KLINES_URL", "https://api.binance.com/api/v3/klines")
BINANCE_SYMBOL = os.getenv("BINANCE_SYMBOL", "BTCUSDT")

# ---- Multi-timeframe prediction engine (app/mtf_engine.py) ------------------
MTF_BACKTEST_DAYS = float(os.getenv("MTF_BACKTEST_DAYS", "7"))    # pre-backtest / rolling history length
MTF_WARMUP_CANDLES = 300            # extra candles per timeframe so slow indicators are converged
# A "situation" (1-3 conditions, e.g. "4H trend UP + 1H RSI<30 + T 08-12h UTC")
# is kept only if it passes ALL of these on the backtest history:
MTF_MIN_SAMPLES = int(os.getenv("MTF_MIN_SAMPLES", "25"))         # at least this many matching windows
MTF_MIN_Z = float(os.getenv("MTF_MIN_Z", "2.6"))                  # floor for the hit-rate z-score vs a coin flip
MTF_PERMUTATIONS = int(os.getenv("MTF_PERMUTATIONS", "30"))       # label-shuffled searches used to calibrate the z cut-off (0 = off)
MTF_ALPHA = 0.05                    # chance a pure-noise search would produce any surviving situation
MTF_PARSIMONY = 0.03                # 2-/3-condition situations must beat each of their parts by this much
MTF_MAX_RULE_SIZE = 3               # max conditions per situation
MTF_MAX_RULES = 300                 # keep only the strongest N situations
MTF_TOP_RULES = 7                   # strongest matching situations that vote on a live call
MTF_SHRINK_PRIOR = 10.0             # pseudo-observations pulling small-sample hit rates toward 50%
MTF_ALLOW_FALLBACK = os.getenv("MTF_ALLOW_FALLBACK", "1").strip().lower() not in ("0", "false", "no", "off")
                                    # False = trade ONLY when a noise-validated situation matches (often: never)
MTF_CANDIDATE_MIN_Z = 2.0           # "weak pattern" tier: same filters, no noise calibration, this z floor
MTF_BASELINE_PRIOR = 20.0           # baseline tier: pseudo-observations shrinking each reading toward the base rate
MTF_BASELINE_MIN_TOKEN_N = 15       # baseline tier: ignore readings seen in fewer windows than this
MTF_REFRESH_EVERY_WINDOWS = 12      # re-mine the situations every N resolved windows (~1h)

# ---- Trading fees -----------------------------------------------------
# Every entry, the TP exit and any forced window-end close are TAKER market
# orders and pay the real fee, priced by walking real order-book depth.
# Verify against GET https://clob.polymarket.com/fee-rate?token_id=...
# before trading real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
