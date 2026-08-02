'use strict';

/**
 * Factory for a self-contained "P(next candle up)" model that learns
 * ONLINE (one gradient step per resolved window) from real outcomes.
 * Call createSignalModel() once per timeframe (5m, 15m, ...) so each
 * gets its own persisted weights and learning history.
 *
 * HONESTY NOTE (surfaced on the dashboard too): weights start at zero,
 * so early predictions are a coin flip (0.5) by construction. This only
 * has a chance of showing real edge after many dozens/hundreds of
 * resolved windows feed it real outcomes — and there's no guarantee any
 * of this feature set contains exploitable edge at all, especially once
 * spread/fees are accounted for. Treat confidence as a research signal.
 *
 * FEATURES (beyond the 20 candlestick patterns in patterns.js):
 *   - Momentum: recent returns, RSI(14), MACD histogram, Stochastic RSI
 *   - Volatility/mean-reversion: ATR%, Bollinger %B (20, 2sigma)
 *   - Volume: z-score vs 20-bar average
 *   - Trend: distance from SMA20, SMA20-vs-SMA50 cross
 *   - Autocorrelation: current same-direction candle streak length
 *   - Session effects: hour-of-day and day-of-week, cyclically encoded
 *     (sin/cos) since crypto volatility/direction tendencies do vary by
 *     trading session — this is a genuine hypothesis to test, not a
 *     guaranteed signal.
 */

const fs = require('fs');
const { detectPatterns, BULLISH_PATTERNS, BEARISH_PATTERNS } = require('./patterns');

const FEATURE_NAMES = [
  'pat_doji', 'pat_hammer', 'pat_inverted_hammer', 'pat_hanging_man', 'pat_shooting_star',
  'pat_marubozu_bull', 'pat_marubozu_bear', 'pat_spinning_top',
  'pat_bullish_engulfing', 'pat_bearish_engulfing', 'pat_bullish_harami', 'pat_bearish_harami',
  'pat_piercing_line', 'pat_dark_cloud_cover', 'pat_tweezer_top', 'pat_tweezer_bottom',
  'pat_morning_star', 'pat_evening_star', 'pat_three_white_soldiers', 'pat_three_black_crows',
  'ret_1', 'ret_3', 'ret_6', 'rsi_14', 'stoch_rsi', 'atr_pct', 'macd_hist_norm', 'bb_percent_b',
  'vol_zscore', 'dist_sma20_pct', 'trend_up', 'streak', 'bullish_score', 'bearish_score',
  'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos',
];

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

function computeRSISeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
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
function computeMACDHist(closes) {
  if (closes.length < 26) return 0;
  const fast = ema(closes.slice(-40), 12);
  const slow = ema(closes.slice(-40), 26);
  return fast - slow;
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

function buildFeatures(candles) {
  const n = candles.length;
  if (n < 55) return null;

  const closes = candles.map(c => c.close);
  const patterns = detectPatterns(candles);
  const last = candles[n - 1];

  const c1 = candles[n - 2].close, c3 = candles[n - 4] ? candles[n - 4].close : c1, c6 = candles[n - 7] ? candles[n - 7].close : c1;
  const ret1 = (last.close - c1) / c1;
  const ret3 = (last.close - c3) / c3;
  const ret6 = (last.close - c6) / c6;

  const rsiSeries = computeRSISeries(closes, 14);
  const rsi14 = rsiSeries[n - 1] != null ? rsiSeries[n - 1] : 50;
  const rsiWindow = rsiSeries.slice(-14).filter(v => v != null);
  const rsiMin = rsiWindow.length ? Math.min(...rsiWindow) : rsi14;
  const rsiMax = rsiWindow.length ? Math.max(...rsiWindow) : rsi14;
  const stochRsi = rsiMax > rsiMin ? (rsi14 - rsiMin) / (rsiMax - rsiMin) : 0.5;

  const atr = computeATR(candles, 14);
  const atrPct = atr != null ? atr / last.close : 0;
  const macdHist = computeMACDHist(closes);
  const macdHistNorm = macdHist / last.close;

  const sma20 = sma(closes, 20);
  const std20 = stdev(closes, 20);
  const bbPercentB = (sma20 != null && std20) ? (last.close - (sma20 - 2 * std20)) / (4 * std20) : 0.5;

  const volumes = candles.map(c => c.volume || 0);
  const volSma = sma(volumes, 20);
  const volStd = stdev(volumes, 20);
  const volZ = (volSma != null && volStd) ? (last.volume - volSma) / (volStd || 1) : 0;

  const sma50 = sma(closes, 50);
  const distSma20 = sma20 ? (last.close - sma20) / sma20 : 0;
  const trendUp = (sma20 && sma50 && sma20 > sma50) ? 1 : 0;

  const streak = currentStreak(candles);

  let bullScore = 0, bearScore = 0;
  for (let k = 0; k < 3 && n - k >= 1; k++) {
    const p = detectPatterns(candles.slice(0, n - k));
    for (const name of BULLISH_PATTERNS) bullScore += p[name] || 0;
    for (const name of BEARISH_PATTERNS) bearScore += p[name] || 0;
  }

  const dt = new Date(last.closeTime || Date.now());
  const hour = dt.getUTCHours() + dt.getUTCMinutes() / 60;
  const dow = dt.getUTCDay();

  return {
    ...patterns,
    ret_1: ret1, ret_3: ret3, ret_6: ret6,
    rsi_14: (rsi14 - 50) / 50,
    stoch_rsi: stochRsi - 0.5,
    atr_pct: atrPct,
    macd_hist_norm: macdHistNorm,
    bb_percent_b: bbPercentB - 0.5,
    vol_zscore: volZ,
    dist_sma20_pct: distSma20,
    trend_up: trendUp,
    streak: Math.max(-5, Math.min(5, streak)) / 5,
    bullish_score: bullScore,
    bearish_score: bearScore,
    hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    hour_cos: Math.cos((2 * Math.PI * hour) / 24),
    dow_sin: Math.sin((2 * Math.PI * dow) / 7),
    dow_cos: Math.cos((2 * Math.PI * dow) / 7),
  };
}

function createSignalModel({ statePath, learningRate = 0.05, l2Reg = 0.0005 }) {
  function loadModel() {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.weights) return parsed;
    } catch (_) {}
    const weights = {};
    for (const f of FEATURE_NAMES) weights[f] = 0;
    return { weights, bias: 0, updates: 0, wins: 0, losses: 0, createdAt: Date.now() };
  }

  let model = loadModel();

  function saveModel() {
    try { fs.writeFileSync(statePath, JSON.stringify(model)); } catch (_) {}
  }

  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  function predict(features) {
    if (!features) return 0.5;
    let z = model.bias;
    for (const f of FEATURE_NAMES) z += (model.weights[f] || 0) * (features[f] || 0);
    return sigmoid(z);
  }

  function learn(features, actualUp) {
    if (!features) return;
    const pred = predict(features);
    const grad = pred - (actualUp ? 1 : 0);
    for (const f of FEATURE_NAMES) {
      const x = features[f] || 0;
      model.weights[f] -= learningRate * (grad * x + l2Reg * model.weights[f]);
    }
    model.bias -= learningRate * grad;
    model.updates += 1;
    if ((pred >= 0.5) === !!actualUp) model.wins += 1; else model.losses += 1;
    saveModel();
  }

  function modelInfo() {
    return {
      updates: model.updates,
      wins: model.wins,
      losses: model.losses,
      accuracy: model.updates > 0 ? model.wins / model.updates : null,
      topWeights: Object.entries(model.weights)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 6)
        .map(([k, v]) => ({ feature: k, weight: Math.round(v * 1000) / 1000 })),
    };
  }

  return { predict, learn, modelInfo };
}

module.exports = { buildFeatures, createSignalModel, FEATURE_NAMES };
