'use strict';

const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';
const CLOB_POLL_MS = Number(process.env.CLOB_POLL_MS || 500);
const CLOB_FRESH_MS = Number(process.env.CLOB_FRESH_MS || 3500);
const WINDOW_SECONDS = 300;
const ASSETS = ['btc'];
const LEAD_ASSET = (process.env.LEAD_ASSET || 'btc').toLowerCase();
const START_BANKROLL = Number(process.env.START_BANKROLL || 20000);
const BASE_SHARES = Number(process.env.BASE_SHARES || 100);
const TRIGGER_PRICE = Number(process.env.TRIGGER_PRICE || 0.70);
const LIMIT_PRICE = Number(process.env.LIMIT_PRICE || 0.60);
const LIMIT_PRICE_300 = Number(process.env.LIMIT_PRICE_300 || 0.30);
const BASE_SHARES_300 = Number(process.env.BASE_SHARES_300 || 133);
const MARTINGALE_300_MULT = Number(process.env.MARTINGALE_300_MULT || 1.5);
const RESOLUTION_PRICE = Number(process.env.RESOLUTION_PRICE || 0.90);
const MARKET_OPEN_WAIT = Number(process.env.MARKET_OPEN_WAIT || 10);
const PRICE_HISTORY_MS = Number(process.env.PRICE_HISTORY_MS || 5000);
const TAKER_FEE_BPS = Number(process.env.TAKER_FEE_BPS || 0);
const SWEEP_INTERVAL_MS = Number(process.env.RESOLUTION_SWEEP_MS || 5000);
// Polymarket fee/rebate model (official docs):
// fee = shares x feeRate x p x (1-p). Makers never pay fees (makerFeeRate=0).
// Crypto taker feeRate = 0.07; maker rebate = 20% of taker-fee-equivalent (fee-curve weighted, daily, $1 min).
const TAKER_FEE_RATE = Number(process.env.TAKER_FEE_RATE || 0.07);
const MAKER_FEE_RATE = Number(process.env.MAKER_FEE_RATE || 0);
const MAKER_REBATE_RATE = Number(process.env.MAKER_REBATE_RATE || 0.20);
const EQUITY_FILE = process.env.EQUITY_FILE || './equity.json';
const fs = require('fs');

function round2(value) { return Math.round(value * 100) / 100; }
function round5(value) { return Math.round(value * 100000) / 100000; }
function takerFeeFor(shares, price) { return round5(shares * TAKER_FEE_RATE * price * (1 - price)); }
function makerRebateFor(shares, price) { return round5(takerFeeFor(shares, price) * MAKER_REBATE_RATE); }
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
function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(asset, start) { return `${asset}-updown-5m-${start}`; }

class MartingaleBotEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.emitTick = options.onTick || (() => {});
    this.emitLog = options.onLog || (() => {});
    this.startedAt = Date.now();
    this.shared = options.shared || null;
    this.secondary = options.secondary || null;
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
    Object.defineProperty(this, 'bankroll', {
      get: () => this.capital.value,
      set: (v) => { this.capital.value = v; },
      configurable: true,
    });
    this.makerRebateAccrued = 0;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.tickCount = 0;
    this.messageCount = 0;
    this.pollCount = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    const seededEquity = (options.initialEquity && Array.isArray(options.initialEquity) && options.initialEquity.length)
      ? options.initialEquity.slice() : null;
    this.equityCurve = seededEquity || [{ t: Date.now(), equity: START_BANKROLL }];
    this.equitySavePending = false;
    this.logs = [];
    this.trades = [];
    this.positions = [];
    this.resolvedPositions = [];
    this.windows = new Map();
    this.discoveredWindows = new Set();
    this.activeWindowStart = null;
    this.pollRunning = false;
    this.loopRunning = false;
    this.discoveryErrors = [];
    this.lastDiscoveryAt = null;
    this.discoveryRunning = false;
    this.lastPollErrorAt = null;
    // Per-market martingale state: { shares, losses }
    this.martingale = new Map();
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = 0;
    if (seededEquity) {
      this.peakEquity = Math.max(START_BANKROLL, ...seededEquity.map(p => Number(p.equity) || 0));
    } else {
      this.peakEquity = START_BANKROLL;
    }
    this.maxDrawdown = 0;
    // Tracks which windows already had a bet per asset, to prevent intra-window martingale
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
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'martingale-bot/1.0' } });
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
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'martingale-bot/1.0' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

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
    const upIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'up');
    const downIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'down');
    if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
      this.log(`⚠️ Invalid token mapping ${slug}`);
      return null;
    }
    const record = {
      slug,
      asset,
      conditionId: market.conditionId,
      title: market.question || slug,
      windowStart: start,
      windowEnd: start + WINDOW_SECONDS,
      tradingClosed: false,
      resolved: false,
      winner: null,
      resolutionSource: null,
      finalUpMax: null,
      finalDownMax: null,
      up: this.makeToken(tokenIds[upIndex], slug, asset, 'UP'),
      down: this.makeToken(tokenIds[downIndex], slug, asset, 'DOWN'),
    };
    this.markets.set(slug, record);
    this.tokens.set(record.up.tokenId, record.up);
    this.tokens.set(record.down.tokenId, record.down);
    this.log(`🎯 ${asset.toUpperCase()} 5m discovered ${slug} — CLOB polling armed`);
    return record;
  }

  makeToken(tokenId, slug, asset, outcome) {
    return {
      tokenId: String(tokenId), slug, asset, outcome,
      bid: null, ask: null, mid: null, spread: null,
      previousMid: null, updatedAt: null,
      bookAsks: [],
    };
  }

  async discoverWindow(start, label) {
    await Promise.all(ASSETS.map(asset => this.discoverMarket(asset, start)));
    if (!this.activeWindowStart && this.hasOpenTradingMarket(start)) {
      this.activeWindowStart = start;
      this.log(`🚀 ${label} window active — ${start}`);
    }
  }

  hasOpenTradingMarket(start) {
    return [...this.markets.values()].some(market =>
      market.windowStart === start && !market.tradingClosed && market.up.tokenId);
  }

  martingaleState(asset) {
    if (!this.martingale.has(asset)) {
      this.martingale.set(asset, { shares: BASE_SHARES, losses: 0 });
    }
    return this.martingale.get(asset);
  }

  currentShares(asset) {
    return this.martingaleState(asset).shares;
  }

  applyBook(token, bids, asks) {
    const validBids = bids.filter(level => Number(level.size) > 0).map(level => ({ price: Number(level.price), size: Number(level.size) }));
    const validAsks = asks.filter(level => Number(level.size) > 0).map(level => ({ price: Number(level.price), size: Number(level.size) }));
    validBids.sort((a, b) => b.price - a.price);
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    this.setQuote(token, validBids[0]?.price ?? null, validAsks[0]?.price ?? null);
  }

  applyTop(token, bestBid, bestAsk) {
    const bid = bestBid == null ? token.bid : Number(bestBid);
    const ask = bestAsk == null ? token.ask : Number(bestAsk);
    this.setQuote(token, bid, ask);
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

  simulateGtcBookFill(token, shares, ceiling = 0.99) {
    const asks = token.bookAsks || [];
    let remaining = shares;
    let totalCost = 0;
    const levels = [];
    for (const level of asks) {
      if (level.price > ceiling) break;
      if (remaining <= 0) break;
      const fill = Math.min(level.size, remaining);
      const cost = round2(fill * level.price);
      levels.push({ price: level.price, size: fill, cost });
      totalCost += cost;
      remaining -= fill;
    }
    const filled = shares - remaining;
    if (filled <= 0) return null;
    const avgPrice = round5(totalCost / filled);
    return { avgPrice, filled, totalCost: round2(totalCost), levels };
  }

  trackFinalPrices(market) {
    const nowSeconds = Date.now() / 1000;
    const elapsed = nowSeconds - market.windowStart;
    if (elapsed < WINDOW_SECONDS - 2) {
      market.finalUpMax = null;
      market.finalDownMax = null;
      return;
    }
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

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const series = this.history.get(tokenId) || [];
    series.push({ t: now, p: price });
    while (series.length > 2 && now - series[0].t > PRICE_HISTORY_MS) series.shift();
    this.history.set(tokenId, series.slice(-240));
  }

  currentMarket(asset) {
    return [...this.markets.values()].find(market =>
      market.asset === asset && !market.resolved && Date.now() / 1000 < market.windowEnd) || null;
  }

  positionPnl(position) {
    return round2(position.shares * (position.markPrice ?? position.avgPrice) - position.cost - position.fee);
  }

  /* ═════════════════════════════════════════════════════════
     CORE STRATEGY — Limit-order entry
     When any side hits TRIGGER_PRICE (0.70) → immediately place
     GTC limit buy at LIMIT_PRICE (0.60) on that side.
     Fill only if price walks down to 0.60. If no fill, cancel
     and skip the window (martingale carries to next window).
     SL at 0.45, TP at resolution. One bet per window per asset.
     On loss, double shares. On win, reset.
     ═════════════════════════════════════════════════════════ */
  evaluateEntries() {
    for (const asset of ASSETS) {
      const market = this.currentMarket(asset);
      if (!market) continue;
      if (this.hasOpenBet(asset, market.windowStart)) continue;
      if (this.betWindows.has(`${asset}:${market.windowStart}`)) continue;
      if (this.pendingOrders.some(o => o.asset === asset && o.windowStart === market.windowStart)) continue;
      const elapsed = Date.now() / 1000 - market.windowStart;
      if (elapsed < MARKET_OPEN_WAIT) continue;
      // Trigger: any side reaches TRIGGER_PRICE (0.70)
      const candidates = [market.up, market.down].map(token => {
        const best = token.mid ?? token.ask ?? token.bid;
        return { token, price: best };
      }).filter(c => Number.isFinite(c.price) && c.price >= TRIGGER_PRICE - 0.02);
      if (!candidates.length) continue;
      candidates.sort((a, b) => a.price - b.price);
      this.placeLimitOrder(market, candidates[0].token, candidates[0].price);
    }
  }

  hasOpenBet(asset, windowStart) {
    return this.positions.some(p => p.status === 'open' && p.asset === asset && p.windowStart === windowStart);
  }

  placeLimitOrder(market, token, triggerPrice) {
    const asset = market.asset;
    if (this.pendingOrders.some(o => o.asset === asset && o.windowStart === market.windowStart)) return false;
    const order = {
      id: `limit-${asset}-${market.windowStart}-${Date.now()}`,
      asset, windowStart: market.windowStart, windowEnd: market.windowEnd,
      outcome: token.outcome, tokenId: token.tokenId, slug: market.slug,
      limitPrice: LIMIT_PRICE, triggerPrice, placedAt: Date.now(),
      status: 'pending',
    };
    this.pendingOrders.push(order);
    this.log(`📌 LIMIT PLACED ${asset.toUpperCase()} ${token.outcome} ${this.currentShares(asset)}sh @${LIMIT_PRICE.toFixed(2)} — triggered at ${triggerPrice.toFixed(3)} (≥0.70) · waiting to walk down`);
    return true;
  }

  checkPendingOrders() {
    for (const order of this.pendingOrders) {
      const market = this.markets.get(order.slug);
      if (!market) continue;
      const token = order.outcome === 'UP' ? market.up : market.down;
      const best = token?.mid ?? token?.ask ?? token?.bid;
      const nowSecs = Date.now() / 1000;
      if (nowSecs >= order.windowEnd) {
        order.status = 'cancelled';
        this.log(`❌ LIMIT CANCELLED ${order.asset.toUpperCase()} ${order.outcome} — never reached ${LIMIT_PRICE.toFixed(2)} · window skipped · martingale ${this.currentShares(order.asset)} SH carries to next window`);
      } else if (Number.isFinite(best) && best <= LIMIT_PRICE && this.simulateGtcBookFill(token, 1, LIMIT_PRICE)) {
        order.status = 'filled';
        this.log(`✅ LIMIT FILLED ${order.asset.toUpperCase()} ${order.outcome} @${LIMIT_PRICE.toFixed(2)} — price walked to ${best.toFixed(3)}`);
        this.enterBet(market, token, order);
      }
    }
    this.pendingOrders = this.pendingOrders.filter(o => o.status !== 'cancelled' && o.status !== 'filled');
  }

  enterBet(market, token, order) {
    const asset = market.asset;
    const shares = this.currentShares(asset);
    // Resting maker limit fills at exactly the limit price — no slippage, no maker fee.
    const entryPrice = LIMIT_PRICE;
    const cost = round2(shares * LIMIT_PRICE);
    const fee = 0;
    const feeEquivalent = takerFeeFor(shares, LIMIT_PRICE);
    const rebateEstimate = makerRebateFor(shares, LIMIT_PRICE);
    if (cost > this.bankroll) {
      this.log(`⚠️ ${asset.toUpperCase()} fill skipped — need $${round2(cost)}, available $${this.bankroll}`);
      return false;
    }
    this.bankroll = this.capital.value = round2(this.bankroll - cost);
    this.makerRebateAccrued = round2(this.makerRebateAccrued + rebateEstimate);
    const now = Date.now();
    const position = {
      id: `bet-${asset}-${market.windowStart}-${now}`,
      slug: market.slug, asset, conditionId: market.conditionId,
      outcome: token.outcome, tokenId: token.tokenId,
      shares, avgPrice: entryPrice, entryPrice, cost, fee,
      feeEquivalent, rebateEstimate,
      status: 'open', openedAt: now, markPrice: token.mid,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      stopLossPrice: null,
      signal: { triggerPrice: order.triggerPrice, limitPrice: LIMIT_PRICE, triggerSource: 'MAKER_LIMIT_0.70→0.60', bid: token.bid, ask: token.ask, mid: token.mid, elapsed: Math.floor(now / 1000 - market.windowStart) },
      martingaleIndex: this.martingaleState(asset).losses,
    };
    this.positions.push(position);
    this.betWindows.add(`${asset}:${market.windowStart}`);
    this.trades.push({ timestamp: now, orderType: 'PAPER-MAKER-LIMIT@0.60', asset, outcome: token.outcome, shares, price: entryPrice, cost, markPrice: token.mid, pnl: this.positionPnl(position), signal: position.signal, rebateEstimate });
    this.trades = this.trades.slice(-300);
    this.log(`⚡ FILLED ${asset.toUpperCase()} ${token.outcome} ${shares}sh @${entryPrice.toFixed(3)} (maker limit ${LIMIT_PRICE.toFixed(2)}, no fee) martingale #${position.martingaleIndex} · cost $${cost.toFixed(2)} · rebate est. $${rebateEstimate.toFixed(5)}`);
    this.recordEquity();
    return true;
  }


  settleResolved() {
    for (const position of this.positions) {
      if (position.status !== 'open') continue;
      const market = this.markets.get(position.slug);
      if (!market?.resolved || !market.winner) continue;
      const won = position.outcome === market.winner;
      const payout = won ? position.shares : 0;
      const exitFee = 0; // resolution settlement carries no fee
      const pnl = round2(payout - exitFee - position.cost - position.fee);
      position.status = 'closed';
      position.won = won;
      position.payout = round2(payout);
      position.pnl = pnl;
      position.exitPrice = won ? 1 : 0;
      position.closedAt = Date.now();
      position.closeReason = 'RESOLUTION';
      position.winner = market.winner;
      this.bankroll = this.capital.value = round2(this.bankroll + payout - exitFee);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      const st = this.martingaleState(position.asset);
      if (won) {
        this.wins++;
        // Reset martingale + consecutive losses on win
        st.shares = BASE_SHARES;
        st.losses = 0;
        this.consecutiveLosses = 0;
        this.log(`🏁 ${position.asset.toUpperCase()} ${position.outcome} WIN — payout $${position.payout.toFixed(2)} · cost $${(position.cost + position.fee).toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · martingale reset to ${BASE_SHARES} SH`);
      } else {
        this.losses++;
        this.consecutiveLosses += 1;
        if (this.consecutiveLosses > this.maxConsecutiveLosses) this.maxConsecutiveLosses = this.consecutiveLosses;
        st.losses += 1;
        st.shares = BASE_SHARES * Math.pow(2, st.losses);
        this.log(`🏁 ${position.asset.toUpperCase()} ${position.outcome} LOSS — payout $0 · cost $${(position.cost + position.fee).toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · next bet doubled to ${st.shares} SH · losses-in-row ${this.consecutiveLosses}`);
      }
      this.resolvedPositions.unshift({ ...position });
      this.resolvedPositions = this.resolvedPositions.slice(0, 40);
    }
    this.positions = this.positions.filter(position => position.status === 'open');
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
      ...p,
      markValue: p.shares * (p.markPrice ?? p.avgPrice),
      unrealized: this.positionPnl(p),
    })).reverse();
  }

  publicMarkets() {
    const currentStart = windowStartFor(Date.now());
    return [...this.markets.values()]
      .filter(market => market.windowStart === currentStart)
      .sort((a, b) => a.asset.localeCompare(b.asset))
      .map(market => ({
        slug: market.slug, asset: market.asset, title: market.title,
        windowStart: market.windowStart, windowEnd: market.windowEnd,
        resolved: market.resolved, winner: market.winner,
        resolutionSource: market.resolutionSource,
        finalUpMax: market.finalUpMax, finalDownMax: market.finalDownMax,
        elapsed: Math.max(0, Math.floor(Date.now() / 1000 - market.windowStart)),
        remaining: Math.max(0, market.windowEnd - Math.floor(Date.now() / 1000)),
        up: publicToken(market.up), down: publicToken(market.down),
      }));
  }

  buildState() {
    this.updatePositionMarks();
    const open = this.activePositionSummaries();
    const sec = this.secondary ? this.secondary.buildState() : null;
    const secOpen = sec?.positions || [];
    const openValue = round2(open.reduce((sum, p) => sum + p.markValue, 0) + secOpen.reduce((sum, p) => sum + p.markValue, 0));
    const unrealizedPnl = round2(open.reduce((sum, p) => sum + p.unrealized, 0) + secOpen.reduce((sum, p) => sum + p.unrealized, 0));
    const markValue = round2(this.capital.value + openValue);
    const totalRealized = round2(this.realizedPnl + (sec?.realizedPnl || 0));
    const totalWins = this.wins + (sec?.wins || 0);
    const totalLosses = this.losses + (sec?.losses || 0);
    const allTrades = [...this.trades, ...(sec?.trades || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 160);
    const allResolved = [...this.resolvedPositions, ...(sec?.resolvedPositions || [])]
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 30);
    const activeStart = windowStartFor(Date.now());
    const currentDiscovered = ASSETS.filter(asset => this.markets.has(slugFor(asset, activeStart))).length;
    const nextDiscovered = ASSETS.filter(asset => this.markets.has(slugFor(asset, activeStart + WINDOW_SECONDS))).length;
    const martingale = Object.fromEntries([...this.martingale.entries()].map(([asset, st]) => [asset, { ...st }]));
    return {
      mode: 'AUTONOMOUS DEMO',
      strategy: 'Limit @0.60 after 0.70 trigger · SL @0.45 · TP=resolution · martingale next window',
      serverTime: Date.now(),
      windowStart: activeStart,
      connected: this.isClobFresh(), tickCount: this.tickCount, messageCount: this.messageCount,
      pollCount: this.pollCount, lastPollAt: this.lastPollAt,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      trackedTokens: this.tokens.size,
      martingale,
      consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveLosses: Math.max(this.maxConsecutiveLosses, sec?.maxConsecutiveLosses || 0),
      peakEquity: Math.max(this.peakEquity, sec?.peakEquity || 0),
      maxDrawdown: Math.max(this.maxDrawdown, sec?.maxDrawdown || 0),
      discovery: {
        expectedMarkets: ASSETS.length,
        currentDiscovered, nextDiscovered,
        expectedTokens: ASSETS.length * 2 * (currentDiscovered === ASSETS.length && nextDiscovered === ASSETS.length ? 2 : 1),
        errors: this.discoveryErrors,
        lastDiscoveryAt: this.lastDiscoveryAt,
      },
      watchAssets: ASSETS, leadAsset: LEAD_ASSET.toUpperCase(),
      bankroll: this.capital.value, markValue, realizedPnl: totalRealized,
      openValue, unrealizedPnl, totalPnl: round2(markValue - START_BANKROLL),
      wins: totalWins, losses: totalLosses,
      winRate: totalWins + totalLosses ? round2(totalWins / (totalWins + totalLosses) * 100) : null,
      makerRebateAccrued: round2(this.makerRebateAccrued + (sec?.makerRebateAccrued || 0)),
      markets: this.publicMarkets(),
      positions: [...open, ...secOpen].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)),
      resolvedPositions: allResolved,
      trades: allTrades,
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: [...this.logs, ...(sec?.logs || [])].sort().slice(-220),
      config: {
        baseShares: BASE_SHARES, triggerPrice: TRIGGER_PRICE, limitPrice: LIMIT_PRICE,
        resolutionPrice: RESOLUTION_PRICE, feeBps: TAKER_FEE_BPS, marketOpenWait: MARKET_OPEN_WAIT,
        baseShares300: BASE_SHARES_300, limitPrice300: LIMIT_PRICE_300,
        makerFeeRate: MAKER_FEE_RATE, takerFeeRate: TAKER_FEE_RATE, makerRebateRate: MAKER_REBATE_RATE,
      },
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      secondary: sec,
    };
  }

  recordEquity() {
    const last = this.equityCurve[this.equityCurve.length - 1];
    const state = this.buildState();
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - state.markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: state.markValue });
      if (this.equityCurve.length > 4000) this.equityCurve = sampleCurve(this.equityCurve, 2000);
      if (Date.now() - (this.lastEquitySaveAt || 0) > 5000) {
        this.lastEquitySaveAt = Date.now();
        try {
          fs.writeFileSync(EQUITY_FILE, JSON.stringify(sampleCurve(this.equityCurve, 2000)));
        } catch (_) { /* disk unavailable — lifetime curve kept in memory */ }
      }
    }
    if (state.markValue > this.peakEquity) this.peakEquity = state.markValue;
    const dd = this.peakEquity - state.markValue;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
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

  async rotateAndSweep() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      const start = windowStartFor(Date.now());
      if (start !== this.activeWindowStart) {
        this.activeWindowStart = null;
        await this.discoverWindow(start, 'New');
      }
      for (const market of this.markets.values()) {
        if (market.resolved || Date.now() / 1000 < market.windowEnd - 2) continue;
        this.trackFinalPrices(market);
        if (Date.now() / 1000 >= market.windowEnd) this.resolveFromFinalPrices(market);
      }
      this.settleResolved();
      if (this.secondary) { this.secondary.settleByResolution(); this.secondary.recordEquity(); }
      this.pruneExpiredMarkets();
      this.recordEquity();
    } catch (error) {
      this.log(`⚠️ Loop: ${error.message}`);
    } finally { this.loopRunning = false; }
  }

  pruneExpiredMarkets() {
    const expiryCutoff = Date.now() / 1000 - 2;
    const expired = [...this.markets.values()].filter(market => market.windowEnd < expiryCutoff);
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
      const books = await this.postJSON(`${CLOB_REST}/books`, tokens.map(token => ({ token_id: token.tokenId })));
      const byToken = new Map((Array.isArray(books) ? books : [])
        .map(book => [String(book?.asset_id || ''), book]).filter(([tokenId]) => this.tokens.has(tokenId)));
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
      if (this.secondary) {
        this.secondary.updatePositionMarks();
        this.secondary.checkPendingOrders();
        this.secondary.evaluateEntries();
      }
      this.tickCount++;
      this.emitTick(this.publicMarkets(), this.messageCount);
    } catch (error) {
      const shouldLog = !this.lastPollErrorAt || Date.now() - this.lastPollErrorAt >= 5000;
      if (shouldLog) {
        this.log(`⚠️ CLOB book poll failed: ${error.message}`);
        this.lastPollErrorAt = Date.now();
      }
    } finally { this.pollRunning = false; }
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
    this.log(`🚀 Martingale bot started | ${ASSETS.join('/')} | trigger@${TRIGGER_PRICE.toFixed(2)}→limit@${LIMIT_PRICE.toFixed(2)} no-SL base ${BASE_SHARES} SH | demo ${START_BANKROLL}`);
  }
}


class DoubleSide300Engine {
  constructor(options = {}) {
    this.shared = options.shared || null;
    if (!this.shared) throw new Error('DoubleSide300Engine requires shared feed { markets, tokens, history, capital }');
    this.markets = this.shared.markets;
    this.tokens = this.shared.tokens;
    this.history = this.shared.history;
    this.capital = this.shared.capital;
    this.emitLog = options.onLog || (() => {});
    this.startedAt = Date.now();
    Object.defineProperty(this, 'bankroll', {
      get: () => this.capital.value,
      set: (v) => { this.capital.value = v; },
      configurable: true,
    });
    this.makerRebateAccrued = 0;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.positions = [];
    this.resolvedPositions = [];
    this.trades = [];
    this.logs = [];
    this.pendingOrders = [];
    this.betWindows = new Set();
    this.martingale = new Map();
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = 0;
    this.peakEquity = START_BANKROLL;
    this.maxDrawdown = 0;
    this.equityCurve = [{ t: Date.now(), equity: START_BANKROLL }];
  }

  log(message) {
    const line = `[${new Date().toISOString().slice(11, 23)}] [0.30] ${message}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.emitLog(line);
  }

  martingaleState(asset) {
    if (!this.martingale.has(asset)) this.martingale.set(asset, { shares: BASE_SHARES_300, losses: 0 });
    return this.martingale.get(asset);
  }

  currentShares(asset) {
    return this.martingaleState(asset).shares;
  }

  simulateGtcBookFill(token, shares, ceiling = LIMIT_PRICE_300) {
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

  // Both sides get a limit order at 0.30 immediately once the window is discovered
  evaluateEntries() {
    const currentStart = windowStartFor(Date.now());
    for (const market of this.markets.values()) {
      if (market.windowStart !== currentStart || market.resolved || market.tradingClosed) continue;
      if (this.pendingOrders.some(o => o.windowStart === market.windowStart)) continue;
      const key = `${market.asset}:${market.windowStart}`;
      if (this.betWindows.has(key)) continue;
      const asset = market.asset;
      const shares = this.currentShares(asset);
      this.pendingOrders.push(
        {
          id: `d300-up-${asset}-${market.windowStart}-${Date.now()}`,
          asset, windowStart: market.windowStart, windowEnd: market.windowEnd,
          outcome: 'UP', tokenId: market.up.tokenId, slug: market.slug,
          limitPrice: LIMIT_PRICE_300, placedAt: Date.now(), status: 'pending',
        },
        {
          id: `d300-dn-${asset}-${market.windowStart}-${Date.now()}`,
          asset, windowStart: market.windowStart, windowEnd: market.windowEnd,
          outcome: 'DOWN', tokenId: market.down.tokenId, slug: market.slug,
          limitPrice: LIMIT_PRICE_300, placedAt: Date.now(), status: 'pending',
        }
      );
      this.log(`📌 [0.30] ${asset.toUpperCase()} LIMIT BOTH SIDES @0.30 — ${shares} SH each · martingale #${this.martingaleState(asset).losses}`);
    }
  }

  checkPendingOrders() {
    for (const order of this.pendingOrders) {
      const market = this.markets.get(order.slug);
      if (!market) continue;
      const token = order.outcome === 'UP' ? market.up : market.down;
      const best = token?.mid ?? token?.ask ?? token?.bid;
      const nowSecs = Date.now() / 1000;
      if (nowSecs >= order.windowEnd || market.resolved) {
        order.status = 'cancelled';
        this.log(`❌ [0.30] LIMIT CANCELLED ${order.asset.toUpperCase()} ${order.outcome} @${LIMIT_PRICE_300.toFixed(2)} — no fill`);
      } else if (Number.isFinite(best) && best <= LIMIT_PRICE_300 && this.simulateGtcBookFill(token, 1, LIMIT_PRICE_300)) {
        order.status = 'filled';
        const opposite = this.pendingOrders.find(o => o !== order && o.status === 'pending' && o.windowStart === order.windowStart && o.asset === order.asset);
        if (opposite) {
          opposite.status = 'cancelled';
          this.log(`❌ [0.30] OPPOSITE ${opposite.outcome} ORDER CANCELLED — ${order.outcome} filled first`);
        }
        this.enterBet(market, token, order);
      }
    }
    this.pendingOrders = this.pendingOrders.filter(o => o.status !== 'cancelled' && o.status !== 'filled');
  }

  enterBet(market, token, order) {
    const asset = market.asset;
    const shares = this.currentShares(asset);
    // Resting maker limit fills at exactly the limit price — no slippage, no maker fee.
    const entryPrice = LIMIT_PRICE_300;
    const cost = round2(shares * LIMIT_PRICE_300);
    const fee = 0;
    const feeEquivalent = takerFeeFor(shares, LIMIT_PRICE_300);
    const rebateEstimate = makerRebateFor(shares, LIMIT_PRICE_300);
    if (cost > this.capital.value) {
      this.log(`⚠️ [0.30] ${asset.toUpperCase()} fill skipped — need $${round2(cost)}, available $${this.capital.value}`);
      return false;
    }
    this.bankroll = this.capital.value = round2(this.capital.value - cost);
    this.makerRebateAccrued = round2(this.makerRebateAccrued + rebateEstimate);
    const now = Date.now();
    const position = {
      id: `d300-${asset}-${market.windowStart}-${now}`,
      slug: market.slug, asset, conditionId: market.conditionId,
      outcome: token.outcome, tokenId: token.tokenId,
      shares, avgPrice: entryPrice, entryPrice, cost, fee,
      feeEquivalent, rebateEstimate,
      status: 'open', openedAt: now, markPrice: token.mid,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      stopLossPrice: null, engine: '0.30',
      signal: { limitPrice: LIMIT_PRICE_300, triggerSource: 'BOTH_SIDES_0.30_MAKER', bid: token.bid, ask: token.ask, mid: token.mid, elapsed: Math.floor(now / 1000 - market.windowStart) },
      martingaleIndex: this.martingaleState(asset).losses,
    };
    this.positions.push(position);
    this.betWindows.add(`${asset}:${market.windowStart}`);
    this.trades.push({ timestamp: now, orderType: 'PAPER-MAKER-LIMIT@0.30', engine: '0.30', asset, outcome: token.outcome, shares, price: entryPrice, cost, markPrice: token.mid, pnl: this.positionPnl(position), signal: position.signal, rebateEstimate });
    this.trades = this.trades.slice(-300);
    this.log(`⚡ [0.30] FILLED ${asset.toUpperCase()} ${token.outcome} ${shares}sh @${entryPrice.toFixed(3)} (maker limit 0.30, no fee) · martingale #${position.martingaleIndex} · cost $${cost.toFixed(2)} · rebate est. $${rebateEstimate.toFixed(5)}`);
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
      ...p,
      markValue: p.shares * (p.markPrice ?? p.avgPrice),
      unrealized: this.positionPnl(p),
    })).reverse();
  }

  // No stop loss — TP by resolution only
  settleByResolution() {
    for (const position of this.positions) {
      if (position.status !== 'open') continue;
      const market = this.markets.get(position.slug);
      if (!market?.resolved || !market.winner) continue;
      const won = position.outcome === market.winner;
      const payout = won ? position.shares : 0;
      const exitFee = 0; // resolution settlement carries no fee
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
      const st = this.martingaleState(position.asset);
      if (won) {
        this.wins++;
        st.shares = BASE_SHARES_300;
        st.losses = 0;
        this.consecutiveLosses = 0;
        this.log(`🏁 [0.30] ${position.asset.toUpperCase()} ${position.outcome} WIN — payout $${position.payout.toFixed(2)} · cost $${(position.cost + position.fee).toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · reset to ${BASE_SHARES_300} SH`);
      } else {
        this.losses++;
        this.consecutiveLosses += 1;
        if (this.consecutiveLosses > this.maxConsecutiveLosses) this.maxConsecutiveLosses = this.consecutiveLosses;
        st.losses += 1;
        st.shares = round2(BASE_SHARES_300 * Math.pow(MARTINGALE_300_MULT, st.losses));
        this.log(`🏁 [0.30] ${position.asset.toUpperCase()} ${position.outcome} LOSS — payout $0 · cost $${(position.cost + position.fee).toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · next bet ${st.shares} SH (1.5×)`);
      }
      this.resolvedPositions.unshift({ ...position });
      this.resolvedPositions = this.resolvedPositions.slice(0, 40);
    }
    this.positions = this.positions.filter(position => position.status === 'open');
  }

  buildState() {
    this.updatePositionMarks();
    const open = this.activePositionSummaries();
    const openValue = round2(open.reduce((sum, p) => sum + p.markValue, 0));
    const unrealizedPnl = round2(open.reduce((sum, p) => sum + p.unrealized, 0));
    const markValue = round2(this.capital.value + openValue);
    const martingale = Object.fromEntries([...this.martingale.entries()].map(([asset, st]) => [asset, { ...st }]));
    return {
      name: '0.30 Both-Side',
      strategy: 'Limit buy @0.30 both sides · cancel opposite on fill · no SL · TP=resolution · 1.5× martingale next window',
      bankroll: this.capital.value, markValue,
      realizedPnl: this.realizedPnl, openValue, unrealizedPnl,
      totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      makerRebateAccrued: this.makerRebateAccrued,
      martingale,
      consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      peakEquity: this.peakEquity,
      maxDrawdown: this.maxDrawdown,
      positions: open,
      resolvedPositions: this.resolvedPositions.slice(0, 30),
      trades: this.trades.slice(-160).reverse(),
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: this.logs.slice(-220),
      config: { baseShares: BASE_SHARES_300, limitPrice: LIMIT_PRICE_300, multiplier: MARTINGALE_300_MULT, resolutionPrice: RESOLUTION_PRICE, feeBps: TAKER_FEE_BPS, makerFeeRate: MAKER_FEE_RATE, takerFeeRate: TAKER_FEE_RATE, makerRebateRate: MAKER_REBATE_RATE },
    };
  }

  recordEquity() {
    const last = this.equityCurve[this.equityCurve.length - 1];
    const state = this.buildState();
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - state.markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: state.markValue });
      if (this.equityCurve.length > 4000) this.equityCurve = sampleCurve(this.equityCurve, 2000);
    }
    if (state.markValue > this.peakEquity) this.peakEquity = state.markValue;
    const dd = this.peakEquity - state.markValue;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }
}


function publicToken(token) {
  return {
    bid: token.bid, ask: token.ask, mid: token.mid, spread: token.spread,
    updatedAt: token.updatedAt,
  };
}

module.exports = {
  MartingaleBotEngine,
  DoubleSide300Engine,
  loadEquityFile,
  config: {
    ASSETS, LEAD_ASSET, START_BANKROLL, BASE_SHARES, TRIGGER_PRICE, LIMIT_PRICE,
    RESOLUTION_PRICE, TAKER_FEE_BPS, TAKER_FEE_RATE, MAKER_FEE_RATE, MAKER_REBATE_RATE,
  },
};
