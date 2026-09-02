'use strict';

// ── Config ────────────────────────────────────────────────
const GAMMA_API   = process.env.GAMMA_API   || 'https://gamma-api.polymarket.com';
const CLOB_REST   = process.env.CLOB_REST   || 'https://clob.polymarket.com';
const WINDOW_SECONDS = 300;
const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));
const START_BANKROLL  = Number(process.env.START_BANKROLL || 10000);

const BASE_SHARES       = 100;
const ENTRY_TRIGGER     = 0.80;
const STOP_LOSS_PRICE   = 0.62;
const RESOLUTION_THRESHOLD = 0.95;
const MARTINGALE_MULT   = 2.5;
const MAX_ENTRIES_PER_WINDOW = 2;
const TAKER_FEE = 0.02; // 2% taker fee

// ── Helpers ───────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }
function takerFee(shares, price) { return round2(shares * price * TAKER_FEE); }

// ── Engine ────────────────────────────────────────────────
class MomentumCatchEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'FadeBot';
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
    this._currentWindowSlug = null;
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

    // ── Strategy state ──
    this._baseShares = BASE_SHARES;
    this._windowEntries = 0;
    this._windowActive = null;       // { slug, outcome, shares, entryPrice, cost, openedAt }
    this._windowTriggered = new Set(); // which side already triggered 0.80 this window
    this._pendingFill = null;        // { slug, outcome, shares, triggerPrice, firedAt } — waiting for next tick
    this._pendingSL = null;          // { slug, outcome, shares, entryPrice, cost, openedAt } — SL sell pending
    this._windowSlug = null;
    this._lastEvalAt = 0;
  }

  log(message) {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
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
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'momentumcatch/1.0', ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  // ── Discovery ───────────────────────────────────────────
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
          up: { tokenId: String(tokenIds[ui]), slug, outcome: 'UP', bid: null, ask: null, mid: null, spread: null, bookAsks: [], bookBids: [], updatedAt: null },
          down: { tokenId: String(tokenIds[di]), slug, outcome: 'DOWN', bid: null, ask: null, mid: null, spread: null, bookAsks: [], bookBids: [], updatedAt: null },
        };
        this.markets.set(slug, rec);
        this.tokens.set(rec.up.tokenId, rec.up);
        this.tokens.set(rec.down.tokenId, rec.down);
        this.log(`🎯 MARKET ${slug} · ${rec.title}`);
        return rec;
      } catch (e) {
        this.log(`DISCOVERY FAIL ${slug}: ${e.message}`);
        throw e;
      } finally { this.discoveryJobs.delete(slug); }
    })();
    this.discoveryJobs.set(slug, job);
    return job;
  }

  // ── Book handling ───────────────────────────────────────
  _makeToken(tokenId, slug, outcome) {
    const token = { tokenId: String(tokenId), slug, outcome, bid: null, ask: null, mid: null, spread: null, updatedAt: null };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  applyBook(token, bids, asks) {
    const validBids = (bids || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validBids.sort((a, b) => b.price - a.price);
    const validAsks = (asks || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookBids = validBids;
    token.bookAsks = validAsks;
    const bestBid = validBids[0]?.price ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    token.bid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    token.ask = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    token.spread = token.bid != null && token.ask != null ? round5(token.ask - token.bid) : null;
    token.mid = token.bid != null && token.ask != null ? round5((token.bid + token.ask) / 2) : (token.ask ?? token.bid);
    token.updatedAt = Date.now();

    // Track max prices for resolution
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

  // ── Strategy Logic ─────────────────────────────────────
  _resetWindow(market) {
    if (this._windowSlug === market.slug) return; // already reset

    // Force-close any leftover positions from the previous window
    const oldPositions = this.positions.filter(p => p.exitReason == null && p.slug !== market.slug);
    for (const pos of oldPositions) {
      // Treat unresolved position as a loss (cost was already deducted)
      pos.exitReason = 'UNRESOLVED_LOSS';
      pos.exitPrice = 0;
      pos.pnl = -pos.cost;
      pos.closedAt = Date.now();
      pos.won = false;
      this.losses += 1;
      this.realizedPnl = round2(this.realizedPnl - pos.cost);
      this.results.unshift({
        slug: pos.slug, outcome: pos.outcome, shares: pos.shares,
        entryPrice: pos.entryPrice, cost: pos.cost, exitPrice: 0, pnl: -pos.cost,
        exitReason: 'UNRESOLVED_LOSS', closedAt: Date.now(), won: false,
      });
      this.log(`🧹 UNRESOLVED ${pos.outcome} ${pos.shares}sh — treated as loss, cost $${pos.cost.toFixed(2)} written off`);
    }
    this.positions = this.positions.filter(p => p.exitReason == null);

    this._windowSlug = market.slug;
    this._windowEntries = 0;
    this._windowActive = null;
    this._windowTriggered.clear();
    this._pendingFill = null;
    this._pendingSL = null;
    this.log(`📊 Window ${market.slug.slice(-10)} open — base ${this._baseShares}sh — monitoring for ${ENTRY_TRIGGER} trigger`);
  }

  _getSideTokens(market) {
    return { up: market.up, down: market.down };
  }

  // Check if any side reaches 0.80 and fire entry
  _checkEntry(market, nowS) {
    if (this._windowActive || this._pendingFill || this._pendingSL) return;
    if (this._windowEntries >= MAX_ENTRIES_PER_WINDOW) return;
    if (nowS < market.windowStart + 1) return; // wait at least 1s after window opens

    const { up, down } = this._getSideTokens(market);
    let triggerSide = null;

    if (up.ask != null && up.ask >= ENTRY_TRIGGER && !this._windowTriggered.has('UP')) {
      triggerSide = 'UP';
    } else if (down.ask != null && down.ask >= ENTRY_TRIGGER && !this._windowTriggered.has('DOWN')) {
      triggerSide = 'DOWN';
    }

    if (!triggerSide) return;

    this._windowTriggered.add(triggerSide);
    const triggerPrice = triggerSide === 'UP' ? up.ask : down.ask;

    // Fire entry — fill price will be set on next tick (slippage simulation)
    this._pendingFill = {
      slug: market.slug,
      outcome: triggerSide,
      shares: this._baseShares,
      triggerPrice,
      firedAt: Date.now(),
    };
    this.log(`🔥 ENTRY FIRED ${triggerSide} — ${this._baseShares}sh @ ask $${triggerPrice.toFixed(2)} — awaiting fill`);
  }

  // Resolve pending fill on next tick (slippage simulation)
  _resolveFill(market) {
    if (!this._pendingFill) return;
    const pf = this._pendingFill;
    const token = pf.outcome === 'UP' ? market.up : market.down;

    // Slippage: fill price = current ask ± random slippage (can be better or worse)
    const ask = token.ask ?? pf.triggerPrice;
    // Slippage range: -0.03 (better) to +0.05 (worse), capped at 0.99
    const slippage = (Math.random() * 0.08 - 0.03); // -0.03 to +0.05
    let fillPrice = round5(Math.max(0.01, Math.min(0.99, ask + slippage)));

    const grossCost = round2(pf.shares * fillPrice);
    const fee = takerFee(pf.shares, fillPrice);
    const cost = round2(grossCost + fee);

    if (cost > this.bankroll) {
      this.log(`⚠️ SKIP FILL ${pf.outcome} ${pf.shares}sh — bankroll too low ($${this.bankroll.toFixed(2)})`);
      this._pendingFill = null;
      return;
    }

    const position = {
      slug: pf.slug, outcome: pf.outcome, market,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      shares: pf.shares, entryPrice: fillPrice, cost, fee,
      openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null,
    };
    this.positions.push(position);
    this._windowActive = position;
    this._windowEntries += 1;
    this.bankroll = round2(this.bankroll - cost);

    this.trades.push({
      timestamp: Date.now(), type: 'BUY', slug: pf.slug, outcome: pf.outcome,
      shares: pf.shares, price: fillPrice, cost, fee,
      reason: `FILL ask $${ask.toFixed(2)} slippage → $${fillPrice.toFixed(2)} (${pf.shares}sh) · fee $${fee.toFixed(2)}`,
    });
    this.log(`✅ FILL ${pf.outcome} ${pf.shares}sh @ $${fillPrice.toFixed(2)} (ask $${ask.toFixed(2)}) · cost $${grossCost.toFixed(2)} + fee $${fee.toFixed(2)} = $${cost.toFixed(2)} · entry #${this._windowEntries}/${MAX_ENTRIES_PER_WINDOW}`);
    this._pendingFill = null;
  }

  // Check stop loss at 0.62
  _checkStopLoss(market) {
    if (!this._windowActive || this._pendingSL) return;
    const pos = this._windowActive;
    const token = pos.outcome === 'UP' ? market.up : market.down;

    if (token.ask != null && token.ask <= STOP_LOSS_PRICE) {
      // SL triggered — sell at market, fill on next tick
      this._pendingSL = { ...pos };
      this.log(`🛑 SL TRIGGERED ${pos.outcome} ${pos.shares}sh — ask $${token.ask.toFixed(2)} ≤ $${STOP_LOSS_PRICE} — selling`);
    }
  }

  // Resolve pending SL fill on next tick
  _resolveSL(market) {
    if (!this._pendingSL) return;
    const ps = this._pendingSL;
    const token = ps.outcome === 'UP' ? market.up : market.down;

    // SL fill with slippage (can be better or worse than 0.62)
    const ask = token.ask ?? STOP_LOSS_PRICE;
    const slippage = (Math.random() * 0.06 - 0.03); // -0.03 to +0.03
    let fillPrice = round5(Math.max(0.01, Math.min(0.99, STOP_LOSS_PRICE + slippage)));

    const grossProceeds = round2(ps.shares * fillPrice);
    const fee = takerFee(ps.shares, fillPrice);
    const proceeds = round2(grossProceeds - fee);
    const pnl = round2(proceeds - ps.cost);

    this.bankroll = round2(this.bankroll + proceeds);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    this.losses += 1;

    // Mark position as resolved
    ps.exitReason = 'STOP_LOSS';
    ps.exitPrice = fillPrice;
    ps.pnl = pnl;
    ps.closedAt = Date.now();

    this.results.unshift({
      slug: ps.slug, outcome: ps.outcome, shares: ps.shares,
      entryPrice: ps.entryPrice, cost: ps.cost, exitPrice: fillPrice, pnl,
      exitReason: 'STOP_LOSS', closedAt: Date.now(), won: false,
    });
    this.trades.push({
      timestamp: Date.now(), type: 'SELL', slug: ps.slug, outcome: ps.outcome,
      shares: ps.shares, price: fillPrice, pnl,
      reason: `SL @ $${fillPrice.toFixed(2)} → P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
    });
    this.log(`❌ SL ${ps.outcome} ${ps.shares}sh sold @ $${fillPrice.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);

    this._windowActive = null;
    this._pendingSL = null;
    // Allow re-entry on either side for the 2nd entry
    this._windowTriggered.clear();

    // Escalate martingale for next entry/window
    this._baseShares = round2(this._baseShares * MARTINGALE_MULT);
    this.log(`📈 Martingale → next base ${this._baseShares}sh`);
  }

  // Check resolution (last 1 second of window)
  _checkResolution(market, nowS) {
    if (!this._windowActive) return;
    if (nowS < market.windowEnd - 1) return; // only check in last 1 second

    const pos = this._windowActive;
    const token = pos.outcome === 'UP' ? market.up : market.down;
    const ask = token.ask ?? 0;

    market.settled = true;
    const won = ask >= RESOLUTION_THRESHOLD;

    if (won) {
      const grossProceeds = pos.shares; // $1 per share
      const fee = takerFee(pos.shares, 1);
      const proceeds = round2(grossProceeds - fee);
      const pnl = round2(proceeds - pos.cost);
      this.bankroll = round2(this.bankroll + proceeds);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      this.wins += 1;

      pos.exitReason = 'RESOLUTION_WIN';
      pos.exitPrice = 1;
      pos.pnl = pnl;
      pos.closedAt = Date.now();
      pos.won = true;

      this.results.unshift({
        slug: pos.slug, outcome: pos.outcome, shares: pos.shares,
        entryPrice: pos.entryPrice, cost: pos.cost, exitPrice: 1, pnl,
        exitReason: 'RESOLUTION_WIN', closedAt: Date.now(), won: true,
      });
      this.trades.push({
        timestamp: Date.now(), type: 'RESOLVED', slug: pos.slug, outcome: pos.outcome,
        shares: pos.shares, price: 1, pnl,
        reason: `WIN ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L +$${pnl.toFixed(2)} (ask $${ask.toFixed(3)} ≥ 0.95)`,
      });
      this.log(`🏆 WIN ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L +$${pnl.toFixed(2)} (proceeds $${grossProceeds.toFixed(2)} - fee $${fee.toFixed(2)}) — martingale RESET`);

      // Reset martingale
      this._baseShares = BASE_SHARES;
    } else {
      const pnl = round2(0 - pos.cost);
      this.bankroll = round2(this.bankroll); // $0 proceeds
      this.realizedPnl = round2(this.realizedPnl + pnl);
      this.losses += 1;

      pos.exitReason = 'RESOLUTION_LOSS';
      pos.exitPrice = 0;
      pos.pnl = pnl;
      pos.closedAt = Date.now();
      pos.won = false;

      this.results.unshift({
        slug: pos.slug, outcome: pos.outcome, shares: pos.shares,
        entryPrice: pos.entryPrice, cost: pos.cost, exitPrice: 0, pnl,
        exitReason: 'RESOLUTION_LOSS', closedAt: Date.now(), won: false,
      });
      this.trades.push({
        timestamp: Date.now(), type: 'RESOLVED', slug: pos.slug, outcome: pos.outcome,
        shares: pos.shares, price: 0, pnl,
        reason: `LOSS ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L -$${Math.abs(pnl).toFixed(2)} (ask $${ask.toFixed(3)} < 0.95)`,
      });
      this.log(`💀 LOSS ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L -$${Math.abs(pnl).toFixed(2)} (no proceeds) — martingale → ${this._baseShares}sh`);

      // Escalate martingale for next window
      this._baseShares = round2(this._baseShares * MARTINGALE_MULT);
    }

    this._windowActive = null;
    this.positions = this.positions.filter(p => p.exitReason == null);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── Main evaluate loop ─────────────────────────────────
  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));
    const elapsed = Math.floor(nowS - cs);

    // Discover current + next window
    if (!this.markets.has(slugFor(cs))) this.discoverWindow(cs).catch(() => {});
    if (!this.markets.has(slugFor(cs + WINDOW_SECONDS))) this.discoverWindow(cs + WINDOW_SECONDS).catch(() => {});

    if (!market) { this.onTick(this.buildState()); return; }
    if (this.entryWindow != null && market.windowStart < this.entryWindow) { this.onTick(this.buildState()); return; }

    // New window — reset state
    this._resetWindow(market);

    // During active window — check entry + SL first (may create pendingFill / pendingSL)
    if (elapsed >= 1 && elapsed < WINDOW_SECONDS) {
      this._checkEntry(market, nowS);
      this._checkStopLoss(market);
    }

    // Resolve pending SL fill (sell position)
    this._resolveSL(market);

    // Resolve pending entry fill (open position)
    this._resolveFill(market);

    // Check resolution (last 1 second or past window end)
    if (nowS >= market.windowEnd - 1 || elapsed >= WINDOW_SECONDS) {
      if (this._windowActive) {
        this._checkResolution(market, nowS);
      }
    }

    this.recordEquity();
    this.onTick(this.buildState());
  }

  // ── Equity tracking ─────────────────────────────────────
  recordEquity() {
    const now = Date.now();
    const last = this.equityCurve.at(-1);
    if (last && now - last.t < 5000) return;
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
      strategy: `Momentum Catch · ${ENTRY_TRIGGER} trigger · SL ${STOP_LOSS_PRICE} · ${MAX_ENTRIES_PER_WINDOW} entries/window · ${MARTINGALE_MULT}x martingale · base ${BASE_SHARES}sh`,
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
      prevWindowWinner: null,
      currentWindow: market ? this.publicMarket(market) : null,
      martingaleBase: this._baseShares,
      windowEntries: this._windowEntries,
      maxEntries: MAX_ENTRIES_PER_WINDOW,
      entryTrigger: ENTRY_TRIGGER,
      stopLoss: STOP_LOSS_PRICE,
      pendingFill: this._pendingFill ? { outcome: this._pendingFill.outcome, shares: this._pendingFill.shares, triggerPrice: this._pendingFill.triggerPrice } : null,
      pendingSL: this._pendingSL ? { outcome: this._pendingSL.outcome, shares: this._pendingSL.shares, entryPrice: this._pendingSL.entryPrice } : null,
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
        const markPrice = token?.mid ?? p.entryPrice;
        return { outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, markPrice, unrealized: round2(p.shares * markPrice - p.cost) };
      }),
      results: this.results.slice(-50),
      trades: this.trades.slice(-50),
      logs: this.logs,
      equityCurve: this.equityCurve,
      config: { baseShares: BASE_SHARES, entryTrigger: ENTRY_TRIGGER, stopLoss: STOP_LOSS_PRICE, martingaleMult: MARTINGALE_MULT, maxEntries: MAX_ENTRIES_PER_WINDOW, takerFeeRate: TAKER_FEE, bankroll: this.bankroll },
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
    this.log(`🚀 ${this.name} started · ${ENTRY_TRIGGER} trigger · SL ${STOP_LOSS_PRICE} · ${MARTINGALE_MULT}x martingale · base ${BASE_SHARES}sh · ${(TAKER_FEE*100).toFixed(0)}% taker fee · CLOB-only`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { MomentumCatchEngine, config: { BASE_SHARES, ENTRY_TRIGGER, STOP_LOSS_PRICE, MARTINGALE_MULT, MAX_ENTRIES_PER_WINDOW, TAKER_FEE, START_BANKROLL } };
