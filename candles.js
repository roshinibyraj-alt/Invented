'use strict';

/**
 * Factory for a live OHLCV candle feed, sourced from Binance's public
 * klines endpoint (no API key needed). Call createCandleFeed() once per
 * timeframe you want to track independently (e.g. one for 5m, one for 15m)
 * — each instance keeps its own buffer and fetch cursor.
 *
 * We use Binance as the price series driving the prediction models
 * because it's a clean, complete OHLCV history. Polymarket's BTC Up/Down
 * markets resolve against a Chainlink BTC/USD feed, which tracks the same
 * broad price very closely but isn't identical tick-for-tick — worth
 * knowing since the model's "next candle" read and Polymarket's actual
 * settlement can occasionally diverge slightly right at a window's edge.
 */

const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines';

function toCandle(k) {
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  };
}

function createCandleFeed({ interval, symbol = 'BTCUSDT', maxCandles = 500, label = interval }) {
  let candles = [];
  let lastFetchOpenTime = null;

  async function fetchKlines(limit = 500) {
    const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { headers: { 'User-Agent': `btc-${label}-signal-bot/1.0` } });
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status} (${interval})`);
    const raw = await res.json();
    return raw.map(toCandle);
  }

  async function seed(log) {
    const rows = await fetchKlines(maxCandles);
    const nowMs = Date.now();
    candles = rows.filter(c => c.closeTime <= nowMs);
    if (candles.length) lastFetchOpenTime = candles[candles.length - 1].openTime;
    if (log) log(`📈 [${label}] seeded ${candles.length} historical candles from Binance`);
  }

  async function refresh(log) {
    try {
      const rows = await fetchKlines(5);
      const nowMs = Date.now();
      const closed = rows.filter(c => c.closeTime <= nowMs);
      for (const c of closed) {
        if (lastFetchOpenTime == null || c.openTime > lastFetchOpenTime) {
          candles.push(c);
          lastFetchOpenTime = c.openTime;
          if (candles.length > maxCandles) candles.shift();
          if (log) log(`🕯️  [${label}] new candle closed: O ${c.open.toFixed(1)} H ${c.high.toFixed(1)} L ${c.low.toFixed(1)} C ${c.close.toFixed(1)} — ${c.close >= c.open ? 'bullish' : 'bearish'}`);
        }
      }
    } catch (e) {
      if (log) log(`⚠️  [${label}] candle refresh failed: ${e.message}`);
    }
  }

  return {
    seed,
    refresh,
    getCandles: () => candles,
    latestClose: () => (candles.length ? candles[candles.length - 1].close : null),
    count: () => candles.length,
  };
}

module.exports = { createCandleFeed };
