'use strict';

const finite = Number.isFinite;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
function median(xs) {
  const a = xs.slice().sort((x, y) => x - y), i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
function cdf(z) {
  const x = Math.abs(z), t = 1 / (1 + .2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
    * t * (.319381530 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}
function pointAt(points, at, maxAge = 3000) {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].at <= at) return at - points[i].at <= maxAge ? points[i] : null;
  }
  return null;
}

// USD diffusion/decaying momentum/OU ensemble, not a trained or calibrated classifier.
// Forecast the final 60s average, including its already-observed portion.
function probabilityModel({ now, end, beatPrice, binance, chainlink }) {
  const blocked = reason => ({ status: 'WAITING', reason, at: now });
  if (!finite(beatPrice) || beatPrice <= 0) return blocked('Waiting for the official price-to-beat reference.');
  if (!finite(now) || end <= now || end - now > 300000) return blocked('Outside the current five-minute window.');
  const history = (binance || []).filter(p => finite(p.price) && p.price > 0
    && finite(p.at) && p.at <= now && p.at >= now - 600000).sort((a, b) => a.at - b.at);
  const oracle = (chainlink || []).filter(p => finite(p.price) && p.price > 0
    && finite(p.at) && p.at <= now).sort((a, b) => a.at - b.at);
  const latest = oracle.at(-1), spot = latest?.price;
  if (!latest || now - latest.at > 4000) return blocked('Chainlink BTC/USD is missing or stale; no Binance-only substitute.');
  if (history.length < 540 || history.at(-1).at - history[0].at < 570000
    || now - history.at(-1).at > 10000) return blocked('Waiting for ten minutes of fresh one-second BTC history.');
  const changes = [];
  for (let i = 1; i < history.length; i++) {
    const dt = (history[i].at - history[i - 1].at) / 1000;
    if (dt > 0 && dt <= 2) changes.push({ at: history[i].at,
      value: (history[i].price - history[i - 1].price) / Math.sqrt(dt) });
  }
  if (changes.length < 520) return blocked('BTC history has too many missing seconds.');
  const longMean = mean(changes.map(p => p.value));
  const variance = rows => {
    const average = mean(rows.map(p => p.value));
    return mean(rows.map(p => (p.value - average) ** 2));
  };
  const recent = changes.filter(p => p.at >= now - 60000);
  if (recent.length < 45) return blocked('Recent BTC movement coverage is incomplete.');
  const sigma = Math.max(Math.sqrt(variance(changes)), .85 * Math.sqrt(variance(recent)), spot * .000002);
  const latestBinance = history.at(-1);
  const p30 = pointAt(history, latestBinance.at - 30000, 2000);
  if (!p30) return blocked('Missing recent BTC momentum context.');
  const momentum = clamp(.25 * (latestBinance.price - p30.price) / 30 + .1 * longMean,
    -.12 * sigma, .12 * sigma);
  const pairs = oracle.filter(p => p.at >= now - 60000).map(p => {
    const b = pointAt(history, p.at, 2000);
    return b ? p.price - b.price : null;
  }).filter(finite);
  if (pairs.length < 20) return blocked('Waiting for aligned Chainlink/Binance observations.');
  const basis = median(pairs), basisMad = median(pairs.map(x => Math.abs(x - basis)));
  // A wide cross-feed disagreement widens uncertainty rather than creating false edge.
  const basisUncertainty = Math.max(2, spot * .00005, 1.4826 * basisMad,
    Math.abs(spot - latestBinance.price - basis) * .5);
  const center = median(history.map(p => p.price)) + basis;
  const blocks = history.filter((p, i) => i % 5 === 0);
  const xs = [], ys = [];
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].at - blocks[i - 1].at !== 5000) continue;
    xs.push(blocks[i - 1].price - (center - basis));
    ys.push(blocks[i].price - blocks[i - 1].price);
  }
  const xm = mean(xs), ym = mean(ys);
  const xx = xs.reduce((s, x) => s + (x - xm) ** 2, 0);
  const yy = ys.reduce((s, y) => s + (y - ym) ** 2, 0);
  const xy = xs.reduce((s, x, i) => s + (x - xm) * (ys[i] - ym), 0);
  const fit = xx > 0 && yy > 0 ? xy * xy / (xx * yy) : 0;
  // Reversion is an uncertain competing scenario, never an automatic dip-buy instruction.
  const kappa = xx > 0 && xy < 0 ? clamp(-xy / xx / 5 * .35, 0, 1 / 120) : 0;
  const reversionWeight = kappa > 0 ? .15 + .1 * Math.min(1, fit / .1) : .1;
  const seconds = Math.ceil((end - now) / 1000);
  const weights = new Array(seconds + 1).fill(0);
  let known = 0, observedSeconds = 0;
  for (let i = 0; i < 60; i++) {
    const at = end - (59 - i) * 1000;
    if (at <= now) {
      const p = pointAt(oracle, at, 3000);
      if (!p) return blocked('Final-minute TWAP history is incomplete; no invented reference samples.');
      known += p.price / 60; observedSeconds++;
    } else weights[Math.ceil((at - now) / 1000)] += 1 / 60;
  }
  const scenarios = [
    { name: 'Diffusion', weight: .65 - reversionWeight, a: 1, drift: 0 },
    { name: 'Decaying momentum', weight: .35, a: 1, drift: momentum },
    { name: 'Mean reversion', weight: reversionWeight, a: Math.exp(-kappa), drift: 0 },
  ].map(s => {
    let expected = spot, projected = known, carry = 0, variance = 0;
    for (let i = 1; i <= seconds; i++) {
      expected = s.a * expected + (1 - s.a) * center + s.drift * Math.exp(-i / 45);
      projected += weights[i] * expected;
    }
    for (let i = seconds; i >= 1; i--) {
      carry = weights[i] + s.a * carry;
      variance += sigma * sigma * carry * carry;
    }
    const sd = Math.sqrt(variance + basisUncertainty ** 2);
    return { name: s.name, weight: s.weight, expectedTwap: projected, sd,
      up: cdf((projected - beatPrice) / sd) };
  });
  const rawUp = scenarios.reduce((s, x) => s + x.weight * x.up, 0);
  const up = clamp(.5 + .94 * (rawUp - .5), .02, .98);
  const disagreement = Math.max(...scenarios.map(s => s.up)) - Math.min(...scenarios.map(s => s.up));
  const margin = clamp(.055 + .25 * disagreement + Math.min(.03, basisUncertainty / spot * 100), .06, .18);
  return { status: 'READY', reason: 'Time-aware BTC movement ensemble; probabilities are estimates, not a proven trading edge.',
    at: now, beatPrice, spot, distanceUsd: spot - beatPrice, secondsRemaining: (end - now) / 1000,
    up, down: 1 - up, lowerUp: Math.max(0, up - margin), lowerDown: Math.max(0, 1 - up - margin),
    uncertaintyMargin: margin, sigmaPerRootSecond: sigma,
    expectedRemainingMoveUsd: sigma * Math.sqrt(seconds),
    momentumUsdPerSecond: momentum, reversionSpeed: kappa, reversionFit: fit,
    regime: kappa > .0003 && fit > .01 ? 'Reversion evidence; trend scenario retained' : 'No strong reversion evidence',
    historySeconds: (history.at(-1).at - history[0].at) / 1000, samples: changes.length,
    basisUsd: basis, basisUncertaintyUsd: basisUncertainty,
    settlementBasis: 'Official beat price; final 60-second Chainlink spot average forecast as a TWAP proxy, not the official TWAP stream.',
    observedTwapSeconds: observedSeconds, scenarios };
}
module.exports = { probabilityModel, cdf, pointAt };
