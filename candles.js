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
      open: parseFloat(r[3]),
      close: parseFloat(r[4]),
      // flat candle (close === open) counts as GREEN, same as Polymarket's "Up" (end >= start)
      color: parseFloat(r[4]) >= parseFloat(r[3]) ? 'GREEN' : 'RED',
    }))
    .filter((c) => c.openTs + GRANULARITY <= nowSec)
    .sort((a, b) => a.openTs - b.openTs);
}

/**
 * Signal for the window opening at windowOpenTs.
 * Needs the last STREAK_LEN closed candles to be consecutive and to end at the
 * candle that just closed (windowOpenTs - 300); otherwise not ready yet.
 * Returns { ready:false, reason } or { ready:true, colors, side } where side is
 * 'DOWN' after all-green, 'UP' after all-red, null otherwise.
 */
function evaluateSignal(candles, windowOpenTs) {
  const last = candles.slice(-STREAK_LEN);
  if (last.length < STREAK_LEN) return { ready: false, reason: `only ${last.length} closed candles available` };
  if (last[last.length - 1].openTs !== windowOpenTs - GRANULARITY) {
    return { ready: false, reason: 'latest closed candle not published yet' };
  }
  for (let i = 1; i < last.length; i++) {
    if (last[i].openTs - last[i - 1].openTs !== GRANULARITY) return { ready: false, reason: 'gap in candle data' };
  }
  const colors = last.map((c) => c.color);
  let side = null;
  if (colors.every((c) => c === 'GREEN')) side = 'DOWN';
  else if (colors.every((c) => c === 'RED')) side = 'UP';
  return { ready: true, colors, side };
}

module.exports = { fetchClosedCandles, evaluateSignal };
