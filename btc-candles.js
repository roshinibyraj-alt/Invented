'use strict';

const cfg = require('./config');
const { WINDOW_SECONDS } = require('./polymarket-market');
const API = 'https://api.binance.com/api/v3/klines';

/** Fetch the previous closed and optional current live BTC 5-minute candles aligned to a Polymarket window. */
async function fetchWindowCandles(windowOpenTs) {
  const query = 'symbol=' + encodeURIComponent(cfg.BTC_SYMBOL)
    + '&interval=' + encodeURIComponent(cfg.BTC_INTERVAL) + '&limit=3';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(API + '?' + query, { signal: controller.signal });
    if (!response.ok) throw new Error('Binance klines HTTP ' + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Binance klines response was not an array');
    const candles = rows.map((row) => ({
      openTs: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    }));
    if (candles.some((c) => ![c.openTs, c.open, c.high, c.low, c.close].every(Number.isFinite))) {
      throw new Error('Binance returned an invalid BTC candle');
    }
    const previous = candles.find((c) => c.openTs === windowOpenTs - WINDOW_SECONDS);
    const current = candles.find((c) => c.openTs === windowOpenTs);
    if (!previous) return null; // previous completed candle determines the signalled side
    return { previous, current: current || null };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchWindowCandles };
