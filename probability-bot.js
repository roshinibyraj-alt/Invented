'use strict';
const { CalibratedBot, quote } = require('./calibrated-bot');
const ProbabilityFeed = require('./probability-feed');
const SIDES = ['UP', 'DOWN'], EPS = 1e-6;
const STRATEGY = Object.freeze({
  id: 'invented-btc5m-time-aware-twap-value-v2',
  name: 'BTC 5m · Time & value',
  mode: 'PAPER', timeframes: ['5m'], targetShares: 50,
  entryCapitalPercent: 2, openCostPercent: 5, minEdge: .03,
  maxEntriesPerWindow: 3, cooldownSeconds: 15, entryCutoffSeconds: 20, latencyMs: 500,
  model: 'Ten-minute BTC movement ensemble: diffusion, decaying momentum and evidence-weighted mean reversion.',
  entrySelection: 'Compare both sides by executable fee- and uncertainty-adjusted edge, not by highest win probability. A below-50% side can qualify. Equal-edge choices prefer the lower all-in price.',
  exit: 'Sell when the executable net bid exceeds modeled value, or when probability deteriorates and selling remains within the uncertainty allowance. Otherwise hold to official settlement.',
  warning: 'Uncalibrated statistical estimates, not guaranteed edge. Uses a final-60s Chainlink spot-average proxy for the official TWAP. Actual later books and taker fees determine paper fills. No recovery sizing or forced trades.',
});
const feesFor = m => ({
  rate: m.feesEnabled === false ? 0 : Number(m.feeSchedule?.rate),
  exponent: m.feesEnabled === false ? 1 : Number(m.feeSchedule?.exponent),
});
const validFees = f => Number.isFinite(f.rate) && f.rate >= 0 && f.rate <= 1
  && Number.isFinite(f.exponent) && f.exponent >= 0;
const unitFee = (price, f) => f.rate * (price * (1 - price)) ** f.exponent;

function entryPlan(q, budget, fairLower, f, targetShares = STRATEGY.targetShares) {
  if (!q || !validFees(f) || !Number.isFinite(fairLower) || !(budget > 0)) return null;
  let shares = 0, cost = 0, fees = 0;
  const fills = [];
  for (const l of q.asks) {
    const uf = unitFee(l.price, f);
    if (fairLower - l.price - uf < STRATEGY.minEdge - EPS) break;
    const n = Math.min(targetShares - shares, l.size, Math.max(0, budget - cost - fees - .00001) / (l.price + uf));
    if (n <= EPS) continue;
    const fee = Number((n * uf).toFixed(5));
    shares += n; cost += n * l.price; fees += fee; fills.push({ price: l.price, shares: n, fee });
    if (shares >= targetShares - EPS) break;
  }
  if (shares < 5 - EPS || cost + fees > budget + EPS) return null;
  return { shares, cost, fees, fills, entryPrice: cost / shares,
    conservativeEdge: fairLower - (cost + fees) / shares };
}

function rankEntryCandidates(books, model, budget, fees) {
  if (model.status !== 'READY') return [];
  return SIDES.map(side => {
    const probability = side === 'UP' ? model.up : model.down;
    const lower = side === 'UP' ? model.lowerUp : model.lowerDown;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1
      || !Number.isFinite(lower) || lower < 0 || lower > probability) return null;
    const plan = entryPlan(books[side], budget, lower, fees);
    return plan ? { side, probability, allInPrice: (plan.cost + plan.fees) / plan.shares, plan } : null;
  }).filter(Boolean).sort((x, y) => {
    const edgeDifference = y.plan.conservativeEdge - x.plan.conservativeEdge;
    return Math.abs(edgeDifference) > EPS ? edgeDifference : x.allInPrice - y.allInPrice;
  });
}

class ProbabilityBot extends CalibratedBot {
  constructor(options = {}) {
    super(options);
    this.feed = options.feed || new ProbabilityFeed({ now: this.now });
    this.referenceKey = null; this.tradeSequence = 0;
    for (const r of Object.values(this.records)) { r.decision = null; r.model = null; r.lastExitAt = 0; }
  }
  start() { this.feed.start(); super.start(); }
  stop() { this.feed.stop(); super.stop(); }
  async refresh(tf, now) {
    await this.feed.refreshHistory();
    // The inherited refresh only discovers current BTC 5m, fetches/normalizes books,
    // marks holdings, and calls our overridden consider. Its old entry/stop rules are never called.
    await super.refresh(tf, now);
    const r = this.records[tf];
    if (r.market) {
      await this.feed.refreshReference(r.market);
      this.consider(tf, this.now());
    }
  }
  fresh(q, m, side, now) {
    return q && q.tokenId === m.tokens[side] && q.updatedAt <= now && now - q.updatedAt <= 3000
      && q.exchangeAt <= now && now - q.exchangeAt <= 3000 && q.updatedAt >= m.start
      && new Set(q.asks.map(l => l.price)).size === q.asks.length
      && new Set(q.bids.map(l => l.price)).size === q.bids.length;
  }
  entryBook(r, m, side) {
    const q = r.quotes[side];
    r.entryDepths = r.entryDepths || {};
    let d = r.entryDepths[side];
    if (!d || d.start !== m.start) d = r.entryDepths[side] = { start: m.start, at: 0, levels: {} };
    if (q.exchangeAt > d.at) {
      const next = {};
      for (const l of q.asks) {
        const old = d.levels[l.price];
        next[l.price] = { seen: l.size, available: old
          ? Math.min(l.size, old.available + Math.max(0, l.size - old.seen)) : l.size };
      }
      d.at = q.exchangeAt; d.levels = next;
    }
    return { ...q, asks: q.asks.map(l => ({ ...l, size: d.levels[l.price]?.available || 0 })) };
  }
  riskBudget(a) {
    const settled = Math.max(0, a.initialCapital + a.history.reduce((s, p) => s + p.pnl, 0));
    const openCost = a.positions.reduce((s, p) => s + (p.cost + p.entryFees) * p.shares / p.initialShares, 0);
    return Math.max(0, Math.min(a.cash, settled * .02, settled * .05 - openCost));
  }
  decide(r, action, reason, extra = {}) {
    r.status = reason; r.decision = { at: this.now(), action, reason, ...extra };
  }
  consider(tf, now) {
    const r = this.records[tf], m = r.market, a = this.accounts[tf];
    if (!m || now < m.start || now >= m.end || m.raw?.closed || m.raw?.acceptingOrders === false) {
      r.pending = null; this.decide(r, 'WAIT', 'Waiting for an open current BTC five-minute market.'); return;
    }
    const model = r.model = this.feed.evaluate(m);
    const held = a.positions.find(p => p.windowStart === m.start);
    const f = feesFor(m);
    r.edges = Object.fromEntries(SIDES.map(side => {
      const q = r.quotes[side], fair = model.status === 'READY' ? (side === 'UP' ? model.up : model.down) : null;
      const lower = model.status === 'READY' ? (side === 'UP' ? model.lowerUp : model.lowerDown) : null;
      const fresh = this.fresh(q, m, side, now);
      return [side, { probability: fair, lowerProbability: lower, bid: fresh ? q.bestBid : null,
        ask: fresh ? q.bestAsk : null, feePerShare: fresh && q.bestAsk != null && validFees(f) ? unitFee(q.bestAsk, f) : null,
        conservativeEdge: fresh && q.bestAsk != null && fair != null && validFees(f)
          ? lower - q.bestAsk - unitFee(q.bestAsk, f) : null, fresh: !!fresh }];
    }));
    if (held) {
      r.pending = null;
      this.managePosition(held, r, a, now, model);
      return;
    }
    if (model.status !== 'READY') {
      r.pending = null; this.decide(r, 'WAIT', model.reason); return;
    }
    if ((m.end - now) / 1000 <= STRATEGY.entryCutoffSeconds) {
      r.pending = null; this.decide(r, 'WAIT', 'Final 20 seconds: manage existing positions only.'); return;
    }
    const count = [...a.positions, ...a.history].filter(p => p.windowStart === m.start).length;
    if (count >= STRATEGY.maxEntriesPerWindow || now - r.lastExitAt < 15000) {
      r.pending = null; this.decide(r, 'WAIT', count >= 3 ? 'Three-entry window limit reached.' : '15-second cooldown after an exit.'); return;
    }
    if (!validFees(f)) {
      r.pending = null; this.decide(r, 'WAIT', 'Waiting for the market taker fee schedule.'); return;
    }
    const budget = this.riskBudget(a);
    const books = Object.fromEntries(SIDES.filter(side => this.fresh(r.quotes[side], m, side, now))
      .map(side => [side, this.entryBook(r, m, side)]));
    const candidates = rankEntryCandidates(books, model, budget, f);
    if (!candidates.length) {
      r.pending = null; this.decide(r, 'WAIT', budget < 1 ? 'Open-cost or cash limit reached.'
        : 'No executable purchase offers 3¢ edge after fees and model uncertainty.', { budget }); return;
    }
    const { side, plan, probability, allInPrice } = candidates[0], q = r.quotes[side];
    const valueReason = `${side} wins an estimated ${(probability * 100).toFixed(1)}% versus ${(allInPrice * 100).toFixed(1)}¢ all-in cost; ${(plan.conservativeEdge * 100).toFixed(1)}¢ edge after uncertainty. Selected by value, not highest win probability.`;
    if (!r.pending || r.pending.side !== side) {
      r.pending = { side, at: now, bookAt: q.exchangeAt, windowStart: m.start };
      this.decide(r, 'BUY_PENDING', `${valueReason} Checking a later book after 500ms.`, { side, budget }); return;
    }
    if (now - r.pending.at < 500 || q.exchangeAt <= r.pending.bookAt) return;
    const position = {
      id: `value-${m.start}-${now}-${++this.tradeSequence}`, timeframe: tf,
      marketId: m.id, marketSlug: m.slug, title: m.title, tokenId: m.tokens[side],
      side, windowStart: m.start, windowEnd: m.end,
      ...plan, initialShares: plan.shares, initialCost: plan.cost, entryFees: plan.fees,
      exitFees: 0, proceeds: 0, sales: [], feeRate: f.rate, feeExponent: f.exponent,
      openedAt: now, mark: null, status: 'OPEN', entryProbability: probability,
      entryReason: valueReason, entryAllInPrice: allInPrice,
      entryUncertainty: model.uncertaintyMargin, lastProbability: probability,
    };
    a.cash -= plan.cost + plan.fees; a.positions.unshift(position);
    for (const fill of plan.fills) r.entryDepths[side].levels[fill.price].available -= fill.shares;
    position.mark = this.mark(position, q, now);
    r.pending = null; this.dirty = true;
    this.decide(r, 'BOUGHT', `Bought ${plan.shares.toFixed(2)} ${side} shares at actual VWAP $${plan.entryPrice.toFixed(4)}.`, { side });
    this.log(`${side} BUY ${plan.shares.toFixed(2)} shares at $${plan.entryPrice.toFixed(4)}; probability ${(probability * 100).toFixed(1)}%; fees $${plan.fees.toFixed(4)}.`);
  }
  managePosition(p, r, a, now, model) {
    const m = r.market, q = r.quotes[p.side];
    if (!this.fresh(q, m, p.side, now)) {
      this.decide(r, 'HOLD', 'Held position: waiting for a fresh executable bid.'); return;
    }
    const fair = model.status === 'READY' ? (p.side === 'UP' ? model.up : model.down) : null;
    p.lastProbability = fair;
    const f = { rate: p.feeRate, exponent: p.feeExponent };
    const netBid = q.bestBid == null ? null : q.bestBid - unitFee(q.bestBid, f);
    if (!p.exitIntent) {
      let reason = null;
      if (fair != null && netBid != null && netBid >= fair + .025) reason = 'BID_ABOVE_FAIR_VALUE';
      else if (fair != null && netBid != null && fair < p.entryProbability - .08
        && netBid >= fair - model.uncertaintyMargin) reason = 'PROBABILITY_DETERIORATED';
      if (!reason) {
        this.decide(r, 'HOLD', fair == null ? 'Model inputs unavailable: hold pending valid data or official settlement.'
          : 'Holding has better modeled value than selling at the current net bid.', { side: p.side }); return;
      }
      p.exitIntent = { reason, at: now, bookAt: q.exchangeAt };
      this.dirty = true;
      this.decide(r, 'SELL_PENDING', reason === 'BID_ABOVE_FAIR_VALUE'
        ? 'Executable bid exceeds fair value: market sale requested.'
        : 'Probability deteriorated; current bid supports an uncertainty-aware exit.', { side: p.side }); return;
    }
    this.decide(r, 'SELL_PENDING', 'Selling at later available bids; any unfilled remainder stays pending.', { side: p.side });
    if (now - p.exitIntent.at < 500 || q.exchangeAt <= p.exitIntent.bookAt) return;
    const bids = new Set();
    p.exitDepth = p.exitDepth || {};
    for (const l of q.bids) {
      const key = String(l.price); bids.add(key);
      const d = p.exitDepth[key] || { seen: 0, available: 0 };
      d.available = Math.min(l.size, d.available + Math.max(0, l.size - d.seen));
      d.seen = l.size; p.exitDepth[key] = d;
      const n = Math.min(p.shares, d.available);
      if (n <= EPS) continue;
      const fee = Number((n * unitFee(l.price, f)).toFixed(5));
      const proceeds = n * l.price - fee;
      p.shares -= n; d.available -= n; p.exitFees += fee; p.fees += fee;
      p.proceeds += proceeds; a.cash += proceeds;
      p.sales.push({ at: now, price: l.price, shares: n, fee });
      this.dirty = true;
    }
    for (const [key, d] of Object.entries(p.exitDepth)) if (!bids.has(key)) { d.seen = 0; d.available = 0; }
    p.exitIntent.bookAt = q.exchangeAt; p.mark = this.mark(p, q, now);
    if (p.shares <= EPS) {
      p.closedAt = now; p.exitReason = p.exitIntent.reason;
      p.exitPrice = (p.proceeds + p.exitFees) / p.initialShares;
      p.pnl = p.proceeds - p.cost - p.entryFees; p.payout = p.proceeds;
      p.status = 'MODEL_EXIT'; p.shares = p.initialShares; p.mark = null;
      a.positions = a.positions.filter(x => x.id !== p.id); a.history.unshift(p);
      r.lastExitAt = now; this.dirty = true;
      this.decide(r, 'SOLD', `Model exit: ${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)} after all fees.`);
      this.log(`${p.side} MODEL EXIT at $${p.exitPrice.toFixed(4)}; ${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)} net.`);
    }
  }
  // The old fixed 90c stop must never run in the replacement strategy.
  stopPosition() { throw new Error('Fixed-price stop is not part of the probability strategy.'); }
  restoreLedger(saved) {
    if (saved.strategyId !== STRATEGY.id || !saved.accounts?.['5m']) throw new Error('Wrong probability ledger.');
    const a = saved.accounts['5m'];
    if (!Array.isArray(a.positions) || !Array.isArray(a.history) || !Array.isArray(a.equityCurve)
      || a.initialCapital !== 1500 || !Number.isFinite(a.cash) || a.cash < -EPS)
      throw new Error('Invalid probability paper account.');
    const ids = new Set();
    let cash = 1500;
    for (const p of [...a.positions, ...a.history]) {
      if (ids.has(p.id) || !SIDES.includes(p.side) || !(p.initialShares >= 5 - EPS)
        || p.initialShares > 50 + EPS || !Number.isFinite(p.cost) || !Number.isFinite(p.entryFees)
        || !Number.isFinite(p.proceeds) || !Number.isFinite(p.exitFees)
        || !validFees({ rate: p.feeRate, exponent: p.feeExponent }))
        throw new Error('Invalid or duplicated probability position.');
      ids.add(p.id); cash -= p.cost + p.entryFees;
      cash += a.positions.includes(p) ? p.proceeds : p.payout;
    }
    if (Math.abs(cash - a.cash) > .0001) throw new Error('Probability ledger cash reconciliation failed.');
    this.accounts = saved.accounts; this.events = saved.events || [];
    this.tradeSequence = saved.tradeSequence || 0;
    const r = this.records['5m'];
    r.lastExitAt = Math.max(0, ...a.history.map(p => p.closedAt || 0));
    r.entryDepths = saved.entryDepths || {};
  }
  async flushLedger() {
    if (!this.ledgerStore) return;
    const payload = JSON.parse(JSON.stringify({ strategyId: STRATEGY.id, accounts: this.accounts,
      events: this.events, tradeSequence: this.tradeSequence,
      entryDepths: this.records['5m'].entryDepths || {}, savedAt: this.now() }));
    const write = this.saveChain.catch(() => {}).then(() => this.ledgerStore.save(payload));
    this.saveChain = write;
    try { await write; this.lastSavedAt = this.now(); this.persistenceError = null; }
    catch (e) { this.persistenceError = e.message; throw e; }
  }
  snapshot() {
    const state = super.snapshot();
    return { ...state, strategy: STRATEGY, feed: this.feed.snapshot(),
      model: this.records['5m'].model, risk: { budget: this.riskBudget(this.accounts['5m']),
        ...Object.fromEntries(['entryCapitalPercent', 'openCostPercent', 'targetShares'].map(k => [k, STRATEGY[k]])) } };
  }
}
ProbabilityBot.STRATEGY = STRATEGY;
module.exports = { ProbabilityBot, STRATEGY, entryPlan, rankEntryCandidates, quote };
