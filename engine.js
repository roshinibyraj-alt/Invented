'use strict';

// ── Config ────────────────────────────────────────────────
const GAMMA_API   = process.env.GAMMA_API   || 'https://gamma-api.polymarket.com';
const CLOB_REST   = process.env.CLOB_REST   || 'https://clob.polymarket.com';
const WINDOW_SECONDS = 300;
const TAKER_FEE_RATE = Number(process.env.TAKER_FEE_RATE || 0.07);
const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));
const START_BANKROLL  = Number(process.env.START_BANKROLL || 500);

// Price ladder — 6 limit buy order levels, 100 shares each
const ORDER_SHARES = 100;
const LADDER_PRICES = [0.40, 0.35, 0.30, 0.25, 0.20, 0.15];

// ── Helpers ───────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function takerFee(shares, price) { return round5(shares * TAKER_FEE_RATE * price * (1 - price)); }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

// ── Binance 5m Candle Signal ──────────────────────────────
class CandleSignalManager {
  constructor(log) {
    this.log = log;
    this.lastClosedCandle = null; // { open, close, color, windowStart }
    this.currentCandle = null;   // { open, close }
    this.ws = null;
    this.connected = false;
    this.lastColor = null;       // 'GREEN' or 'RED'
  }

  connect() {
    try {
      if (typeof WebSocket === 'undefined') {
        this.log('⚠️ WebSocket unavailable in this Node version — no candle signal');
        return;
      }
      this.ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_5m');
      this.ws.onopen = () => {
        this.connected = true;
        this.log('✅ Binance WS connected (btcusdt 5m kline)');
      };
      this.ws.onmessage = (e) => this._onMessage(e);
      this.ws.onclose = () => {
        this.connected = false;
        this.log('🔌 Binance WS closed — reconnecting in 5s');
        setTimeout(() => this.connect(), 5000);
      };
      this.ws.onerror = (err) => {
        this.connected = false;
        this.log(`⚠️ Binance WS error: ${err.message || 'unknown'}`);
      };
    } catch (err) {
      this.log(`⚠️ Binance WS failed: ${err.message}`);
    }
  }

  _onMessage(event) {
    try {
      const msg = JSON.parse(event.data);
      const k = msg.k;
      if (!k) return;
      const o = parseFloat(k.o), c = parseFloat(k.c);
      this.currentCandle = { open: o, close: c };
      if (k.x) {
        const color = c > o ? 'GREEN' : (c < o ? 'RED' : 'NEUTRAL');
        const closeTime = k.T;
        const wStart = Math.floor(closeTime / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
        this.lastClosedCandle = { open: o, close: c, color, windowStart: wStart };
        this.lastColor = color;
        this.log(`🕯️ Candle closed ${color} (O:${o.toFixed(2)} C:${c.toFixed(2)}) — signals for window ${wStart + WINDOW_SECONDS}`);
      }
    } catch (_) {}
  }

  getColor() {
    return this.lastColor || 'NEUTRAL';
  }

  buildState() {
    const cc = this.currentCandle || this.lastClosedCandle;
    return {
      connected: this.connected,
      lastColor: this.lastColor,
      candleOpen: cc?.open ?? null,
      candleClose: cc?.close ?? null,
    };
  }
}

// ── Engine ────────────────────────────────────────────────
class CheapHunterEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'CandleBot';
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
    this.windowStartFor = null;
    this.positions = [];
    this.results = [];
    this.trades = [];
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
    this.candle = new CandleSignalManager((m) => this.log(m));
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
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'candlebot/1.0', ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  // ── Discovery (slug-only, no fallback) ──────────────────
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
          up: this._makeToken(String(tokenIds[ui]), slug, 'UP'),
          down: this._makeToken(String(tokenIds[di]), slug, 'DOWN'),
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

  _makeToken(tokenId, slug, outcome) {
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

  // ── CLOB Polling ───────────────────────────────────────
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

  // ── Window Open: Place 6 Limit Orders ──────────────────
  _prepareWindow(market) {
    this.windowStartFor = market.windowStart;
    const color = this.candle.getColor();
    const side = color === 'GREEN' ? 'UP' : (color === 'RED' ? 'DOWN' : null);

    if (!side) {
      this.log(`⏭️ No candle signal (${color}) — skipping window ${market.slug.slice(-10)}`);
      this.onTick(this.buildState());
      return;
    }

    this.log(`🚀 WINDOW ${market.slug.slice(-10)} — signal ${color} → BUY ${side} × ${LADDER_PRICES.length} limit orders`);

    for (const price of LADDER_PRICES) {
      const cost = round2(ORDER_SHARES * price);
      const fee = takerFee(ORDER_SHARES, price);
      if (cost + fee > this.bankroll) {
        this.log(`⚠️ SKIP BUY ${side} ${ORDER_SHARES}sh @ $${price.toFixed(2)} — bankroll $${this.bankroll.toFixed(2)} < cost+fee $${(cost + fee).toFixed(2)}`);
        continue;
      }
      this.bankroll = round2(this.bankroll - cost - fee);
      this.totalFeesPaid = round2(this.totalFeesPaid + fee);
      const position = {
        slug: market.slug, outcome: side, market,
        windowStart: market.windowStart, windowEnd: market.windowEnd,
        shares: ORDER_SHARES, entryPrice: price, cost, buyFee: fee,
        openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null,
      };
      this.positions.push(position);
      this.trades.push({
        timestamp: Date.now(), type: 'BUY', slug: market.slug, outcome: side,
        shares: ORDER_SHARES, price, cost, fee,
        reason: `LADDER @ $${price.toFixed(2)} · ${side} ${ORDER_SHARES}sh`,
      });
      this.log(`✅ BUY ${side} ${ORDER_SHARES}sh @ $${price.toFixed(2)} · cost $${cost.toFixed(2)} · fee $${fee.toFixed(4)}`);
    }
    this.onTick(this.buildState());
  }

  // ── Resolution ─────────────────────────────────────────
  _resolveExpiredPositions(market, nowS) {
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
        this._sellPosition(pos, exitPrice, 'RESOLUTION', { winner, won });
        if (won) winPayout += pos.shares; else lossCost += pos.cost;
      }
      this.log(`🏁 WINDOW ${m.slug.slice(-10)} RESOLVED → ${winner} won · payout $${winPayout.toFixed(2)} · loss $${lossCost.toFixed(2)}`);
      for (const pos of group) {
        const tag = pos.outcome === winner ? 'WIN' : 'LOSS';
        this.log(`   ${tag} ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L ${pos.pnl >= 0 ? '+' : '-'}$${Math.abs(pos.pnl).toFixed(2)}`);
      }
    }
    if (buckets.size) this.positions = this.positions.filter(p => p.exitReason == null);
  }

  _sellPosition(position, price, reason, extra = {}) {
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
    this.trades.push({
      timestamp: Date.now(), type: 'SELL', slug: position.slug, outcome: position.outcome,
      shares: position.shares, price, pnl, fee, reason, ...extra,
    });
    this.log(`💰 SELL ${position.outcome} @ ${price.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · ${position.shares}sh`);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── Evaluate (called every 200ms) ──────────────────────
  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));
    this._resolveExpiredPositions(market, nowS);
    if (!market) { this.onTick(this.buildState()); return; }
    if (this.entryWindow != null && market.windowStart < this.entryWindow) { this.onTick(this.buildState()); return; }
    if (this.windowStartFor !== market.windowStart) this._prepareWindow(market);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── State ──────────────────────────────────────────────
  markValue() {
    let mark = this.bankroll;
    for (const pos of this.positions.filter(p => p.exitReason == null)) {
      const token = pos.outcome === 'UP' ? pos.market?.up : pos.market?.down;
      const price = token?.mid ?? pos.entryPrice;
      mark = round2(mark + pos.shares * price);
    }
    return mark;
  }

  publicMarket(market) {
    return {
      slug: market.slug, title: market.title,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      settled: market.settled, winner: market.winner,
      elapsed: Math.max(0, Math.floor(Date.now() / 1000) - market.windowStart),
      remaining: Math.max(0, market.windowEnd - Math.floor(Date.now() / 1000)),
      up:   { bid: market.up.bid, ask: market.up.ask, mid: market.up.mid, spread: market.up.spread },
      down: { bid: market.down.bid, ask: market.down.ask, mid: market.down.mid, spread: market.down.spread },
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
      name: this.name,
      strategy: `Candle Color + Ladder · 6 limit buys @ 0.40-0.15 · ${ORDER_SHARES}sh each · ${LADDER_PRICES.length}× ${ORDER_SHARES}sh`,
      serverTime: now,
      connected: this.pollCount > 0,
      lastError: this.lastError,
      pollCount: this.pollCount,
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
      currentWindow: market ? this.publicMarket(market) : null,
      candle: this.candle.buildState(),
      orderLadder: {
        side: this.candle.getColor() === 'GREEN' ? 'UP' : (this.candle.getColor() === 'RED' ? 'DOWN' : '—'),
        prices: LADDER_PRICES,
        sharesPerOrder: ORDER_SHARES,
      },
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
        const mark = token?.mid ?? p.entryPrice;
        return {
          outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice,
          cost: p.cost, markPrice: mark,
          unrealized: round2(p.shares * mark - p.cost),
          remaining: p.windowEnd ? Math.max(0, p.windowEnd - Math.floor(now / 1000)) : null,
        };
      }),
      tradeCount: this.trades.length,
      trades: this.trades.slice(-60).reverse(),
      results: this.results.slice(0, 30),
      equityCurve: this._equityCurveForUi(),
      logs: this.logs.slice(-160),
      peakEquity: this.peakEquity,
      drawdown: round2(this.peakEquity - this.markValue()),
      maxDrawdown: this.maxDrawdown,
      uptime: Math.floor((now - this.startedAt) / 1000),
      config: {
        ladderPrices: LADDER_PRICES, orderShares: ORDER_SHARES,
        bankroll: this.initialBankroll, takerFeeRate: TAKER_FEE_RATE,
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

  _equityCurveForUi() {
    const FULL = this.equityCurve;
    if (FULL.length <= 3000) return FULL;
    const step = Math.ceil(FULL.length / 3000);
    const out = [];
    for (let i = 0; i < FULL.length; i += step) out.push(FULL[i]);
    const last = FULL[FULL.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }

  // ── Init & Cleanup ─────────────────────────────────────
  async init() {
    const start = windowStartFor(Date.now());
    this.entryWindow = start + WINDOW_SECONDS;
    this.log(`⏳ Started mid-window ${start} — trading begins at next window ${this.entryWindow}`);
    await Promise.all([this.discoverWindow(start), this.discoverWindow(start + WINDOW_SECONDS)]);
    this.candle.connect();
    this.timers = [
      setInterval(() => { this.pollClob().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => {
        this.discoverWindow(windowStartFor(Date.now())).catch(() => {});
        this.discoverWindow(windowStartFor(Date.now()) + WINDOW_SECONDS).catch(() => {});
      }, 5000),
      setInterval(() => this.evaluate(), 200),
      setInterval(() => this.recordEquity(), 1000),
    ];
    this.log(`🚀 CandleBot started | Candle-color signal + 6-limit ladder · ${ORDER_SHARES}sh each · no SL · no TP · hold to resolution`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.candle.ws) try { this.candle.ws.close(); } catch (_) {}
  }
}

module.exports = { CheapHunterEngine, config: { LADDER_PRICES, ORDER_SHARES, START_BANKROLL, CLOB_POLL_MS, TAKER_FEE_RATE } };
