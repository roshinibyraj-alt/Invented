'use strict';

// ── Config ──────────────────────────────────────────────────
const GAMMA_API     = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST     = process.env.CLOB_REST || 'https://clob.polymarket.com';
const BINANCE_API   = process.env.BINANCE_API || 'https://api.binance.com';
const CLOB_POLL_MS  = Number(process.env.CLOB_POLL_MS || 1500);
const CLOB_FRESH_MS = Number(process.env.CLOB_FRESH_MS || 5000);
const TICK_POLL_MS  = Number(process.env.TICK_POLL_MS || 2000);
const WINDOW_SECONDS = 300;
const ASSETS        = ['btc'];
const START_BANKROLL = Number(process.env.START_BANKROLL || 20000);
const EQUITY_FILE   = process.env.EQUITY_FILE || './equity.json';

// Strategy params
const HIGH_CONF         = Number(process.env.HIGH_CONF || 0.70);
const LOW_CONF          = Number(process.env.LOW_CONF || 0.30);
const ENTRY_ELAPSED      = Number(process.env.ENTRY_ELAPSED || 80);
const FLAT_SHARES       = Number(process.env.FLAT_SHARES || 1000);
const REVERSAL_PCT      = Number(process.env.REVERSAL_PCT || 0.05);
const REVERSAL_CONSIST  = Number(process.env.REVERSAL_CONSIST || 0.60);
const MIN_BET           = Number(process.env.MIN_BET || 1);

// Polymarket fee
const TAKER_FEE_RATE  = Number(process.env.TAKER_FEE_RATE || 0.07);

const fs = require('fs');

// ── Helpers ─────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(a, s) { return `${a}-updown-5m-${s}`; }
function takerFee(shares, price) { return round5(shares * TAKER_FEE_RATE * price * (1 - price)); }
function ema(data, period) {
  const k = 2 / (period + 1);
  let e = data[0];
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}
function sampleCurve(c, max = 1500) {
  if (!Array.isArray(c) || c.length <= max) return c || [];
  const step = (c.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(c[Math.round(i * step)]);
  out[max - 1] = c[c.length - 1];
  return out;
}
function loadEquityFile(f) {
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(d) ? d : []; } catch (_) { return []; }
}

// ── Engine ──────────────────────────────────────────────────
class BotEngine {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || fetch;
    this.startedAt = Date.now();
    this.capital = { value: START_BANKROLL };
    Object.defineProperty(this, 'bankroll', { get: () => this.capital.value, set: v => { this.capital.value = v; } });

    // Market data
    this.markets = new Map();
    this.tokens = new Map();
    this.history = new Map();
    this.discoveredWindows = new Set();
    this.activeWindowStart = null;
    this.discoveryRunning = false;
    this.pollRunning = false;
    this.loopRunning = false;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;

    // Binance data
    this.binanceCandles = [];
    this.tickHistory = [];
    this.tickFetching = false;
    this.tickFetchedAt = 0;
    this.candleFetching = false;
    this.candleFetchedAt = 0;

    // Signal
    this.signal = { score: 0, confidence: 0, lean: 'NEUTRAL', updatedAt: null, indicators: {} };

    // Position (one at a time, max)
    this.positions = [];
    this.resolvedPositions = [];

    // Tracking
    this.trades = [];
    this.wins = 0;
    this.losses = 0;
    this.realizedPnl = 0;
    this.peakEquity = START_BANKROLL;
    this.maxDrawdown = 0;
    this.logs = [];
    this.pollCount = 0;

    // Equity
    const seeded = (opts.initialEquity && Array.isArray(opts.initialEquity) && opts.initialEquity.length) ? opts.initialEquity.slice() : null;
    this.equityCurve = seeded || [{ t: Date.now(), equity: START_BANKROLL }];
    this.lastEquitySaveAt = 0;
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
  }

  async getJSON(url, timeout = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await this.fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'bot/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async postJSON(url, body, timeout = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await this.fetchImpl(url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'bot/1.0' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  // ── Market Discovery ──────────────────────────────────────
  async discoverMarket(asset, start) {
    const slug = slugFor(asset, start);
    if (this.discoveredWindows.has(slug)) return this.markets.get(slug) || null;
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
      const market = Array.isArray(rows) ? rows[0] : null;
      if (!market || !market.conditionId || !market.clobTokenIds || market.closed) return null;
      this.discoveredWindows.add(slug);
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes || [];
      const tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds || [];
      const ui = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
      const di = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
      if (ui < 0 || di < 0 || !tokenIds[ui] || !tokenIds[di]) return null;
      const rec = {
        slug, asset, conditionId: market.conditionId, title: market.question || slug,
        windowStart: start, windowEnd: start + WINDOW_SECONDS,
        resolved: false, winner: null, tradingClosed: false,
        up: { tokenId: tokenIds[ui], slug, asset, outcome: 'UP', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [] },
        down: { tokenId: tokenIds[di], slug, asset, outcome: 'DOWN', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [] },
      };
      this.markets.set(slug, rec);
      this.tokens.set(rec.up.tokenId, rec.up);
      this.tokens.set(rec.down.tokenId, rec.down);
      this.log(`🎯 ${asset.toUpperCase()} 5m discovered ${slug}`);
      return rec;
    } catch (e) { this.log(`⚠️ Discovery: ${e.message}`); return null; }
  }

  async retryDiscovery() {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      const starts = [windowStartFor(Date.now()), windowStartFor(Date.now()) + WINDOW_SECONDS];
      for (const s of starts) for (const a of ASSETS)
        if (!this.markets.has(slugFor(a, s))) await this.discoverMarket(a, s);
    } finally { this.discoveryRunning = false; }
  }

  // ── CLOB Book Polling ─────────────────────────────────────
  applyBook(token, bids, asks) {
    const validAsks = asks.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    const bestBid = (bids.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price) })).sort((a,b) => b.price - a.price)[0]?.price) ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    const cleanBid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    const cleanAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid; token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
    this.pushHistory(token.tokenId, token.mid);
  }

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now(), s = this.history.get(tokenId) || [];
    s.push({ t: now, p: price });
    while (s.length > 2 && now - s[0].t > 5000) s.shift();
    this.history.set(tokenId, s.slice(-240));
  }

  simulateGtcBookFill(token, shares, ceiling) {
    const asks = token.bookAsks || [];
    let rem = shares, total = 0;
    for (const lv of asks) { if (lv.price > ceiling) break; if (rem <= 0) break; const f = Math.min(lv.size, rem); total += round2(f * lv.price); rem -= f; }
    const filled = shares - rem;
    return filled > 0 ? { avgPrice: round5(total / filled), filled, totalCost: round2(total) } : null;
  }

  async pollClobBooks() {
    if (this.pollRunning) return;
    const now = Date.now(), cs = windowStartFor(now);
    const tokens = [...this.tokens.values()].filter(t => { const m = this.markets.get(t.slug); return m?.windowStart === cs && !m.tradingClosed && !m.resolved; });
    if (!tokens.length) return;
    this.pollRunning = true;
    try {
      const books = await this.postJSON(`${CLOB_REST}/books`, tokens.map(t => ({ token_id: t.tokenId })));
      const byToken = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id || ''), b]).filter(([id]) => this.tokens.has(id)));
      for (const t of tokens) { const b = byToken.get(t.tokenId); if (b) this.applyBook(t, b.bids || [], b.asks || []); }
      this.pollCount++;
      this.lastSuccessfulPollAt = Date.now();
    } catch (e) {
      if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt >= 5000) { this.log(`⚠️ CLOB poll: ${e.message}`); this.lastPollErrorAt = Date.now(); }
    } finally { this.pollRunning = false; }
  }

  // ── Binance Data ──────────────────────────────────────────
  async fetchBinanceCandles(limit = 25) {
    if (this.candleFetching) return;
    const now = Date.now();
    if (now - this.candleFetchedAt < 8000) return;
    this.candleFetching = true;
    try {
      const data = await this.getJSON(`${BINANCE_API}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`);
      if (Array.isArray(data) && data.length > 0) {
        this.binanceCandles = data.map(c => ({
          openTime: Number(c[0]) / 1000,
          open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]),
          volume: Number(c[5]),
        }));
        this.candleFetchedAt = now;
      }
    } catch (_) {} finally { this.candleFetching = false; }
  }

  async fetchBinanceTick() {
    if (this.tickFetching) return;
    const now = Date.now();
    if (now - this.tickFetchedAt < TICK_POLL_MS - 200) return;
    this.tickFetching = true;
    try {
      const data = await this.getJSON(`${BINANCE_API}/api/v3/ticker/price?symbol=BTCUSDT`, 4000);
      const price = Number(data?.price);
      if (Number.isFinite(price)) {
        this.tickHistory.push({ t: now, p: price });
        if (this.tickHistory.length > 120) this.tickHistory.shift();
        this.tickFetchedAt = now;
      }
    } catch (_) {} finally { this.tickFetching = false; }
  }

  // ── Signal: 7-Indicator Composite ─────────────────────────
  // Score > 0 → UP, score < 0 → DOWN
  // Confidence = |score| / 7.0, capped at 1.0
  computeSignal() {
    const candles = this.binanceCandles;
    const cs = windowStartFor(Date.now());
    if (!candles || candles.length < 5) { this.signal = { score: 0, confidence: 0, lean: 'NEUTRAL', updatedAt: Date.now(), indicators: {} }; return; }
    const indicators = {};

    // 1. Window Delta (weight 5-7)
    const ind1 = this._windowDelta(candles, cs);
    indicators.windowDelta = ind1;

    // 2. Micro Momentum (weight 2)
    const ind2 = this._microMomentum(candles);
    indicators.microMomentum = ind2;

    // 3. Acceleration (weight 1.5)
    const ind3 = this._acceleration(candles);
    indicators.acceleration = ind3;

    // 4. EMA 9/21 (weight 1)
    const ind4 = this._ema921(candles);
    indicators.ema921 = ind4;

    // 5. RSI 14 (weight 1-2)
    const ind5 = this._rsi14(candles);
    indicators.rsi14 = ind5;

    // 6. Volume Surge (weight 1)
    const ind6 = this._volumeSurge(candles);
    indicators.volumeSurge = ind6;

    // 7. Tick Trend (weight 2)
    const ind7 = this._tickTrend();
    indicators.tickTrend = ind7;

    const score = ind1.score + ind2.score + ind3.score + ind4.score + ind5.score + ind6.score + ind7.score;
    const confidence = Math.min(Math.abs(score) / 7.0, 1.0);
    const lean = score > 0 ? 'UP' : score < 0 ? 'DOWN' : 'NEUTRAL';
    this.signal = { score: round5(score), confidence: round5(confidence), lean, updatedAt: Date.now(), indicators };
  }

  _windowDelta(candles, windowStart) {
    let openPrice = null;
    for (const c of candles) { if (c.openTime <= windowStart && c.openTime + 60 > windowStart) { openPrice = c.open; break; } }
    if (openPrice == null) openPrice = candles[0]?.open;
    const current = candles[candles.length - 1]?.close;
    if (!Number.isFinite(openPrice) || !Number.isFinite(current) || openPrice <= 0) return { deltaPct: 0, score: 0 };
    const deltaPct = round5((current - openPrice) / openPrice * 100);
    let score = 0;
    const abs = Math.abs(deltaPct);
    const dir = deltaPct >= 0 ? 1 : -1;
    if (abs > 0.10) score = dir * 7;
    else if (abs > 0.02) score = dir * 5;
    else if (abs > 0.005) score = dir * 3;
    else if (abs > 0.001) score = dir * 1;
    return { deltaPct, score };
  }

  _microMomentum(candles) {
    if (candles.length < 3) return { score: 0 };
    const last = candles[candles.length - 1], prev = candles[candles.length - 2];
    let count = 0;
    if (last.close > last.open) count++;
    else if (last.close < last.open) count--;
    if (prev.close > prev.open) count++;
    else if (prev.close < prev.open) count--;
    return { score: count === 2 ? 2 : count === -2 ? -2 : 0 };
  }

  _acceleration(candles) {
    if (candles.length < 4) return { score: 0 };
    const latest = candles[candles.length - 1], ago2 = candles[candles.length - 3];
    const lm = latest.close - latest.open, am = ago2.close - ago2.open;
    if (lm > 0 && am > 0) return { score: lm > am ? 1.5 : -0.5 };
    if (lm < 0 && am < 0) return { score: lm < am ? -1.5 : 0.5 };
    if (lm > 0) return { score: 0.75 };
    if (lm < 0) return { score: -0.75 };
    return { score: 0 };
  }

  _ema921(candles) {
    if (candles.length < 21) return { score: 0 };
    const closes = candles.map(c => c.close);
    const e9 = ema(closes, 9), e21 = ema(closes, 21);
    return { ema9: round2(e9), ema21: round2(e21), score: e9 > e21 ? 1 : -1 };
  }

  _rsi14(candles) {
    if (candles.length < 15) return { score: 0 };
    const closes = candles.slice(-15).map(c => c.close);
    let gains = 0, losses = 0;
    for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses -= d; }
    if (losses === 0) return { rsi: 100, score: -2 };
    const rsi = round2(100 - 100 / (1 + gains / losses));
    return { rsi, score: rsi > 75 ? -2 : rsi < 25 ? 2 : 0 };
  }

  _volumeSurge(candles) {
    if (candles.length < 6) return { score: 0 };
    const r3 = candles.slice(-3), p3 = candles.slice(-6, -3);
    const ra = r3.reduce((s, c) => s + c.volume, 0) / 3;
    const pa = p3.reduce((s, c) => s + c.volume, 0) / 3;
    if (pa === 0 || ra / pa < 1.5) return { score: 0 };
    const dir = r3[2].close > r3[0].open ? 1 : -1;
    return { surge: round2(ra / pa), score: dir };
  }

  _tickTrend() {
    const ticks = this.tickHistory.slice(-30);
    if (ticks.length < 6) return { score: 0, consistency: 0, direction: 'NONE' };
    let ups = 0, downs = 0;
    for (let i = 1; i < ticks.length; i++) { if (ticks[i].p > ticks[i - 1].p) ups++; else if (ticks[i].p < ticks[i - 1].p) downs++; }
    const total = ups + downs;
    if (total === 0) return { score: 0, consistency: 0, direction: 'NONE' };
    const consistency = round2(Math.max(ups, downs) / total);
    const move = (ticks[ticks.length - 1].p - ticks[0].p) / ticks[0].p * 100;
    if (consistency < REVERSAL_CONSIST || Math.abs(move) < 0.005) return { score: 0, consistency, direction: 'NONE' };
    const dir = ups > downs ? 'UP' : 'DOWN';
    return { score: dir === 'UP' ? 2 : -2, consistency, direction: dir, move: round5(move) };
  }

  // ── Tick Reversal Detection ───────────────────────────────
  // After entry: if ticks reverse >60% consistency AND move > 0.05%, return true
  isTickReversal(entrySide) {
    const ticks = this.tickHistory.slice(-15); // last 30 seconds
    if (ticks.length < 6) return false;
    let against = 0;
    for (let i = 1; i < ticks.length; i++) {
      if (entrySide === 'UP' && ticks[i].p < ticks[i - 1].p) against++;
      else if (entrySide === 'DOWN' && ticks[i].p > ticks[i - 1].p) against++;
    }
    const consistency = against / (ticks.length - 1);
    const move = Math.abs(ticks[ticks.length - 1].p - ticks[0].p) / ticks[0].p * 100;
    return consistency >= REVERSAL_CONSIST && move >= REVERSAL_PCT;
  }

  // ── Strategy: Model-Driven Entry / Exit ───────────────────
  evaluateEntry() {
    const now = Date.now();
    const cs = windowStartFor(now);
    const elapsed = Math.floor(now / 1000) - cs;
    const remaining = WINDOW_SECONDS - elapsed;
    if (remaining <= 0) return;
    if (elapsed < ENTRY_ELAPSED) return;

    const conf = this.signal.confidence;
    const lean = this.signal.lean;
    if (lean !== 'UP' && lean !== 'DOWN') return;

    const market = [...this.markets.values()].find(m => m.windowStart === cs && !m.resolved && !m.tradingClosed);
    if (!market) return;

    const upProb = lean === 'UP' ? conf : (1 - conf);
    if (upProb >= HIGH_CONF) {
      // Strong UP signal → buy UP, close any DOWN
      const dnPos = this.positions.find(p => p.windowStart === cs && p.outcome === 'DOWN' && p.status === 'open');
      if (dnPos) this.sellPosition(dnPos, 'FLIP_TO_UP');
      const upPos = this.positions.find(p => p.windowStart === cs && p.outcome === 'UP' && p.status === 'open');
      if (!upPos) this.tryBuy(market, 'UP', cs, market.windowEnd, upProb);
    } else if (upProb <= LOW_CONF) {
      // Strong DOWN signal → buy DOWN, close any UP
      const upPos = this.positions.find(p => p.windowStart === cs && p.outcome === 'UP' && p.status === 'open');
      if (upPos) this.sellPosition(upPos, 'FLIP_TO_DN');
      const dnPos = this.positions.find(p => p.windowStart === cs && p.outcome === 'DOWN' && p.status === 'open');
      if (!dnPos) this.tryBuy(market, 'DOWN', cs, market.windowEnd, upProb);
    }
  }

  tryBuy(market, outcome, windowStart, windowEnd, upProb) {
    const token = outcome === 'UP' ? market.up : market.down;
    const price = token.ask ?? token.mid ?? token.bid;
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return;
    this.executeBuy(market, outcome, price, FLAT_SHARES, windowStart, windowEnd, upProb);
  }

  executeBuy(market, outcome, price, shares, windowStart, windowEnd, conf) {
    const cost = round2(shares * price);
    const fee = takerFee(shares, price);
    const totalCost = round2(cost + fee);
    if (totalCost > this.bankroll) { this.log(`⚠️ SKIP ${outcome} ${shares}sh — need $${totalCost.toFixed(2)}, have $${this.bankroll.toFixed(2)}`); return; }
    this.bankroll = round2(this.bankroll - totalCost);
    const token = outcome === 'UP' ? market.up : market.down;
    const pos = {
      slug: market.slug, asset: market.asset, conditionId: market.conditionId,
      outcome, tokenId: token.tokenId,
      shares, entryPrice: price, cost, fee, totalCost,
      status: 'open', openedAt: Date.now(), markPrice: token.mid,
      windowStart, windowEnd,
      signalConf: conf, signalScore: this.signal.score,
      signalIndicators: { ...this.signal.indicators }, betLabel: outcome,
      exitReason: null, exitPrice: null, closedAt: null, pnl: null,
    };
    this.positions.push(pos);
    this.trades.push({ timestamp: Date.now(), type: 'BUY', outcome, shares, price, cost, fee, confidence: conf, score: this.signal.score, markPrice: token.mid, betLabel: outcome });
    this.log(`⚡ BUY ${outcome} ${shares}sh @${price.toFixed(3)} · conf ${(conf * 100).toFixed(0)}% · cost $${cost.toFixed(2)}`);
    this.recordEquity();
  }


  evaluateExit() {
    // Exits are controlled by the confidence flipper (evaluateEntry).
    // This only refreshes mark prices for open positions.
    for (const p of this.positions) {
      if (p.status !== 'open') continue;
      const market = this.markets.get(p.slug);
      if (market) { const token = p.outcome === 'UP' ? market.up : market.down; if (Number.isFinite(token?.mid)) p.markPrice = token.mid; }
    }
  }


  sellPosition(p, reason) {
    if (!p || p.status !== 'open') return;
    const exitPrice = p.markPrice ?? p.entryPrice;
    const proceeds = round2(p.shares * exitPrice);
    const exitFee = takerFee(p.shares, exitPrice);
    const netProceeds = round2(proceeds - exitFee);
    const pnl = round2(netProceeds - p.cost - p.fee);
    p.status = 'closed'; p.exitReason = reason; p.exitPrice = exitPrice; p.exitFee = exitFee;
    p.closedAt = Date.now(); p.pnl = pnl; p.won = pnl >= 0;
    this.bankroll = round2(this.bankroll + netProceeds);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    if (pnl >= 0) this.wins++; else this.losses++;
    this.log(`💰 EXIT ${reason} ${p.betLabel||''} ${p.outcome} ${p.shares}sh @${exitPrice.toFixed(3)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    this.resolvedPositions.unshift({ ...p });
    this.resolvedPositions = this.resolvedPositions.slice(0, 50);
    this.trades.push({ timestamp: p.closedAt, type: 'SELL', outcome: p.outcome, shares: p.shares, price: exitPrice, cost: p.cost, fee: exitFee, pnl });
    this.positions = this.positions.filter(x => x !== p);
    this.recordEquity();
  }

  // ── Resolution (Binance-based) ────────────────────────────
  async resolveByBinance() {
    const openPositions = this.positions.filter(p => p.status === 'open');
    if (!openPositions.length) return;
    const now = Date.now() / 1000;
    if (now < openPositions[0].windowEnd) return;
    const candles = this.binanceCandles;
    if (!candles || candles.length < 2) return;
    for (const p of openPositions) {

    // Fetch the final 1m candle for the window
    const candles = this.binanceCandles;
    if (!candles || candles.length < 2) return;

    // Find the close price at window end
    let closePrice = null;
    for (const c of candles) {
      if (c.openTime >= p.windowEnd - 60 && c.openTime < p.windowEnd) {
        closePrice = c.close; break;
      }
    }
    if (closePrice == null) {
      // Fallback: use the latest candle's close
      closePrice = candles[candles.length - 1]?.close;
    }
    // Find the open price at window start
    let openPrice = null;
    for (const c of candles) {
      if (c.openTime <= p.windowStart && c.openTime + 60 > p.windowStart) {
        openPrice = c.open; break;
      }
    }
    if (openPrice == null) openPrice = candles[0]?.open;
    if (!Number.isFinite(closePrice) || !Number.isFinite(openPrice)) return;

    const winner = closePrice >= openPrice ? 'UP' : 'DOWN';
    const won = p.outcome === winner;
    const payout = won ? p.shares : 0;
    const exitFee = 0; // Polymarket resolution has no fee
    const netPayout = round2(payout);
    const pnl = round2(netPayout - p.cost - p.fee);

    p.status = 'closed';
    p.won = won;
    p.exitReason = 'RESOLUTION';
    p.exitPrice = won ? 1 : 0;
    p.exitFee = 0;
    p.closedAt = Date.now();
    p.pnl = pnl;
    p.resolvedWinner = winner;
    p.resolvedOpen = openPrice;
    p.resolvedClose = closePrice;

    this.bankroll = round2(this.bankroll + netPayout);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    if (won) this.wins++; else this.losses++;

    this.log(`🏁 RESOLUTION ${winner} (${openPrice.toFixed(0)}→${closePrice.toFixed(0)}) · ${p.outcome} ${won ? 'WIN' : 'LOSS'} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    this.resolvedPositions.unshift({ ...p });
    this.resolvedPositions = this.resolvedPositions.slice(0, 50);
    this.trades.push({ timestamp: p.closedAt, type: 'RESOLVED', outcome: p.outcome, shares: p.shares, price: won ? 1 : 0, cost: p.cost, fee: p.fee, pnl });
      this.positions = this.positions.filter(x => x !== p);
    }
    this.recordEquity();
  }

  // ── Equity Curve ──────────────────────────────────────────
  recordEquity() {
    const openMark = this.positions.filter(p => p.status === 'open').reduce((s, p) => s + p.shares * (p.markPrice ?? p.entryPrice), 0);
    const markValue = round2(this.bankroll + openMark);
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: markValue });
      if (this.equityCurve.length > 4000) this.equityCurve = sampleCurve(this.equityCurve, 2000);
      if (Date.now() - this.lastEquitySaveAt > 5000) {
        this.lastEquitySaveAt = Date.now();
        try { fs.writeFileSync(EQUITY_FILE, JSON.stringify(sampleCurve(this.equityCurve, 2000))); } catch (_) {}
      }
    }
    if (markValue > this.peakEquity) this.peakEquity = markValue;
    const dd = this.peakEquity - markValue;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  isClobFresh() { return Boolean(this.lastSuccessfulPollAt && Date.now() - this.lastSuccessfulPollAt <= CLOB_FRESH_MS); }

  publicMarkets() {
    const cs = windowStartFor(Date.now());
    return [...this.markets.values()].filter(m => m.windowStart === cs)
      .map(m => ({
        slug: m.slug, asset: m.asset, title: m.title,
        windowStart: m.windowStart, windowEnd: m.windowEnd,
        resolved: m.resolved, winner: m.winner,
        elapsed: Math.max(0, Math.floor(Date.now() / 1000 - m.windowStart)),
        remaining: Math.max(0, m.windowEnd - Math.floor(Date.now() / 1000)),
        up: { bid: m.up.bid, ask: m.up.ask, mid: m.up.mid, spread: m.up.spread, updatedAt: m.up.updatedAt },
        down: { bid: m.down.bid, ask: m.down.ask, mid: m.down.mid, spread: m.down.spread, updatedAt: m.down.updatedAt },
      }));
  }

  buildState() {
    const openPos = this.positions.filter(p => p.status === 'open');
    const openMarkValue = openPos.reduce((s, p) => s + p.shares * (p.markPrice ?? p.entryPrice), 0);
    const unrealizedPnl = openPos.reduce((s, p) => s + round2(p.shares * (p.markPrice ?? p.entryPrice) - p.cost - p.fee), 0);
    const markValue = round2(this.bankroll + openMarkValue);
    const now = Date.now();
    const cs = windowStartFor(now);
    return {
      bankroll: this.bankroll, markValue, realizedPnl: this.realizedPnl,
      unrealizedPnl, totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      maxDrawdown: this.maxDrawdown,
      signal: this.signal,
      positions: openPos.map(p => ({ outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost,
        betLabel: p.betLabel, markPrice: p.markPrice,
        unrealized: round2(p.shares * (p.markPrice ?? p.entryPrice) - p.cost - p.fee),
        confidence: p.signalConf, openedAt: p.openedAt, side: p.outcome })),

      markets: this.publicMarkets(),
      resolvedPositions: this.resolvedPositions.slice(0, 30),
      trades: this.trades.slice(-80).reverse(),
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: this.logs.slice(-220),
      config: { highConf: HIGH_CONF, lowConf: LOW_CONF, flatShares: FLAT_SHARES, entryElapsed: ENTRY_ELAPSED, reversalPct: REVERSAL_PCT, reversalConsist: REVERSAL_CONSIST, takerFeeRate: TAKER_FEE_RATE },
      connected: this.isClobFresh(),
      uptime: Math.floor((now - this.startedAt) / 1000),
      tickCount: this.tickHistory.length,
    };
  }

  // ── Main Loop ─────────────────────────────────────────────
  async init() {
    const start = windowStartFor(Date.now());
    await Promise.all([this.discoverMarket('btc', start), this.discoverMarket('btc', start + WINDOW_SECONDS)]);
    await this.fetchBinanceCandles();

    // CLOB polling
    setInterval(() => this.pollClobBooks(), CLOB_POLL_MS);
    // Binance tick polling (2s)
    setInterval(() => this.fetchBinanceTick().catch(() => {}), TICK_POLL_MS);
    // Binance candle refresh (10s)
    setInterval(() => this.fetchBinanceCandles().catch(() => {}), 10000);
    // Signal recomputation (every 3s)
    setInterval(() => { this.computeSignal(); this.evaluateEntry(); }, 3000);
    // Exit check (every 2s)
    setInterval(() => { this.evaluateExit(); }, 2000);
    // Resolution check (every 5s)
    setInterval(() => { this.resolveByBinance().catch(() => {}); }, 5000);
    // Discovery retry
    setInterval(() => this.retryDiscovery().catch(() => {}), 1500);
    // Equity snapshot
    setInterval(() => this.recordEquity(), 2000);

    this.log(`🚀 Model Bot started | >${(HIGH_CONF*100).toFixed(0)}%→UP · <${(LOW_CONF*100).toFixed(0)}%→DOWN · flip ${FLAT_SHARES}sh · after ${ENTRY_ELAPSED}s`);
  }
}

module.exports = { BotEngine, loadEquityFile, config: { ASSETS, START_BANKROLL, HIGH_CONF, LOW_CONF, FLAT_SHARES, ENTRY_ELAPSED, REVERSAL_PCT, REVERSAL_CONSIST, TAKER_FEE_RATE, WINDOW_SECONDS } };
