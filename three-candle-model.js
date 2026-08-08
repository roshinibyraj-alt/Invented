'use strict';

/**
 * 3-CANDLE RULE-BASED PREDICTION MODEL
 *
 * Predicts whether the NEXT candle (the Polymarket window opening right
 * now) will close UP or DOWN using ONLY the last 3 CLOSED candles from
 * the feed. Deterministic and fully transparent — the side is a weighted
 * vote of three simple sub-signals, each normalised to [-1, +1]:
 *
 *   1. majority — how many of the 3 candle bodies are bullish vs bearish
 *   2. momentum — net % move across the 3 candles (scaled so a 5% move
 *                 is a full-strength signal)
 *   3. lastBody — direction and relative size of the most recent body
 *
 *   score      = 0.45*majority + 0.35*momentum + 0.20*lastBody   (-1..1)
 *   side       = 'up' when score >= 0, else 'down'
 *   confidence = 0.5 + 0.5*tanh(2*score)  (0.5 = pure coin flip)
 *
 * The same model drives both the 5m and 15m engines — each engine feeds
 * it the last 3 closed candles of its own timeframe, and it bets the
 * predicted side immediately on the next window.
 */

function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
function round3(n) { return Math.round(n * 1000) / 1000; }

function predictNextDirection(candles) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return {
      side: null,
      score: 0,
      confidence: 0.5,
      sub: null,
      error: 'need at least 3 closed candles',
    };
  }

  const c = candles.slice(-3);
  const eps = 1e-9;

  // 1) Majority direction of the 3 candle bodies (dojis don't vote).
  let bull = 0, bear = 0;
  for (const k of c) {
    if (k.close > k.open) bull++;
    else if (k.close < k.open) bear++;
  }
  const majority = (bull - bear) / c.length; // 1.0, 0.33, -0.33 or -1.0

  // 2) Momentum: net move from the first open to the last close,
  //    scaled so a 5% move counts as a full-strength signal.
  const start = c[0].open || eps;
  const momentum = clamp(((c[2].close - start) / start) * 20, -1, 1);

  // 3) Last candle body strength: direction * body/range of the newest bar.
  const last = c[2];
  const lastBody = (last.close - last.open) / Math.max(last.high - last.low, eps);

  const score = 0.45 * majority + 0.35 * momentum + 0.2 * lastBody;
  const side = score >= 0 ? 'up' : 'down';
  const confidence = round3(clamp(0.5 + 0.5 * Math.tanh(2 * score), 0, 1));

  return {
    side,
    score: round3(score),
    confidence,
    sub: {
      majority: round3(majority),
      momentum: round3(momentum),
      lastBody: round3(lastBody),
    },
    error: null,
  };
}

module.exports = { predictNextDirection };
