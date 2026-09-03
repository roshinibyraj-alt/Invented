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
const ENTRY_TRIGGER     = 0.70;
const RESOLUTION_THRESHOLD = 0.95;
const MARTINGALE_MULT   = 2.5;
const MAX_MARTINGALE_CAP = 400; // cap at 4x base
const MAX_ENTRIES_PER_WINDOW = 2;
const WAIT_SECONDS        = 45;
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
    this._windowTriggered = new Set(); // which side already triggered 0.70 this window
    this._windowSkipped = new Set();   // which side was skipped due to bankroll this window
    this._lastOutcome = null;             // last traded side, next must flip
    this._pendingFill = null;        // { slug, outcome, shares, triggerPrice, firedAt } — waiting for next tick
    
    this._positionAge = 0;          // { slug, outcome, shares, entryPrice, cost, openedAt } — SL sell pending
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
    this._windowSkipped.clear();
    this._pendingFill = null;
    this._positionAge = 0;
    this._lastOutcome = null;
    // Bankroll guard at window open: reset base if it can't be afforded
    const windowCostEstimate = round2(this._baseShares * 0.70 * 1.025);
    if (this._baseShares > BASE_SHARES && windowCostEstimate > this.bankroll * 0.50) {
      this.log(`🔄 Window ${market.slug.slice(-10)} open — base ${this._baseShares}sh too large ($${windowCostEstimate.toFixed(2)} > 50% bankroll) → reset to ${BASE_SHARES}sh`);
      this._baseShares = BASE_SHARES;
    } else {
      this.log(`📊 Window ${market.slug.slice(-10)} open — base ${this._baseShares}sh — monitoring for ${ENTRY_TRIGGER} trigger`);
    }
  }

  _getSideTokens(market) {
    return { up: market.up, down: market.down };
  }

  // Check if any side reaches 0.80 and fire entry
  _checkEntry(market, nowS) {
    if (this._pendingFill) return;
    if (nowS <= market.windowStart + WAIT_SECONDS) return;

    const { up, down } = this._getSideTokens(market);
    const upPrice = up.mid ?? up.ask ?? up.bid ?? 0;
    const downPrice = down.mid ?? down.ask ?? down.bid ?? 0;

    // Check which sides already have open positions
    const hasUp = this.positions.some(p => p.exitReason == null && p.outcome === 'UP');
    const hasDown = this.positions.some(p => p.exitReason == null && p.outcome === 'DOWN');

    let triggerSide = null;
    if (!hasUp && upPrice >= 0.69 && !this._windowSkipped.has('UP')) {
      triggerSide = 'UP';
    } else if (!hasDown && downPrice >= 0.69 && !this._windowSkipped.has('DOWN')) {
      triggerSide = 'DOWN';
    }

    if (!triggerSide) return;

    const triggerPrice = triggerSide === 'UP' ? upPrice : downPrice;
    const minCost = round2(this._baseShares * triggerPrice * 1.025);
    if (minCost > this.bankroll) {
      this.log(`⚠️ SKIP ${triggerSide} — can't afford ${this._baseShares}sh @ $${triggerPrice.toFixed(2)} (need $${minCost.toFixed(2)}, have $${this.bankroll.toFixed(2)})`);
      this._windowSkipped.add(triggerSide);
      if (this._baseShares > BASE_SHARES) {
        this.log(`🔄 Bankroll guard — resetting martingale base ${this._baseShares}sh → ${BASE_SHARES}sh`);
        this._baseShares = BASE_SHARES;
      }
      return;
    }

    this._pendingFill = {
      slug: market.slug,
      outcome: triggerSide,
      shares: this._baseShares,
      triggerPrice,
      firedAt: Date.now(),
    };
    this.log(`🔥 ENTRY FIRED ${triggerSide} — ${this._baseShares}sh @ $${triggerPrice.toFixed(2)} — awaiting fill`);
  }

  // Resolve pending fill on next tick (slippage simulation)
  _resolveFill(market) {
    if (!this._pendingFill) return;
    const pf = this._pendingFill;
    const token = pf.outcome === 'UP' ? market.up : market.down;

    // Limit order fills at exactly 0.70
    const fillPrice = 0.70;

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
    this._windowTriggered.add(pf.outcome);
    this.positions.push(position);
    this._windowEntries += 1;
    this.bankroll = round2(this.bankroll - cost);

    this.trades.push({
      timestamp: Date.now(), type: 'BUY', slug: pf.slug, outcome: pf.outcome,
      shares: pf.shares, price: fillPrice, cost, fee,
      reason: `LIMIT 0.70 fill → $${fillPrice.toFixed(2)} (${pf.shares}sh) · fee $${fee.toFixed(2)}`,
    });
    this.log(`✅ FILL ${pf.outcome} ${pf.shares}sh @ $${fillPrice.toFixed(2)} (trigger $${pf.triggerPrice.toFixed(2)}) · cost $${grossCost.toFixed(2)} + fee $${fee.toFixed(2)} = $${cost.toFixed(2)} · entry #${this._windowEntries}`);
    this._pendingFill = null;
  }

  // No stop loss — hold to resolution

  // Check resolution (last 1 second of window)
  _checkResolution(market, nowS) {
    const openPositions = this.positions.filter(p => p.exitReason == null && p.slug === market.slug);
    if (openPositions.length === 0) return;
    if (nowS < market.windowEnd - 1) return;

    const upToken = market.up;
    const downToken = market.down;
    const upPrice = upToken.mid ?? upToken.ask ?? upToken.bid ?? 0;
    const downPrice = downToken.mid ?? downToken.ask ?? downToken.bid ?? 0;
    const upHigh = Math.max(upPrice, market.finalUpMax ?? 0);
    const downHigh = Math.max(downPrice, market.finalDownMax ?? 0);

    market.settled = true;

    // Resolve each open position
    for (const pos of openPositions) {
    let won = false;
    if (pos.outcome === 'UP') {
      won = upHigh >= RESOLUTION_THRESHOLD || (upPrice > downPrice && upPrice >= 0.90);
    } else {
      won = downHigh >= RESOLUTION_THRESHOLD || (downPrice > upPrice && downPrice >= 0.90);
    }

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
        reason: `WIN ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L +$${pnl.toFixed(2)} (up $${upPrice.toFixed(3)} dn $${downPrice.toFixed(3)})`,
      });
      this.log(`🏆 WIN ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L +$${pnl.toFixed(2)} (proceeds $${grossProceeds.toFixed(2)} - fee $${fee.toFixed(2)}) — martingale RESET`);

      // Reset martingale
      this._baseShares = BASE_SHARES;
      this._lastOutcome = pos.outcome;
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
        reason: `LOSS ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L -$${Math.abs(pnl).toFixed(2)} (up $${upPrice.toFixed(3)} dn $${downPrice.toFixed(3)})`,
      });
      // Escalate martingale for next window (capped at MAX_MARTINGALE_CAP)
      this._baseShares = Math.min(round2(this._baseShares * MARTINGALE_MULT), MAX_MARTINGALE_CAP);

      // Bankroll guard: if next position cost exceeds 50% of bankroll, reset to base
      const nextCostEstimate = round2(this._baseShares * 0.70 * 1.025);
      if (nextCostEstimate > this.bankroll * 0.50) {
        this.log(`💀 LOSS ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L -$${Math.abs(pnl).toFixed(2)} — martingale ${this._baseShares}sh would cost $${nextCostEstimate.toFixed(2)} > 50% bankroll → RESET to ${BASE_SHARES}sh`);
        this._baseShares = BASE_SHARES;
      } else {
        this.log(`💀 LOSS ${pos.outcome} ${pos.shares}sh @ $${pos.entryPrice.toFixed(2)} → P&L -$${Math.abs(pnl).toFixed(2)} — martingale → ${this._baseShares}sh`);
      }
      this._lastOutcome = pos.outcome;
      this._windowTriggered.clear();
    }

    } // end for each position
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
      this._positionAge++;
      this._checkEntry(market, nowS);
    }



    // Resolve pending entry fill (open position)
    this._resolveFill(market);

    // Check resolution (last 1 second or past window end)
    if (nowS >= market.windowEnd - 1 || elapsed >= WINDOW_SECONDS) {
      this._checkResolution(market, nowS);
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
      strategy: `MomentumCatch · limit 0.70 · no SL · unlimited entries · ${MARTINGALE_MULT}x martingale · base ${BASE_SHARES}sh`,
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

      pendingFill: this._pendingFill ? { outcome: this._pendingFill.outcome, shares: this._pendingFill.shares, triggerPrice: this._pendingFill.triggerPrice } : null,

      positions: open.map(p => {
        const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
        const markPrice = token?.mid ?? p.entryPrice;
        return { outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, markPrice, unrealized: round2(p.shares * markPrice - p.cost) };
      }),
      results: this.results.slice(-50),
      trades: this.trades.slice(-50),
      logs: this.logs,
      equityCurve: this.equityCurve,
      config: { baseShares: this._baseShares, entryTrigger: 0.70, noStopLoss: true, martingaleMult: MARTINGALE_MULT, martingaleCap: MAX_MARTINGALE_CAP, takerFeeRate: TAKER_FEE, bankroll: this.bankroll },
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
    this.log(`🚀 ${this.name} started · limit 0.70 · no SL · ${MARTINGALE_MULT}x martingale · base ${BASE_SHARES}sh · ${(TAKER_FEE*100).toFixed(0)}% taker fee · CLOB-only`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { MomentumCatchEngine, config: { BASE_SHARES, ENTRY_TRIGGER: 0.70, MARTINGALE_MULT, TAKER_FEE, START_BANKROLL } };
