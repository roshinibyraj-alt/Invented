'use strict';

// ── Config ────────────────────────────────────────────────
const GAMMA_API   = process.env.GAMMA_API   || 'https://gamma-api.polymarket.com';
const CLOB_REST   = process.env.CLOB_REST   || 'https://clob.polymarket.com';
const WINDOW_SECONDS = 300;
const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));
const START_BANKROLL  = Number(process.env.START_BANKROLL || 10000);

const DEFAULT_SHARES = 100;
const LADDER = [
  { price: 0.49, shares: 200 },
  { price: 0.45, shares: 200 },
  { price: 0.40, shares: 100 },
  { price: 0.35, shares: 100 },
  { price: 0.30, shares: 100 },
  { price: 0.25, shares: 100 },
  { price: 0.20, shares: 100 },
  { price: 0.15, shares: 100 },
];
const LADDER_PRICES = LADDER.map(r => r.price);
const ORDER_SHARES = DEFAULT_SHARES;
const RESOLUTION_THRESHOLD = 0.95;

// ── Helpers ───────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

// ── Engine ────────────────────────────────────────────────
class CheapHunterEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'PrevWinner';
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
    this.windowStartFor = null;
    this.positions = [];
    this.pendingOrders = [];
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

    // Previous window winner tracking
    this._prevWindowWinner = null;   // 'UP' | 'DOWN' | null (skip)
    this._prevWindowSlug = null;
    this._ordersPlacedForWindow = null;
    this._windowSide = null;         // frozen side for current window
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
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'prevwinner/1.0', ...(options.headers || {}) },
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

    // Track max prices during window for resolution
    if (token.slug) {
      const m = this.markets.get(token.slug);
      if (m && !m.settled) {
        const probe = token.ask ?? token.bid ?? token.mid ?? 0;
        if (token.outcome === 'UP') {
          if (m.finalUpMax == null || probe > m.finalUpMax) m.finalUpMax = probe;
        } else {
          if (m.finalDownMax == null || probe > m.finalDownMax) m.finalDownMax = probe;
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

  // ── Detect previous window winner from CLOB prices ──────
  _detectPrevWinner(market) {
    const prevSlug = slugFor(market.windowStart - WINDOW_SECONDS);
    const prev = this.markets.get(prevSlug);
    if (!prev || !prev.settled) {
      this._prevWindowWinner = null;
      this._prevWindowSlug = null;
      return;
    }

    const upMax = prev.finalUpMax ?? 0;
    const downMax = prev.finalDownMax ?? 0;

    if (upMax >= RESOLUTION_THRESHOLD) {
      this._prevWindowWinner = 'UP';
    } else if (downMax >= RESOLUTION_THRESHOLD) {
      this._prevWindowWinner = 'DOWN';
    } else {
      this._prevWindowWinner = null; // skip
    }
    this._prevWindowSlug = prev.slug;
  }

  // ── Window Open: freeze side + place ladder after 2s ────
  _detectWindow(market) {
    this.windowStartFor = market.windowStart;
    this._ordersPlacedForWindow = null;
    this.finalUpMax = null;
    this.finalDownMax = null;

    // Determine side: FADE the previous winner (contrarian)
    this._detectPrevWinner(market);
    const winner = this._prevWindowWinner;

    if (!winner) {
      this.log(`⏭️ No prev winner (UP max=${(this.markets.get(slugFor(market.windowStart - WINDOW_SECONDS))?.finalUpMax ?? 0).toFixed(3)} DOWN max=${(this.markets.get(slugFor(market.windowStart - WINDOW_SECONDS))?.finalDownMax ?? 0).toFixed(3)}) — skipping ${market.slug.slice(-10)}`);
    } else {
      // FADE: buy the LOSING side (mean-reversion)
      const fadeSide = winner === 'UP' ? 'DOWN' : 'UP';
      this._windowSide = fadeSide;
      this.log(`🔍 Window ${market.slug.slice(-10)} — prev winner ${winner} → FADING ${fadeSide} — orders in 2s`);
    }
    this.onTick(this.buildState());
  }

  _placeLadder(market) {
    const side = this._windowSide;
    if (!side) {
      this.onTick(this.buildState());
      return;
    }

    this.pendingOrders = [];
    this.log(`🚀 WINDOW ${market.slug.slice(-10)} — BUY ${side} × ${LADDER.length} limit orders`);

    for (const rung of LADDER) {
      const cost = round2(rung.shares * rung.price);
      this.pendingOrders.push({
        id: `ord_${Date.now()}_${rung.price.toFixed(2)}`,
        slug: market.slug,
        outcome: side,
        limitPrice: rung.price,
        shares: rung.shares,
        cost,
        status: 'PENDING',
        filledAt: null,
        fillPrice: null,
      });
      this.log(`📋 LIMIT ${side} ${rung.shares}sh @ $${rung.price.toFixed(2)} — PENDING`);
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
      // Limit buy fills when bid ≤ limit price
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
      this.log(`✅ FILL ${order.outcome} ${order.shares}sh @ $${fillPrice.toFixed(2)} (bid $${bid.toFixed(2)} ≤ limit) · cost $${fillCost.toFixed(2)}`);
    }
  }

  // ── Cancel remaining unfilled orders at window end ──────
  _cancelUnfilled(market) {
    for (const order of this.pendingOrders) {
      if (order.status === 'PENDING' && order.slug === market.slug) {
        order.status = 'CANCELLED';
        this.log(`❌ CANCEL ${order.outcome} ${order.shares}sh @ $${order.limitPrice.toFixed(2)} — window ended`);
      }
    }
  }

  // ── Resolution: ≥0.95 final max, otherwise refund ───────
  _resolveExpiredPositions(market, nowS) {
    if (!market) return;
    if (nowS < market.windowEnd) return;

    // Always settle the market once past its window end
    market.settled = true;
    const fUp = market.finalUpMax ?? 0;
    const fDown = market.finalDownMax ?? 0;

    let winner = null;
    if (fUp >= RESOLUTION_THRESHOLD) winner = 'UP';
    if (fDown >= RESOLUTION_THRESHOLD) winner = 'DOWN';

    const open = this.positions.filter(p => p.exitReason == null && p.slug === market.slug);
    if (!open.length) {
      // No positions to resolve, but market is now settled
      this.log(`🏁 ${market.slug.slice(-10)} settled — ${winner ? winner + ' won' : 'NO WINNER'} (UP max=${fUp.toFixed(3)} DOWN max=${fDown.toFixed(3)}) — no positions`);
      this.recordEquity();
      this.onTick(this.buildState());
      return;
    }

    if (!winner) {
      this.log(`⏳ ${market.slug.slice(-10)} — NO WINNER (UP max=${fUp.toFixed(3)} DOWN max=${fDown.toFixed(3)}) — refunding`);
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
      this.log(`${won ? '✅ WIN' : '❌ LOSS'} ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    }
    this.log(`🏁 ${market.slug.slice(-10)} RESOLVED → ${winner} won · payout $${winPayout.toFixed(2)} · loss $${lossCost.toFixed(2)} (UP max=${fUp.toFixed(3)} DOWN max=${fDown.toFixed(3)})`);
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

    // Resolve previous window
    const prevStart = Math.floor((nowS - WINDOW_SECONDS) / WINDOW_SECONDS) * WINDOW_SECONDS;
    const prevMarket = this.markets.get(slugFor(prevStart));
    if (prevMarket && !prevMarket.settled) {
      const prevElapsed = Math.floor(nowS - prevMarket.windowStart);
      if (prevElapsed >= WINDOW_SECONDS) {
        this._cancelUnfilled(prevMarket);
        this._resolveExpiredPositions(prevMarket, nowS);
      }
    }

    // Resolve current window if past end
    if (market && !market.settled) {
      if (elapsed >= WINDOW_SECONDS) {
        this._cancelUnfilled(market);
        this._resolveExpiredPositions(market, nowS);
      }
    }

    if (!market) { this.onTick(this.buildState()); return; }
    if (this.entryWindow != null && market.windowStart < this.entryWindow) { this.onTick(this.buildState()); return; }

    // New window — detect side from previous window winner
    if (this.windowStartFor !== market.windowStart) this._detectWindow(market);

    // Place ladder 2 seconds after window opens
    if (this.windowStartFor === market.windowStart && !this._ordersPlacedForWindow && elapsed >= 2) {
      this._ordersPlacedForWindow = market.windowStart;
      this._placeLadder(market);
    }

    // Check pending order fills against CLOB book
    if (elapsed < WINDOW_SECONDS) this._checkFills(market);

    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── Equity tracking ─────────────────────────────────────
  recordEquity() {
    const now = Date.now();
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (last && now - last.t < 5000) return; // record every 5s max
    const equity = this.markValue();
    this.equityCurve.push({ t: now, equity: round2(equity) });
    if (this.equityCurve.length > 2000) this.equityCurve = this.equityCurve.slice(-1500);
  }

  markValue() {
    let m = this.bankroll;
    for (const p of this.positions.filter(p => p.exitReason == null)) {
      const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
      const price = token?.mid ?? p.entryPrice;
      m += round2(p.shares * price);
    }
    return round2(m);
  }

  // ── State ──────────────────────────────────────────────
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
      strategy: `FADE Prev Winner (Contrarian) · ${LADDER.length} limit buys @ ${LADDER.map(r=>r.price+'×'+r.shares).join('/')} · CLOB · no SL · hold to resolution`,
      serverTime: now,
      connected: this.pollCount > 0 && this.isClobFresh(now),
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
      prevWindowWinner: this._prevWindowWinner,
      currentWindow: market ? this.publicMarket(market) : null,
      orderLadder: {
        side: this._windowSide || this._prevWindowWinner || '—',
        prices: LADDER_PRICES,
        ladder: LADDER.map(r => ({ price: r.price, shares: r.shares })),
      },
      pendingOrders: this.pendingOrders.map(o => ({
        outcome: o.outcome, limitPrice: o.limitPrice, shares: o.shares,
        status: o.status, fillPrice: o.fillPrice, filledAt: o.filledAt,
      })),
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
        const markPrice = token?.mid ?? p.entryPrice;
        return { outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, markPrice, unrealized: round2(p.shares * markPrice - p.cost) };
      }),
      results: this.results.slice(-50),
      trades: this.trades.slice(-50),
      logs: this.logs,
      equityCurve: this.equityCurve,
      config: { ladder: LADDER.map(r => ({ price: r.price, shares: r.shares })), bankroll: this.bankroll },
    };
  }

  // ── Init ────────────────────────────────────────────────
  async init() {
    const now = Date.now();
    const curStart = windowStartFor(now);
    this.entryWindow = curStart + WINDOW_SECONDS;
    this.log(`⏳ Started mid-window ${curStart} — first trade at next window ${this.entryWindow}`);

    await Promise.all([
      this.discoverWindow(curStart),
      this.discoverWindow(curStart + WINDOW_SECONDS),
    ]);

    this.timers = [
      setInterval(() => { this.pollClob().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => {
        this.discoverWindow(windowStartFor(Date.now())).catch(() => {});
        this.discoverWindow(windowStartFor(Date.now()) + WINDOW_SECONDS).catch(() => {});
      }, 5000),
      setInterval(() => this.evaluate(), 200),
      setInterval(() => this.recordEquity(), 1000),
    ];
    this.log(`🚀 ${this.name} started · ${LADDER.length} limit buys · CLOB-only · FADE contrarian strategy`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { CheapHunterEngine, config: { LADDER, LADDER_PRICES, ORDER_SHARES, START_BANKROLL } };
