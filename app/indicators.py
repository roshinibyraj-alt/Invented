"""
Technical indicators, pure Python (no numpy/pandas dependency).

Every function takes plain lists and returns a list of the SAME length
as its input, with None for the warm-up region where the indicator
isn't defined yet. Index i of the output only ever depends on inputs
0..i -- nothing here can look ahead -- which is what makes it safe to
reuse the identical code for the historical backtest and the live
prediction.

Conventions (standard textbook definitions):
  - RSI, ATR, ADX use Wilder smoothing.
  - EMA is seeded with the SMA of its first `period` values.
  - MACD is (12, 26, 9).
  - Bollinger uses a 20-period SMA and 2 population standard deviations.
  - Stochastic is the "slow" version: %K(14) smoothed by a 3-period SMA.
"""
import math
from typing import List, Optional

Series = List[Optional[float]]


def sma(values: List[float], period: int) -> Series:
    out: Series = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    window_sum = sum(values[:period])
    out[period - 1] = window_sum / period
    for i in range(period, len(values)):
        window_sum += values[i] - values[i - period]
        out[i] = window_sum / period
    return out


def ema(values: List[float], period: int) -> Series:
    out: Series = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    alpha = 2.0 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = alpha * values[i] + (1 - alpha) * prev
        out[i] = prev
    return out


def rsi(closes: List[float], period: int = 14) -> Series:
    out: Series = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gains += d
        else:
            losses -= d
    avg_gain, avg_loss = gains / period, losses / period
    out[period] = _rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain, loss = (d, 0.0) if d >= 0 else (0.0, -d)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


def macd(closes: List[float], fast: int = 12, slow: int = 26, signal: int = 9):
    """Returns (macd_line, signal_line, histogram)."""
    n = len(closes)
    fast_ema, slow_ema = ema(closes, fast), ema(closes, slow)
    line: Series = [None] * n
    for i in range(n):
        if fast_ema[i] is not None and slow_ema[i] is not None:
            line[i] = fast_ema[i] - slow_ema[i]
    first = next((i for i, v in enumerate(line) if v is not None), None)
    sig: Series = [None] * n
    hist: Series = [None] * n
    if first is not None:
        sub = ema([v for v in line[first:]], signal)
        for j, v in enumerate(sub):
            sig[first + j] = v
        for i in range(n):
            if line[i] is not None and sig[i] is not None:
                hist[i] = line[i] - sig[i]
    return line, sig, hist


def bollinger_pct_b(closes: List[float], period: int = 20, k: float = 2.0) -> Series:
    """%B: 0 = on the lower band, 1 = on the upper band, <0 / >1 = outside."""
    out: Series = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        w = closes[i - period + 1: i + 1]
        mean = sum(w) / period
        std = math.sqrt(sum((x - mean) ** 2 for x in w) / period)
        lo, hi = mean - k * std, mean + k * std
        out[i] = 0.5 if hi == lo else (closes[i] - lo) / (hi - lo)
    return out


def stochastic_k(highs: List[float], lows: List[float], closes: List[float],
                 period: int = 14, smooth: int = 3) -> Series:
    n = len(closes)
    raw: Series = [None] * n
    for i in range(period - 1, n):
        hh = max(highs[i - period + 1: i + 1])
        ll = min(lows[i - period + 1: i + 1])
        raw[i] = 50.0 if hh == ll else 100.0 * (closes[i] - ll) / (hh - ll)
    first = period - 1
    out: Series = [None] * n
    if n - first >= smooth:
        sub = sma([v for v in raw[first:]], smooth)
        for j, v in enumerate(sub):
            out[first + j] = v
    return out


def _true_ranges(highs, lows, closes) -> List[float]:
    tr = [highs[0] - lows[0]]
    for i in range(1, len(closes)):
        tr.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    return tr


def atr(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> Series:
    n = len(closes)
    out: Series = [None] * n
    if n <= period:
        return out
    tr = _true_ranges(highs, lows, closes)
    prev = sum(tr[1: period + 1]) / period
    out[period] = prev
    for i in range(period + 1, n):
        prev = (prev * (period - 1) + tr[i]) / period
        out[i] = prev
    return out


def adx(highs: List[float], lows: List[float], closes: List[float], period: int = 14):
    """Returns (adx, plus_di, minus_di), Wilder-smoothed."""
    n = len(closes)
    adx_out: Series = [None] * n
    pdi_out: Series = [None] * n
    mdi_out: Series = [None] * n
    if n < 2 * period + 1:
        return adx_out, pdi_out, mdi_out
    tr = _true_ranges(highs, lows, closes)
    plus_dm, minus_dm = [0.0] * n, [0.0] * n
    for i in range(1, n):
        up, down = highs[i] - highs[i - 1], lows[i - 1] - lows[i]
        plus_dm[i] = up if (up > down and up > 0) else 0.0
        minus_dm[i] = down if (down > up and down > 0) else 0.0

    s_tr = sum(tr[1: period + 1])
    s_pdm = sum(plus_dm[1: period + 1])
    s_mdm = sum(minus_dm[1: period + 1])
    dx: List[Optional[float]] = [None] * n

    def _di(i, s_tr_, s_pdm_, s_mdm_):
        if s_tr_ == 0:
            pdi_out[i] = mdi_out[i] = 0.0
            dx[i] = 0.0
            return
        p, m = 100.0 * s_pdm_ / s_tr_, 100.0 * s_mdm_ / s_tr_
        pdi_out[i], mdi_out[i] = p, m
        dx[i] = 0.0 if (p + m) == 0 else 100.0 * abs(p - m) / (p + m)

    _di(period, s_tr, s_pdm, s_mdm)
    for i in range(period + 1, n):
        s_tr = s_tr - s_tr / period + tr[i]
        s_pdm = s_pdm - s_pdm / period + plus_dm[i]
        s_mdm = s_mdm - s_mdm / period + minus_dm[i]
        _di(i, s_tr, s_pdm, s_mdm)

    first_adx_i = 2 * period - 1
    prev = sum(dx[period: 2 * period]) / period
    adx_out[first_adx_i] = prev
    for i in range(first_adx_i + 1, n):
        prev = (prev * (period - 1) + dx[i]) / period
        adx_out[i] = prev
    return adx_out, pdi_out, mdi_out
