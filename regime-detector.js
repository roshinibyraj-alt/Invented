'use strict';

const DEFAULTS = {
  lookbackMs: 90_000,
  sampleMs: 10_000,
  minSpanMs: 60_000,
  maxTickAgeMs: 15_000,
  minSamples: 7,
  minRangePct: 0.0003,
  chopEfficiencyMax: 0.22,
  minReversals: 3,
  trendEfficiencyMin: 0.35,
  trendNetMoveMinPct: 0.00035,
};
const MIN_RETURN_FOR_REVERSAL = 0.00005;

function unknown(reason, extra = {}) {
  return { state: 'UNKNOWN', reason, ...extra };
}

function classifyRegime(ticks, now = Date.now(), options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!Array.isArray(ticks)) return unknown('BTC price history is unavailable');
  const valid = ticks
    .filter(t => Number.isFinite(Number(t?.ts)) && Number.isFinite(Number(t?.price)) && Number(t.price) > 0)
    .filter(t => Number(t.ts) <= now && Number(t.ts) >= now - cfg.lookbackMs - cfg.sampleMs)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const last = valid.at(-1);
  if (!last || now - Number(last.ts) > cfg.maxTickAgeMs) {
    return unknown('BTC price feed is stale', { ageMs: last ? now - Number(last.ts) : null });
  }

  const samples = [];
  let cursor = 0;
  for (let target = now - cfg.lookbackMs; target <= now; target += cfg.sampleMs) {
    while (cursor + 1 < valid.length && Number(valid[cursor + 1].ts) <= target) cursor++;
    const tick = valid[cursor];
    if (!tick || Number(tick.ts) > target || target - Number(tick.ts) > cfg.maxTickAgeMs) continue;
    if (!samples.length || samples.at(-1).ts !== Number(tick.ts)) {
      samples.push({ ts: Number(tick.ts), price: Number(tick.price) });
    }
  }

  const spanMs = samples.length > 1 ? samples.at(-1).ts - samples[0].ts : 0;
  if (samples.length < cfg.minSamples || spanMs < cfg.minSpanMs) {
    return unknown('Waiting for at least 60 seconds of fresh BTC price history', {
      sampleCount: samples.length, spanMs, ageMs: now - Number(last.ts),
    });
  }

  const prices = samples.map(x => x.price);
  const mean = prices.reduce((sum, x) => sum + x, 0) / prices.length;
  const signedMove = prices.at(-1) - prices[0];
  const signedNetMovePct = signedMove / mean;
  const netMovePct = Math.abs(signedNetMovePct);
  const rangePct = (Math.max(...prices) - Math.min(...prices)) / mean;
  let grossMove = 0;
  let reversals = 0;
  let previousDirection = 0;

  for (let i = 1; i < prices.length; i++) {
    const move = (prices[i] - prices[i - 1]) / mean;
    grossMove += Math.abs(move);
    const direction = Math.abs(move) >= MIN_RETURN_FOR_REVERSAL ? Math.sign(move) : 0;
    if (direction && previousDirection && direction !== previousDirection) reversals++;
    if (direction) previousDirection = direction;
  }

  const efficiency = grossMove ? netMovePct / grossMove : 0;
  const metrics = {
    efficiency,
    reversals,
    rangePct,
    netMovePct,
    signedNetMovePct,
    direction: signedMove > 0 ? 'UP' : signedMove < 0 ? 'DOWN' : 'FLAT',
    sampleCount: samples.length,
    spanMs,
    ageMs: now - Number(last.ts),
    updatedAt: Number(last.ts),
  };

  if (rangePct < cfg.minRangePct) {
    return { state: 'CHOPPY', reason: 'BTC has moved too little to establish a useful trend', ...metrics };
  }
  if (efficiency <= cfg.chopEfficiencyMax && reversals >= cfg.minReversals) {
    return { state: 'CHOPPY', reason: 'BTC price is reversing repeatedly with little net progress', ...metrics };
  }
  if (efficiency >= cfg.trendEfficiencyMin && netMovePct >= cfg.trendNetMoveMinPct && reversals < cfg.minReversals) {
    return { state: 'TRENDING', reason: 'BTC price shows a sustained directional move', ...metrics };
  }
  return { state: 'MIXED', reason: 'BTC direction is not clear enough for a new entry', ...metrics };
}

module.exports = {
  classifyRegime,
  thresholds: {
    ...DEFAULTS,
  },
};
