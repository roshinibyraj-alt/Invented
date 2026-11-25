'use strict';

const Base = require('./dip-bounce-bot');
const config = require('./config');
const {summarizeMakerRebates} = require('./maker-rebates');
const STRATEGY = {
  id: 'btc-eth-independent-rung-tp-progression',
  name: 'Independent rung recovery ladders', version: '4',
  entry: 'BTC and ETH 5m UP/DOWN: limits at $0.40, $0.35 and $0.30; each rung starts at 100 shares.',
  fill: 'Depth-backed paper touch; shared liquidity is consumed once until replenished. Limit-price accounting; not guaranteed exchange fills.',
  takeProfit: 'Start entry + $0.10. After SL increase next-window TP by $0.10, capped at $0.99. A completed TP resets size and TP.',
  stopLoss: 'Best bid at entry − $0.10 triggers a depth-backed taker sweep; gaps, partial exits and taker fees apply.',
  sizing: 'A filled final $0.99 attempt that stops or expires without full TP doubles next-window shares and restarts TP at +$0.10. Each asset/side/rung progresses independently.',
  expiry: 'Cancel remaining buys; hold remaining shares to official resolution. Unfilled orders do not advance. Nonfinal expiry leaves progression unchanged.',
  rearm: 'Disabled. Each rung trades at most once per side per window; fresh ladders start next window.',
  fees: 'Passive buys and TP fills have zero fees; SL taker sweeps incur modeled fees. Maker rebate estimates exclude SL and trading equity.',
  resolutionPollMs: config.DIP_BOUNCE_RESOLUTION_POLL_MS,
};
const EPS = 1e-8;
const active = p => ['OPEN', 'PENDING_RESOLUTION'].includes(p.status);

class RungLadderBot extends Base {
  constructor(options = {}) {
    super(options);
    this.liquidity = new Map();
    this.rungProgress = new Map();
  }

  applyRestoredWindowConsumption() {}
  checkStopLosses() {}
  checkTakeProfits() {}
  updateSizingAfterClose() {}

  progressKey(asset, side, price) {
    return `${asset}:${side}:${price.toFixed(2)}`;
  }

  progress(asset, side, price) {
    const key = this.progressKey(asset, side, price);
    if (!this.rungProgress.has(key)) this.rungProgress.set(key, {shares: 100, step: 0});
    return this.rungProgress.get(key);
  }

  finishAttempt(order, result) {
    if (order.progressionApplied || order.filledShares <= EPS) return;
    order.progressionApplied = result;
    const state = this.progress(order.asset, order.side, order.limitPrice);
    if (result === 'TP') {
      state.shares = 100;
      state.step = 0;
    } else if (order.tpPrice >= 0.99 - EPS) {
      // Never allow overflow to produce an unbounded/invalid paper order.
      const doubled = order.requestedShares * 2;
      state.shares = Number.isSafeInteger(doubled) ? doubled : order.requestedShares;
      state.blocked = !Number.isSafeInteger(doubled);
      state.step = 0;
    } else if (result === 'SL') {
      state.shares = order.requestedShares;
      state.step = order.progressStep + 1;
    }
    this.log(`${order.asset} ${order.side} $${order.limitPrice.toFixed(2)} ${result}: next ${state.shares} shares, TP $${Math.min(.99, order.limitPrice + .10 * (state.step + 1)).toFixed(2)}.`, {
      asset: order.asset, side: order.side, type: 'RUNG_PROGRESSION',
    });
    this.scheduleLedgerSave();
  }

  ensureOrders(record) {
    if (!record.market || record.marketStatus !== 'OPEN' || this.now() >= record.market.end) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const side of ['UP', 'DOWN']) {
      for (const limitPrice of [0.40, 0.35, 0.30]) {
        if (!this.orders.some(o => o.marketId === marketId && o.side === side && o.limitPrice === limitPrice)) {
          const progress = this.progress(record.asset, side, limitPrice);
          if (!progress.blocked) this.placeRung(record, side, limitPrice,
            Math.min(.99, Number((limitPrice + .10 * (progress.step + 1)).toFixed(2))), 1);
        }
      }
    }
  }

  placeRung(record, side, limitPrice, tpPrice, cycle) {
    const progress = this.progress(record.asset, side, limitPrice);
    const required = progress.shares * limitPrice;
    const funded = this.availableCash() + EPS >= required;
    const order = {
      id: `rung-${++this.orderSequence}`, asset: record.asset, timeframe: record.timeframe,
      marketId: String(record.market.id || record.market.slug), tokenId: String(record.market.tokens[side]),
      windowStart: record.market.start, windowEnd: record.market.end, side, limitPrice, tpPrice,
      requestedShares: progress.shares, progressStep: progress.step,
      slPrice: Number((limitPrice - .10).toFixed(2)),
      filledShares: 0, soldShares: 0, tpSoldShares: 0, stopSoldShares: 0, remainingShares: 0,
      reservedCash: funded ? required : 0, status: funded ? 'RESTING' : 'WAITING_FUNDS',
      cycle, createdAt: this.now(), positionId: null,
    };
    this.orders.unshift(order);
    this.log(`${record.asset} ${side}: placed ${order.requestedShares} at $${limitPrice.toFixed(2)}, TP $${tpPrice.toFixed(2)}, SL $${order.slPrice.toFixed(2)}.`, {
      asset: record.asset, side, type: 'LIMIT_PLACED',
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
    // Completed rungs remain in the ledger and cannot trade again this window.
    const orders = this.orders.filter(o => o.marketId === marketId && o.side === side
      && ['RESTING','PARTIAL','OPEN','WAITING_FUNDS'].includes(o.status))
      .sort((a,b) => b.limitPrice - a.limitPrice || a.createdAt - b.createdAt);
    for (const order of orders) {
      if (order.status === 'WAITING_FUNDS') {
        if (this.availableCash() + EPS < order.requestedShares * order.limitPrice) continue;
        order.reservedCash = order.requestedShares * order.limitPrice;
        order.status = 'RESTING';
      }
      let p = this.positions.find(p => p.id === order.positionId);
      if (p?.shares > EPS && (order.stopTriggered ||
          (quote.bestBid != null && quote.bestBid <= order.slPrice + EPS))) {
        order.stopTriggered = true;
        order.entryCancelled = true;
        order.reservedCash = 0;
        this.finishAttempt(order, 'SL');
        const feeRate = record.market.feesEnabled === false ? 0
          : Number(record.market.feeSchedule?.rate ?? (record.asset === 'BTC' ? .05 : .01));
        if (!Number.isFinite(feeRate) || feeRate < 0) continue;
        for (const price of [...bids.keys()].sort((a,b) => b-a)) {
          const level = bids.get(price);
          const sold = Math.min(level.available, p.shares);
          if (sold <= EPS || price <= 0) continue;
          level.available -= sold;
          const fee = sold * feeRate * price * (1-price);
          const cost = sold * p.entryPrice;
          this.cash += sold * price - fee;
          p.shares = Math.max(0, p.shares - sold);
          p.totalCost = Math.max(0, p.totalCost - cost);
          p.realizedPnl += sold * price - cost - fee;
          p.fees += fee;
          p.exitProceeds = (p.exitProceeds || 0) + sold * price;
          order.stopSoldShares += sold;
          order.soldShares += sold;
          order.remainingShares = p.shares;
          p.exitPrice = p.exitProceeds / order.soldShares;
          p.exitAt = now;
          this.log(`${record.asset} ${side} SL: sold ${sold.toFixed(2)} at $${price.toFixed(3)}, fee $${fee.toFixed(4)}.`, {
            asset: record.asset, side, type: 'SL_FILL', outcome: 'bad', now,
          });
          if (p.shares <= EPS) break;
        }
        if (p.shares <= EPS) {
          p.status = 'STOP_LOSS';
          p.unrealizedPnl = null;
          order.status = 'COMPLETED';
        } else order.status = 'OPEN';
        continue;
      }
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
          p.exitProceeds = (p.exitProceeds || 0) + sold * order.tpPrice;
          p.exitAt = now;
          order.soldShares += sold;
          order.tpSoldShares += sold;
          order.remainingShares = p.shares;
          this.log(`${record.asset} ${side} TP $${order.tpPrice.toFixed(2)}: sold ${sold.toFixed(2)}, profit $${profit.toFixed(2)}.`, {
            asset: record.asset, side, type: 'TP_FILL', outcome: 'good', now,
          });
          // Cancel the unfilled entry remainder once TP starts. Never leave a
          // hidden live buy behind a closed rung.
          order.reservedCash = 0;
          order.entryCancelled = true;
          if (p.shares <= EPS) {
            p.status = 'TAKE_PROFIT';
            p.unrealizedPnl = null;
            order.status = 'COMPLETED';
            this.finishAttempt(order, 'TP');
            continue;
          }
        }
      }
      if (!order.entryCancelled && order.filledShares < order.requestedShares - EPS) {
        const filled = this.consume(asks, price => price <= order.limitPrice + EPS, order.requestedShares - order.filledShares, false);
        if (filled > EPS) {
          if (!p) {
            p = {
              id: `ladder-position-${++this.positionSequence}`, marketId, tokenId: token,
              asset: record.asset, timeframe: record.timeframe, side, windowStart: record.market.start,
              windowEnd: record.market.end, entryAt: now, entryPrice: order.limitPrice, tpPrice: order.tpPrice, slPrice: order.slPrice,
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
          order.reservedCash = Math.max(0, (order.requestedShares - order.filledShares) * order.limitPrice);
          this.log(`${record.asset} ${side} buy $${order.limitPrice.toFixed(2)}: ${filled.toFixed(2)} shares (${order.filledShares.toFixed(2)}/${order.requestedShares}).`, {
            asset: record.asset, side, type: 'BUY_FILL', now,
          });
        }
      }
      order.status = order.entryCancelled || order.filledShares >= order.requestedShares - EPS ? 'OPEN'
        : order.filledShares > EPS ? 'PARTIAL' : 'RESTING';
    }
    this.updateAccountMetrics(now);
  }

  markPositions(now, onlyRecordKey = null, onlySide = null) {
    super.markPositions(now, onlyRecordKey, onlySide);
    // SL fees were already realized on the sold portion, not the open remainder.
    for (const p of this.positions) {
      if (p.status !== 'OPEN' || p.markStatus !== 'LIVE' || p.unrealizedPnl == null) continue;
      if (onlyRecordKey && `${p.asset}:${p.timeframe}` !== onlyRecordKey) continue;
      if (onlySide && p.side !== onlySide) continue;
      p.unrealizedPnl += p.fees || 0;
    }
  }

  expireMarket(record, now) {
    const marketId = String(record.market?.id || record.market?.slug || '');
    for (const order of this.orders) {
      if (order.marketId !== marketId || order.status === 'COMPLETED') continue;
      if (order.remainingShares > EPS && order.tpPrice >= .99 - EPS) this.finishAttempt(order, 'EXPIRY');
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
    state.rungProgress = Object.fromEntries(this.rungProgress);
    delete state.sizingByAsset;
    for (const market of state.markets) {
      market.ladders = Object.fromEntries(['UP','DOWN'].map(side => [side,
        [0.40,0.35,0.30].map(price => this.orders.find(o => o.marketId === String(market.id || market.slug)
          && o.side === side && o.limitPrice === price)).filter(Boolean).map(o => {
            const next = this.progress(o.asset, o.side, o.limitPrice);
            return {...o, nextShares: next.shares,
              nextTpPrice: Math.min(.99, Number((o.limitPrice + .10 * (next.step + 1)).toFixed(2)))};
          }),
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
    this.rungProgress = new Map(Object.entries(s.rungProgress || {}));
    this.events = s.events || [];
    this.orderSequence = Math.max(0, ...this.orders.map(o => Number(o.id.split('-').at(-1)) || 0));
    this.positionSequence = Math.max(0, ...this.positions.map(p => Number(p.id.split('-').at(-1)) || 0));
    this.liquidity = new Map((ledger.liquidity || []).map(([key, levels]) => [key, new Map(levels)]));
    this.equityCurve = s.account.equityCurve || [];
    this.peakEquity = s.account.peakEquity || this.initialCapital;
    this.maxDrawdown = s.account.maxDrawdown || 0;
    for (const order of this.orders) if (order.windowEnd <= this.now()) {
      if (order.remainingShares > EPS && order.tpPrice >= .99 - EPS) this.finishAttempt(order, 'EXPIRY');
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
