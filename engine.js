'use strict';

// ── Config (env-overridable) ───────────────────────────────
const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST = process.env.CLOB_REST || 'https://clob.polymarket.com';

const WINDOW_SECONDS = 300;                     // BTC 5m windows

const ENTRY_PRICE   = Number(process.env.ENTRY_PRICE   || 0.70); // first entry fire level
const SL_PRICE      = Number(process.env.SL_PRICE      || 0.50); // stop-loss sell level
const REENTRY_PRICE = Number(process.env.REENTRY_PRICE || 0.65); // re-entry fire level after SL
const WAIT_SECONDS  = Number(process.env.WAIT_SECONDS  || 45);   // wait after window open
const SLIP_CEILING  = Number(process.env.SLIP_CEILING  || 0.99); // accept ANY slippage up to this ceiling (0.99)
const BASE_PCT      = Number(process.env.BASE_PCT      || 0.10); // base = this fraction of bankroll (10%)
const MARTINGALE_X  = Number(process.env.MARTINGALE_X  || 2);    // double shares each re-entry
const MAX_MARTINGALE = Number(process.env.MAX_MARTINGALE || 2);   // max martingale steps per window (base + 2 = 3 entries max)
const START_BANKROLL= Number(process.env.START_BANKROLL|| 1000); // demo capital
const TAKER_FEE_RATE = Number(process.env.TAKER_FEE_RATE || 0.07); // Polymarket crypto taker fee rate (0.07 = 7%); makers 0

const CLOB_POLL_MS   = Math.max(100, Number(process.env.CLOB_POLL_MS || 300));
const CLOB_FRESH_MS  = Math.max(CLOB_POLL_MS, Number(process.env.CLOB_FRESH_MS || 1500));
const CLOB_TIMEOUT_MS= Math.max(400, Number(process.env.CLOB_TIMEOUT_MS || 1500));

// ── Helpers ────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
// Polymarket taker fee: fee = C * feeRate * p * (1 - p), rounded to 5 decimals.
function takerFee(C, p, rate = TAKER_FEE_RATE) {
  return round5(C * rate * p * (1 - p));
}
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(start) { return `btc-updown-5m-${start}`; }

class FlipBotEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.onTick = options.onTick || (() => {});
    this.onLog = options.onLog || (() => {});
    this.name = options.name || 'FlipBot5m';
    this.startedAt = Date.now();

    this.bankroll = options.bankroll ?? START_BANKROLL;
    this.initialBankroll = this.bankroll;
    this.realizedPnl = 0;
    this.totalFeesPaid = 0;
    this.wins = 0;
    this.losses = 0;
    this.peakEquity = this.bankroll;
    this.maxDrawdown = 0;        // biggest drop from peak equity (lifetime)
    this.maxReentryEver = 0;   // highest martingale steps ever used in one window
    this.maxSharesEver = 0;    // largest single entry ever placed (lifetime)
    this.maxDeepestBeforeWin = 0;   // deepest martingale escalation reached before a win (all-time)
    this.maxConsecLosesBeforeWin = 0; // most consecutive losing steps before a win (all-time)

    this.markets = new Map();          // slug -> market record
    this.tokens = new Map();           // tokenId -> token
    this.discoveryJobs = new Map();
    this.currentStart = windowStartFor(Date.now());

    // Per-window trading state
    this.windowStartFor = null;           // windowStart currently being traded
    this.positionSeq = 0;                 // entry count within current window (1-based)
    this.reentryCount = 0;                // how many re-entries (after SL) in this window
    this.maxMartingale = MAX_MARTINGALE;  // max martingale steps per window
    this.baseShares = Math.max(1, Math.round(this.bankroll * BASE_PCT / ENTRY_PRICE)); // 10% of capital in shares at 0.70
    this.nextShares = this.baseShares;    // shares for the next entry
    this.entryTarget = ENTRY_PRICE;       // current fire level (0.70 first, 0.65 after SL)
    this.awaitingReentry = false;         // true after an SL, wait for any side at 0.65
    this.openEntry = null;                // side of the current open position
    this.noMoreEntries = false;           // martingale cap reached -> no more entries this window
    this.positions = [];                  // BUY positions (open + resolved this window)
    this.results = [];
    this.trades = [];
    this.windowPaused = false;
    this.pauseReason = null;

    this.logs = [];
    this.equityCurve = [{ t: Date.now(), equity: this.bankroll }];

    this.entryWindow = null;           // first tradeable window (wait for next on restart)
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
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'flip-bot/1.0',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
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
          slug, title: market.question || slug,
          conditionId: market.conditionId,
          windowStart: start, windowEnd: start + WINDOW_SECONDS,
          settled: false, winner: null,
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
      } finally {
        this.discoveryJobs.delete(slug);
      }
    })();
    this.discoveryJobs.set(slug, job);
    return job;
  }

  makeToken(tokenId, slug, outcome) {
    const token = {
      tokenId: String(tokenId), slug, outcome,
      bid: null, ask: null, mid: null, spread: null,
      topAskNotional: 0, updatedAt: null, bookAsks: [], bookBids: [],
      prevAsk: null,
      lastFireTick: null, // last ask value we already fired/considered for this side
    };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  // ── CLOB polling ──────────────────────────────────────────
  applyBook(token, bids, asks) {
    token.prevAsk = token.ask; // snapshot for tick-crossing detection
    const validBids = (bids || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validBids.sort((a, b) => b.price - a.price);
    const validAsks = (asks || []).filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookBids = validBids;
    token.bookAsks = validAsks;
    const bestBid = validBids[0]?.price ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    const topAskNotional = validAsks[0] ? round2(validAsks[0].price * validAsks[0].size) : 0;
    const cleanBid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    const cleanAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    token.bid = cleanBid; token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.topAskNotional = topAskNotional;
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
    } finally {
      this.pollInFlight -= 1;
    }
  }

  // ── Strategy ──────────────────────────────────────────────
  // Flow per window:
  //   1. Wait WAIT_SECONDS (7s) after the window opens.
  //   2. Fire when ANY side's ask ticks to ENTRY_PRICE (0.70) — first entry,
  //      base = 1% of capital in shares. Hold it.
  //   3. If held price drops to SL_PRICE (0.50) → sell immediately at 0.50.
  //   4. After SL, wait for ANY side's ask to reach REENTRY_PRICE (0.65) and fire
  //      with DOUBLE the shares — capped at MAX_MARTINGALE (2) steps per window.
  //   5. If held and never hits SL → hold to resolution (winner 1.0, loser 0).
  //   6. No carry-over: each window always starts fresh at base (10% of capital).
  //      When the martingale cap (2 steps) is reached and the 3rd bet SLs, the
  //      window simply ends — nothing carries to the next window.

  computeBaseForNextWindow() {
    this.baseShares = Math.max(1, Math.round(this.bankroll * BASE_PCT / ENTRY_PRICE));
  }

  prepareWindow(market) {
    // Called once per new window to reset per-window state.
    this.windowStartFor = market.windowStart;
    this.positionSeq = 0;
    this.reentryCount = 0;
    this.awaitingReentry = false;
    this.openEntry = null;
    this.windowPaused = false;
    this.pauseReason = null;
    this.noMoreEntries = false;
    this.computeBaseForNextWindow();
    this.nextShares = this.baseShares;
    this.entryTarget = ENTRY_PRICE;
    this.windowOpenedAt = Date.now();
    this.log(`🆕 WINDOW ${market.slug.slice(-10)} — BASE ${this.baseShares} SH = 10% of $${this.bankroll.toFixed(2)} @ ${ENTRY_PRICE.toFixed(2)} · wait ${WAIT_SECONDS}s · SL ${SL_PRICE.toFixed(2)} · re-enter @ ${REENTRY_PRICE.toFixed(2)} · max ${MAX_MARTINGALE} martingale (no carry)`);
    this.onTick(this.buildState());
  }

  evaluate() {
    const now = Date.now();
    const nowS = now / 1000;
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor(cs));

    // Resolve any open position whose own window has ended (handles rollover).
    this.resolveExpired(market, nowS);

    if (!market) return;
    if (this.entryWindow != null && market.windowStart < this.entryWindow) {
      // Started mid-window on (re)start: skip until next full window.
      return;
    }

    // New window → reset state.
    if (this.windowStartFor !== market.windowStart) this.prepareWindow(market);

    const elapsed = Math.floor(nowS - market.windowStart);


    if (!this.windowPaused) {
      if (this.openEntry) {
        // Holding a position → check stop loss first.
        this.checkStopLoss(market);
      } else if (elapsed >= WAIT_SECONDS && !this.noMoreEntries) {
        // Not holding, past wait, and martingale cap not hit → fire at the current target.
        this.tryEntry(market);
      }
    }

    this.recordEquity();
    this.onTick(this.buildState());
  }

  tryEntry(market) {
    // Fire when ANY side's ask ticks to the current target (<= SLIP_CEILING).
    // Matches the v070-pullback-analyzed profitable behavior — may buy the cheap side.
    const target = this.entryTarget;
    const upRd = this.tryBuildEntry('UP', market, target);
    const dnRd = this.tryBuildEntry('DOWN', market, target);
    let entry = null;
    if (upRd && dnRd) {
      // Both crossed: pick the side closer to the target (fresher), tie -> UP.
      const upDist = Math.abs((market.up.ask ?? 1) - target);
      const dnDist = Math.abs((market.down.ask ?? 1) - target);
      entry = upDist <= dnDist ? upRd : dnRd;
    } else entry = upRd || dnRd;
    if (!entry) return;
    this.executeEntry(market, entry.outcome, entry.shares, entry.fillPrice, target);
  }

  tryBuildEntry(outcome, market, target) {
    const token = outcome === 'UP' ? market.up : market.down;
    const ask = token.ask;
    if (ask == null) return null;
    if (this.awaitingReentry) {
      // Re-entry after SL: fire at/above the re-entry level; ceiling = slippage only.
      if (ask > SLIP_CEILING) return null;
      if (ask < target) return null;
    } else {
      // First entry fires via tryEntry when any side ask <= target; this branch is for re-entry sizing.
      if (ask > target) return null;
      if (ask <= 0.05) return null;
    }
    // Don't re-fire the same static level.
    if (token.lastFireTick === ask) return null;
    const shares = this.nextShares;
    const cost = round2(shares * ask);
    const fee = takerFee(shares, ask);
    if (cost + fee > this.bankroll) { this.log(`⚠️  SKIP ${outcome} @ ${ask.toFixed(3)} — bankroll $${this.bankroll.toFixed(2)} < cost+fee $${(cost+fee).toFixed(2)}`); return null; }
    return { outcome, shares, fillPrice: ask };
  }

  executeEntry(market, outcome, shares, fillPrice, target) {
    const price = fillPrice;
    const cost = round2(shares * price);
    const fee = takerFee(shares, price);
    this.bankroll = round2(this.bankroll - cost - fee);
    this.totalFeesPaid = round2(this.totalFeesPaid + fee);
    this.positionSeq += 1;
    const isReentry = this.positionSeq > 1;
    if (isReentry) this.reentryCount += 1;
    this.openEntry = outcome;
    // Mark this side's fired level so a static price doesn't re-trigger.
    const fireToken = outcome === 'UP' ? market.up : market.down;
    fireToken.lastFireTick = price;
    const position = {
      slug: market.slug, outcome, market,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      shares, entryPrice: price, cost, buyFee: fee,
      openedAt: Date.now(), exitReason: null, exitPrice: null, pnl: null,
      entryNo: this.positionSeq, isReentry,
    };
    this.positions.push(position);
    if (shares > this.maxSharesEver) this.maxSharesEver = shares;
    if (this.reentryCount > this.maxReentryEver) this.maxReentryEver = this.reentryCount;
    this.trades.push({ timestamp: Date.now(), type: 'BUY', slug: market.slug, outcome, shares, price, cost, fee, reason: `ENTRY#${this.positionSeq} ${this.reentryCount > 0 ? `RE@${REENTRY_PRICE}` : `@${ENTRY_PRICE}`} fill ${fillPrice.toFixed(3)}` });
    this.log(`⚡ ENTRY#${this.positionSeq} ${outcome} ${shares}sh @ ${price.toFixed(3)} · cost $${cost.toFixed(2)} · fee $${fee.toFixed(4)} · fill ${fillPrice.toFixed(3)}` + (this.reentryCount > 0 ? ` · RE-ENTRY after SL` : ` · first entry`));
    this.onTick(this.buildState());
  }

  checkStopLoss(market) {
    const pos = this.positions.find(p => p.exitReason == null);
    if (!pos) { this.openEntry = null; return; }
    const token = pos.outcome === 'UP' ? market.up : market.down;
    const px = token.mid ?? token.bid ?? token.ask;
    if (px == null) return;
    if (px <= SL_PRICE) {
      // If entry was below SL_PRICE (cheap side), this is a TP — profitable exit.
      const isTP = pos.entryPrice < SL_PRICE;
      const exitReason = isTP ? 'TP' : 'STOP_LOSS';
      this.sellPosition(pos, SL_PRICE, exitReason);
      this.openEntry = null;
      if (isTP) {
        this.log(`✅ TP at ${SL_PRICE.toFixed(2)} — entry ${pos.entryPrice.toFixed(3)} < ${SL_PRICE.toFixed(2)} · profitable exit`);
      }
      // Martingale always escalates regardless of TP or SL.
      if (this.reentryCount >= this.maxMartingale) {
        this.noMoreEntries = true;
        this.awaitingReentry = false;
        this.log(`🔁 ${exitReason} at ${SL_PRICE.toFixed(2)} — martingale cap (${this.maxMartingale}) reached · stop trading this window`);
      } else {
        this.nextShares = Math.round(pos.shares * MARTINGALE_X);
        this.entryTarget = REENTRY_PRICE;
        this.awaitingReentry = true;
        this.log(`🔁 ${exitReason} at ${SL_PRICE.toFixed(2)} — next re-entry @ ${REENTRY_PRICE.toFixed(2)} with ${this.nextShares}sh (M${this.reentryCount + 1}/${this.maxMartingale})`);
      }
    }
  }

  sellPosition(position, price, reason, extra = {}) {
    if (position.exitReason != null) return;
    const proceeds = round2(position.shares * price);
    const fee = takerFee(position.shares, price);
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
    this.results.unshift({ ...position, market: undefined, token: undefined });
    this.results = this.results.slice(0, 50);
    this.trades.push({ timestamp: Date.now(), type: 'SELL', slug: position.slug, outcome: position.outcome, shares: position.shares, price, pnl, fee, reason, ...extra });
    this.log(`💰 ${reason === 'RESOLUTION' ? 'RESOLUTION' : 'STOP-LOSS'} ${position.outcome} @ ${price.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · ${position.shares}sh · entry #${position.entryNo} · fees $${((position.buyFee||0)+fee).toFixed(4)}`);
    this.recordEquity();
    this.onTick(this.buildState());
  }

  resolveExpired(market, nowS) {
    const open = this.positions.filter(p => p.exitReason == null);
    const buckets = new Map(); // windowStart -> positions
    for (const pos of open) {
      if (nowS < pos.windowEnd) continue;
      const w = pos.windowEnd;
      if (!buckets.has(w)) buckets.set(w, []);
      buckets.get(w).push(pos);
    }
    for (const [windowEnd, group] of buckets) {
      const m = group[0].market;
      const upMid = m.up.mid, downMid = m.down.mid;
      let winner = null;
      if (upMid != null && downMid != null) winner = upMid >= downMid ? 'UP' : 'DOWN';
      else if (upMid != null) winner = upMid >= 0.5 ? 'UP' : 'DOWN';
      else if (downMid != null) winner = downMid >= 0.5 ? 'DOWN' : 'UP';
      if (!winner) winner = 'UP';
      let winPayout = 0, lossCost = 0;
      for (const pos of group) {
        const won = pos.outcome === winner;
        const payout = won ? pos.shares : 0;
        const exitPrice = won ? 1 : 0;
        this.sellPosition(pos, exitPrice, 'RESOLUTION', { winner, won });
        if (won) winPayout += payout; else lossCost += pos.cost;
      }
      // Track the deepest martingale escalation & consecutive losing steps before the winning leg.
      const winPos = group.find(p => p.outcome === winner && p.exitReason != null && p.won);
      if (winPos) {
        const stepsBeforeWin = Math.max(0, (winPos.entryNo || 1) - 1);
        if (stepsBeforeWin > this.maxDeepestBeforeWin) this.maxDeepestBeforeWin = stepsBeforeWin;
        if (stepsBeforeWin > this.maxConsecLosesBeforeWin) this.maxConsecLosesBeforeWin = stepsBeforeWin;
      }
      this.log(`🏁 WINDOW ${m.slug.slice(-10)} RESOLVED → ${winner} · win payout $${winPayout.toFixed(2)} · loss cost $${lossCost.toFixed(2)}`);
      // No carry-over: next window always starts fresh at base.
    }
    // Prune resolved positions so the array doesn't grow forever.
    if (buckets.size) this.positions = this.positions.filter(p => p.exitReason == null);
  }

  // ── State / equity ────────────────────────────────────────
  markValue() {
    let value = this.bankroll;
    const cs = windowStartFor(Date.now());
    const market = this.markets.get(slugFor(cs));
    for (const p of this.positions) {
      if (p.exitReason != null) continue;
      const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
      const mark = token?.mid ?? p.entryPrice;
      value += round2(p.shares * mark);
    }
    return round2(value);
  }

  isClobFresh(now = Date.now()) {
    return Boolean(this.lastSuccessfulPollAt && now - this.lastSuccessfulPollAt <= CLOB_FRESH_MS);
  }

  publicMarket(market) {
    const now = Date.now();
    const remaining = market.windowEnd - Math.floor(now / 1000);
    return {
      slug: market.slug, title: market.title,
      windowStart: market.windowStart, windowEnd: market.windowEnd,
      remaining: Math.max(0, remaining),
      elapsed: Math.max(0, Math.floor(now / 1000 - market.windowStart)),
      settled: market.settled, winner: market.winner,
      up: { bid: market.up.bid, ask: market.up.ask, mid: market.up.mid, spread: market.up.spread, topAskNotional: market.up.topAskNotional, updatedAt: market.up.updatedAt },
      down: { bid: market.down.bid, ask: market.down.ask, mid: market.down.mid, spread: market.down.spread, topAskNotional: market.down.topAskNotional, updatedAt: market.down.updatedAt },
    };
  }

  buildState() {
    const cs = windowStartFor(Date.now());
    const now = Date.now();
    const market = this.markets.get(slugFor(cs));
    const open = this.positions.filter(p => p.exitReason == null);
    const openUnrealized = open.reduce((s, p) => {
      const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
      const mark = token?.mid ?? p.entryPrice;
      return s + round2(p.shares * mark - p.cost);
    }, 0);
    return {
      version: '3.0.0',
      name: this.name,
      strategy: `FLIP BOT · wait ${WAIT_SECONDS}s → first entry AT/BELOW ${ENTRY_PRICE.toFixed(2)} any side · re-enter ≥ ${REENTRY_PRICE.toFixed(2)} ×${MARTINGALE_X} · SL ${SL_PRICE.toFixed(2)} (max ${MAX_MARTINGALE} martingale) · base 10% · NO carry`,
      serverTime: now,
      connected: this.isClobFresh(),
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
      pauseReason: this.pauseReason,
      currentWindow: market ? this.publicMarket(market) : null,
      windowRemaining: market ? Math.max(0, market.windowEnd - Math.floor(now / 1000)) : null,
      baseShares: this.baseShares,
      noMoreEntries: this.noMoreEntries,
      nextShares: this.nextShares,
      entryTarget: this.entryTarget,
      openEntry: this.openEntry,
      awaitingReentry: this.awaitingReentry,
      reentryCount: this.reentryCount,
      windowElapsed: market ? Math.max(0, Math.floor(now / 1000 - market.windowStart)) : 0,
      positions: open.map(p => {
        const token = p.outcome === 'UP' ? p.market?.up : p.market?.down;
        const mark = token?.mid ?? p.entryPrice;
        return {
          outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost,
          markPrice: mark, unrealized: round2(p.shares * mark - p.cost),
          remaining: p.windowEnd ? Math.max(0, p.windowEnd - Math.floor(now / 1000)) : null,
          entryNo: p.entryNo, isReentry: p.isReentry,
        };
      }),
      tradeCount: this.trades.length,
      trades: this.trades.slice(-60).reverse(),
      results: this.results.slice(0, 30),
      equityCurve: this.equityCurveForUi(), // full lifetime range (downsampled for UI)
      logs: this.logs.slice(-160),
      peakEquity: this.peakEquity,
      drawdown: round2(this.peakEquity - this.markValue()),
      maxDrawdown: this.maxDrawdown,
      maxReentryEver: this.maxReentryEver,
      maxSharesEver: this.maxSharesEver,
      maxDeepestBeforeWin: this.maxDeepestBeforeWin,
      maxConsecLosesBeforeWin: this.maxConsecLosesBeforeWin,
      uptime: Math.floor((now - this.startedAt) / 1000),
      config: {
        entryPrice: ENTRY_PRICE, slPrice: SL_PRICE, reentryPrice: REENTRY_PRICE, waitSeconds: WAIT_SECONDS,
        basePct: BASE_PCT, martingaleX: MARTINGALE_X, slippageCap: SLIP_CEILING,
        baseShares: this.baseShares, maxMartingale: this.maxMartingale, noMoreEntries: this.noMoreEntries, nextShares: this.nextShares, entryTarget: this.entryTarget, takerFeeRate: TAKER_FEE_RATE,
        openEntry: this.openEntry, reentryCount: this.reentryCount,
        pollMs: CLOB_POLL_MS, bankroll: this.initialBankroll,
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
      this.equityCurve.push({ t: Date.now(), equity: mark }); // lifetime: keep full curve
    }
  }

  // Serve the full lifetime curve, downsampled so the dashboard stays light.
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
    this.entryWindow = start + WINDOW_SECONDS; // wait for next full window
    this.log(`⏳ Started mid-window ${start} — trading begins at next window ${this.entryWindow}`);
    await Promise.all([this.discoverWindow(start), this.discoverWindow(start + WINDOW_SECONDS)]);
    this.timers = [
      setInterval(() => { this.pollClob().catch(() => {}); }, CLOB_POLL_MS),
      setInterval(() => { this.discoverWindow(windowStartFor(Date.now())).catch(() => {}); this.discoverWindow(windowStartFor(Date.now()) + WINDOW_SECONDS).catch(() => {}); }, 5000),
      setInterval(() => this.evaluate(), 200),
      setInterval(() => this.recordEquity(), 1000),
    ];
    this.log(`🚀 FlipBot started | wait ${WAIT_SECONDS}s → fire AT/BELOW ${ENTRY_PRICE} any side (wait for pullback) · SL @ ${SL_PRICE} · re-enter @ ${REENTRY_PRICE} ×${MARTINGALE_X} · ceiling ${SLIP_CEILING}`);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = { FlipBotEngine, config: { ENTRY_PRICE, SL_PRICE, REENTRY_PRICE, WAIT_SECONDS, BASE_PCT, MARTINGALE_X, MAX_MARTINGALE, START_BANKROLL, CLOB_POLL_MS, TAKER_FEE_RATE } };
