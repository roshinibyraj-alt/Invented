'use strict';

const Base = require('./dip-bounce-bot');
const config = require('./config');
const {summarizeMakerRebates} = require('./maker-rebates');
const STRATEGY = {
  id: 'btc-eth-independent-depth-ladders-wide-tp',
  name: 'Independent rung ladders', version: '2',
  entry: 'BTC and ETH 5m UP/DOWN: 100-share limits at $0.40, $0.35 and $0.30.',
  fill: 'Depth-backed paper touch; shared liquidity is consumed once until replenished. Limit-price accounting; not guaranteed exchange fills.',
  takeProfit: 'Each rung targets $0.90, $0.80 or $0.70 respectively, with visible bid depth.',
  expiry: 'Cancel remaining buys; hold remaining shares to official resolution. No stop-loss.',
  rearm: 'Rearm a rung only after all its purchased shares reach its own TP.',
  fees: 'Passive paper fills have zero fees. Price-dependent maker rebate scenarios are shown separately; estimates are not paid income or trading equity.',
  resolutionPollMs: config.DIP_BOUNCE_RESOLUTION_POLL_MS,
};
const EPS = 1e-8;
const active = p => ['OPEN', 'PENDING_RESOLUTION'].includes(p.status);

class RungLadderBot extends Base {
  constructor(options = {}) {
    super(options);
    this.liquidity = new Map();
  }

  applyRestoredWindowConsumption() {}
  checkStopLosses() {}
  checkTakeProfits() {}
  updateSizingAfterClose() {}

  ensureOrders(record) {
    if (!record.market || record.marketStatus !== 'OPEN' || this.now() >= record.market.end) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const side of ['UP', 'DOWN']) {
      for (const [limitPrice, tpPrice] of [[0.40, 0.90], [0.35, 0.80], [0.30, 0.70]]) {
        if (!this.orders.some(o => o.marketId === marketId && o.side === side && o.limitPrice === limitPrice)) {
          this.placeRung(record, side, limitPrice, tpPrice, 1);
        }
      }
    }
  }

  placeRung(record, side, limitPrice, tpPrice, cycle) {
    const required = 100 * limitPrice;
    const funded = this.availableCash() + EPS >= required;
    const order = {
      id: `rung-${++this.orderSequence}`, asset: record.asset, timeframe: record.timeframe,
      marketId: String(record.market.id || record.market.slug), tokenId: String(record.market.tokens[side]),
      windowStart: record.market.start, windowEnd: record.market.end, side, limitPrice, tpPrice,
      requestedShares: 100, filledShares: 0, soldShares: 0, remainingShares: 0,
      reservedCash: funded ? required : 0, status: funded ? 'RESTING' : 'WAITING_FUNDS',
      cycle, createdAt: this.now(), positionId: null,
    };
    this.orders.unshift(order);
    this.log(`${record.asset} ${side}: ${cycle > 1 ? 'rearmed' : 'placed'} 100 at $${limitPrice.toFixed(2)}, TP $${tpPrice.toFixed(2)}.`, {
      asset: record.asset, side, type: cycle > 1 ? 'REARM' : 'LIMIT_PLACED',
    });
    return order;
  }

  async refreshMarket(record, now) {
    await super.refreshMarket(record, now);
    this.ensureOrders(record);
  }

  availableCash() {
    return Math.max(0, this.cash - this.orders.reduce((s, o) => s + (o.reservedCash || 0), 0));
  }

  // Repeated snapshots do not replenish the same visible shares. Only an observed
  // increase adds new executable capacity, and every rung shares that capacity.
  capacity(token, type, levels) {
    const key = `${token}:${type}`;
    const previous = this.liquidity.get(key) || new Map();
    const next = new Map();
    for (const {price, size} of levels) {
      const old = previous.get(price);
      const available = old ? Math.min(size, old.available + Math.max(0, size - old.size)) : size;
      next.set(price, {size, available});
    }
    this.liquidity.set(key, next);
    return next;
  }

  consume(capacity, predicate, requested, descending) {
    let filled = 0;
    const prices = [...capacity.keys()].sort((a,b) => descending ? b-a : a-b);
    for (const price of prices) {
      if (!predicate(price)) continue;
      const level = capacity.get(price);
      const amount = Math.min(level.available, requested - filled);
      level.available -= amount;
      filled += amount;
      if (filled >= requested - EPS) break;
    }
    return filled;
  }

  processSide(record, side, quote) {
    const now = this.now();
    if (!record.market || record.marketStatus !== 'OPEN' || now < record.market.start || now >= record.market.end) return;
    if (quote.updatedAt == null || now - quote.updatedAt > config.DIP_BOUNCE_MAX_QUOTE_AGE_MS) return;
    this.ensureOrders(record);
    const marketId = String(record.market.id || record.market.slug);
    const token = String(record.market.tokens[side]);
    const bids = this.capacity(token, 'bids', record.books[side].bids);
    const asks = this.capacity(token, 'asks', record.books[side].asks);
    // Snapshot this list: a newly rearmed order cannot also fill on the same event.
    const orders = this.orders.filter(o => o.marketId === marketId && o.side === side
      && ['RESTING','PARTIAL','OPEN','WAITING_FUNDS'].includes(o.status))
      .sort((a,b) => b.limitPrice - a.limitPrice || a.createdAt - b.createdAt);
    for (const order of orders) {
      if (order.status === 'WAITING_FUNDS') {
        if (this.availableCash() + EPS < 100 * order.limitPrice) continue;
        order.reservedCash = 100 * order.limitPrice;
        order.status = 'RESTING';
      }
      let p = this.positions.find(p => p.id === order.positionId);
      // TP is eligible on later book updates, never the same event as a new buy.
      if (p?.shares > EPS) {
        const sold = this.consume(bids, price => price + EPS >= order.tpPrice, p.shares, true);
        if (sold > EPS) {
          const cost = sold * p.entryPrice;
          const profit = sold * order.tpPrice - cost;
          this.cash += sold * order.tpPrice;
          p.shares = Math.max(0, p.shares - sold);
          p.totalCost = Math.max(0, p.totalCost - cost);
          p.realizedPnl += profit;
          p.exitPrice = order.tpPrice;
          p.exitAt = now;
          order.soldShares += sold;
          order.remainingShares = p.shares;
          this.log(`${record.asset} ${side} TP $${order.tpPrice.toFixed(2)}: sold ${sold.toFixed(2)}, profit $${profit.toFixed(2)}.`, {
            asset: record.asset, side, type: 'TP_FILL', outcome: 'good', now,
          });
          // Cancel the unfilled entry remainder once TP starts. Never leave a
          // hidden live buy behind a closed/rearmed rung.
          order.reservedCash = 0;
          order.entryCancelled = true;
          if (p.shares <= EPS) {
            p.status = 'TAKE_PROFIT';
            p.unrealizedPnl = null;
            order.status = 'COMPLETED';
            this.placeRung(record, side, order.limitPrice, order.tpPrice, order.cycle + 1);
            continue;
          }
        }
      }
      if (!order.entryCancelled && order.filledShares < 100 - EPS) {
        const filled = this.consume(asks, price => price <= order.limitPrice + EPS, 100 - order.filledShares, false);
        if (filled > EPS) {
          if (!p) {
            p = {
              id: `ladder-position-${++this.positionSequence}`, marketId, tokenId: token,
              asset: record.asset, timeframe: record.timeframe, side, windowStart: record.market.start,
              windowEnd: record.market.end, entryAt: now, entryPrice: order.limitPrice, tpPrice: order.tpPrice,
              shares: 0, originalShares: 0, totalCost: 0, fees: 0, estimatedMakerRebate: 0,
              realizedPnl: 0, status: 'OPEN', markBid: quote.bestBid, cycle: order.cycle, orderId: order.id,
            };
            this.positions.unshift(p);
            order.positionId = p.id;
          }
          p.shares += filled;
          p.originalShares += filled;
          p.totalCost += filled * order.limitPrice;
          this.cash -= filled * order.limitPrice;
          order.filledShares += filled;
          order.remainingShares = p.shares;
          order.reservedCash = Math.max(0, (100 - order.filledShares) * order.limitPrice);
          this.log(`${record.asset} ${side} buy $${order.limitPrice.toFixed(2)}: ${filled.toFixed(2)} shares (${order.filledShares.toFixed(2)}/100).`, {
            asset: record.asset, side, type: 'BUY_FILL', now,
          });
        }
      }
      order.status = order.entryCancelled || order.filledShares >= 100 - EPS ? 'OPEN'
        : order.filledShares > EPS ? 'PARTIAL' : 'RESTING';
    }
    this.updateAccountMetrics(now);
  }

  markPositions(now, onlyRecordKey = null, onlySide = null) {
    super.markPositions(now, onlyRecordKey, onlySide);
  }

  expireMarket(record, now) {
    const marketId = String(record.market?.id || record.market?.slug || '');
    for (const order of this.orders) {
      if (order.marketId !== marketId || order.status === 'COMPLETED') continue;
      order.reservedCash = 0;
      order.entryCancelled = true;
      order.status = order.remainingShares > EPS ? 'PENDING_RESOLUTION' : 'EXPIRED';
    }
    super.expireMarket(record, now);
    if (record.market) {
      for (const side of ['UP','DOWN']) for (const type of ['asks','bids']) {
        this.liquidity.delete(`${record.market.tokens[side]}:${type}`);
      }
    }
  }

  settleMarket(marketId, winner, now) {
    for (const p of this.positions) {
      if (p.marketId !== marketId || p.status !== 'PENDING_RESOLUTION') continue;
      const payout = p.side === winner ? p.shares : 0;
      this.cash += payout;
      p.realizedPnl += payout - p.totalCost;
      p.status = p.side === winner ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
      p.exitPrice = p.side === winner ? 1 : 0;
      p.exitAt = p.resolvedAt = now;
      p.exitReason = 'OFFICIAL_RESOLUTION';
      p.resolutionWinner = winner;
      p.shares = 0;
      p.totalCost = 0;
      p.unrealizedPnl = null;
      const order = this.orders.find(o => o.id === p.orderId);
      if (order) { order.status = p.status; order.remainingShares = 0; }
      this.log(`${p.asset} ${p.side} resolved ${winner}; total rung P&L $${p.realizedPnl.toFixed(2)}.`, {
        asset: p.asset, side: p.side, type: 'RESOLUTION', outcome: p.realizedPnl >= 0 ? 'good':'bad', now,
      });
    }
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
  }

  accountSnapshot() {
    const base = super.accountSnapshot();
    const closed = this.positions.filter(p => !active(p));
    const wins = closed.filter(p => p.realizedPnl > 0).length;
    return {...base,
      realizedPnl: this.positions.reduce((s,p) => s + (p.realizedPnl || 0), 0),
      wins, losses: closed.filter(p => p.realizedPnl < 0).length,
      settledPositions: closed.length,
      winRate: closed.length ? 100 * wins / closed.length : 0,
      totalRebates: 0,
      makerRebates: summarizeMakerRebates(this.orders),
    };
  }

  snapshot() {
    const state = super.snapshot();
    state.strategy = {...STRATEGY};
    delete state.sizingByAsset;
    for (const market of state.markets) {
      market.ladders = Object.fromEntries(['UP','DOWN'].map(side => [side,
        [0.40,0.35,0.30].map(price => this.orders.find(o => o.marketId === String(market.id || market.slug)
          && o.side === side && o.limitPrice === price)).filter(Boolean).map(o => ({...o})),
      ]));
    }
    return state;
  }

  exportLedger() {
    return {schemaVersion: 1, strategyId: STRATEGY.id, savedAt: this.now(),
      snapshot: {...this.snapshot(), positions: this.positions, orders: this.orders},
      liquidity: [...this.liquidity].map(([key, levels]) => [key, [...levels]])};
  }

  restoreLedger(ledger) {
    const s = ledger.snapshot;
    if (s?.strategy?.id !== STRATEGY.id || !Number.isFinite(s.account?.cash)) throw new Error('Invalid ladder ledger.');
    this.initialCapital = s.account.initialCapital;
    this.cash = s.account.cash;
    this.positions = s.positions || [];
    this.orders = s.orders || [];
    this.events = s.events || [];
    this.orderSequence = Math.max(0, ...this.orders.map(o => Number(o.id.split('-').at(-1)) || 0));
    this.positionSequence = Math.max(0, ...this.positions.map(p => Number(p.id.split('-').at(-1)) || 0));
    this.liquidity = new Map((ledger.liquidity || []).map(([key, levels]) => [key, new Map(levels)]));
    this.equityCurve = s.account.equityCurve || [];
    this.peakEquity = s.account.peakEquity || this.initialCapital;
    this.maxDrawdown = s.account.maxDrawdown || 0;
    for (const order of this.orders) if (order.windowEnd <= this.now()) {
      order.reservedCash = 0;
      if (['RESTING','PARTIAL','OPEN','WAITING_FUNDS'].includes(order.status)) order.status = order.remainingShares > EPS ? 'PENDING_RESOLUTION' : 'EXPIRED';
    }
    for (const p of this.positions) if (active(p)) {
      p.status = p.windowEnd <= this.now() ? 'PENDING_RESOLUTION' : 'OPEN';
      p.markStatus = 'STALE';
      p.unrealizedPnl = null;
    }
    this.ledgerPersistenceState.restored = true;
  }
}

module.exports = RungLadderBot;
module.exports.STRATEGY = STRATEGY;
