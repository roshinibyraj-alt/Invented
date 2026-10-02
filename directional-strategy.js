'use strict';

function sampleTime(sample) {
  const value = Number(sample && (sample.sampledAt ?? sample.receivedAt ?? sample.ts ?? sample.timestamp));
  return Number.isFinite(value) ? value : null;
}

function samplePrice(sample) {
  const value = Number(sample && sample.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function computeOneSecondMove(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const lookbackMs = Number(options.lookbackMs) || 1000;
  const toleranceMs = Number(options.toleranceMs) || 250;
  const valid = samples
    .map((sample) => ({ sample, at: sampleTime(sample), price: samplePrice(sample) }))
    .filter((item) => item.at != null && item.price != null)
    .sort((a, b) => a.at - b.at);
  if (valid.length < 2) return null;

  const current = valid[valid.length - 1];
  let baseline = null;
  let bestDifference = Infinity;
  for (const candidate of valid.slice(0, -1)) {
    const age = current.at - candidate.at;
    if (age <= 0) continue;
    const difference = Math.abs(age - lookbackMs);
    if (difference < bestDifference) {
      bestDifference = difference;
      baseline = { ...candidate, age };
    }
  }
  if (!baseline || bestDifference > toleranceMs) return null;

  return {
    fromPrice: baseline.price,
    toPrice: current.price,
    changeUsd: current.price - baseline.price,
    lookbackMs: baseline.age,
    receivedAt: Number(current.sample.receivedAt) || current.at,
  };
}

function adaptiveMoveThreshold(history, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const windowMs = Math.max(1, Number(options.windowMs) || 20 * 60 * 1000);
  const percentile = Math.min(100, Math.max(0, Number(options.percentile) || 99));
  const floorUsd = Math.max(0, Number(options.floorUsd) || 0);
  const minSamples = Math.max(1, Math.floor(Number(options.minSamples) || 120));
  const values = (Array.isArray(history) ? history : [])
    .filter((item) => {
      const at = Number(item && item.at);
      const move = Math.abs(Number(item && item.absMoveUsd));
      return Number.isFinite(at) && at <= now && now - at <= windowMs
        && Number.isFinite(move) && move >= 0;
    })
    .map((item) => Math.abs(Number(item.absMoveUsd)))
    .sort((a, b) => a - b);
  const sampleCount = values.length;
  const ready = sampleCount >= minSamples;
  if (!ready) {
    return {
      ready: false, thresholdUsd: null, percentileThresholdUsd: null,
      sampleCount, minSamples, percentile, windowMs, floorUsd,
    };
  }
  const rank = Math.max(1, Math.ceil((percentile / 100) * sampleCount));
  const percentileThresholdUsd = values[Math.min(values.length - 1, rank - 1)];
  return {
    ready: true,
    thresholdUsd: Math.max(floorUsd, percentileThresholdUsd),
    percentileThresholdUsd,
    sampleCount, minSamples, percentile, windowMs, floorUsd,
  };
}

function sideForMove(changeUsd, thresholdUsd) {
  const change = Number(changeUsd);
  const threshold = Number(thresholdUsd);
  if (!Number.isFinite(change) || !Number.isFinite(threshold) || threshold <= 0) return null;
  if (change >= threshold) return 'UP';
  if (change <= -threshold) return 'DOWN';
  return null;
}

module.exports = { computeOneSecondMove, adaptiveMoveThreshold, sideForMove };