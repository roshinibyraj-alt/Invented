'use strict';

const { STREAK_LEN } = require('./config');

// Coinbase Exchange public candles (Binance returns 451 from Railway's US servers).
// Row shape: [bucketStartSec, low, high, open, close, volume], newest first.
const URL_BASE = 'https://api.exchange.coinbase.com/products/BTC-USD/candles';
const GRANULARITY = 300;

/** Closed 5m candles, oldest -> newest. The still-forming candle is dropped by time. */
async function fetchClosedCandles(nowMs = Date.now()) {
  const start = new Date(nowMs - 40 * 60 * 1000).toISOString();
  const end = new Date(nowMs).toISOString();
  const res = await fetch(`${URL_BASE}?granularity=${GRANULARITY}&start=${start}&end=${end}`, {
    headers: { 'User-Agent': 'polymarket-candle-bot', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Coinbase candles HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Coinbase candles: unexpected response');
  const nowSec = Math.floor(nowMs / 1000);
  return rows
    .map((r) => ({
      openTs: r[0],
      close: parseFloat(r[4]),
    }))
    .filter((c) => c.openTs + GRANULARITY <= nowSec)
    .sort((a, b) => a.openTs - b.openTs);
}

/**
 * Signal for the window opening at windowOpenTs.
 * Counts consecutive close-to-close price moves ending at the last candle
 * before the window. Three rises signal DOWN; three falls signal UP.
 */
function evaluateSignal(candles, windowOpenTs) {
  const requiredCloses = STREAK_LEN + 1;
  const last = candles.slice(-requiredCloses);
  if (last.length < requiredCloses) {
    return { ready: false, reason: `only ${last.length} closed candles available; need ${requiredCloses} for ${STREAK_LEN} price moves` };
  }
  if (last[last.length - 1].openTs !== windowOpenTs - GRANULARITY) {
    return { ready: false, reason: 'latest closed candle not published yet' };
  }
  for (let i = 1; i < last.length; i++) {
    if (last[i].openTs - last[i - 1].openTs !== GRANULARITY) return { ready: false, reason: 'gap in candle data' };
  }
  if (last.some((c) => !Number.isFinite(c.close))) {
    return { ready: false, reason: 'invalid candle close price' };
  }
  const closePrices = last.map((c) => c.close);
  const priceMoves = [];
  for (let i = 1; i < closePrices.length; i++) {
    if (closePrices[i] > closePrices[i - 1]) priceMoves.push('UP');
    else if (closePrices[i] < closePrices[i - 1]) priceMoves.push('DOWN');
    else priceMoves.push('FLAT');
  }
  let side = null;
  if (priceMoves.every((move) => move === 'UP')) side = 'DOWN';
  else if (priceMoves.every((move) => move === 'DOWN')) side = 'UP';
  return { ready: true, priceMoves, closePrices, side };
}

module.exports = { fetchClosedCandles, evaluateSignal };
