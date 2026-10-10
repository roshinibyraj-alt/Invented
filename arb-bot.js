'use strict';

const { matchBinaryMarkets, findArbitrage, normalizeLevels } = require('./arb-core');
const api = require('./arb-market-data');
const cfg = require('./config');
const CAPITAL = cfg.DEMO_CAPITAL;
const SHARES = cfg.SHARES_PER_LEG;
const MIN_EDGE = cfg.MIN_EDGE_PER_SHARE;
const POLL_MS = cfg.SCAN_INTERVAL_MS;
const PAGE_BATCH = cfg.MARKET_BATCH_SIZE;

class ArbBot {
  constructor(opts = {}) {
    this.apiKey = opts.predictApiKey || process.env.PREDICT_API_KEY || '';
    this.cash = CAPITAL;
    this.positions = [];
    this.events = [];
    this.seen = new Set();
    this.lastErrorLog = '';
    this.lastMarketsAt = 0;
    this.polyMarkets = [];
    this.predictMarkets = [];
    this.cursor = 0;
    this.status = 'starting';
    this.error = null;
    this.lastScanAt = null;
    this.lastSettlementCheck = 0;
    this.matched = 0;
    this.scanned = 0;
    this.running = false;
  }

  log(event, detail = {}) {
    const row = { ts: Date.now(), event, ...detail };
    this.events.unshift(row);
    this.events.length = Math.min(this.events.length, 250);
    console.log('[arb] ' + JSON.stringify(row));
  }

  async discover() {
    const [poly, predict] = await Promise.all([
      api.getPolymarketMarkets(), api.getPredictMarkets(this.apiKey),
    ]);
    this.polyMarkets = poly;
    this.predictMarkets = predict;
    this.lastMarketsAt = Date.now();
    this.pairs = matchBinaryMarkets(poly, predict);
    this.matched = this.pairs.length;
  }

  async tick() {
    try {
      if (!this.apiKey) throw new Error('PREDICT_API_KEY is missing from Railway server variables');
      if (!this.lastMarketsAt || Date.now() - this.lastMarketsAt > cfg.MARKETS_REFRESH_MS) await this.discover();
      const pairs = this.pairs || [];
      if (!pairs.length) {
        this.status = 'no_exact_binary_matches';
        this.scanned = 0;
        this.lastScanAt = Date.now();
        return;
      }
      const batch = [];
      for (let i = 0; i < Math.min(PAGE_BATCH, pairs.length); i++) {
        batch.push(pairs[(this.cursor + i) % pairs.length]);
      }
      this.cursor = (this.cursor + batch.length) % pairs.length;
      this.scanned += batch.length;
      const results = await Promise.allSettled(batch.map(pair => this.scanPair(pair)));
      for (const result of results) {
        if (result.status === 'rejected') this.log('BOOK_READ_ERROR', { note: result.reason.message });
      }
      this.lastScanAt = Date.now();
      if (Date.now() - this.lastSettlementCheck > 30000) {
        this.lastSettlementCheck = Date.now();
        await this.settleOpenPairs();
      }
      this.status = 'scanning';
      this.error = null;
      if (!this.lastHeartbeatAt || Date.now() - this.lastHeartbeatAt >= 30000) {
        this.lastHeartbeatAt = Date.now();
        this.log('HEARTBEAT', { matchedPairs: this.matched, batchSize: Math.min(PAGE_BATCH, pairs.length),
          cash: Number(this.cash.toFixed(2)) });
      }
    } catch (error) {
      this.status = 'blocked_or_error';
      this.error = error.message;
      if (this.lastErrorLog !== error.message || Date.now() - (this.lastErrorAt || 0) > 30000) {
        this.lastErrorLog = error.message;
        this.lastErrorAt = Date.now();
        this.log('SCAN_ERROR', { note: error.message });
      }
    }
  }

  async scanPair(pair) {
    const feeRate = pair.poly.raw.takerFeeRate ?? pair.poly.raw.feeRate ?? pair.poly.raw.feeSchedule?.rate;
    if (pair.poly.raw.feesEnabled === true
      && (feeRate == null || !Number.isFinite(Number(feeRate)) || Number(feeRate) < 0)) {
      this.log('PAIR_SKIPPED_UNKNOWN_POLY_FEE', { title: pair.title });
      return;
    }
    const labels = pair.labels;
    const [polyBooks, predictBook] = await Promise.all([
      Promise.all(labels.map(label => api.getPolyBook(pair.poly.outcomes[label]))),
      api.getPredictBook(pair.predict.id, this.apiKey),
    ]);
    const books = { poly: {}, predict: {} };
    for (let i = 0; i < labels.length; i++) {
      books.poly[pair.poly.outcomes[labels[i]]] = polyBooks[i].asks || [];
    }
    const yesBids = normalizeLevels(predictBook.yesBids || predictBook.bids || predictBook.yes?.bids || []);
    const noBids = normalizeLevels(predictBook.noBids || predictBook.no?.bids || []);
    const tick = Number(pair.predict.raw.tickSize || predictBook.tickSize) || 0.01;
    const complement = levels => levels.map(x => ({
      price: Math.round((1 - x.price) / tick) * tick, size: x.size,
    }));
    const yesAsks = normalizeLevels(predictBook.yesAsks || predictBook.asks || predictBook.yes?.asks || [])
      .concat(complement(noBids));
    const noAsks = normalizeLevels(predictBook.noAsks || predictBook.no?.asks || [])
      .concat(complement(yesBids));
    const yesLabel = labels.find(x => x.toLowerCase() === 'yes');
    const noLabel = labels.find(x => x.toLowerCase() === 'no');
    if (yesLabel && noLabel) {
      books.predict[pair.predict.outcomes[yesLabel]] = yesAsks;
      books.predict[pair.predict.outcomes[noLabel]] = noAsks;
    } else {
      // Unknown Predict outcome-book mapping: fail closed rather than guess.
      return;
    }
    const opportunities = findArbitrage(pair, books, {
      shares: SHARES, minEdge: MIN_EDGE,
      predictFee: (p, q) => 0.02 * Math.min(p, 1 - p) * q,
      polyFee: (p, q) => {
        const rate = Number(feeRate ?? 0);
        const exponent = Number(pair.poly.raw.feeSchedule?.exponent ?? 1);
        return Math.max(0, rate) * Math.pow(p * (1 - p), exponent) * q;
      },
    });
    for (const opportunity of opportunities) {
      const key = `${pair.key}|${opportunity.direction}`;
      if (this.seen.has(key)) continue;
      if (opportunity.totalCost > this.cash) continue;
      this.seen.add(key);
      this.cash -= opportunity.totalCost;
      const trade = {
        id: `${Date.now()}-${this.positions.length + 1}`, title: pair.title,
        direction: opportunity.direction, shares: SHARES,
        edgePerShare: opportunity.edgePerShare, cost: opportunity.totalCost,
        fees: opportunity.legs.poly.fees + opportunity.legs.predict.fees,
        status: 'OPEN · AWAITING BOTH VENUE RESOLUTIONS',
        markets: { polymarket: pair.poly.id, predict: pair.predict.id },
        legs: [
          { venue: 'POLYMARKET', marketId: pair.poly.id, outcome: opportunity.label,
            shares: SHARES, cost: opportunity.legs.poly.totalCost },
          { venue: 'PREDICT', marketId: pair.predict.id, outcome: opportunity.opposite,
            shares: SHARES, cost: opportunity.legs.predict.totalCost },
        ],
        openedAt: Date.now(),
      };
      this.positions.unshift(trade);
      this.log('PAPER_ARB_OPENED', trade);
    }
  }

  async settleOpenPairs() {
    const open = this.positions.filter(p => p.status.startsWith('OPEN')).slice(0, 10);
    for (const p of open) {
      try {
        const [poly, predict] = await Promise.all([
          api.getPolyMarket(p.markets.polymarket),
          api.getPredictMarket(p.markets.predict, this.apiKey),
        ]);
        const a = payoutFor(poly, p.legs[0].outcome);
        const b = payoutFor(predict, p.legs[1].outcome);
        if (a == null || b == null) continue;
        const proceeds = (a + b) * p.shares;
        p.realizedPnl = proceeds - p.cost;
        p.settledAt = Date.now();
        p.status = 'SETTLED FROM BOTH VENUE RESULTS';
        this.cash += proceeds;
        this.log('PAPER_ARB_SETTLED', { title: p.title, proceeds, realizedPnl: p.realizedPnl });
      } catch (error) {
        this.log('SETTLEMENT_CHECK_ERROR', { market: p.title, note: error.message });
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log('BOT_STARTED', { note: 'Demo-only cross-venue scanner; no live orders are sent.' });
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, POLL_MS);
    };
    void loop();
  }

  stop() { this.running = false; clearTimeout(this.timer); }

  snapshot() {
    const invested = this.positions.filter(p => p.status.startsWith('OPEN')).reduce((sum, p) => sum + p.cost, 0);
    const realizedPnl = this.positions.reduce((sum, p) => sum + (Number(p.realizedPnl) || 0), 0);
    return {
      now: Date.now(), mode: 'DEMO ONLY', status: this.status, error: this.error,
      strategy: { marketScope: 'ALL NON-CRYPTO OPEN BINARY MARKETS', demoCapital: CAPITAL,
        sharesPerLeg: SHARES, minNetEdgePerShare: MIN_EDGE, matching: 'EXACT NORMALIZED TITLE + SAME BINARY OUTCOME LABELS',
        cryptoExcluded: true, execution: 'PAPER ONLY' },
      account: { capital: CAPITAL, cash: this.cash, committed: invested,
        equityAtCost: this.cash + this.positions.filter(p => p.status.startsWith('OPEN')).reduce((n, p) => n + p.cost, 0),
        realizedPnl },
      scanner: { matchedPairs: this.matched, batchSize: PAGE_BATCH, processedPairs: this.scanned, lastScanAt: this.lastScanAt },
      positions: this.positions.slice(0, 100), events: this.events,
    };
  }
}

function payoutFor(market, label) {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes
    : typeof market.outcomes === 'string' ? (() => { try { return JSON.parse(market.outcomes); } catch (_) { return []; } })() : [];
  const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices
    : typeof market.outcomePrices === 'string' ? (() => { try { return JSON.parse(market.outcomePrices); } catch (_) { return []; } })() : [];
  const status = String(market.status || '').toUpperCase();
  const resolved = market.closed === true || market.resolved === true || ['RESOLVED','SETTLED','CLOSED'].includes(status);
  if (!resolved) return null;
  const winner = market.resolvedOutcome || market.winningOutcome || market.winner;
  if (winner != null) return String(winner).toLowerCase() === String(label).toLowerCase() ? 1 : 0;
  const index = outcomes.findIndex(x => String(typeof x === 'string' ? x : (x.label || x.name || x.title)).toLowerCase()
    === String(label).toLowerCase());
  if (index < 0) return null;
  const p = Number(prices[index] ?? (typeof outcomes[index] === 'object'
    ? outcomes[index].payout ?? outcomes[index].price : NaN));
  return Number.isFinite(p) && (p >= 0.99 || p <= 0.01) ? (p >= 0.99 ? 1 : 0) : null;
}

module.exports = ArbBot;
module.exports.payoutFor = payoutFor;
