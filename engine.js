'use strict';

// ── Config (env-overridable) ───────────────────────────────
const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';

const WINDOW_SECONDS = 300;                     // BTC 5m windows
const WAIT_SECONDS   = Number(process.env.WAIT_SECONDS   || 45);   // (unused, kept for compat)
const BASE_PCT       = Number(process.env.BASE_PCT       || 0.05); // 5% of bankroll in dollars
const START_BANKROLL = Number(process.env.START_BANKROLL  || 300);
const TP_PRICE       = Number(process.env.TP_PRICE       || 0.50); // take-profit target
const TAKER_FEE_RATE = Number(process.env.TAKER_FEE_RATE || 0.07);
const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));

// Three independent checks — each has its own timeout (seconds) and threshold (ask price)
const CHECKS = [
  { id: 1, timeout: Number(process.env.CHECK1_TIMEOUT || 9),  threshold: Number(process.env.CHECK1_THRESHOLD || 0.35) },
  { id: 2, timeout: Number(process.env.CHECK2_TIMEOUT || 17), threshold: Number(process.env.CHECK2_THRESHOLD || 0.25) },
  { id: 3, timeout: Number(process.env.CHECK3_TIMEOUT || 30), threshold: Number(process.env.CHECK3_THRESHOLD || 0.20) },
];

// ── Helpers ────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function takerFee(C, p, rate = TAKER_FEE_RATE) { return round5(C * rate * p * (1 - p)); }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

class CheapHunterEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'CheapHunter45';
    this.startedAt = Date.now();

    this.bankroll = options.bankroll ?? START_BANKROLL;
    this.initialBankroll = this.bankroll;
    this.realizedPnl = 0;
    this.totalFeesPaid = 0;
    this.wins = 0;
    this.losses = 0;
    this.peakEquity = this.bankroll;
    this.maxDrawdown = 0;

    this.markets = new Map();
    this.tokens = new Map();
    this.discoveryJobs = new Map();
    this.currentStart = windowStartFor(Date.now());

    // Per-window state
    this.windowStartFor = null;
    this.baseCost = 0;
    this.openEntries = [];          // active position objects (can be up to 3)
    this.windowChecks = [];         // per-window check state: [{fired, timeout, threshold}]
    this.positions = [];
    this.results = [];
    this.trades = [];
    this.windowPaused = false;
    this.windowJustOpened = false;
    this.pauseReason = null;

    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: this.bankroll }];

    this.entryWindow = null;
    this.pollInFlight = 0;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;
    this.lastError = null;
    this.pollCount = 0;
    this.tickCount = 0;
    this.timers = [];
  }

  log(message) {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.onLog(line);
  }

  parseJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  async requestJSON(url, options = {}, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, {
        ...options, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'cheap-hunter/1.0', ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  // ── Discovery ─────────────────────────────────────────────
  discoverWindow(start) {
    const slug = slugFor(start);
    if (this.markets.has(slug)) return Promise.resolve(this.markets.get(slug));
    if (this.discoveryJobs.has(slug)) return this.discoveryJobs.get(slug);
    const job = (async () => {
      try {
        const rows = await this.requestJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, {}, 8000);
        const market = Array.isArray(rows) ? rows[0] : null;
        if (!market?.conditionId || market.closed) throw new Error('market unavailable or closed');
        const outcomes = this.parseJson(market.outcomes) || [];
        const tokenIds = this.parseJson(market.clobTokenIds) || [];
        const ui = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
        const di = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
        if (ui < 0 || di < 0 || !tokenIds[ui] || !tokenIds[di]) throw new Error('missing up/down tokens');
        const rec = {
          slug, title: market.question || slug, conditionId: market.conditionId,
          windowStart: start, windowEnd: start + WINDOW_SECONDS, settled: false, winner: null,
          up: this.makeToken(String(tokenIds[ui]), slug, 'UP'),
          down: this.makeToken(String(tokenIds[di]), slug, 'DOWN'),
        };
        this.markets.set(slug, rec);
        this.log(`🎯 MARKET ${slug} · ${rec.title}`);
        return rec;
      } catch (error) {
        this.lastError = error.message;
        if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt > 5000) {
          this.lastPollErrorAt = Date.now();
          this.log(`DISCOVERY FAIL ${slug}: ${error.message}`);
        }
        return null;
      } finally { this.discoveryJobs.delete(slug); }
    })();
    this.discoveryJobs.set(slug, job);
    return job;
  }

  makeToken(tokenId, slug, outcome) {
    const token = { tokenId: String(tokenId), slug, outcome, bid: null, ask: null, mid: null, spread: null, topAskNotional: 0, updatedAt: null, bookAsks: [], bookBids: [], prevAsk: null };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  applyBook(token, bids, asks) {
    token.prevAsk = token.ask;
    const validBids = (bids || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validBids.sort((a, b) => b.price - a.price);
    const validAsks = (asks || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookBids = validBids;
    token.bookAsks = validAsks;
    const bestBid = validBids[0]?.price ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    token.topAskNotional = validAsks[0] ? round2(validAsks[0].price * validAsks[0].size) : 0;
    token.bid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    token.ask = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    token.spread = token.bid != null && token.ask != null ? round5(token.ask - token.bid) : null;
    token.mid = token.bid != null && token.ask != null ? round5((token.bid + token.ask) / 2) : (token.ask ?? token.bid);
    token.updatedAt = Date.now();
  }

  async pollClob() {
    if (this.pollInFlight >= 2) return;
    const now = Date.now();
    const cs = windowStartFor(now);
    const markets = [this.markets.get(slugFor(cs)), this.markets.get(slugFor(cs + WINDOW_SECONDS))].filter(Boolean);
    const tokens = markets.flatMap(m => [m.up, m.down]);
    if (!tokens.length) { this.lastPollAt = Date.now(); return; }
    this.pollInFlight += 1;
    try {
      const books = await this.requestJSON(`${CLOB_REST}/books`, {
        method: 'POST',
        body: JSON.stringify(tokens.map(t => ({ token_id: t.tokenId }))),
      }, CLOB_TIMEOUT_MS);
      const byToken = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id || ''), b]));
      for (const t of tokens) {
        const b = byToken.get(t.tokenId);
        if (b) this.applyBook(t, b.bids || [], b.asks || []);
      }
      this.lastSuccessfulPollAt = Date.now();
      this.lastPollAt = Date.now();
      this.lastError = null;
      this.pollCount += 1;
      this.tickCount += 1;
    } catch (error) {
      this.lastError = error.message;
      if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt > 5000) {
        this.lastPollErrorAt = Date.now();
        this.log(`CLOB POLL FAIL ${error.message}`);
      }
    } finally { this.pollInFlight -= 1; }
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
  }

  // ── Strategy: 3 independent checks ──────────────────────
  computeBaseForNextWindow() {
    this.baseCost = Math.max(1, Math.round(this.bankroll * BASE_PCT * 100) / 100);
  }

  prepareWindow(market) {
    this.windowStartFor = market.windowStart;
    this.openEntries = [];
    this.windowPaused = false;
    this.pauseReason = null;
    this.computeBaseForNextWindow();
    this.windowOpenedAt = Date.now();
    this.windowJustOpened = true;
    // Init 3 independent checks — each unfired
    this.windowChecks = CHECKS.map(c => ({ ...c, fired: false }));
    const checkDesc = CHECKS.map(c => `C${c.id}≤${c.threshold.toFixed(2)}@${c.timeout}s`).join(' · ');
    this.log(`🆕 WINDOW ${market.slug.slice(-10)} — BASE $${this.baseCost.toFixed(2)} = ${BASE_PCT*100}% · ${checkDesc} · TP @ ${TP_PRICE.toFixed(2)}`);
    this.onTick(this.buildState());
  }

  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));

    // Resolve any open positions whose window has ended
    this.resolveExpired(market, nowS);

    if (!market) return;
    if (this.entryWindow != null && market.windowStart < this.entryWindow) return;
    if (this.windowStartFor !== market.windowStart) this.prepareWindow(market);

    const elapsed = Math.floor(nowS - market.windowStart);

    if (!this.windowPaused) {
      // Check TP on all open positions
      this.checkTp(market);

      // Run each independent check (skip on exact tick window opens to avoid double-fire)
      if (this.windowJustOpened) {
        this.windowJustOpened = false;
      } else {
        for (const check of this.windowChecks) {
          if (check.fired) continue;
          if (elapsed <= check.timeout) {
            this.tryCheckEntry(market, check, elapsed);
          } else {
            check.fired = true;
            this.log(`⏰ CHECK ${check.id} EXPIRED — no side ≤ ${check.threshold.toFixed(2)} within ${check.timeout}s`);
          }
        }
      }
    }

    this.recordEquity();
    this.onTick(this.buildState());
  }

  tryCheckEntry(market, check, elapsed) {
    const upAsk = market.up.ask, dnAsk = market.down.ask;
    if (upAsk == null || dnAsk == null) return;
    let side = null, ask = null;
    if (upAsk <= check.threshold && dnAsk <= check.threshold) {
      ask = upAsk; side = 'UP';
      if (dnAsk < upAsk) { ask = dnAsk; side = 'DOWN'; }
    } else if (upAsk <= check.threshold) { side = 'UP'; ask = upAsk; }
    else if (dnAsk <= check.threshold) { side = 'DOWN'; ask = dnAsk; }
    if (!side) return; // neither side cheap enough yet
    check.fired = true;
    const shares = Math.max(1, Math.floor(this.baseCost / ask));
    const cost = round2(shares * ask);
    const fee = takerFee(shares, ask);
    if (cost + fee > this.bankroll) {
      this.log(`⚠️ SKIP CHECK ${check.id} ${side} @ ${ask.toFixed(3)} — bankroll $${this.bankroll.toFixed(2)} < cost+fee $${(cost+fee).toFixed(2)}`);
      return;
    }
    this.executeEntry(market, side, shares, ask, check);
  }

  executeEntry(market, outcome, shares, fillPrice, check) {
    const price = fillPrice;
    const cost = round2(shares * price);
    const fee = takerFee(shares, price);
    this.bankroll = round2(this.bankroll - cost - fee);
    this.totalFeesPaid = round2(this.totalFeesPaid + fee);
    this.openEntry = outcome;

    const position = {
      slug: market.slug, outcome, market,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      shares, entryPrice: price, cost, buyFee: fee,
      openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null,
      entryNo: check.id, tpTarget: TP_PRICE,
    };
    this.openEntries.push(position);
    this.positions.push(position);
    this.trades.push({ timestamp: Date.now(), type: 'BUY', slug: market.slug, outcome, shares, price, cost, fee,
      reason: `CHECK ${check.id} · ${outcome} ${shares}sh @ ${price.toFixed(3)} ≤ ${check.threshold.toFixed(2)}` });
    this.log(`⚡ CHECK ${check.id} BUY ${outcome} ${shares}sh @ ${price.toFixed(3)} · cost $${cost.toFixed(2)} · fee $${fee.toFixed(4)} · ≤ ${check.threshold.toFixed(2)}`);
    this.onTick(this.buildState());
  }

  checkTp(market) {
    // Check TP on ALL open positions (not just one)
    for (const pos of this.openEntries) {
      if (pos.exitReason != null) continue;
      const token = pos.outcome === 'UP' ? market.up : market.down;
      const px = token.mid ?? token.bid ?? token.ask;
      if (px == null) continue;
      if (px >= pos.tpTarget) {
        this.sellPosition(pos, pos.tpTarget, 'TP_LIMIT');
        this.log(`✅ TP LIMIT CHECK ${pos.entryNo} at ${pos.tpTarget.toFixed(2)} — mid ${px.toFixed(3)} >= target`);
      }
    }
    // Clean up closed positions from openEntries
    this.openEntries = this.openEntries.filter(p => p.exitReason == null);
  }

  resolveExpired(market, nowS) {
    const open = this.positions.filter(p => p.exitReason == null);
    const buckets = new Map();
    for (const pos of open) {
      if (!buckets.has(pos.slug)) buckets.set(pos.slug, []);
      buckets.get(pos.slug).push(pos);
    }
    for (const [slug, group] of buckets) {
      const m = group[0]?.market;
      if (!m || nowS < m.windowEnd) continue;
      m.settled = true;
      const upMid = m.up.mid, downMid = m.down.mid;
      let winner = null;
      if (upMid != null && downMid != null) winner = upMid >= downMid ? 'UP' : 'DOWN';
      else if (upMid != null) winner = upMid >= 0.5 ? 'UP' : 'DOWN';
      else if (downMid != null) winner = downMid >= 0.5 ? 'DOWN' : 'UP';
      if (!winner) winner = 'UP';
      m.winner = winner;
      let winPayout = 0, lossCost = 0;
      for (const pos of group) {
        const won = pos.outcome === winner;
        const exitPrice = won ? 1 : 0;
        this.sellPosition(pos, exitPrice, 'RESOLUTION', { winner, won });
        const payout = won ? pos.shares : 0;
        if (won) winPayout += payout; else lossCost += pos.cost;
      }
      this.log(`🏁 WINDOW ${m.slug.slice(-10)} RESOLVED → ${winner} · win payout $${winPayout.toFixed(2)} · loss cost $${lossCost.toFixed(2)}`);
    }
    if (buckets.size) this.positions = this.positions.filter(p => p.exitReason == null);
  }

  sellPosition(position, price, reason, extra = {}) {
    if (position.exitReason != null) return;
    const proceeds = round2(position.shares * price);
    const fee = (price > 0 && price < 1) ? takerFee(position.shares, price) : 0;
    const pnl = round2(proceeds - position.cost - (position.buyFee || 0) - fee);
    if (pnl >= 0) this.wins++; else this.losses++;
    this.bankroll = round2(this.bankroll + proceeds - fee);
    this.totalFeesPaid = round2(this.totalFeesPaid + fee);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    position.pnl = pnl;
    position.exitPrice = price;
    position.exitReason = reason;
    position.sellFee = fee;
    position.closedAt = Date.now();
    position.won = extra.won != null ? extra.won : pnl > 0;
    this.results.unshift({ ...position, market: undefined });
    this.results = this.results.slice(0, 50);
    this.trades.push({ timestamp: Date.now(), type: 'SELL', slug: position.slug, outcome: position.outcome, shares: position.shares, price, pnl, fee, reason, ...extra });
    const tag = reason === 'RESOLUTION' ? '🏁 RESOLUTION' : reason === 'TP_LIMIT' ? '✅ TP LIMIT' : '💰 SELL';
    this.log(`${tag} C${position.entryNo} ${position.outcome} @ ${price.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · ${position.shares}sh`);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── State / equity ────────────────────────────────────────
  markValue() {
    const open = this.positions.filter(p => p.exitReason == null);
    const openCost = open.reduce((s, p) => s + p.cost, 0);
    const openMv = open.reduce((s, p) => {
      const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
      const mark = token?.mid ?? p.entryPrice;
      return s + round2(p.shares * mark);
    }, 0);
    return round2(this.bankroll + openMv - openCost - open.reduce((s, p) => s + (p.buyFee || 0), 0));
  }

  publicMarket(market) {
    const now = Date.now();
    return {
      slug: market.slug, title: market.title,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      remaining: Math.max(0, market.windowEnd - Math.floor(now / 1000)),
      elapsed: Math.max(0, Math.floor(now / 1000 - market.windowStart)),
      settled: market.settled, winner: market.winner,
      up: { bid: market.up.bid, ask: market.up.ask, mid: market.up.mid, spread: market.up.spread, topAskNotional: market.up.topAskNotional, updatedAt: market.up.updatedAt },
      down: { bid: market.down.bid, ask: market.down.ask, mid: market.down.mid, spread: market.down.spread, topAskNotional: market.down.topAskNotional, updatedAt: market.down.updatedAt },
    };
  }

  buildState() {
    const now = Date.now();
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));
    const open = this.positions.filter(p => p.exitReason == null);
    const openUnrealized = open.reduce((s, p) => {
      const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
      const mark = token?.mid ?? p.entryPrice;
      return s + round2(p.shares * mark - p.cost);
    }, 0);
    return {
      version: '4.0.0',
      name: this.name,
      strategy: `3-Check CheapHunter · C1≤0.35@9s · C2≤0.25@17s · C3≤0.20@30s · TP @ ${TP_PRICE.toFixed(2)} · ${BASE_PCT*100}% base`,
      serverTime: now,
      connected: this.pollCount > 0 || this.tickCount > 0,
      lastError: this.lastError,
      pollCount: this.pollCount,
      tickCount: this.tickCount,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      bankroll: this.bankroll,
      markValue: this.markValue(),
      realizedPnl: this.realizedPnl,
      totalFeesPaid: this.totalFeesPaid,
      unrealizedPnl: round2(openUnrealized),
      totalPnl: round2(this.markValue() - this.initialBankroll),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      entryWindow: this.entryWindow,
      waitingForWindow: this.entryWindow != null && cs < this.entryWindow,
      windowPaused: this.windowPaused,
      currentWindow: market ? this.publicMarket(market) : null,
      baseCost: this.baseCost,
      openEntryCount: this.openEntries.length,
      windowElapsed: market ? Math.max(0, Math.floor(now / 1000 - market.windowStart)) : 0,
      checks: (this.windowChecks || []).map(c => ({ id: c.id, threshold: c.threshold, timeout: c.timeout, fired: c.fired })),
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
        const mark = token?.mid ?? p.entryPrice;
        return { outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, markPrice: mark, unrealized: round2(p.shares * mark - p.cost), remaining: p.windowEnd ? Math.max(0, p.windowEnd - Math.floor(now / 1000)) : null, entryNo: p.entryNo };
      }),
      tradeCount: this.trades.length,
      trades: this.trades.slice(-60).reverse(),
      results: this.results.slice(0, 30),
      equityCurve: this.equityCurveForUi(),
      logs: this.logs.slice(-160),
      peakEquity: this.peakEquity,
      drawdown: round2(this.peakEquity - this.markValue()),
      maxDrawdown: this.maxDrawdown,
      uptime: Math.floor((now - this.startedAt) / 1000),
      config: {
        checks: CHECKS, tpPrice: TP_PRICE, basePct: BASE_PCT, baseCost: this.baseCost,
        bankroll: this.initialBankroll, pollMs: CLOB_POLL_MS, takerFeeRate: TAKER_FEE_RATE,
      },
    };
  }

  recordEquity() {
    const mark = this.markValue();
    if (mark > this.peakEquity) this.peakEquity = mark;
    const dd = this.peakEquity - mark;
    if (dd > this.maxDrawdown) this.maxDrawdown = round2(dd);
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - mark) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: mark });
    }
  }

  equityCurveForUi() {
    const FULL = this.equityCurve;
    if (FULL.length <= 3000) return FULL;
    const step = Math.ceil(FULL.length / 3000);
    const out = [];
    for (let i = 0; i < FULL.length; i += step) out.push(FULL[i]);
    const last = FULL[FULL.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }

  // ── Main loop ─────────────────────────────────────────────
  async init() {
    const start = windowStartFor(Date.now());
    this.entryWindow = start + WINDOW_SECONDS;
    this.log(`⏳ Started mid-window ${start} — trading begins at next window ${this.entryWindow}`);
    await Promise.all([this.discoverWindow(start), this.discoverWindow(start + WINDOW_SECONDS)]);
    this.timers = [
      setInterval(() => { this.pollClob().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => { this.discoverWindow(windowStartFor(Date.now())).catch(() => {}); this.discoverWindow(windowStartFor(Date.now()) + WINDOW_SECONDS).catch(() => {}); }, 5000),
      setInterval(() => this.evaluate(), 200),
      setInterval(() => this.recordEquity(), 1000),
    ];
    const checkDesc = CHECKS.map(c => `C${c.id}≤${c.threshold} within ${c.timeout}s`).join(' · ');
    this.log(`🚀 CheapHunter started | ${checkDesc} · TP @ ${TP_PRICE} · ${BASE_PCT*100}% base · no SL · no martingale`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { CheapHunterEngine, config: { CHECKS, TP_PRICE, BASE_PCT, START_BANKROLL, CLOB_POLL_MS, TAKER_FEE_RATE } };
