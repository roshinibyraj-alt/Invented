'use strict';

// ── Config ────────────────────────────────────────────────
const GAMMA_API    = 'https://gamma-api.polymarket.com';
const CLOB_REST    = 'https://clob.polymarket.com';
const WINDOW_SEC   = 300;              // 5 minutes
const CLOB_POLL_MS = 300;              // poll orderbook every 300ms
const EVAL_MS      = 200;              // evaluate loop every 200ms
const START_CAPITAL = Number(process.env.START_BANKROLL || 2000);
const LADDER       = [0.40, 0.35, 0.30, 0.25, 0.20, 0.15];
const SHARES_PER   = 100;
const RESOLUTION   = 0.95;             // price ≥ this in final 2s = winner

// ── Helpers ───────────────────────────────────────────────
const r2  = v => Math.round(v * 100) / 100;
const slug = s => `btc-updown-5m-${s}`;
const winStart = ms => Math.floor(ms / 1000 / WINDOW_SEC) * WINDOW_SEC;

// ══════════════════════════════════════════════════════════
// Candle Signal — Binance 5m kline via WebSocket
// ══════════════════════════════════════════════════════════
class CandleSignal {
  constructor(log) {
    this.log = log;
    this.ws = null;
    this.connected = false;
    this.color = null;       // 'GREEN' | 'RED' | null
    this.open = null;
    this.close = null;
  }

  connect() {
    try {
      this.ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_5m');
      this.ws.onopen = () => { this.connected = true; this.log('✅ Binance WS connected (btcusdt 5m)'); };
      this.ws.onclose = () => { this.connected = false; this.log('🔌 Binance WS closed — reconnect in 5s'); setTimeout(() => this.connect(), 5000); };
      this.ws.onerror = () => { this.connected = false; };
      this.ws.onmessage = (ev) => {
        try {
          const k = JSON.parse(ev.data).k;
          if (!k) return;
          const o = +k.o, c = +k.c;
          this.open = o;
          this.close = c;
          if (k.x) {  // candle closed
            this.color = c > o ? 'GREEN' : (c < o ? 'RED' : null);
            this.log(`🕯️ Candle closed ${this.color || 'NEUTRAL'} (O:${o.toFixed(2)} C:${c.toFixed(2)})`);
          }
        } catch (_) {}
      };
    } catch (e) {
      this.log(`⚠️ Binance WS failed: ${e.message}`);
    }
  }

  state() {
    return { connected: this.connected, lastColor: this.color, candleOpen: this.open, candleClose: this.close };
  }
}

// ══════════════════════════════════════════════════════════
// CandleBot Engine
// ══════════════════════════════════════════════════════════
class CandleBot {
  constructor(opts = {}) {
    this.fetchFn  = opts.fetchImpl || fetch;
    this.onTick   = opts.onTick   || (() => {});
    this.onLog    = opts.onLog    || (() => {});
    this.name     = opts.name     || 'CandleBot';

    // Capital
    this.bankroll     = opts.bankroll ?? START_CAPITAL;
    this.startCapital = this.bankroll;

    // Candle
    this.candle = new CandleSignal(m => this._log(m));

    // Market data: slug → { slug, title, start, end, up, down, settled, finalUpMax, finalDownMax }
    this.markets = new Map();

    // Current window tracking
    this.currentWindowSlug = null;   // slug of window we've already prepared orders for

    // Orders & positions
    this.pendingOrders = [];
    this.positions     = [];         // { slug, outcome, shares, entryPrice, cost, closedAt, exitReason, pnl, won }

    // Ledger
    this.results = [];               // resolved trades
    this.trades  = [];               // all buy/sell events
    this.logs    = [];
    this.equityCurve = [{ t: Date.now(), equity: this.bankroll }];

    // Stats
    this.wins   = 0;
    this.losses = 0;
    this.realizedPnl = 0;
    this.peakEquity  = this.bankroll;
    this.drawdown    = 0;

    // Timers
    this._timers = [];
    this._pollInFlight = 0;
    this._lastPollAt   = null;
    this._lastPollOk   = null;
    this._lastErr      = null;

    // Entry gate — skip until next full window
    this._entryWindow = null;

    // Frozen detection
    this._frozenCheckedThisWindow = false;
    this._ordersPlacedAt = null;
  }

  // ── Init ──────────────────────────────────────────────────
  async init() {
    const now = Date.now();
    const curStart = winStart(now);
    this._entryWindow = curStart + WINDOW_SEC;  // don't trade until next full window
    this._log(`⏳ Started mid-window ${curStart} — first trade at ${this._entryWindow}`);

    // Pre-discover current + next windows
    await Promise.all([
      this._discover(curStart),
      this._discover(curStart + WINDOW_SEC),
    ]);

    this.candle.connect();

    this._timers = [
      setInterval(() => this._pollClob(), CLOB_POLL_MS),
      setInterval(() => this._evaluate(), EVAL_MS),
      setInterval(() => this._recordEquity(), 1000),
      setInterval(() => {
        this._discover(winStart(Date.now())).catch(() => {});
        this._discover(winStart(Date.now()) + WINDOW_SEC).catch(() => {});
      }, 5000),
    ];

    this._log(`🚀 ${this.name} started · ${LADDER.length} limit orders × ${SHARES_PER}sh · ladder ${LADDER.join('/')} · hold to resolution`);
  }

  close() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    if (this.candle.ws) try { this.candle.ws.close(); } catch (_) {}
  }

  // ── Logging ───────────────────────────────────────────────
  _log(msg) {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.onLog(line);
  }

  // ── Gamma / CLOB discovery (slug-only, no fallback) ──────
  async _discover(start) {
    const s = slug(start);
    if (this.markets.has(s)) return this.markets.get(s);
    try {
      const rows = await this._fetchJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(s)}`, {}, 8000);
      const m = Array.isArray(rows) ? rows[0] : null;
      if (!m?.conditionId || m.closed) throw new Error('market unavailable');
      const outcomes = JSON.parse(m.outcomes || '[]');
      const tokenIds = JSON.parse(m.clobTokenIds || '[]');
      const ui = outcomes.findIndex(o => o.toLowerCase() === 'up');
      const di = outcomes.findIndex(o => o.toLowerCase() === 'down');
      if (ui < 0 || di < 0 || !tokenIds[ui] || !tokenIds[di]) throw new Error('missing tokens');
      const rec = {
        slug: s, title: m.question || s,
        start, end: start + WINDOW_SEC,
        up:   { id: tokenIds[ui], bid: null, ask: null, mid: null, spread: null },
        down: { id: tokenIds[di], bid: null, ask: null, mid: null, spread: null },
        settled: false, finalUpMax: null, finalDownMax: null,
      };
      this.markets.set(s, rec);
      this._log(`🎯 MARKET ${s} · ${rec.title}`);
      return rec;
    } catch (e) {
      this._lastErr = e.message;
      this._log(`DISCOVERY FAIL ${s}: ${e.message}`);
      return null;
    }
  }

  async _fetchJSON(url, opts = {}, timeout = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await this.fetchFn(url, { ...opts, signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': 'candlebot/1.0', ...(opts.headers || {}) } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  // ── CLOB poll — fetch orderbook, apply books, check fills ─
  async _pollClob() {
    if (this._pollInFlight >= 2) return;
    this._pollInFlight++;
    try {
      const cs = winStart(Date.now());
      const markets = [this.markets.get(slug(cs)), this.markets.get(slug(cs + WINDOW_SEC))].filter(Boolean);
      const tokens = markets.flatMap(m => [
        { ref: m.up,   id: m.up.id },
        { ref: m.down, id: m.down.id },
      ]);
      if (!tokens.length) return;

      const books = await this._fetchJSON(`${CLOB_REST}/books`, {
        method: 'POST',
        body: JSON.stringify(tokens.map(t => ({ token_id: t.id }))),
      }, 1500);

      const byId = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id || ''), b]));
      for (const t of tokens) {
        const b = byId.get(t.id);
        if (b) this._applyBook(t.ref, b.bids || [], b.asks || []);
      }
      this._lastPollAt = Date.now();
      this._lastPollOk = Date.now();
      this._lastErr = null;

      // Immediately check fills after fresh book data
      const market = this.markets.get(slug(winStart(Date.now())));
      if (market && !market.settled) {
        const elapsed = Math.floor(Date.now() / 1000 - market.start);
        if (elapsed < WINDOW_SEC) this._checkFills(market);
      }
    } catch (e) {
      this._lastErr = e.message;
    } finally {
      this._pollInFlight--;
    }
  }

  _applyBook(token, bids, asks) {
    const validBids = bids.filter(l => +l.size > 0).map(l => ({ p: +l.price, s: +l.size }));
    const validAsks = asks.filter(l => +l.size > 0).map(l => ({ p: +l.price, s: +l.size }));
    const bestBid = validBids.length ? validBids[0].p : null;
    const bestAsk = validAsks.length ? validAsks[0].p : null;
    token.bid = (bestBid != null && bestBid > 0 && bestBid <= 1) ? bestBid : null;
    token.ask = (bestAsk != null && bestAsk > 0 && bestAsk <= 1) ? bestAsk : null;
    token.mid = (token.bid != null && token.ask != null) ? r2((token.bid + token.ask) / 2) : (token.ask ?? token.bid);
    token.spread = (token.bid != null && token.ask != null) ? r2(token.ask - token.bid) : null;
  }

  // ── Evaluate — called every 200ms ────────────────────────
  _evaluate() {
    const now  = Date.now();
    const nowS = now / 1000;
    const cs   = winStart(now);
    const market = this.markets.get(slug(cs));
    const elapsed = Math.floor(nowS - cs);

    // 1) Resolve previous window if it just ended
    const prevCs  = winStart(nowS - WINDOW_SEC) * 1000 === cs ? cs - WINDOW_SEC : cs;
    const prevKey = slug(cs - WINDOW_SEC);
    const prev    = this.markets.get(prevKey);
    if (prev && !prev.settled && elapsed >= 0 && nowS >= prev.end) {
      this._cancelUnfilled(prev);
      this._resolve(prev);
    }

    // 2) Resolve current window if somehow past end
    if (market && !market.settled && elapsed >= WINDOW_SEC) {
      this._cancelUnfilled(market);
      this._resolve(market);
    }

    if (!market) { this._tick(); return; }

    // 3) Entry gate — skip windows before _entryWindow
    if (this._entryWindow != null && market.start < this._entryWindow) { this._tick(); return; }

    // 4) New window → place orders
    if (this.currentWindowSlug !== market.slug) {
      this.currentWindowSlug = market.slug;
      this.pendingOrders = [];
      this._frozenCheckedThisWindow = false;
      this._ordersPlacedAt = Date.now();
      this._placeOrders(market);
    }

    // 5) Frozen check — if both sides stuck at 0.50, skip
    if (!this._frozenCheckedThisWindow && !market.settled && this._ordersPlacedAt && (Date.now() - this._ordersPlacedAt) >= 15000 && elapsed < WINDOW_SEC) {
      this._frozenCheckedThisWindow = true;
      if (this._isFrozen(market)) {
        this._log(`⏸️ FROZEN window ${market.slug.slice(-10)} — both sides at 0.50, skipping`);
        this._cancelUnfilled(market);
      }
    }

    // 6) Check fills
    if (!market.settled && elapsed < WINDOW_SEC) this._checkFills(market);

    this._tick();
  }

  _tick() {
    this.onTick(this._buildState());
  }

  // ── Frozen detection ──────────────────────────────────────
  _isFrozen(m) {
    const up = m.up, dn = m.down;
    if (up.bid == null || up.ask == null || dn.bid == null || dn.ask == null) return false;
    const upMid = (up.bid + up.ask) / 2;
    const dnMid = (dn.bid + dn.ask) / 2;
    return Math.abs(upMid - 0.50) < 0.01 && Math.abs(dnMid - 0.50) < 0.01;
  }

  // ── Place orders — ONE set per window ─────────────────────
  _placeOrders(market) {
    const color = this.candle.color;
    const side  = color === 'GREEN' ? 'UP' : (color === 'RED' ? 'DOWN' : null);

    if (!side) {
      this._log(`⏭️ No candle signal (${color || 'NEUTRAL'}) — skipping window ${market.slug.slice(-10)}`);
      return;
    }

    this.pendingOrders = [];
    this._log(`🚀 WINDOW ${market.slug.slice(-10)} — candle ${color} → BUY ${side} × ${LADDER.length} limit orders`);

    for (const price of LADDER) {
      this.pendingOrders.push({
        slug: market.slug,
        outcome: side,
        limitPrice: price,
        shares: SHARES_PER,
        cost: r2(SHARES_PER * price),
        status: 'PENDING',
        filledAt: null,
        fillPrice: null,
      });
    }

    for (const o of this.pendingOrders) {
      this._log(`📋 LIMIT ${side} ${o.shares}sh @ $${o.limitPrice.toFixed(2)} — PENDING`);
    }
  }

  // ── Fill check — bid ≤ limit → fill at exact limit price ──
  _checkFills(market) {
    if (!this.pendingOrders.length) return;
    const side    = this.pendingOrders[0].outcome;
    const token   = side === 'UP' ? market.up : market.down;

    if (token.bid == null) return;  // no book data yet

    for (const order of this.pendingOrders) {
      if (order.status !== 'PENDING') continue;
      if (order.slug !== market.slug) continue;

      // Fill when bid ≤ limit price (someone is willing to sell at or below our limit)
      if (token.bid > order.limitPrice) continue;

      const fillPrice = order.limitPrice;  // exact limit, no slippage
      const fillCost  = r2(order.shares * fillPrice);

      if (fillCost > this.bankroll) {
        this._log(`⚠️ SKIP — bankroll $${this.bankroll.toFixed(2)} < cost $${fillCost.toFixed(2)}`);
        order.status = 'CANCELLED';
        continue;
      }

      // Fill the order
      order.status     = 'FILLED';
      order.fillPrice  = fillPrice;
      order.filledAt   = Date.now();
      order.cost       = fillCost;
      this.bankroll    = r2(this.bankroll - fillCost);

      // Create position
      this.positions.push({
        slug: order.slug, outcome: order.outcome,
        shares: order.shares, entryPrice: fillPrice, cost: fillCost,
        closedAt: null, exitReason: null, pnl: null, won: null,
      });

      this.trades.push({
        timestamp: Date.now(), type: 'BUY', outcome: order.outcome,
        shares: order.shares, price: fillPrice, cost: fillCost, pnl: null,
        slug: order.slug,
      });

      this._log(`✅ FILL ${side} ${order.shares}sh @ $${fillPrice.toFixed(2)} (bid $${token.bid.toFixed(2)} ≤ limit) · cost $${fillCost.toFixed(2)}`);
    }
  }

  // ── Cancel unfilled orders ────────────────────────────────
  _cancelUnfilled(market) {
    for (const order of this.pendingOrders) {
      if (order.status === 'PENDING' && order.slug === market.slug) {
        order.status = 'CANCELLED';
        this._log(`❌ CANCEL ${order.outcome} ${order.shares}sh @ $${order.limitPrice.toFixed(2)} — window ended`);
      }
    }
  }

  // ── Resolution — hold to binary result ────────────────────
  _resolve(market) {
    if (market.settled) return;
    const open = this.positions.filter(p => !p.closedAt && p.slug === market.slug);
    if (!open.length && !this.pendingOrders.some(o => o.slug === market.slug)) return;
    if (Date.now() / 1000 < market.end) return;

    market.settled = true;
    const fUp   = market.finalUpMax   ?? 0;
    const fDown = market.finalDownMax ?? 0;

    // Determine winner
    let winner = null;
    if (fUp >= RESOLUTION)   winner = 'UP';
    if (fDown >= RESOLUTION) winner = 'DOWN';

    if (!winner) {
      // Neither side hit threshold → refund
      this._log(`⏳ ${market.slug.slice(-10)} — NO WINNER (UP=${fUp.toFixed(3)} DOWN=${fDown.toFixed(3)}) — refunding`);
      for (const pos of open) {
        this.bankroll = r2(this.bankroll + pos.cost);
        pos.exitReason = 'UNRESOLVED_REFUND';
        pos.pnl = 0;
        pos.won = null;
        pos.closedAt = Date.now();
        this.results.push({ ...pos, exitPrice: 0, closedAt: Date.now() });
        this.trades.push({ timestamp: Date.now(), type: 'REFUND', outcome: pos.outcome, shares: pos.shares, price: 0, pnl: 0, slug: pos.slug });
        this._log(`   REFUND ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} — cost $${pos.cost.toFixed(2)} returned`);
      }
    } else {
      // Winner declared
      let winPayout = 0, lossCost = 0;
      for (const pos of open) {
        const won = pos.outcome === winner;
        const proceeds = won ? pos.shares : 0;
        const pnl = r2(proceeds - pos.cost);
        pos.exitReason = 'RESOLUTION';
        pos.pnl = pnl;
        pos.won = won;
        pos.closedAt = Date.now();
        this.bankroll = r2(this.bankroll + proceeds);
        this.realizedPnl = r2(this.realizedPnl + pnl);
        if (won) this.wins++; else this.losses++;
        this.results.push({ ...pos, exitPrice: won ? 1 : 0, closedAt: Date.now() });
        this.trades.push({ timestamp: Date.now(), type: 'RESOLVED', outcome: pos.outcome, shares: pos.shares, price: won ? 1 : 0, pnl, slug: pos.slug });
        if (won) winPayout += pos.shares; else lossCost += pos.cost;
        this._log(`${won ? '✅ WIN' : '❌ LOSS'} ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
      }
      this._log(`🏁 ${market.slug.slice(-10)} → ${winner} won · payout $${winPayout.toFixed(2)} · loss $${lossCost.toFixed(2)} (UP max=${fUp.toFixed(3)} DOWN max=${fDown.toFixed(3)})`);
    }

    // Clear resolved positions
    this.positions = this.positions.filter(p => !p.closedAt);
    this._recordEquity();
    this._tick();
  }

  // ── Equity tracking ───────────────────────────────────────
  _recordEquity() {
    const equity = this._markValue();
    if (equity > this.peakEquity) this.peakEquity = equity;
    this.drawdown = r2(this.peakEquity - equity);
    this.equityCurve.push({ t: Date.now(), equity: r2(equity) });
    if (this.equityCurve.length > 2000) this.equityCurve = this.equityCurve.slice(-1500);
  }

  _markValue() {
    let m = this.bankroll;
    for (const p of this.positions) {
      const token = p.outcome === 'UP' ? this.markets.get(p.slug)?.up : this.markets.get(p.slug)?.down;
      const price = token?.mid ?? p.entryPrice;
      m += r2(p.shares * price);
    }
    return r2(m);
  }

  // ── Build state for dashboard ─────────────────────────────
  _buildState() {
    const now = Date.now();
    const cs  = winStart(now);
    const market = this.markets.get(slug(cs));
    const open = this.positions.filter(p => !p.closedAt);

    const unrealized = open.reduce((sum, p) => {
      const token = p.outcome === 'UP' ? (this.markets.get(p.slug)?.up) : (this.markets.get(p.slug)?.down);
      const price = token?.mid ?? p.entryPrice;
      return sum + r2(p.shares * price - p.cost);
    }, 0);

    return {
      name: this.name,
      strategy: `Candle Color + Ladder · ${LADDER.length} limit buys @ ${LADDER.join('/')} · ${SHARES_PER}sh each · no SL · hold to resolution`,
      serverTime: now,
      connected: this.candle.connected && this._lastPollOk != null && (now - this._lastPollOk) < 5000,
      lastError: this._lastErr,
      pollCount: this._lastPollAt ? 1 : 0,
      bankroll: this.bankroll,
      markValue: this._markValue(),
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      totalPnl: r2(this._markValue() - this.startCapital),
      wins: this.wins,
      losses: this.losses,
      winRate: (this.wins + this.losses) ? r2(this.wins / (this.wins + this.losses) * 100) : null,
      peakEquity: this.peakEquity,
      drawdown: this.drawdown,
      entryWindow: this._entryWindow,
      waitingForWindow: this._entryWindow != null && cs < this._entryWindow,
      currentWindow: market ? {
        slug: market.slug, title: market.title,
        windowStart: market.start, windowEnd: market.end,
        elapsed: Math.max(0, Math.floor(now / 1000) - market.start),
        remaining: Math.max(0, market.end - Math.floor(now / 1000)),
        settled: market.settled,
        up: { bid: market.up.bid, ask: market.up.ask, mid: market.up.mid, spread: market.up.spread },
        down: { bid: market.down.bid, ask: market.down.ask, mid: market.down.mid, spread: market.down.spread },
      } : null,
      candle: this.candle.state(),
      orderLadder: {
        side: this.candle.color === 'GREEN' ? 'UP' : (this.candle.color === 'RED' ? 'DOWN' : '—'),
        prices: LADDER,
        sharesPerOrder: SHARES_PER,
      },
      pendingOrders: this.pendingOrders.map(o => ({
        outcome: o.outcome, limitPrice: o.limitPrice, shares: o.shares,
        status: o.status, fillPrice: o.fillPrice, filledAt: o.filledAt,
      })),
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? (this.markets.get(p.slug)?.up) : (this.markets.get(p.slug)?.down);
        const markPrice = token?.mid ?? p.entryPrice;
        return { outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, markPrice, unrealized: r2(p.shares * markPrice - p.cost) };
      }),
      results: this.results.slice(-50),
      trades: this.trades.slice(-50),
      logs: this.logs,
      equityCurve: this.equityCurve,
      config: { ladderPrices: LADDER, orderShares: SHARES_PER, bankroll: this.bankroll },
    };
  }
}

module.exports = { CheapHunterEngine: CandleBot, config: { LADDER_PRICES: LADDER, ORDER_SHARES: SHARES_PER, START_BANKROLL: START_CAPITAL } };
