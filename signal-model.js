'use strict';

/**
 * FIXED RULE-BASED SIGNAL ENGINE — no training, no learning, no persistence.
 *
 * Every window, this recomputes the exact same calculation from scratch:
 * each of the 20 candlestick patterns and each indicator gets a FIXED point
 * value (assigned below, based on standard technical-analysis convention —
 * not fitted to any historical data). Points are summed into a raw score,
 * then squashed into a 0-100% confidence with a sigmoid. Nothing here ever
 * changes based on results — run it today or in a year, same candles in
 * means same confidence out.
 *
 * HONESTY NOTE: these point values are reasonable, textbook interpretations
 * (e.g. "bullish engulfing = bullish", "RSI > 70 = overbought/mean-reversion
 * bearish tilt"), not weights derived from testing against real outcomes.
 * Whether this fixed ruleset actually predicts anything is still an open
 * question — same caveat as always: candlestick patterns and indicators are
 * widely used but have inconsistent, contested track records as standalone
 * predictors, especially on short crypto timeframes. This file makes every
 * point value visible and adjustable (see WEIGHTS below) so you can see
 * exactly what's driving each decision, and tune it by hand if you want —
 * but nothing tunes itself.
 */

const { detectPatterns, BULLISH_PATTERNS, BEARISH_PATTERNS } = require('./patterns');

// ── Fixed point values — edit these by hand any time; nothing overwrites them ──
const WEIGHTS = {
  // Strong reversal/continuation patterns
  pat_marubozu_bull: 3, pat_marubozu_bear: -3,
  pat_bullish_engulfing: 3, pat_bearish_engulfing: -3,
  pat_three_white_soldiers: 3, pat_three_black_crows: -3,
  pat_morning_star: 3, pat_evening_star: -3,
  // Medium-strength patterns
  pat_bullish_harami: 2, pat_bearish_harami: -2,
  pat_piercing_line: 2, pat_dark_cloud_cover: -2,
  pat_tweezer_bottom: 2, pat_tweezer_top: -2,
  // Weaker / context-dependent single-candle patterns
  pat_hammer: 1.5, pat_shooting_star: -1.5,
  pat_inverted_hammer: 1, pat_hanging_man: -1,
  // Indecision patterns — small, direction depends on prevailing trend
  // (doji/spinning top after an uptrend hints reversal down, and vice versa)
  pat_doji: 0, pat_spinning_top: 0,

  // Indicators
  rsi: 2,            // mean-reversion: RSI<50 tilts bullish, >50 tilts bearish
  stochRsi: 1,        // same idea, secondary confirmation
  macd: 2.5,          // momentum: positive histogram tilts bullish
  bollinger: 2,        // mean-reversion: price near lower band tilts bullish
  trend: 1.5,          // momentum: SMA20 above SMA50 tilts bullish
  distSma20: 1,        // momentum: price above its SMA20 tilts bullish
  volumeConfirm: 1,    // confirmation: high volume amplifies last candle's direction
  streak: 1.5,          // momentum: consecutive same-direction candles tilt continuation
};

// How much the raw point total gets divided before the sigmoid — higher
// SCALE means confidence moves more gently per point; lower means it
// saturates toward 0%/100% faster. Purely a display/sensitivity constant.
const SCALE = Number(process.env.SIGNAL_SCALE || 7);

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}
function stdev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const m = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - m) ** 2, 0) / period;
  return Math.sqrt(variance);
}
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], prevC = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prevC), Math.abs(c.low - prevC));
  }
  return sum / period;
}
function ema(vals, span) {
  const k = 2 / (span + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
function currentStreak(candles) {
  let streak = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    const up = candles[i].close > candles[i].open;
    if (i === candles.length - 1) { streak = up ? 1 : -1; continue; }
    if (up === (streak > 0)) streak += up ? 1 : -1; else break;
  }
  return streak;
}

/**
 * Computes the fixed-rule signal for the window that will follow the last
 * closed candle in `candles`. Returns null if there isn't enough history
 * yet (indicator warm-up), otherwise { score, confidence, breakdown }
 * where breakdown lists every component and its point contribution —
 * fully transparent, nothing hidden, nothing learned.
 */
function computeSignal(candles) {
  const n = candles.length;
  if (n < 55) return null;

  const closes = candles.map(c => c.close);
  const last = candles[n - 1];
  const patterns = detectPatterns(candles);
  const breakdown = [];
  let score = 0;

  function add(name, contribution) {
    if (contribution !== 0) breakdown.push({ name, contribution: Math.round(contribution * 100) / 100 });
    score += contribution;
  }

  // Patterns — fixed point per pattern that fired.
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (key.startsWith('pat_') && patterns[key]) add(key, weight);
  }

  // Doji / spinning top: contextual small nudge against the recent trend (reversal hint).
  const priorTrendUp = candles[n - 2] ? candles[n - 2].close > candles[n - 6 >= 0 ? n - 6 : 0].close : false;
  if (patterns.pat_doji || patterns.pat_spinning_top) {
    add(patterns.pat_doji ? 'pat_doji_context' : 'pat_spinning_top_context', priorTrendUp ? -1 : 1);
  }

  // RSI — mean reversion.
  const rsi = computeRSI(closes, 14);
  add('rsi_14', ((50 - rsi) / 50) * WEIGHTS.rsi);

  // Stochastic RSI-ish (position of RSI within its own recent range) — mean reversion.
  const rsiSeries = [];
  for (let i = Math.max(15, n - 20); i < n; i++) rsiSeries.push(computeRSI(closes.slice(0, i + 1), 14));
  if (rsiSeries.length) {
    const rMin = Math.min(...rsiSeries), rMax = Math.max(...rsiSeries);
    const stoch = rMax > rMin ? (rsi - rMin) / (rMax - rMin) : 0.5;
    add('stoch_rsi', (0.5 - stoch) * WEIGHTS.stochRsi);
  }

  // MACD histogram — momentum.
  if (closes.length >= 26) {
    const fast = ema(closes.slice(-40), 12);
    const slow = ema(closes.slice(-40), 26);
    const macdNorm = (fast - slow) / last.close;
    add('macd_hist', Math.max(-1, Math.min(1, macdNorm * 500)) * WEIGHTS.macd);
  }

  // Bollinger %B — mean reversion.
  const sma20 = sma(closes, 20);
  const std20 = stdev(closes, 20);
  if (sma20 != null && std20) {
    const bbPercentB = (last.close - (sma20 - 2 * std20)) / (4 * std20);
    add('bollinger_pct_b', (0.5 - bbPercentB) * WEIGHTS.bollinger);
  }

  // Trend (SMA20 vs SMA50) — momentum.
  const sma50 = sma(closes, 50);
  if (sma20 != null && sma50 != null) {
    add('trend_sma20_vs_50', (sma20 > sma50 ? 1 : -1) * WEIGHTS.trend);
  }

  // Distance from SMA20 — momentum.
  if (sma20 != null) {
    const dist = (last.close - sma20) / sma20;
    add('dist_sma20', Math.max(-1, Math.min(1, dist * 50)) * WEIGHTS.distSma20);
  }

  // Volume confirmation — amplifies whatever direction the last candle already closed.
  const volumes = candles.map(c => c.volume || 0);
  const volSma = sma(volumes, 20);
  const volStd = stdev(volumes, 20);
  if (volSma != null && volStd) {
    const volZ = (last.volume - volSma) / (volStd || 1);
    const lastDir = last.close > last.open ? 1 : -1;
    add('volume_confirmation', lastDir * Math.max(0, Math.min(3, volZ)) * WEIGHTS.volumeConfirm * 0.5);
  }

  // Streak — momentum (continuation of consecutive same-direction candles).
  const streak = currentStreak(candles);
  add('streak', Math.max(-1, Math.min(1, streak / 5)) * WEIGHTS.streak);

  const confidence = sigmoid(score / SCALE);
  return { score: Math.round(score * 100) / 100, confidence, breakdown: breakdown.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)) };
}

module.exports = { computeSignal, WEIGHTS, SCALE };
