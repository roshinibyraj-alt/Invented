'use strict';

const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';
const CLOB_POLL_MS = Number(process.env.CLOB_POLL_MS || 500);
const CLOB_FRESH_MS = Number(process.env.CLOB_FRESH_MS || 3500);
const WINDOW_SECONDS = 300;
const ASSETS = ['btc'];
const START_BANKROLL = Number(process.env.START_BANKROLL || 20000);
const BASE_SHARES = Number(process.env.BASE_SHARES || 133);
const LIMIT_PRICE = Number(process.env.LIMIT_PRICE || 0.30);
const MARTINGALE_MULT = Number(process.env.MARTINGALE_MULT || 1.5);
const RESOLUTION_PRICE = Number(process.env.RESOLUTION_PRICE || 0.90);
const PRICE_HISTORY_MS = Number(process.env.PRICE_HISTORY_MS || 5000);
const TAKER_FEE_RATE = Number(process.env.TAKER_FEE_RATE || 0.07);
const MAKER_FEE_RATE = Number(process.env.MAKER_FEE_RATE || 0);
const MAKER_REBATE_RATE = Number(process.env.MAKER_REBATE_RATE || 0.20);
const EQUITY_FILE = process.env.EQUITY_FILE || './equity.json';
const fs = require('fs');

function round2(value) { return Math.round(value * 100) / 100; }
function round5(value) { return Math.round(value * 100000) / 100000; }
function takerFeeFor(shares, price) { return round5(shares * TAKER_FEE_RATE * price * (1 - price)); }
function makerRebateFor(shares, price) { return round5(takerFeeFor(shares, price) * MAKER_REBATE_RATE); }
function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(asset, start) { return `${asset}-updown-5m-${start}`; }

function sampleCurve(curve, max = 1500) {
  if (!Array.isArray(curve) || curve.length <= max) return curve || [];
  const step = (curve.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(curve[Math.round(i * step)]);
  out[max - 1] = curve[curve.length - 1];
  return out;
}

function loadEquityFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

class BotEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.emitTick = options.onTick || (() => {});
    this.emitLog = options.onLog || (() => {});
    this.shared = options.shared || null;
    if (this.shared) {
      this.markets = this.shared.markets;
      this.tokens = this.shared.tokens;
      this.history = this.shared.history;
      this.capital = this.shared.capital;
    } else {
      this.markets = new Map();
      this.tokens = new Map();
      this.history = new Map();
      this.capital = { value: START_BANKROLL };
    }
    this.startedAt = Date.now();
    Object.defineProperty(this, 'bankroll', {
      get: () => this.capital.value,
      set: (v) => { this.capital.value = v; },
      configurable: true,
    });
    const seededEquity = (options.initialEquity && Array.isArray(options.initialEquity) && options.initialEquity.length)
      ? options.initialEquity.slice() : null;
    this.equityCurve = seededEquity || [{ t: Date.now(), equity: START_BANKROLL }];
    this.lastEquitySaveAt = 0;
    this.makerRebateAccrued = 0;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.tickCount = 0;
    this.messageCount = 0;
    this.pollCount = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.logs = [];
    this.trades = [];
    this.positions = [];
    this.resolvedPositions = [];
    this.discoveredWindows = new Set();
    this.discoveryErrors = [];
    this.lastDiscoveryAt = null;
    this.discoveryRunning = false;
    this.lastPollErrorAt = null;
    this.pollRunning = false;
    this.loopRunning = false;
    this.activeWindowStart = null;
    // Per-side martingale: key = `${asset}:${outcome}` e.g. `btc:UP`, `btc:DOWN`
    this.martingale = new Map();
    this.maxConsecutiveLosses = 0;
    if (seededEquity) {
      this.peakEquity = Math.max(START_BANKROLL, ...seededEquity.map(p => Number(p.equity) || 0));
    } else {
      this.peakEquity = START_BANKROLL;
    }
    this.maxDrawdown = 0;
    // Tracks which windows already had a bet per SIDE
    this.betWindows = new Set();
    this.pendingOrders = [];
  }

  log(message) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.emitLog(line);
  }

  parseJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  async getJSON(url, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'bot/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async postJSON(url, body, timeout = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'bot/1.0' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  // ── Market Discovery ──────────────────────────────────────

  async discoverMarket(asset, start) {
    const slug = slugFor(asset, start);
    if (this.discoveredWindows.has(slug)) return this.markets.get(slug) || null;
    let market = null;
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
      market = Array.isArray(rows) ? rows[0] : null;
    } catch (error) {
      this.discoveryErrors.unshift(`${slug}: ${error.message}`);
      this.discoveryErrors = this.discoveryErrors.slice(0, 8);
      this.log(`⚠️ Discovery ${slug}: ${error.message}`);
      return null;
    }
    this.lastDiscoveryAt = Date.now();
    if (!market || !market.conditionId || !market.clobTokenIds || market.closed) {
      this.discoveryErrors.unshift(`${slug}: market unavailable/closed`);
      this.discoveryErrors = this.discoveryErrors.slice(0, 8);
      return null;
    }
    this.discoveredWindows.add(slug);
    const outcomes = this.parseJson(market.outcomes) || [];
    const tokenIds = this.parseJson(market.clobTokenIds) || [];
    const upIndex = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
    const downIndex = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
    if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
      this.log(`⚠️ Invalid token mapping ${slug}`);
      return null;
    }
    const record = {
      slug, asset, conditionId: market.conditionId,
      title: market.question || slug,
      windowStart: start, windowEnd: start + WINDOW_SECONDS,
      tradingClosed: false, resolved: false, winner: null,
      resolutionSource: null, finalUpMax: null, finalDownMax: null,
      up: this.makeToken(tokenIds[upIndex], slug, asset, 'UP'),
      down: this.makeToken(tokenIds[downIndex], slug, asset, 'DOWN'),
    };
    this.markets.set(slug, record);
    this.tokens.set(record.up.tokenId, record.up);
    this.tokens.set(record.down.tokenId, record.down);
    this.log(`🎯 ${asset.toUpperCase()} 5m discovered ${slug}`);
    return record;
  }

  makeToken(tokenId, slug, asset, outcome) {
    return { tokenId: String(tokenId), slug, asset, outcome, bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [] };
  }

  async discoverWindow(start, label) {
    await Promise.all(ASSETS.map(asset => this.discoverMarket(asset, start)));
    if (!this.activeWindowStart && this.hasOpenTradingMarket(start)) {
      this.activeWindowStart = start;
      this.log(`🚀 ${label} window active — ${start}`);
    }
  }

  hasOpenTradingMarket(start) {
    return [...this.markets.values()].some(m => m.windowStart === start && !m.tradingClosed && m.up.tokenId);
  }

  async retryDiscovery() {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      const starts = [windowStartFor(Date.now()), windowStartFor(Date.now()) + WINDOW_SECONDS];
      const missing = [];
      for (const start of starts) {
        for (const asset of ASSETS) {
          if (!this.markets.has(slugFor(asset, start))) missing.push({ asset, start });
        }
      }
      if (missing.length) await Promise.all(missing.map(item => this.discoverMarket(item.asset, item.start)));
    } finally { this.discoveryRunning = false; }
  }

  // ── CLOB Book Polling ─────────────────────────────────────

  applyBook(token, bids, asks) {
    const validBids = bids.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    const validAsks = asks.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validBids.sort((a, b) => b.price - a.price);
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    this.setQuote(token, validBids[0]?.price ?? null, validAsks[0]?.price ?? null);
  }

  setQuote(token, bid, ask) {
    const cleanBid = Number.isFinite(bid) && bid > 0 && bid <= 1 ? bid : null;
    const cleanAsk = Number.isFinite(ask) && ask > 0 && ask <= 1 ? ask : null;
    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid;
    token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
    this.pushHistory(token.tokenId, token.mid);
    const market = this.markets.get(token.slug);
    if (market) this.trackFinalPrices(market);
  }

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const series = this.history.get(tokenId) || [];
    series.push({ t: now, p: price });
    while (series.length > 2 && now - series[0].t > PRICE_HISTORY_MS) series.shift();
    this.history.set(tokenId, series.slice(-240));
  }

  simulateGtcBookFill(token, shares, ceiling = LIMIT_PRICE) {
    const asks = token.bookAsks || [];
    let remaining = shares;
    let totalCost = 0;
    for (const level of asks) {
      if (level.price > ceiling) break;
      if (remaining <= 0) break;
      const fill = Math.min(level.size, remaining);
      totalCost += round2(fill * level.price);
      remaining -= fill;
    }
    const filled = shares - remaining;
    if (filled <= 0) return null;
    return { avgPrice: round5(totalCost / filled), filled, totalCost: round2(totalCost) };
  }

  trackFinalPrices(market) {
    const nowSeconds = Date.now() / 1000;
    const elapsed = nowSeconds - market.windowStart;
    if (elapsed < WINDOW_SECONDS - 2) { market.finalUpMax = null; market.finalDownMax = null; return; }
    if (elapsed >= WINDOW_SECONDS) return;
    const upMid = Number.isFinite(market.up.mid) ? market.up.mid : null;
    const downMid = Number.isFinite(market.down.mid) ? market.down.mid : null;
    if (upMid != null && (market.finalUpMax == null || upMid > market.finalUpMax)) market.finalUpMax = upMid;
    if (downMid != null && (market.finalDownMax == null || downMid > market.finalDownMax)) market.finalDownMax = downMid;
  }

  resolveFromFinalPrices(market) {
    if (market.resolved || !Number.isFinite(market.finalUpMax) || !Number.isFinite(market.finalDownMax)) return false;
    const upStrong = market.finalUpMax > RESOLUTION_PRICE;
    const downStrong = market.finalDownMax > RESOLUTION_PRICE;
    if (upStrong === downStrong) return false;
    market.tradingClosed = true;
    market.resolved = true;
    market.winner = upStrong ? 'UP' : 'DOWN';
    market.resolutionSource = 'CLOB_FINAL_2S';
    return true;
  }

  async pollClobBooks() {
    if (this.pollRunning) return;
    const now = Date.now(), currentStart = windowStartFor(now);
    const tokens = [...this.tokens.values()].filter(token => {
      const market = this.markets.get(token.slug);
      return market?.windowStart === currentStart && !market.tradingClosed && !market.resolved;
    });
    if (!tokens.length) return;
    this.pollRunning = true;
    try {
      const books = await this.postJSON(`${CLOB_REST}/books`, tokens.map(t => ({ token_id: t.tokenId })));
      const byToken = new Map((Array.isArray(books) ? books : [])
        .map(book => [String(book?.asset_id || ''), book]).filter(([id]) => this.tokens.has(id)));
      for (const token of tokens) {
        const book = byToken.get(token.tokenId);
        if (book) this.applyBook(token, Array.isArray(book.bids) ? book.bids : [], Array.isArray(book.asks) ? book.asks : []);
      }
      this.pollCount++;
      this.messageCount = this.pollCount;
      this.lastPollAt = now;
      this.lastSuccessfulPollAt = Date.now();
      for (const market of this.markets.values()) {
        if (!market.resolved && Date.now() / 1000 >= market.windowEnd) this.resolveFromFinalPrices(market);
      }
      this.updatePositionMarks();
      this.checkPendingOrders();
      this.evaluateEntries();
      this.tickCount++;
      this.emitTick(this.publicMarkets(), this.messageCount);
    } catch (error) {
      const shouldLog = !this.lastPollErrorAt || Date.now() - this.lastPollErrorAt >= 5000;
      if (shouldLog) { this.log(`⚠️ CLOB poll failed: ${error.message}`); this.lastPollErrorAt = Date.now(); }
    } finally { this.pollRunning = false; }
  }

  // ── Strategy: Per-Side 0.30 Limit Orders ──────────────────

  martingaleStateKey(asset, outcome) { return `${asset}:${outcome}`; }

  martingaleState(asset, outcome) {
    const key = this.martingaleStateKey(asset, outcome);
    if (!this.martingale.has(key)) this.martingale.set(key, { shares: BASE_SHARES, losses: 0 });
    return this.martingale.get(key);
  }

  currentShares(asset, outcome) {
    return this.martingaleState(asset, outcome).shares;
  }

  // Place 0.30 limit on both UP and DOWN immediately after window open
  evaluateEntries() {
    const currentStart = windowStartFor(Date.now());
    for (const market of this.markets.values()) {
      if (market.windowStart !== currentStart || market.resolved || market.tradingClosed) continue;
      const asset = market.asset;
      for (const outcome of ['UP', 'DOWN']) {
        const betKey = `${asset}:${outcome}:${market.windowStart}`;
        if (this.betWindows.has(betKey)) continue;
        if (this.pendingOrders.some(o => o.windowStart === market.windowStart && o.outcome === outcome)) continue;
        const shares = this.currentShares(asset, outcome);
        this.pendingOrders.push({
          id: `lim-${asset}-${outcome}-${market.windowStart}-${Date.now()}`,
          asset, windowStart: market.windowStart, windowEnd: market.windowEnd,
          outcome, tokenId: outcome === 'UP' ? market.up.tokenId : market.down.tokenId,
          slug: market.slug, limitPrice: LIMIT_PRICE, placedAt: Date.now(), status: 'pending',
        });
        const mg = this.martingaleState(asset, outcome);
        this.log(`📌 ${asset.toUpperCase()} ${outcome} LIMIT @${LIMIT_PRICE.toFixed(2)} — ${shares} SH · mg#${mg.losses}`);
      }
    }
  }

  checkPendingOrders() {
    for (const order of this.pendingOrders) {
      if (order.status !== 'pending') continue;
      const market = this.markets.get(order.slug);
      if (!market) continue;
      const token = order.outcome === 'UP' ? market.up : market.down;
      const best = token?.mid ?? token?.ask ?? token?.bid;
      const nowSecs = Date.now() / 1000;
      if (nowSecs >= order.windowEnd || market.resolved) {
        order.status = 'cancelled';
      } else if (Number.isFinite(best) && best <= LIMIT_PRICE && this.simulateGtcBookFill(token, 1, LIMIT_PRICE)) {
        order.status = 'filled';
        this.enterBet(market, token, order);
      }
    }
    this.pendingOrders = this.pendingOrders.filter(o => o.status === 'pending');
  }

  enterBet(market, token, order) {
    const { asset, outcome } = order;
    const shares = this.currentShares(asset, outcome);
    const entryPrice = LIMIT_PRICE;
    const cost = round2(shares * LIMIT_PRICE);
    const fee = 0;
    const feeEquivalent = takerFeeFor(shares, LIMIT_PRICE);
    const rebateEstimate = makerRebateFor(shares, LIMIT_PRICE);
    if (cost > this.capital.value) {
      this.log(`⚠️ ${asset.toUpperCase()} ${outcome} fill skipped — need $${round2(cost)}, available $${this.capital.value}`);
      return false;
    }
    this.bankroll = this.capital.value = round2(this.capital.value - cost);
    this.makerRebateAccrued = round2(this.makerRebateAccrued + rebateEstimate);
    const now = Date.now();
    const betKey = `${asset}:${outcome}:${market.windowStart}`;
    const mg = this.martingaleState(asset, outcome);
    const position = {
      id: `bet-${asset}-${outcome}-${market.windowStart}-${now}`,
      slug: market.slug, asset, conditionId: market.conditionId,
      outcome, tokenId: token.tokenId,
      shares, avgPrice: entryPrice, entryPrice, cost, fee,
      feeEquivalent, rebateEstimate,
      status: 'open', openedAt: now, markPrice: token.mid,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      signal: { limitPrice: LIMIT_PRICE, triggerSource: 'MAKER_LIMIT_0.30', bid: token.bid, ask: token.ask, mid: token.mid },
      martingaleIndex: mg.losses,
    };
    this.positions.push(position);
    this.betWindows.add(betKey);
    this.trades.push({ timestamp: now, orderType: 'PAPER-MAKER-LIMIT@0.30', asset, outcome, shares, price: entryPrice, cost, markPrice: token.mid, pnl: this.positionPnl(position), signal: position.signal, rebateEstimate });
    this.trades = this.trades.slice(-300);
    this.log(`⚡ FILLED ${asset.toUpperCase()} ${outcome} ${shares}sh @${entryPrice.toFixed(3)} · mg#${mg.losses} · cost $${cost.toFixed(2)} · rebate $${rebateEstimate.toFixed(5)}`);
    this.recordEquity();
    return true;
  }

  positionPnl(position) {
    if (!position || position.status !== 'open') return 0;
    const markPrice = position.markPrice ?? position.avgPrice;
    return round2(position.shares * markPrice - position.cost - position.fee);
  }

  updatePositionMarks() {
    for (const position of this.positions) {
      if (position.status !== 'open') continue;
      const market = this.markets.get(position.slug);
      const token = position.outcome === 'UP' ? market?.up : market?.down;
      if (Number.isFinite(token?.mid)) position.markPrice = token.mid;
    }
  }

  activePositionSummaries() {
    return this.positions.filter(p => p.status === 'open').map(p => ({
      ...p, markValue: p.shares * (p.markPrice ?? p.avgPrice), unrealized: this.positionPnl(p),
    })).reverse();
  }

  settleByResolution() {
    for (const position of this.positions) {
      if (position.status !== 'open') continue;
      const market = this.markets.get(position.slug);
      if (!market?.resolved || !market.winner) continue;
      const won = position.outcome === market.winner;
      const payout = won ? position.shares : 0;
      const exitFee = 0;
      const pnl = round2(payout - exitFee - position.cost - position.fee);
      position.status = 'closed';
      position.won = won;
      position.payout = round2(payout);
      position.pnl = pnl;
      position.exitPrice = won ? 1 : 0;
      position.closedAt = Date.now();
      position.closeReason = 'RESOLUTION';
      position.winner = market.winner;
      this.bankroll = this.capital.value = round2(this.capital.value + payout - exitFee);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      const mg = this.martingaleState(position.asset, position.outcome);
      if (won) {
        this.wins++;
        mg.shares = BASE_SHARES;
        mg.losses = 0;
        this.log(`🏁 ${position.asset.toUpperCase()} ${position.outcome} WIN — payout $${position.payout.toFixed(2)} · cost $${(position.cost + position.fee).toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · reset ${BASE_SHARES} SH`);
      } else {
        this.losses++;
        mg.losses += 1;
        mg.shares = round2(BASE_SHARES * Math.pow(MARTINGALE_MULT, mg.losses));
        if (mg.losses > this.maxConsecutiveLosses) this.maxConsecutiveLosses = mg.losses;
        this.log(`🏁 ${position.asset.toUpperCase()} ${position.outcome} LOSS — P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · next ${mg.shares} SH (1.5×)`);
      }
      this.resolvedPositions.unshift({ ...position });
      this.resolvedPositions = this.resolvedPositions.slice(0, 40);
    }
    this.positions = this.positions.filter(position => position.status === 'open');
  }

  // ── Rotation / Sweep / Equity ──────────────────────────────

  async rotateAndSweep() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      const start = windowStartFor(Date.now());
      if (start !== this.activeWindowStart) { this.activeWindowStart = null; await this.discoverWindow(start, 'New'); }
      for (const market of this.markets.values()) {
        if (market.resolved || Date.now() / 1000 < market.windowEnd - 2) continue;
        this.trackFinalPrices(market);
        if (Date.now() / 1000 >= market.windowEnd) this.resolveFromFinalPrices(market);
      }
      this.settleByResolution();
      this.pruneExpiredMarkets();
      this.recordEquity();
    } catch (error) { this.log(`⚠️ Loop: ${error.message}`); } finally { this.loopRunning = false; }
  }

  pruneExpiredMarkets() {
    const expiryCutoff = Date.now() / 1000 - 2;
    const expired = [...this.markets.values()].filter(m => m.windowEnd < expiryCutoff);
    if (!expired.length) return;
    for (const market of expired) {
      this.markets.delete(market.slug);
      this.tokens.delete(market.up.tokenId);
      this.tokens.delete(market.down.tokenId);
      this.history.delete(market.up.tokenId);
      this.history.delete(market.down.tokenId);
    }
    this.log(`🧹 Released ${expired.length} expired market(s)`);
  }

  recordEquity() {
    const last = this.equityCurve[this.equityCurve.length - 1];
    const state = this.buildState();
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - state.markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: state.markValue });
      if (this.equityCurve.length > 4000) this.equityCurve = sampleCurve(this.equityCurve, 2000);
      if (Date.now() - this.lastEquitySaveAt > 5000) {
        this.lastEquitySaveAt = Date.now();
        try { fs.writeFileSync(EQUITY_FILE, JSON.stringify(sampleCurve(this.equityCurve, 2000))); } catch (_) {}
      }
    }
    if (state.markValue > this.peakEquity) this.peakEquity = state.markValue;
    const dd = this.peakEquity - state.markValue;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
  }

  publicMarkets() {
    const currentStart = windowStartFor(Date.now());
    return [...this.markets.values()]
      .filter(m => m.windowStart === currentStart)
      .sort((a, b) => a.asset.localeCompare(b.asset))
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
    this.updatePositionMarks();
    const open = this.activePositionSummaries();
    const openValue = round2(open.reduce((sum, p) => sum + p.markValue, 0));
    const unrealizedPnl = round2(open.reduce((sum, p) => sum + p.unrealized, 0));
    const markValue = round2(this.capital.value + openValue);
    const activeStart = windowStartFor(Date.now());
    const martingale = Object.fromEntries([...this.martingale.entries()].map(([k, st]) => [k, { ...st }]));
    return {
      bankroll: this.capital.value, markValue,
      realizedPnl: this.realizedPnl, openValue, unrealizedPnl,
      totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      makerRebateAccrued: this.makerRebateAccrued,
      martingale,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      peakEquity: this.peakEquity,
      maxDrawdown: this.maxDrawdown,
      connected: this.isClobFresh(), tickCount: this.tickCount,
      trackedTokens: this.tokens.size,
      markets: this.publicMarkets(),
      positions: open,
      resolvedPositions: this.resolvedPositions.slice(0, 30),
      trades: this.trades.slice(-160).reverse(),
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: this.logs.slice(-220),
      config: { baseShares: BASE_SHARES, limitPrice: LIMIT_PRICE, multiplier: MARTINGALE_MULT, resolutionPrice: RESOLUTION_PRICE, takerFeeRate: TAKER_FEE_RATE, makerFeeRate: MAKER_FEE_RATE, makerRebateRate: MAKER_REBATE_RATE },
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async init() {
    const start = windowStartFor(Date.now());
    await Promise.all([
      this.discoverWindow(start, 'Current'),
      this.discoverWindow(start + WINDOW_SECONDS, 'Next'),
    ]);
    await this.pollClobBooks();
    setInterval(() => this.rotateAndSweep(), 250);
    setInterval(() => this.pollClobBooks(), CLOB_POLL_MS);
    setInterval(() => this.retryDiscovery(), 1500);
    this.log(`🚀 Bot started | ${ASSETS.join('/')} | ${LIMIT_PRICE} limit both sides · no SL · ${MARTINGALE_MULT}× mg · base ${BASE_SHARES} SH`);
  }
}

module.exports = { BotEngine, loadEquityFile, config: { ASSETS, START_BANKROLL, BASE_SHARES, LIMIT_PRICE, MARTINGALE_MULT, RESOLUTION_PRICE, TAKER_FEE_RATE, MAKER_FEE_RATE, MAKER_REBATE_RATE } };
