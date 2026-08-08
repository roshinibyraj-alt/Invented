'use strict';

/**
 * Candlestick pattern detection — JS port of the same 20 patterns used in
 * the earlier Python research model (doji, hammer, engulfing, morning/
 * evening star, three white soldiers/black crows, etc.), operating on a
 * plain array of candle objects: { open, high, low, close, volume }.
 *
 * detectPatterns(candles) returns an object of { patternName: 0|1 } for
 * the LAST candle in the array (i.e. whether that pattern completes on
 * the most recent bar), using up to 2 prior candles for context.
 */

function shape(c) {
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 1e-9);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return {
    body, range,
    bodyPct: body / range,
    upperPct: upper / range,
    lowerPct: lower / range,
    upper, lower,
    isBull: c.close > c.open ? 1 : 0,
  };
}

function avgBody(candles, endIdx, window) {
  let sum = 0, n = 0;
  for (let i = Math.max(0, endIdx - window); i < endIdx; i++) {
    sum += Math.abs(candles[i].close - candles[i].open);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function detectPatterns(candles, avgWindow = 20) {
  const n = candles.length;
  const zero = () => ({
    pat_doji: 0, pat_hammer: 0, pat_inverted_hammer: 0, pat_hanging_man: 0,
    pat_shooting_star: 0, pat_marubozu_bull: 0, pat_marubozu_bear: 0, pat_spinning_top: 0,
    pat_bullish_engulfing: 0, pat_bearish_engulfing: 0, pat_bullish_harami: 0, pat_bearish_harami: 0,
    pat_piercing_line: 0, pat_dark_cloud_cover: 0, pat_tweezer_top: 0, pat_tweezer_bottom: 0,
    pat_morning_star: 0, pat_evening_star: 0, pat_three_white_soldiers: 0, pat_three_black_crows: 0,
  });
  if (n < 1) return zero();

  const i = n - 1;
  const c = candles[i];
  const s = shape(c);
  const prev = i >= 1 ? candles[i - 1] : null;
  const prev2 = i >= 2 ? candles[i - 2] : null;
  const ps = prev ? shape(prev) : null;
  const avgB = avgBody(candles, i, avgWindow) || s.body;

  const r = zero();

  r.pat_doji = s.bodyPct < 0.1 ? 1 : 0;
  r.pat_hammer = (s.lower >= 2 * s.body && s.upperPct <= 0.15 && s.body > 0 && s.bodyPct < 0.4) ? 1 : 0;
  r.pat_inverted_hammer = (s.upper >= 2 * s.body && s.lowerPct <= 0.15 && s.body > 0 && s.bodyPct < 0.4) ? 1 : 0;
  r.pat_hanging_man = (r.pat_hammer && prev && prev.close > prev.open && c.close < prev.close) ? 1 : 0;
  r.pat_shooting_star = (r.pat_inverted_hammer && prev && prev.close > prev.open) ? 1 : 0;
  r.pat_marubozu_bull = (c.close > c.open && s.upperPct <= 0.03 && s.lowerPct <= 0.03 && s.body >= 0.9 * s.range) ? 1 : 0;
  r.pat_marubozu_bear = (c.open > c.close && s.upperPct <= 0.03 && s.lowerPct <= 0.03 && s.body >= 0.9 * s.range) ? 1 : 0;
  r.pat_spinning_top = (s.bodyPct < 0.3 && s.upperPct > 0.25 && s.lowerPct > 0.25) ? 1 : 0;

  if (prev) {
    r.pat_bullish_engulfing = (prev.close < prev.open && c.close > c.open && c.open <= prev.close && c.close >= prev.open) ? 1 : 0;
    r.pat_bearish_engulfing = (prev.close > prev.open && c.open > c.close && c.open >= prev.close && c.close <= prev.open) ? 1 : 0;
    r.pat_bullish_harami = (prev.close < prev.open && c.close > c.open && c.open >= prev.close && c.close <= prev.open) ? 1 : 0;
    r.pat_bearish_harami = (prev.close > prev.open && c.open > c.close && c.open <= prev.close && c.close >= prev.open) ? 1 : 0;
    r.pat_piercing_line = (prev.close < prev.open && c.close > c.open && c.open < prev.low && c.close > (prev.open + prev.close) / 2 && c.close < prev.open) ? 1 : 0;
    r.pat_dark_cloud_cover = (prev.close > prev.open && c.open > c.close && c.open > prev.high && c.close < (prev.open + prev.close) / 2 && c.close > prev.open) ? 1 : 0;
    r.pat_tweezer_top = (prev.close > prev.open && c.open > c.close && Math.abs(c.high - prev.high) <= 0.05 * s.range) ? 1 : 0;
    r.pat_tweezer_bottom = (prev.close < prev.open && c.close > c.open && Math.abs(c.low - prev.low) <= 0.05 * s.range) ? 1 : 0;
  }

  if (prev && prev2) {
    r.pat_morning_star = (prev2.close < prev2.open && ps.body < 0.3 * avgB && c.close > c.open && c.close > (prev2.open + prev2.close) / 2) ? 1 : 0;
    r.pat_evening_star = (prev2.close > prev2.open && ps.body < 0.3 * avgB && c.open > c.close && c.close < (prev2.open + prev2.close) / 2) ? 1 : 0;
    r.pat_three_white_soldiers = (c.close > c.open && prev.close > prev.open && prev2.close > prev2.open &&
      c.close > prev.close && prev.close > prev2.close && c.open > prev.open && c.open < prev.close) ? 1 : 0;
    r.pat_three_black_crows = (c.open > c.close && prev.open > prev.close && prev2.open > prev2.close &&
      c.close < prev.close && prev.close < prev2.close && c.open < prev.open && c.open > prev.close) ? 1 : 0;
  }

  return r;
}

const BULLISH_PATTERNS = [
  'pat_hammer', 'pat_marubozu_bull', 'pat_bullish_engulfing', 'pat_bullish_harami',
  'pat_piercing_line', 'pat_tweezer_bottom', 'pat_morning_star', 'pat_three_white_soldiers',
];
const BEARISH_PATTERNS = [
  'pat_hanging_man', 'pat_shooting_star', 'pat_marubozu_bear', 'pat_bearish_engulfing',
  'pat_bearish_harami', 'pat_dark_cloud_cover', 'pat_tweezer_top', 'pat_evening_star',
  'pat_three_black_crows',
];

module.exports = { detectPatterns, shape, BULLISH_PATTERNS, BEARISH_PATTERNS };
