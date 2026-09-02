'use strict';

// ── Config ────────────────────────────────────────────────
const GAMMA_API   = process.env.GAMMA_API   || 'https://gamma-api.polymarket.com';
const CLOB_REST   = process.env.CLOB_REST   || 'https://clob.polymarket.com';
const WINDOW_SECONDS = 300;
const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));
const START_BANKROLL  = Number(process.env.START_BANKROLL || 2000);

// Price ladder — 6 limit buy order levels, 100 shares each
const ORDER_SHARES = 100;
const LADDER_PRICES = [0.40, 0.35, 0.30, 0.25, 0.20, 0.15];

// Resolution threshold: one side must reach this to declare a winner
const RESOLUTION_THRESHOLD = 0.95;

// ── Helpers ───────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

// ── Binance 5m Candle Signal ──────────────────────────────
class CandleSignalManager {
  constructor(log) {
    this.log = log;
    this.lastClosedCandle = null;
    this.currentCandle = null;
    this.ws = null;
    this.connected = false;
    this.lastColor = null;
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
      this.ws.onerror = () => { this.connected = false; };
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
        this.wins = 0;
    this.losses = 0;
    this.peakEquity = this.bankroll;
    this.maxDrawdown = 0;
    this.markets = new Map();
    this.tokens = new Map();
    this.discoveryJobs = new Map();
    this.currentStart = windowStartFor(Date.now());
    this.windowStartFor = null;
    this.positions = [];           // filled positions (holding to resolution)
    this.pendingOrders = [];       // limit orders waiting for ask to reach limit
    this.finalUpMax = null;
    this.finalDownMax = null;
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
          finalUpMax: null, finalDownMax: null,
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

    // Capture final-2s max prices for resolution
    if (token.slug) {
      const m = this.markets.get(token.slug);
      if (m && !m.settled) {
        const nowS = Date.now() / 1000;
        if (nowS >= m.windowEnd - 2) {
          const probe = token.ask ?? token.bid ?? token.mid ?? 0;
          if (token.outcome === 'UP') {
            if (m.finalUpMax == null || probe > m.finalUpMax) m.finalUpMax = probe;
          } else {
            if (m.finalDownMax == null || probe > m.finalDownMax) m.finalDownMax = probe;
          }
        }
      }
    }
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

      // Immediately check fills after fresh book data
      try {
        const cs2 = windowStartFor(Date.now());
        const market2 = this.markets.get(slugFor(cs2));
        if (market2 && !market2.settled) {
          const elapsed2 = Math.floor(Date.now() / 1000 - market2.windowStart);
          if (elapsed2 < WINDOW_SECONDS) this._checkFills(market2);
        }
      } catch (_) {}
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

  // ── Window Open: Place 6 PENDING limit orders ──────────
  _prepareWindow(market) {
    this.windowStartFor = market.windowStart;
    this.finalUpMax = null;
    this.finalDownMax = null;
    const color = this.candle.getColor();
    const side = color === 'GREEN' ? 'DOWN' : (color === 'RED' ? 'UP' : null);

    if (!side) {
      this.log(`⏭️ No candle signal (${color}) — skipping window ${market.slug.slice(-10)}`);
      this.onTick(this.buildState());
      return;
    }

    this.pendingOrders = [];
    this.log(`🚀 WINDOW ${market.slug.slice(-10)} — signal ${color} → ${side} × ${LADDER_PRICES.length} limit orders pending`);

    for (const price of LADDER_PRICES) {
      const cost = round2(ORDER_SHARES * price);
      this.pendingOrders.push({
        id: `ord_${Date.now()}_${price.toFixed(2)}`,
        slug: market.slug,
        outcome: side,
        limitPrice: price,
        shares: ORDER_SHARES,
        cost,
        status: 'PENDING',
        filledAt: null,
        fillPrice: null,
      });
      this.log(`📋 LIMIT ${side} ${ORDER_SHARES}sh @ $${price.toFixed(2)} — PENDING`);
    }
    this.onTick(this.buildState());
  }

  // ── Check pending orders against CLOB book each tick ──
  _checkFills(market) {
    if (!this.pendingOrders.length) return;
    const token = this.pendingOrders[0]?.outcome === 'UP' ? market.up : market.down;
    if (!token || token.bid == null) return;

    const bid = token.bid;
    for (const order of this.pendingOrders) {
      if (order.status !== 'PENDING') continue;
      if (order.slug !== market.slug) continue;
      // Limit buy fills when ask ≤ limit price (fill at the better of ask or limit)
      if (bid > order.limitPrice) continue;

      const fillPrice = order.limitPrice;
      const fillCost = round2(order.shares * fillPrice);

      if (fillCost > this.bankroll) {
        this.log(`⚠️ SKIP FILL ${order.outcome} ${order.shares}sh @ $${fillPrice.toFixed(2)} — bankroll too low`);
        order.status = 'CANCELLED';
        continue;
      }

      order.status = 'FILLED';
      order.fillPrice = fillPrice;
      order.filledAt = Date.now();
      order.cost = fillCost;

      this.bankroll = round2(this.bankroll - fillCost);

      const position = {
        slug: order.slug, outcome: order.outcome, market,
        windowStart: market.windowStart, windowEnd: market.windowEnd,
        shares: order.shares, entryPrice: fillPrice, cost: fillCost,
        openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null,
      };
      this.positions.push(position);
      this.trades.push({
        timestamp: Date.now(), type: 'BUY', slug: order.slug, outcome: order.outcome,
        shares: order.shares, price: fillPrice, cost: fillCost,
        reason: `FILL bid $${bid.toFixed(2)} ≤ limit $${order.limitPrice.toFixed(2)} → $${fillPrice.toFixed(2)}`,
        fee: 0,
      });
      this.log(`✅ FILL ${order.outcome} ${order.shares}sh @ $${fillPrice.toFixed(2)} (bid $${bid.toFixed(2)} ≤ limit $${order.limitPrice.toFixed(2)}) · cost $${fillCost.toFixed(2)}`);
    }
  }

  // ── Cancel remaining unfilled orders at window end ──────
  _cancelUnfilled(market) {
    for (const order of this.pendingOrders) {
      if (order.status === 'PENDING' && order.slug === market.slug) {
        order.status = 'CANCELLED';
        this.log(`❌ CANCEL LIMIT ${order.outcome} ${order.shares}sh @ $${order.limitPrice.toFixed(2)} — window ended, ask was $${(market.up?.ask ?? market.down?.ask ?? 0).toFixed(2)}`);
      }
    }
  }

  // ── Resolution: ≥0.95 final-2s max, otherwise refund ───
  _resolveExpiredPositions(market, nowS) {
    if (!market) return;
    const open = this.positions.filter(p => p.exitReason == null && p.slug === market.slug);
    if (!open.length) return;
    if (nowS < market.windowEnd) return;

    market.settled = true;
    const fUp = market.finalUpMax ?? 0;
    const fDown = market.finalDownMax ?? 0;

    let winner = null;
    if (fUp >= RESOLUTION_THRESHOLD) winner = 'UP';
    else if (fDown >= RESOLUTION_THRESHOLD) winner = 'DOWN';

    if (!winner) {
      this.log(`⏳ WINDOW ${market.slug.slice(-10)} — no winner (UP max=${fUp.toFixed(3)}, DOWN max=${fDown.toFixed(3)}) — refunding cost`);
      for (const pos of open) {
        const refund = pos.cost;
        this.bankroll = round2(this.bankroll + refund);
        this.results.unshift({
          slug: pos.slug, outcome: pos.outcome, shares: pos.shares,
          entryPrice: pos.entryPrice, cost: pos.cost, exitPrice: 0, pnl: 0,
          exitReason: 'UNRESOLVED_REFUND', closedAt: Date.now(), won: null,
        });
        this.trades.push({
          timestamp: Date.now(), type: 'REFUND', slug: pos.slug, outcome: pos.outcome,
          shares: pos.shares, price: 0, pnl: 0, reason: `UNRESOLVED — UP=${fUp.toFixed(3)} DOWN=${fDown.toFixed(3)} — cost refunded`,
        });
        this.log(`   REFUND ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} — cost $${pos.cost.toFixed(2)} returned`);
        pos.exitReason = 'UNRESOLVED_REFUND';
        pos.exitPrice = 0;
        pos.pnl = 0;
        pos.closedAt = Date.now();
      }
      this.recordEquity();
      this.onTick(this.buildState());
      return;
    }

    // Real winner declared
    let winPayout = 0, lossCost = 0;
    for (const pos of open) {
      const won = pos.outcome === winner;
      const exitPrice = won ? 1 : 0;
      const proceeds = won ? pos.shares : 0;
      const pnl = round2(proceeds - pos.cost);
      if (pnl >= 0) this.wins++; else this.losses++;
      this.bankroll = round2(this.bankroll + proceeds);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      pos.pnl = pnl;
      pos.exitPrice = exitPrice;
      pos.exitReason = 'RESOLUTION';
      pos.closedAt = Date.now();
      pos.won = won;
      this.results.unshift({ slug: pos.slug, outcome: pos.outcome, shares: pos.shares, entryPrice: pos.entryPrice, cost: pos.cost, exitPrice, pnl, exitReason: 'RESOLUTION', closedAt: Date.now(), won });
      this.trades.push({
        timestamp: Date.now(), type: 'RESOLVED', slug: pos.slug, outcome: pos.outcome,
        shares: pos.shares, price: exitPrice, pnl,
        reason: `${won ? 'WIN' : 'LOSS'} ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} (${winner} won, UP max=${fUp.toFixed(3)} DOWN max=${fDown.toFixed(3)})`,
      });
      if (won) winPayout += pos.shares; else lossCost += pos.cost;
      const tag = won ? '✅ WIN' : '❌ LOSS';
      this.log(`${tag} ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    }
    this.log(`🏁 WINDOW ${market.slug.slice(-10)} RESOLVED → ${winner} won · payout $${winPayout.toFixed(2)} · loss $${lossCost.toFixed(2)} (UP max=${fUp.toFixed(3)} DOWN max=${fDown.toFixed(3)})`);
    this.positions = this.positions.filter(p => p.exitReason == null);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── Evaluate (called every 200ms) ──────────────────────
  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));
    const elapsed = Math.floor(nowS - cs);

    // Resolve expired windows — resolve the PREVIOUS window (just ended) and the current one.
    // When a new window begins, the old window's elapsed is exactly WINDOW_SECONDS, so
    // resolve it here before placing new orders.
    const prevStart = Math.floor((nowS - WINDOW_SECONDS) / WINDOW_SECONDS) * WINDOW_SECONDS;
    const prevMarket = this.markets.get(slugFor(prevStart));
    if (prevMarket && !prevMarket.settled) {
      const prevElapsed = Math.floor(nowS - prevMarket.windowStart);
      if (prevElapsed >= WINDOW_SECONDS) {
        this._cancelUnfilled(prevMarket);
        this._resolveExpiredPositions(prevMarket, nowS);
      }
    }

    if (market && !market.settled) {
      if (elapsed >= WINDOW_SECONDS) {
        this._cancelUnfilled(market);
        this._resolveExpiredPositions(market, nowS);
      }
    }

    if (!market) { this.onTick(this.buildState()); return; }
    if (this.entryWindow != null && market.windowStart < this.entryWindow) { this.onTick(this.buildState()); return; }

    // New window — place limit orders
    if (this.windowStartFor !== market.windowStart) this._prepareWindow(market);

    // Check pending order fills against CLOB book
    if (elapsed < WINDOW_SECONDS) this._checkFills(market);

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
      up: { bid: market.up.bid, ask: market.up.ask, mid: market.up.mid, spread: market.up.spread },
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
      strategy: `Candle Color + Ladder · 6 limit buys @ 0.40-0.15 · ${ORDER_SHARES}sh each · CLOB-verified fills · no SL · hold to resolution`,
      serverTime: now,
      connected: this.pollCount > 0,
      lastError: this.lastError,
      pollCount: this.pollCount,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      bankroll: this.bankroll,
      markValue: this.markValue(),
      realizedPnl: this.realizedPnl,
      unrealizedPnl: round2(openUnrealized),
      totalPnl: round2(this.markValue() - this.initialBankroll),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      entryWindow: this.entryWindow,
      waitingForWindow: this.entryWindow != null && cs < this.entryWindow,
      currentWindow: market ? this.publicMarket(market) : null,
      candle: this.candle.buildState(),
      orderLadder: {
        side: this.candle.getColor() === 'GREEN' ? 'DOWN' : (this.candle.getColor() === 'RED' ? 'UP' : '—'),
        prices: LADDER_PRICES,
        sharesPerOrder: ORDER_SHARES,
      },
      pendingOrders: this.pendingOrders.map(o => ({
        outcome: o.outcome, limitPrice: o.limitPrice, shares: o.shares, status: o.status,
        fillPrice: o.fillPrice, filledAt: o.filledAt,
      })),
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
        bankroll: this.initialBankroll,
        resolutionThreshold: RESOLUTION_THRESHOLD,
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
    this.log(`🚀 CandleBot started | Candle-color + 6-limit ladder · ${ORDER_SHARES}sh · CLOB-verified fills · no SL · hold to resolution`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.candle.ws) try { this.candle.ws.close(); } catch (_) {}
  }
}

module.exports = { CheapHunterEngine, config: { LADDER_PRICES, ORDER_SHARES, START_BANKROLL, CLOB_POLL_MS, RESOLUTION_THRESHOLD } };
