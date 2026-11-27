'use strict';
const data = require('./wick-market-data');
const STRATEGY = {
  id: 'invented-calibrated-dual-btc-v1',
  name: 'BTC Calibrated Edge · 5m + 15m',
  mode: 'PAPER', timeframes: ['5m', '15m'], targetShares: 50, riskFraction: .02,
  minimumProbability: .58, minimumNetEdge: .04, latencyMs: 500,
  predictionRefresh: 'After each completed 1-minute candle; separate calibrated LightGBM models.',
  exit: 'One entry per timeframe/window; no flips, TP or SL; official resolution only.',
  warning: 'Research paper experiment. Training labels use Binance BTCUSDT, not Chainlink settlement. No guaranteed edge.',
};
const SIDES = ['UP', 'DOWN'];
function levels(rows, descending = false) {
  return (rows || []).map(r => ({ price: Number(r.price), size: Number(r.size) }))
    .filter(r => Number.isFinite(r.price) && r.price > 0 && r.price < 1 && Number.isFinite(r.size) && r.size > 0)
    .sort((a, b) => descending ? b.price-a.price : a.price-b.price);
}
function quote(book, market, side, at) {
  if (String(book.asset_id) !== String(market.tokens[side])) throw new Error('CLOB book token mismatch');
  const timestamp = Number(book.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > at + 1000 || at - timestamp > 10000) {
    throw new Error('Stale or missing exchange book timestamp');
  }
  const bids = levels(book.bids, true), asks = levels(book.asks);
  return { bids, asks, bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null,
    updatedAt: at, exchangeAt: timestamp, tokenId: market.tokens[side] };
}
function buyPlan(q, probability, cash, feeRate, exponent = 1) {
  if (!q || !Number.isFinite(probability) || probability < STRATEGY.minimumProbability
    || !Number.isFinite(feeRate) || feeRate < 0 || feeRate > 1
    || !Number.isFinite(exponent) || exponent < 0 || q.bestAsk == null) return null;
  const budget = cash * STRATEGY.riskFraction;
  let shares = 0, cost = 0, fees = 0;
  const fills = [];
  for (const l of q.asks) {
    if (l.price < .05 || l.price > .95) continue;
    const unitFee = feeRate * Math.pow(l.price * (1-l.price), exponent);
    if (probability - l.price - unitFee < STRATEGY.minimumNetEdge) break;
    // Reserve per-level fee rounding as well as the displayed 2% cash budget.
    const n = Math.min(STRATEGY.targetShares-shares, l.size,
      Math.max(0, budget-cost-fees-.00001)/(l.price+unitFee));
    if (n < .00001) break;
    const fee = Number((n * unitFee).toFixed(5));
    fills.push({ price: l.price, shares: n, fee });
    shares += n; cost += n*l.price; fees += fee;
    if (shares >= STRATEGY.targetShares-.000001) break;
  }
  if (shares < 1 || cost+fees > budget+.000001) return null;
  return { shares, cost, fees, fills, entryPrice: cost/shares,
    netEdge: probability-(cost+fees)/shares, budget };
}

class CalibratedBot {
  constructor({ marketData = data, worker, ledgerStore = null, now = Date.now } = {}) {
    this.data = marketData; this.worker = worker; this.ledgerStore = ledgerStore; this.now = now;
    this.status = 'STARTING'; this.running = false; this.busy = false; this.saveChain = Promise.resolve();
    this.events = []; this.lastError = null; this.lastSavedAt = null; this.persistenceError = null; this.dirty = false;
    this.accounts = Object.fromEntries(STRATEGY.timeframes.map(tf => [tf, {
      initialCapital: 1500, cash: 1500, positions: [], history: [], equityCurve: [],
    }]));
    this.records = Object.fromEntries(STRATEGY.timeframes.map(tf => [tf, {
      timeframe: tf, market: null, quotes: {}, nextLookup: 0, status: 'Discovering current market', pending: null,
    }]));
    this.lastSettlement = 0; this.lastSample = 0;
  }
  log(message) {
    this.events.unshift({ at: this.now(), message });
    this.events = this.events.slice(0, 100);
    console.log('[paper]', message);
  }
  restoreLedger(saved) {
    if (saved.strategyId !== STRATEGY.id || !saved.accounts) throw new Error('Wrong paper strategy ledger');
    for (const tf of STRATEGY.timeframes) {
      const a = saved.accounts[tf];
      if (!a || !Number.isFinite(a.cash) || !Array.isArray(a.positions) || !Array.isArray(a.history)) {
        throw new Error(`Invalid ${tf} saved account`);
      }
    }
    this.accounts = saved.accounts;
    this.events = saved.events || [];
  }
  async flushLedger() {
    if (!this.ledgerStore) return;
    const payload = JSON.parse(JSON.stringify({ strategyId: STRATEGY.id, accounts: this.accounts,
      events: this.events, savedAt: this.now() }));
    const write = this.saveChain.catch(() => {}).then(() => this.ledgerStore.save(payload));
    this.saveChain = write;
    try { await write; this.lastSavedAt = this.now(); this.persistenceError = null; }
    catch (e) { this.persistenceError = e.message; throw e; }
  }
  start() {
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 2000);
  }
  stop() { this.running = false; clearInterval(this.timer); }
  async refresh(tf, now) {
    const record = this.records[tf], duration = parseInt(tf)*60000;
    const start = Math.floor(now/duration)*duration;
    if (record.targetStart !== start) {
      record.targetStart = start; record.market = null; record.quotes = {};
      record.pending = null; record.nextLookup = 0; record.status = 'Discovering current market';
    }
    if (!record.market && now >= record.nextLookup) {
      record.nextLookup = now + 15000;
      record.market = await this.data.getBtcMarket(start, duration);
      if (record.market && (record.market.start !== start || record.market.end !== start+duration)) {
        record.market = null; throw new Error('Market discovery returned wrong window');
      }
    }
    if (!record.market) return;
    const market = record.market;
    if (market.raw?.closed || market.raw?.acceptingOrders === false) {
      record.status = 'Market not accepting orders'; record.pending = null; return;
    }
    await Promise.all(SIDES.map(async side => {
      try {
        const book = await this.data.getBook(market.tokens[side]);
        // A response arriving after rollover must never attach to the next window.
        if (this.now() >= market.end || this.now() < market.start) return;
        record.quotes[side] = quote(book, market, side, this.now());
      } catch (e) { delete record.quotes[side]; record.status = e.message; }
    }));
    const a = this.accounts[tf];
    for (const position of a.positions) {
      if (position.marketId !== market.id) continue;
      position.mark = this.mark(position, record.quotes[position.side], now);
    }
    this.consider(tf, this.now());
  }
  mark(position, q, now) {
    if (!q || now-q.updatedAt > 5000 || q.tokenId !== position.tokenId) return null;
    let left = position.shares, value = 0;
    for (const l of q.bids) {
      const n = Math.min(left, l.size);
      value += n*l.price - n*position.feeRate*Math.pow(l.price*(1-l.price), position.feeExponent);
      left -= n;
      if (left < .000001) break;
    }
    return { at: q.updatedAt, bid: q.bestBid, value: left < .000001 ? value : null,
      partialValue: value, unpricedShares: left };
  }
  consider(tf, now) {
    const r = this.records[tf], m = r.market, a = this.accounts[tf];
    if (!m || now < m.start || now >= m.end-30000) {
      r.pending = null; r.status = 'No new entries during the final 30 seconds'; return;
    }
    if ([...a.positions, ...a.history].some(p => p.windowStart === m.start)) {
      r.pending = null; r.status = 'Entry used; hold to official resolution'; return;
    }
    const p = this.worker.prediction(tf, m.start);
    if (!p) { r.pending = null; r.status = 'Waiting for a fresh, validated closed-minute prediction'; return; }
    const side = p.pUp >= p.pDown ? 'UP' : 'DOWN', probability = p['p'+(side==='UP'?'Up':'Down')];
    const q = r.quotes[side];
    if (!q || now-q.updatedAt > 3000 || q.tokenId !== m.tokens[side]) {
      r.pending = null; r.status = 'Waiting for a fresh matching executable book'; return;
    }
    const feeRate = m.feesEnabled === false ? 0 : Number(m.feeSchedule?.rate);
    const feeExponent = m.feesEnabled === false ? 1 : Number(m.feeSchedule?.exponent);
    const plan = buyPlan(q, probability, a.cash, feeRate, feeExponent);
    if (!plan) { r.pending = null; r.status = 'No entry: confidence, net edge, fee data or cash budget insufficient'; return; }
    if (!r.pending || r.pending.side !== side || r.pending.observedAt !== p.observedAt) {
      r.pending = { side, at: now, observedAt: p.observedAt, bookAt: q.updatedAt };
      r.status = 'Qualifying signal; waiting for next book to simulate execution latency'; return;
    }
    if (now-r.pending.at < STRATEGY.latencyMs || q.updatedAt <= r.pending.bookAt) return;
    const position = { id: `${tf}-${m.start}`, timeframe: tf, marketId: m.id, marketSlug: m.slug,
      title: m.title, tokenId: m.tokens[side], side, windowStart: m.start, windowEnd: m.end,
      ...plan, feeRate, feeExponent, probability, rawProbability: p.rawUp,
      openedAt: now, predictionAt: p.observedAt, mark: null, status: 'OPEN' };
    a.cash -= plan.cost+plan.fees;
    position.mark = this.mark(position, q, now);
    a.positions.unshift(position);
    this.dirty = true;
    r.pending = null; r.status = 'Filled; hold to official resolution';
    this.log(`${tf} ${side}: ${plan.shares.toFixed(2)} shares at $${plan.entryPrice.toFixed(4)}, net edge ${(100*plan.netEdge).toFixed(1)}¢.`);
  }
  async settle(now) {
    if (now-this.lastSettlement < 10000) return;
    this.lastSettlement = now;
    for (const a of Object.values(this.accounts)) {
      for (const p of [...a.positions]) {
        if (now < p.windowEnd) continue;
        p.status = 'AWAITING_RESOLUTION'; p.mark = null;
        try {
          const market = await this.data.getMarket(p.marketId);
          if (String(market.id) !== String(p.marketId)) throw new Error('Resolution market mismatch');
          const winner = this.data.resolvedWinner(market);
          if (!winner) continue;
          const payout = winner === p.side ? p.shares : 0;
          p.closedAt = this.now(); p.exitPrice = winner === p.side ? 1 : 0;
          p.winner = winner; p.payout = payout; p.pnl = payout-p.cost-p.fees; p.status = 'RESOLVED';
          a.cash += payout;
          a.positions = a.positions.filter(item => item.id !== p.id);
          a.history.unshift(p);
          this.dirty = true;
          this.log(`${p.timeframe} ${p.side} resolved ${winner}: ${p.pnl>=0?'+':''}$${p.pnl.toFixed(2)} after fees.`);
        } catch (e) { this.lastError = `Resolution: ${e.message}`; }
      }
    }
  }
  account(tf, now) {
    const a = this.accounts[tf];
    let value = 0, complete = true;
    const positions = a.positions.map(p => {
      const mark = now < p.windowEnd && p.mark && now-p.mark.at <= 5000 ? p.mark : null;
      if (mark?.value == null) complete = false;
      else value += mark.value;
      return { ...p, status: now >= p.windowEnd ? 'AWAITING_RESOLUTION' : p.status,
        mark, unrealizedPnl: mark?.value == null ? null : mark.value-p.cost-p.fees };
    });
    const realizedPnl = a.history.reduce((s,p) => s+p.pnl, 0);
    return { initialCapital: a.initialCapital, cash: a.cash,
      settledBalance: a.initialCapital+realizedPnl, realizedPnl,
      equity: complete ? a.cash+value : null, knownPositionValue: value, valuationComplete: complete,
      unrealizedPnl: complete ? positions.reduce((s,p)=>s+p.unrealizedPnl,0) : null,
      fees: [...a.positions, ...a.history].reduce((s,p)=>s+p.fees,0),
      wins: a.history.filter(p=>p.pnl>0).length, losses: a.history.filter(p=>p.pnl<0).length,
      positions, history: a.history.slice(0,100), totalClosed: a.history.length,
      equityCurve: a.equityCurve.slice(-2000) };
  }
  async tick() {
    if (this.busy || !this.running) return;
    this.busy = true;
    this.lastError = null;
    try {
      await Promise.all(STRATEGY.timeframes.map(async tf => {
        try { await this.refresh(tf, this.now()); }
        catch (e) { this.records[tf].status = e.message; this.lastError = e.message; }
      }));
      await this.settle(this.now());
      const now = this.now();
      if (now-this.lastSample >= 15000) {
        for (const tf of STRATEGY.timeframes) {
          const a = this.accounts[tf], s = this.account(tf, now);
          a.equityCurve.push({ at: now, equity: s.equity, settledBalance: s.settledBalance });
          a.equityCurve = a.equityCurve.slice(-6000);
        }
        this.lastSample = now;
      }
      if (this.dirty || now-(this.lastSavedAt || 0) >= 15000) {
        await this.flushLedger(); this.dirty = false;
      }
      this.status = 'RUNNING';
    } catch (e) { this.status = 'ERROR'; this.lastError = e.message; }
    finally { this.busy = false; }
  }
  snapshot() {
    const now = this.now();
    const accounts = Object.fromEntries(STRATEGY.timeframes.map(tf => [tf, this.account(tf, now)]));
    return { now, mode: 'PAPER', strategy: STRATEGY, status: this.status, lastError: this.lastError,
      model: this.worker.snapshot(), accounts, markets: this.records, events: this.events,
      persistence: { enabled: !!this.ledgerStore, lastSavedAt: this.lastSavedAt, error: this.persistenceError } };
  }
}
CalibratedBot.STRATEGY = STRATEGY;
module.exports = { CalibratedBot, buyPlan, quote };
