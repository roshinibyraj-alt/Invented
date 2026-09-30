'use strict';

/** Select the buy side using only the previous completed candle's direction. */
function getPullbackSignal(previous) {
  if (!previous) return null;
  const open = Number(previous.open), close = Number(previous.close);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
  if (close > open) return 'UP';
  if (close < open) return 'DOWN';
  return null; // doji: no signal
}

module.exports = { getPullbackSignal };
