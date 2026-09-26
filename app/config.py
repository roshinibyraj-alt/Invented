"""
Central configuration for the BTC 5-min up/down bot.

Kronos-driven side selection, win/loss-driven size ladder (500 base, 0
floor, 1000 cap), asymmetric reset behavior at each end:

  - Side selection: at the start of every window, app/kronos_signal.py
    forecasts the next few 1-minute BTC candles with Kronos (an
    open-source K-line foundation model) off a rolling buffer of real
    BTC/USDT candles, and hands back a side only if the forecast move is
    confident enough (KRONOS_MIN_CONFIDENCE). No more alternation --
    if Kronos isn't confident (or the model/candle buffer isn't ready),
    the window is skipped entirely, same as the old price-filter skip.
    ENGINE2_SHARES worth of shares, taker, on window open -- but only if
    the ask is below ENGINE2_MAX_ENTRY_PRICE (0.50) at the moment of
    entry. That's checked every tick, all window: if the ask never dips
    below 0.50 the whole window, no trade happens that window at all --
    the ladder is untouched, and Kronos is asked fresh for the next
    window as normal.

  - Sizing: starts at the base (ENGINE2_SHARES, 500sh). Each WIN (TP
    fill, or settling in the position's favor) steps size down by
    ENGINE2_SIZE_STEP (100sh); each LOSS (settling against the
    position) steps size up by 100sh.

  - Floor (ENGINE2_MIN_SHARES, 0sh): the moment a win drops size to the
    floor, that's a simple reset -- the very next window goes straight
    back to the 500 base (no recovery condition, purely count-based).

  - Cap (ENGINE2_MAX_SHARES, 1000sh): the moment a loss pushes size up
    to the cap, the bot pins there -- every subsequent window keeps
    trading exactly 1000sh (ignoring further win/loss stepping) while
    tracking cumulative realized P&L since the last reset. Only once
    that cumulative P&L recovers back to >=$0 does it reset to the 500
    base (the recovery condition is dollar-based here, unlike the
    floor, which is not).

  - Any reset (from the floor, or from cap recovery) zeroes the
    cumulative-P&L tracker, so the next climb toward the cap is always
    measured fresh from that reset point.

  Exit mechanics (unchanged):
    - A resting take-profit sell at ENGINE_TP_PRICE (0.99) (maker). If
      it fills, realized proceeds are booked as $1.00/share (not the
      literal 0.99 fill price) per explicit instruction -- fee/rebate
      is still computed off the real 0.99 fill price.
    - No stop loss. If the window closes before TP fills, the position
      is NOT force-closed at market -- it settles naturally with the
      binary market's real resolution: $1/share if the position's side
      won that window, $0/share if it lost (no fee on settlement --
      it's a resolution, not a trade).

  Dashboard also tracks running peak equity and maximum drawdown from
  that peak (in $ and %), using live mark-to-market equity (balance +
  open position's current market value) so intra-window swings count.
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

# ---- Take profit (shared exit mechanic) --------------------------------
ENGINE_TP_PRICE = 0.99          # resting maker sell
ENGINE_TP_COUNTS_AS = 1.00      # TP fill is booked at this price for realized P&L, not 0.99

# ---- Kronos-driven side selection --------------------------------------
# Model repos on Hugging Face; override via env if you want a bigger/
# smaller Kronos variant. See app/kronos_signal.py for the full flow.
KRONOS_TOKENIZER_ID = os.getenv("KRONOS_TOKENIZER_ID", "NeoQuasar/Kronos-Tokenizer-base")
KRONOS_MODEL_ID = os.getenv("KRONOS_MODEL_ID", "NeoQuasar/Kronos-small")
KRONOS_DEVICE = os.getenv("KRONOS_DEVICE", "cpu")

KRONOS_CONTEXT_BARS = 400        # rolling 1m BTC/USDT candle buffer fed to the model
KRONOS_MIN_CONTEXT_BARS = 60     # don't call a side until the buffer has at least this many bars
KRONOS_PRED_LEN = 5              # forecast horizon in 1m bars -- matches the 5m window
KRONOS_TEMPERATURE = 1.0
KRONOS_TOP_P = 0.9
KRONOS_SAMPLE_COUNT = 1
KRONOS_REFRESH_SECONDS = 15.0    # cache only within the same 5m window

# Forecast |move| that maps to 100% confidence, and the floor below which
# a window is skipped rather than traded on a weak signal. Both are in
# fractional BTC price terms (0.0015 = 0.15%) -- tune against backtests,
# these starting values are not calibrated to anything.
KRONOS_MOVE_SCALE = 0.0015
KRONOS_MIN_CONFIDENCE = float(os.getenv("KRONOS_MIN_CONFIDENCE", "0.15"))

# In volatile conditions a useful directional forecast can have a smaller
# normalized move than the fixed threshold expects. The threshold moves from
# KRONOS_MIN_CONFIDENCE down toward the floor as recent 1m close volatility
# rises, but never below the floor.
KRONOS_MIN_CONFIDENCE_FLOOR = float(os.getenv("KRONOS_MIN_CONFIDENCE_FLOOR", "0.08"))
KRONOS_VOLATILITY_LOOKBACK = int(os.getenv("KRONOS_VOLATILITY_LOOKBACK", "60"))
KRONOS_VOLATILITY_LOW = float(os.getenv("KRONOS_VOLATILITY_LOW", "0.0005"))
KRONOS_VOLATILITY_HIGH = float(os.getenv("KRONOS_VOLATILITY_HIGH", "0.0025"))

# ---- Entry price filter --------------------------------------------------
# Only enter if the ask is below this at the moment of the check (checked
# every tick, all window -- if it never dips below, that window is
# skipped entirely: no trade, ladder untouched, side alternation still
# advances to the other side next window).
ENGINE2_MAX_ENTRY_PRICE = 0.50

# ---- Engine sizing: win/loss ladder --------------------------------------
ENGINE2_SHARES = 500.0        # base size -- where every reset lands
ENGINE2_SIZE_STEP = 100.0     # shares removed per win / added per loss
ENGINE2_MIN_SHARES = 0.0      # floor -- hitting this resets to base next window
ENGINE2_MAX_SHARES = 1000.0   # cap -- hitting this pins size until cumulative P&L recovers

MAKER_REBATE_FRACTION = 0.20  # rebate earned on every resting-order fill (maker side)

# Demo capital: debited on entry fill, credited on TP/settlement. The
# engine halts permanently if balance ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "10000"))

# ---- Trading fees -----------------------------------------------------
# Entries are taker orders and pay the fee for real; TP is a resting
# maker order (rebate). Window-close settlement is not a trade -- no fee
# either way. Verify against GET https://clob.polymarket.com/fee-rate?token_id=...
# before trading real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
