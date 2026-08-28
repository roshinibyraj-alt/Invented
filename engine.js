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
const TP_PRICE = Number(process.env.TP_PRICE || 0.75);
const TP_RATIO = Number(process.env.TP_RATIO || 0.5);
const MARTINGALE_MULT = Number(process.env.MARTINGALE_MULT || 1.5);
const RESOLUTION_PRICE = Number(process.env.RESOLUTION_PRICE || 0.90);
const TAKER_FEE_RATE = Number(process.env.TAKER_FEE_RATE || 0.07);
const MAKER_REBATE_RATE = Number(process.env.MAKER_REBATE_RATE || 0.20);
const EQUITY_FILE = process.env.EQUITY_FILE || './equity.json';
const fs = require('fs');

function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function takerFee(shares, price) { return round5(shares * TAKER_FEE_RATE * price * (1 - price)); }
function makerRebate(shares, price) { return round5(takerFee(shares, price) * MAKER_REBATE_RATE); }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
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
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d) ? d : []; } catch (_) { return []; }
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
    const seededEquity = (options.initialEquity && Array.isArray(options.initialEquity) && options.initialEquity.length) ? options.initialEquity.slice() : null;
    this.equityCurve = seededEquity || [{ t: Date.now(), equity: START_BANKROLL }];
    this.lastEquitySaveAt = 0;
    this.makerRebateAccrued = 0;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.tickCount = 0;
    this.messageCount = 0;
    this.pollCount = 0;
    this.lastSuccessfulPollAt = null;
    this.logs = [];
    this.trades = [];
    this.positions = [];
    this.resolvedPositions = [];
    this.discoveredWindows = new Set();
    this.discoveryRunning = false;
    this.lastPollErrorAt = null;
    this.pollRunning = false;
    this.loopRunning = false;
    this.activeWindowStart = null;
    // Per-asset martingale: one shared counter
    this.martingale = new Map();
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = 0;
    this.peakEquity = seededEquity
      ? Math.max(START_BANKROLL, ...seededEquity.map(p => Number(p.equity) || 0))
      : START_BANKROLL;
    this.maxDrawdown = 0;
    // One window key per asset (cancel opposite = one bet per window)
    this.betWindows = new Set();
    this.pendingOrders = [];
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.emitLog(line);
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
    let market = null;
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
      market = Array.isArray(rows) ? rows[0] : null;
    } catch (e) {
      this.log(`⚠️ Discovery ${slug}: ${e.message}`);
      return null;
    }
    if (!market || !market.conditionId || !market.clobTokenIds || market.closed) return null;
    this.discoveredWindows.add(slug);
    const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes || [];
    const tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds || [];
    const upIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
    const dnIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
    if (upIdx < 0 || dnIdx < 0 || !tokenIds[upIdx] || !tokenIds[dnIdx]) return null;
    const record = {
      slug, asset, conditionId: market.conditionId,
      title: market.question || slug,
      windowStart: start, windowEnd: start + WINDOW_SECONDS,
      tradingClosed: false, resolved: false, winner: null,
      up: { tokenId: tokenIds[upIdx], slug, asset, outcome: 'UP', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [] },
      down: { tokenId: tokenIds[dnIdx], slug, asset, outcome: 'DOWN', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [] },
    };
    this.markets.set(slug, record);
    this.tokens.set(record.up.tokenId, record.up);
    this.tokens.set(record.down.tokenId, record.down);
    this.log(`🎯 ${asset.toUpperCase()} 5m discovered ${slug}`);
    return record;
  }

  hasOpenTradingMarket(start) {
    return [...this.markets.values()].some(m => m.windowStart === start && !m.tradingClosed && m.up.tokenId);
  }

  async discoverWindow(start, label) {
    await Promise.all(ASSETS.map(a => this.discoverMarket(a, start)));
    if (!this.activeWindowStart && this.hasOpenTradingMarket(start)) {
      this.activeWindowStart = start;
      this.log(`🚀 ${label} window active — ${start}`);
    }
  }

  async retryDiscovery() {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      const starts = [windowStartFor(Date.now()), windowStartFor(Date.now()) + WINDOW_SECONDS];
      const missing = [];
      for (const s of starts) for (const a of ASSETS) if (!this.markets.has(slugFor(a, s))) missing.push({ asset: a, start: s });
      if (missing.length) await Promise.all(missing.map(i => this.discoverMarket(i.asset, i.start)));
    } finally { this.discoveryRunning = false; }
  }

  // ── CLOB Book Polling ─────────────────────────────────────
  applyBook(token, bids, asks) {
    const validBids = bids.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    const validAsks = asks.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validBids.sort((a, b) => b.price - a.price);
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    const bestBid = validBids[0]?.price ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    const cleanBid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    const cleanAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid;
    token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
    this.pushHistory(token.tokenId, token.mid);
  }

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const s = this.history.get(tokenId) || [];
    s.push({ t: now, p: price });
    while (s.length > 2 && now - s[0].t > 5000) s.shift();
    this.history.set(tokenId, s.slice(-240));
  }

  simulateGtcBookFill(token, shares, ceiling) {
    const asks = token.bookAsks || [];
    let rem = shares, total = 0;
    for (const lv of asks) {
      if (lv.price > ceiling) break;
      if (rem <= 0) break;
      const fill = Math.min(lv.size, rem);
      total += round2(fill * lv.price);
      rem -= fill;
    }
    const filled = shares - rem;
    return filled > 0 ? { avgPrice: round5(total / filled), filled, totalCost: round2(total) } : null;
  }

  async pollClobBooks() {
    if (this.pollRunning) return;
    const now = Date.now(), currentStart = windowStartFor(now);
    const tokens = [...this.tokens.values()].filter(t => {
      const m = this.markets.get(t.slug);
      return m?.windowStart === currentStart && !m.tradingClosed && !m.resolved;
    });
    if (!tokens.length) return;
    this.pollRunning = true;
    try {
      const books = await this.postJSON(`${CLOB_REST}/books`, tokens.map(t => ({ token_id: t.tokenId })));
      const byToken = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id || ''), b]).filter(([id]) => this.tokens.has(id)));
      for (const t of tokens) {
        const b = byToken.get(t.tokenId);
        if (b) this.applyBook(t, b.bids || [], b.asks || []);
      }
      this.pollCount++;
      this.messageCount = this.pollCount;
      this.lastSuccessfulPollAt = Date.now();
      // Check TP on open positions
      for (const pos of this.positions) {
        if (pos.status === 'open' && !pos.tpSold) this.checkTpSell(pos);
      }
      this.updatePositionMarks();
      this.checkPendingOrders();
      this.evaluateEntries();
      this.tickCount++;
      this.emitTick(this.publicMarkets(), this.messageCount);
    } catch (e) {
      const should = !this.lastPollErrorAt || Date.now() - this.lastPollErrorAt >= 5000;
      if (should) { this.log(`⚠️ CLOB poll failed: ${e.message}`); this.lastPollErrorAt = Date.now(); }
    } finally { this.pollRunning = false; }
  }

  // ── Per-Asset Martingale State ─────────────────────────────
  mgState(asset) {
    if (!this.martingale.has(asset)) this.martingale.set(asset, { shares: BASE_SHARES, losses: 0 });
    return this.martingale.get(asset);
  }

  currentShares(asset) { return this.mgState(asset).shares; }

  // ── Strategy: 0.30 Both-Side Limit ────────────────────────
  // One pair per window; cancel opposite on fill
  evaluateEntries() {
    const currentStart = windowStartFor(Date.now());
    for (const market of this.markets.values()) {
      if (market.windowStart !== currentStart || market.resolved || market.tradingClosed) continue;
      const winKey = `${market.asset}:${market.windowStart}`;
      if (this.betWindows.has(winKey)) continue;
      if (this.pendingOrders.some(o => o.windowStart === market.windowStart)) continue;
      const asset = market.asset;
      const shares = this.currentShares(asset);
      this.pendingOrders.push(
        { id: `up-${asset}-${market.windowStart}-${Date.now()}`, asset, windowStart: market.windowStart, windowEnd: market.windowEnd, outcome: 'UP', tokenId: market.up.tokenId, slug: market.slug, limitPrice: LIMIT_PRICE, placedAt: Date.now(), status: 'pending' },
        { id: `dn-${asset}-${market.windowStart}-${Date.now()}`, asset, windowStart: market.windowStart, windowEnd: market.windowEnd, outcome: 'DOWN', tokenId: market.down.tokenId, slug: market.slug, limitPrice: LIMIT_PRICE, placedAt: Date.now(), status: 'pending' },
      );
      this.log(`📌 ${asset.toUpperCase()} LIMIT BOTH SIDES @${LIMIT_PRICE.toFixed(2)} — ${shares} SH · mg#0`);
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
        // Cancel opposite side
        const opposite = this.pendingOrders.find(o => o !== order && o.status === 'pending' && o.windowStart === order.windowStart && o.asset === order.asset);
        if (opposite) {
          opposite.status = 'cancelled';
          this.log(`❌ ${opposite.asset.toUpperCase()} ${opposite.outcome} cancelled — ${order.outcome} filled first`);
        }
        this.enterBet(market, token, order);
      }
    }
    this.pendingOrders = this.pendingOrders.filter(o => o.status === 'pending');
  }

  enterBet(market, token, order) {
    const { asset, outcome } = order;
    const shares = this.currentShares(asset);
    const entryPrice = LIMIT_PRICE;
    const cost = round2(shares * LIMIT_PRICE);
    const fee = 0;
    const rebateEstimate = makerRebate(shares, LIMIT_PRICE);
    if (cost > this.capital.value) {
      this.log(`⚠️ ${asset.toUpperCase()} ${outcome} fill skipped — need $${round2(cost)}, available $${round2(this.capital.value)}`);
      return false;
    }
    this.bankroll = round2(this.capital.value - cost);
    this.makerRebateAccrued = round2(this.makerRebateAccrued + rebateEstimate);
    const now = Date.now();
    const mg = this.mgState(asset);
    const position = {
      id: `bet-${asset}-${outcome}-${market.windowStart}-${now}`,
      slug: market.slug, asset, conditionId: market.conditionId,
      outcome, tokenId: token.tokenId,
      shares, entryPrice, cost, fee,
      remainingShares: shares, tpSold: false, tpPrice: null, tpRevenue: 0, tpFee: 0, tpSoldAt: null,
      rebateEstimate,
      status: 'open', openedAt: now, markPrice: token.mid,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      signal: { limitPrice: LIMIT_PRICE, triggerSource: 'BOTH_SIDES_0.30_MAKER', bid: token.bid, ask: token.ask, mid: token.mid },
      martingaleIndex: mg.losses,
    };
    this.positions.push(position);
    const winKey = `${asset}:${market.windowStart}`;
    this.betWindows.add(winKey);
    this.trades.push({ timestamp: now, orderType: 'MAKER-LIMIT@0.30', asset, outcome, shares, price: entryPrice, cost, markPrice: token.mid, pnl: 0, signal: position.signal, rebateEstimate });
    this.trades = this.trades.slice(-300);
    this.log(`⚡ FILLED ${asset.toUpperCase()} ${outcome} ${shares}sh @${entryPrice.toFixed(2)} · mg#${mg.losses} · cost $${cost.toFixed(2)} · rebate $${rebateEstimate.toFixed(5)}`);
    this.recordEquity();
    return true;
  }

  // ── TP at 0.75: sell half of remaining shares ──────────────
  checkTpSell(pos) {
    if (pos.status !== 'open' || pos.tpSold) return;
    const market = this.markets.get(pos.slug);
    const token = pos.outcome === 'UP' ? market?.up : market?.down;
    if (!token || !Number.isFinite(token.mid)) return;
    if (token.mid < TP_PRICE) return;
    // TP triggered — sell half of total shares (fixed quantity)
    const tpShares = round2(pos.shares * TP_RATIO);
    const sellFee = takerFee(tpShares, TP_PRICE);
    const netProceeds = round2(tpShares * TP_PRICE - sellFee);
    pos.tpSold = true;
    pos.tpPrice = TP_PRICE;
    pos.tpRevenue = netProceeds;
    pos.tpFee = sellFee;
    pos.tpSoldAt = Date.now();
    pos.remainingShares = round2(pos.shares - tpShares);
    // Credit TP proceeds back to capital
    this.bankroll = round2(this.capital.value + netProceeds);
    this.log(`💰 TP SELL ${pos.asset.toUpperCase()} ${pos.outcome} ${tpShares}sh @${TP_PRICE.toFixed(2)} · proceeds $${netProceeds.toFixed(2)} · fee $${sellFee.toFixed(5)} · ${pos.remainingShares}sh remaining`);
    this.trades.push({
      timestamp: pos.tpSoldAt, orderType: 'TP-SELL@0.75',
      asset: pos.asset, outcome: pos.outcome, shares: tpShares, price: TP_PRICE,
      cost: round2(tpShares * TP_PRICE), fee: sellFee,
      markPrice: token.mid, pnl: round2(netProceeds - round2(tpShares * LIMIT_PRICE)),
      signal: { triggerSource: 'TP_0.75', mid: token.mid },
      rebateEstimate: 0,
    });
    this.trades = this.trades.slice(-300);
    this.recordEquity();
  }

  positionPnl(pos) {
    if (!pos || pos.status !== 'open') return 0;
    const mp = pos.markPrice ?? pos.entryPrice;
    if (pos.tpSold) {
      // Unrealized = TP revenue (already realized) + remaining shares mark value
      return round2(pos.tpRevenue + pos.remainingShares * mp - pos.cost);
    }
    return round2(pos.shares * mp - pos.cost);
  }

  updatePositionMarks() {
    for (const pos of this.positions) {
      if (pos.status !== 'open') continue;
      const m = this.markets.get(pos.slug);
      const t = pos.outcome === 'UP' ? m?.up : m?.down;
      if (Number.isFinite(t?.mid)) pos.markPrice = t.mid;
    }
  }

  activePositionSummaries() {
    return this.positions.filter(p => p.status === 'open').map(p => ({
      ...p, markValue: p.remainingShares * (p.markPrice ?? p.entryPrice) + (p.tpSold ? p.tpRevenue : 0),
      unrealized: this.positionPnl(p),
    })).reverse();
  }

  // ── Resolution: win/loss controls martingale ───────────────
  settleByResolution() {
    for (const pos of this.positions) {
      if (pos.status !== 'open') continue;
      const market = this.markets.get(pos.slug);
      if (!market?.resolved || !market.winner) continue;
      const won = pos.outcome === market.winner;
      const payout = round2(won ? pos.remainingShares * 1 : 0);
      const exitFee = 0;
      const pnl = round2(pos.tpRevenue + payout - exitFee - pos.cost - pos.tpFee);
      pos.status = 'closed';
      pos.won = won;
      pos.payout = round2(pos.tpRevenue + payout);
      pos.pnl = pnl;
      pos.exitPrice = won ? 1 : 0;
      pos.closedAt = Date.now();
      pos.closeReason = 'RESOLUTION';
      pos.winner = market.winner;
      // Credit remaining payout (if any)
      if (payout > 0) this.bankroll = round2(this.capital.value + payout);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      const mg = this.mgState(pos.asset);
      if (won) {
        this.wins++;
        this.consecutiveLosses = 0;
        mg.shares = BASE_SHARES;
        mg.losses = 0;
        this.log(`🏁 ${pos.asset.toUpperCase()} ${pos.outcome} WIN · payout $${pos.payout.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · reset to ${BASE_SHARES} SH`);
      } else {
        this.losses++;
        this.consecutiveLosses += 1;
        if (this.consecutiveLosses > this.maxConsecutiveLosses) this.maxConsecutiveLosses = this.consecutiveLosses;
        mg.losses += 1;
        mg.shares = round2(BASE_SHARES * Math.pow(MARTINGALE_MULT, mg.losses));
        this.log(`🏁 ${pos.asset.toUpperCase()} ${pos.outcome} LOSS · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · next bet ${mg.shares} SH (1.5×)`);
      }
      this.resolvedPositions.unshift({ ...pos });
      this.resolvedPositions = this.resolvedPositions.slice(0, 40);
    }
    this.positions = this.positions.filter(p => p.status === 'open');
  }

  // ── Rotation / Sweep / Equity ──────────────────────────────
  async rotateAndSweep() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      const start = windowStartFor(Date.now());
      if (start !== this.activeWindowStart) { this.activeWindowStart = null; await this.discoverWindow(start, 'New'); }
      for (const market of this.markets.values()) {
        if (!market.resolved && Date.now() / 1000 >= market.windowEnd) {
          this.resolveMarketByLastPrice(market);
        }
      }
      this.settleByResolution();
      this.pruneExpiredMarkets();
      this.recordEquity();
    } catch (e) { this.log(`⚠️ Loop: ${e.message}`); } finally { this.loopRunning = false; }
  }

  resolveMarketByLastPrice(market) {
    if (market.resolved) return;
    market.tradingClosed = true;
    market.resolved = true;
    const upMid = Number.isFinite(market.up.mid) ? market.up.mid : 0.5;
    const downMid = Number.isFinite(market.down.mid) ? market.down.mid : 0.5;
    market.winner = upMid > downMid ? 'UP' : downMid > upMid ? 'DOWN' : 'UP';
    market.resolutionSource = 'CLOB_MID_LAST';
  }

  pruneExpiredMarkets() {
    const cutoff = Date.now() / 1000 - 2;
    const expired = [...this.markets.values()].filter(m => m.windowEnd < cutoff);
    for (const m of expired) {
      this.markets.delete(m.slug);
      this.tokens.delete(m.up.tokenId);
      this.tokens.delete(m.down.tokenId);
      this.history.delete(m.up.tokenId);
      this.history.delete(m.down.tokenId);
    }
    if (expired.length) this.log(`🧹 Released ${expired.length} expired market(s)`);
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

  isClobFresh() { return Boolean(this.lastSuccessfulPollAt && Date.now() - this.lastSuccessfulPollAt <= CLOB_FRESH_MS); }

  publicMarkets() {
    const cs = windowStartFor(Date.now());
    return [...this.markets.values()]
      .filter(m => m.windowStart === cs)
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
    const openValue = round2(open.reduce((s, p) => s + p.markValue, 0));
    const unrealizedPnl = round2(open.reduce((s, p) => s + p.unrealized, 0));
    const markValue = round2(this.capital.value + openValue);
    const martingale = Object.fromEntries([...this.martingale.entries()].map(([k, st]) => [k, { ...st }]));
    return {
      bankroll: this.capital.value, markValue,
      realizedPnl: this.realizedPnl, openValue, unrealizedPnl,
      totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      makerRebateAccrued: this.makerRebateAccrued,
      martingale, consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      peakEquity: this.peakEquity, maxDrawdown: this.maxDrawdown,
      connected: this.isClobFresh(), tickCount: this.tickCount,
      trackedTokens: this.tokens.size,
      markets: this.publicMarkets(),
      positions: open,
      resolvedPositions: this.resolvedPositions.slice(0, 30),
      trades: this.trades.slice(-160).reverse(),
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: this.logs.slice(-220),
      config: { baseShares: BASE_SHARES, limitPrice: LIMIT_PRICE, tpPrice: TP_PRICE, tpRatio: TP_RATIO, multiplier: MARTINGALE_MULT, resolutionPrice: RESOLUTION_PRICE, takerFeeRate: TAKER_FEE_RATE, makerRebateRate: MAKER_REBATE_RATE },
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async init() {
    const start = windowStartFor(Date.now());
    await Promise.all([this.discoverWindow(start, 'Current'), this.discoverWindow(start + WINDOW_SECONDS, 'Next')]);
    await this.pollClobBooks();
    setInterval(() => this.rotateAndSweep(), 250);
    setInterval(() => this.pollClobBooks(), CLOB_POLL_MS);
    setInterval(() => this.retryDiscovery(), 1500);
    this.log(`🚀 Bot started | ${ASSETS.join('/')} | 0.30 both sides · cancel opposite · TP@${TP_PRICE} half · ${MARTINGALE_MULT}× mg · base ${BASE_SHARES} SH`);
  }
}

module.exports = { BotEngine, loadEquityFile, config: { ASSETS, START_BANKROLL, BASE_SHARES, LIMIT_PRICE, TP_PRICE, TP_RATIO, MARTINGALE_MULT, RESOLUTION_PRICE, TAKER_FEE_RATE, MAKER_REBATE_RATE } };
