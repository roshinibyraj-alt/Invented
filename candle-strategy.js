'use strict';

/** Return UP/DOWN only for an unbroken pullback into the prior candle's range. */
function getPullbackSignal(previous, current) {
  if (!previous || !current) return null;
  const p = { open: Number(previous.open), high: Number(previous.high), low: Number(previous.low), close: Number(previous.close) };
  const c = { high: Number(current.high), low: Number(current.low), close: Number(current.close) };
  if (![p.open, p.high, p.low, p.close, c.high, c.low, c.close].every(Number.isFinite)) return null;

  // Prior green candle: price is below its close, remains above its low, and the live candle has not broken that low.
  if (p.close > p.open && c.close < p.close && c.close > p.low && c.low >= p.low) return 'UP';
  // Prior red candle: mirror the rule; price is above its close and the live candle has not broken its high.
  if (p.close < p.open && c.close > p.close && c.close < p.high && c.high <= p.high) return 'DOWN';
  return null;
}

module.exports = { getPullbackSignal };
