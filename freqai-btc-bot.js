'use strict';

const DipBounceBot = require('./dip-bounce-bot');
const { isFresh, feeRateFor, windowNet, recoveryShares, sellForFlip } = require('./freqai-recovery');

const STRATEGY = Object.freeze({
  id: 'btc-5m-freqai-recovery-flips-paper-v2',
  name: 'FreqAI BTC 5-minute direction model',
  version: '2',
  execution: 'Paper-only Polymarket taker sweep. Freqtrade/FreqAI runs dry for Binance spot data and does not place orders.',
  market: 'BTC Up/Down 5-minute market only.',
  features: 'Binance 1-minute OHLCV return, candle shape, relative volume, volatility and minute-in-window features.',
  target: 'For each 1-minute sample, classify whether the enclosing BTC 5-minute candle closes above or below its first-minute open.',
  prediction: 'Use the higher FreqAI UP/DOWN class probability. No minimum-confidence or edge gate, so an entry is not rejected for a low score.',
  entry: 'First entry is 50 shares after 80 seconds. The existing higher-probability selection and labeled Binance warm-up fallback apply only to the initial buy.',
  fill: 'Sweep visible Polymarket asks up to the $1.00 maximum valid outcome price, record actual depth-weighted paper fill and modeled taker fees; partial fills are recorded.',
  exit: 'An opposite current-window FreqAI signal strictly above 60% sells the held shares against visible bids, then buys the opposite side. No TP or SL; remaining shares go to official resolution.',
  sizing: 'Replacement buy is at least 50 shares, sized to recover net realized window losses and fees at a $1 winning resolution. No recovery debt carries to the next window. Cash and visible depth constrain execution; recovery is not guaranteed.',
  cadence: 'One initial entry, followed by qualifying recovery flips; no same-side adding.',
});

const ENTRY_DELAY_MS = 80_000;
const SHARES_PER_WINDOW = 50;
const MAX_BUY_PRICE = 1.00;
const FLIP_PROBABILITY = 0.60;
const MAX_AUDIT_ROWS = 10_000;
const MAX_AUDIT_CHECKS = 12;
const SIDES = ['UP', 'DOWN'];

function fresh(value, now, maxAgeMs) {
  const at = Number(value);
  return Number.isFinite(at) && now >= at - 1000 && now - at <= maxAgeMs;
}

class FreqAIBtcBot extends DipBounceBot {
  constructor(options = {}) {
    super(options);
    this.strategyDefinition = STRATEGY;
    this.strategyId = STRATEGY.id;
    this.records = new Map([...this.records.entries()].filter(([key]) => key === 'BTC:5m'));
    this.freqaiWorker = options.freqaiWorker || null;
    this.binanceFeed = options.binanceFeed || null;
    this.modelStatus = 'WAITING_FOR_MODEL';
    this.lastDecision = null;
    this.statusReason = 'Waiting for the FreqAI model and the current BTC 5-minute market.';
    this.flipAudit = [];
    this.flipAuditById = new Map();
    this.auditStore = null;
    this.auditPersistenceState = { enabled: false, restored: false, lastSavedAt: null, error: null };
    this.auditSaveTimer = null;
    this.auditSaveInFlight = null;
    this.auditDirty = false;
  }

  restoreLedger(ledger) {
    super.restoreLedger(ledger);
    for (const position of this.positions) {
      if (position.status === 'OPEN' || position.status === 'PENDING_RESOLUTION') {
        position.realizedPnl = null;
      }
    }
    this.restoreAuditTrail(ledger?.snapshot?.freqai?.auditTrail || []);
    this.updateAccountMetrics(this.now(), true);
    this.scheduleLedgerSave();
  }

  setMarketDataHelpers({ binanceFeed, freqaiWorker } = {}) {
    if (binanceFeed) this.binanceFeed = binanceFeed;
    if (freqaiWorker) this.freqaiWorker = freqaiWorker;
  }

  setAuditStore(auditStore) {
    this.auditStore = auditStore || null;
    this.auditPersistenceState.enabled = Boolean(this.auditStore);
  }

  restoreAuditTrail(entries) {
    const rows = Array.isArray(entries) ? entries : [];
    this.flipAudit = rows.slice(-MAX_AUDIT_ROWS).map((row) => ({
      ...row,
      checks: Array.isArray(row.checks) ? row.checks.slice(-MAX_AUDIT_CHECKS) : [],
    }));
    this.flipAuditById = new Map(this.flipAudit.map((row) => [row.id, row]));
    this.auditPersistenceState.restored = true;
  }

  scheduleAuditSave() {
    if (!this.auditStore) return;
    this.auditDirty = true;
    if (this.auditSaveTimer) return;
    this.auditSaveTimer = setTimeout(() => {
      this.auditSaveTimer = null;
      void this.flushAuditTrail();
    }, 500);
    this.auditSaveTimer.unref?.();
  }

  async flushAuditTrail() {
    if (!this.auditStore) return;
    if (this.auditSaveTimer) clearTimeout(this.auditSaveTimer);
    this.auditSaveTimer = null;
    if (this.auditSaveInFlight) {
      this.auditDirty = true;
      await this.auditSaveInFlight;
      if (this.auditDirty) return this.flushAuditTrail();
      return;
    }
    this.auditDirty = false;
    this.auditSaveInFlight = Promise.resolve().then(() => this.auditStore.save(this.flipAudit));
    try {
      await this.auditSaveInFlight;
      this.auditPersistenceState.lastSavedAt = this.now();
      this.auditPersistenceState.error = null;
    } catch (error) {
      this.auditPersistenceState.error = error?.message || 'Score audit save failed.';
      console.error('[freqai-audit] Could not persist score audit:', this.auditPersistenceState.error);
    } finally {
      this.auditSaveInFlight = null;
      if (this.auditDirty) this.scheduleAuditSave();
    }
  }

  auditBook(quote, now) {
    const validNumber = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
    const ageMs = validNumber(quote?.updatedAt) ? now - Number(quote.updatedAt) : null;
    const depth = (levels) => (Array.isArray(levels) ? levels : []).reduce((sum, level) => {
      const size = Number(level?.size);
      return Number.isFinite(size) && size > 0 ? sum + size : sum;
    }, 0);
    return {
      bestBid: validNumber(quote?.bestBid) ? Number(quote.bestBid) : null,
      bestAsk: validNumber(quote?.bestAsk) ? Number(quote.bestAsk) : null,
      updatedAt: validNumber(quote?.updatedAt) ? Number(quote.updatedAt) : null,
      ageMs,
      fresh: isFresh(quote, now),
      visibleBidShares: depth(quote?.bids),
      visibleAskShares: depth(quote?.asks),
      sequence: Number.isFinite(Number(quote?.sequence)) ? Number(quote.sequence) : null,
    };
  }

  defaultAuditStatus(decision, record, now) {
    const marketId = String(record.market?.id || record.market?.slug || '');
    const held = this.positions.find((position) => position.marketId === marketId
      && position.windowStart === Number(record.market?.start) && position.status === 'OPEN');
    const hasEntry = this.orders.some((order) => order.action === 'BUY_TAKER'
      && order.marketId === marketId && order.windowStart === Number(record.market?.start));
    if (!held) return hasEntry ? ['RECOVERY_SIGNAL', 'A recovery entry is being evaluated; no position is currently open.']
      : ['INITIAL_SIGNAL', 'Initial model score recorded; waiting for the entry checks.'];
    if (held.side === decision.side) {
      return ['HOLDING_SAME_SIDE', `Model still selects held ${held.side}; no flip is due.`];
    }
    const probability = Number(decision[decision.side === 'UP' ? 'pUp' : 'pDown']);
    if (decision.source !== 'FREQAI' || !(probability > FLIP_PROBABILITY)) {
      return ['FLIP_THRESHOLD_NOT_MET', `Opposite score is ${(probability * 100).toFixed(1)}%; a flip requires strictly above 60%.`];
    }
    const bidBook = record.quotes[held.side];
    const askBook = record.quotes[decision.side];
    if (!isFresh(bidBook, now) || !bidBook.bids?.length) {
      return ['WAITING_FOR_HELD_BIDS', 'Flip score qualified; waiting for fresh bids to sell the held side.'];
    }
    if (!isFresh(askBook, now) || !askBook.asks?.length) {
      return ['WAITING_FOR_OPPOSITE_ASKS', 'Flip score qualified; waiting for fresh asks on the opposite side.'];
    }
    return ['FLIP_SIGNAL_QUALIFIED', 'Opposite score is above 60%; the execution checks are being evaluated.'];
  }

  recordPredictionAudit(decision, record, now, status, reason) {
    if (decision?.source !== 'FREQAI' || !record.market) return null;
    const predictionAt = Number(decision.predictionAt) || Number(decision.candleStart) || now;
    const id = `${record.market.start}:${decision.candleStart}:${predictionAt}`;
    let row = this.flipAuditById.get(id);
    let isNew = false;
    if (!row) {
      const marketId = String(record.market.id || record.market.slug);
      const heldAtSignal = this.positions.find((position) => position.marketId === marketId
        && position.windowStart === Number(record.market.start) && position.status === 'OPEN');
      const defaultStatus = this.defaultAuditStatus(decision, record, now);
      row = {
        id,
        windowStart: Number(record.market.start),
        windowEnd: Number(record.market.end),
        marketSlug: record.market.slug || null,
        candleStart: Number(decision.candleStart),
        predictionAt,
        recordedAt: now,
        model: decision.model || 'LightGBMClassifier',
        pUp: Number(decision.pUp),
        pDown: Number(decision.pDown),
        predictedSide: decision.side,
        flipThreshold: FLIP_PROBABILITY,
        status: status || defaultStatus[0],
        reason: reason || defaultStatus[1],
        heldSide: heldAtSignal?.side || null,
        currentHeldSide: heldAtSignal?.side || null,
        oppositeProbability: null,
        currentOppositeProbability: null,
        flipQualified: false,
        selectedBook: null,
        heldBook: null,
        lastCheckedAt: null,
        checks: [],
      };
      this.flipAudit.unshift(row);
      this.flipAuditById.set(id, row);
      if (this.flipAudit.length > MAX_AUDIT_ROWS) {
        const removed = this.flipAudit.splice(MAX_AUDIT_ROWS);
        for (const old of removed) this.flipAuditById.delete(old.id);
      }
      isNew = true;
    }
    const marketId = String(record.market.id || record.market.slug);
    const held = this.positions.find((position) => position.marketId === marketId
      && position.windowStart === Number(record.market.start) && position.status === 'OPEN');
    const probability = held && held.side !== decision.side
      ? Number(decision[decision.side === 'UP' ? 'pUp' : 'pDown']) : null;
    const flipQualifiedNow = Boolean(held && held.side !== decision.side
      && decision.source === 'FREQAI' && Number(probability) > FLIP_PROBABILITY);
    row.predictedSide = decision.side;
    row.pUp = Number(decision.pUp);
    row.pDown = Number(decision.pDown);
    row.currentHeldSide = held?.side || null;
    row.currentOppositeProbability = probability;
    if (probability != null && row.oppositeProbability == null) row.oppositeProbability = probability;
    row.flipQualified = row.flipQualified || flipQualifiedNow;
    row.selectedBook = this.auditBook(record.quotes[decision.side], now);
    row.heldBook = held ? this.auditBook(record.quotes[held.side], now) : null;
    row.lastCheckedAt = now;

    const alreadyExecuted = ['ENTRY_EXECUTED', 'FLIP_EXECUTED'].includes(row.status);
    const defaultStatus = this.defaultAuditStatus(decision, record, now);
    const nextStatus = alreadyExecuted ? row.status
      : status || (isNew ? row.status : defaultStatus[0]);
    const nextReason = alreadyExecuted ? row.reason
      : reason || (isNew ? row.reason : defaultStatus[1]);
    const selectedSequence = row.selectedBook?.sequence ?? 'none';
    const heldSequence = row.heldBook?.sequence ?? 'none';
    const signature = `${nextStatus}|${selectedSequence}|${heldSequence}|${nextReason}`;
    if (row._lastCheckSignature !== signature) {
      row.status = nextStatus;
      row.reason = nextReason;
      row.checks.push({
        at: now,
        status: nextStatus,
        reason: nextReason,
        heldSide: row.heldSide,
        currentHeldSide: row.currentHeldSide,
        predictedSide: row.predictedSide,
        oppositeProbability: row.oppositeProbability,
        currentOppositeProbability: row.currentOppositeProbability,
        flipQualified: row.flipQualified,
        selectedBook: row.selectedBook,
        heldBook: row.heldBook,
      });
      if (row.checks.length > MAX_AUDIT_CHECKS) row.checks.splice(0, row.checks.length - MAX_AUDIT_CHECKS);
      row._lastCheckSignature = signature;
      this.scheduleAuditSave();
    }
    return row;
  }

  async tick(now = this.now()) {
    await super.tick(now);
    const record = this.records.get('BTC:5m');
    const decision = record?.market ? this.getDecision(record, this.now()) : null;
    if (decision?.source === 'FREQAI' && record.marketStatus === 'OPEN') {
      this.recordPredictionAudit(decision, record, this.now());
    }
  }

  getDecision(record, now) {
    const market = record.market;
    if (!market || now < Number(market.start) + ENTRY_DELAY_MS) return null;
    const modelState = this.freqaiWorker?.snapshot?.() || {};
    const prediction = modelState.lastPrediction;
    if (prediction
      && Number(prediction.windowStart) === Number(market.start)
      && fresh(prediction.candleStart, now, 120_000)
      && Number.isFinite(Number(prediction.pUp))
      && Number.isFinite(Number(prediction.pDown))) {
      const pUp = Number(prediction.pUp);
      const pDown = Number(prediction.pDown);
      return {
        side: pUp >= pDown ? 'UP' : 'DOWN',
        pUp,
        pDown,
        source: 'FREQAI',
        candleStart: prediction.candleStart,
        predictionAt: Number(prediction.writtenAt) || now,
        candleCloseAt: Number(prediction.candleCloseAt) || null,
        model: prediction.model || 'LightGBMClassifier',
      };
    }

    const candle = this.binanceFeed?.currentCandle;
    if (candle
      && Number(candle.start) === Number(market.start)
      && Number(candle.open) > 0
      && Number(candle.close) > 0
      && fresh(this.binanceFeed?.tickAt, now, 5000)) {
      const side = Number(candle.close) >= Number(candle.open) ? 'UP' : 'DOWN';
      return {
        side,
        pUp: null,
        pDown: null,
        source: 'BINANCE_WARMUP_FALLBACK',
        candleStart: Number(candle.start),
        model: null,
      };
    }
    return null;
  }

  processSide(record, side, quote, sequence) {
    const market = record.market;
    const now = this.now();
    if (!market || record.marketStatus !== 'OPEN'
      || now < Number(market.start) || now >= Number(market.end)) return;
    const currentId = String(market.id || market.slug);
    const held = this.positions.filter((p) => p.marketId === currentId
      && p.windowStart === Number(market.start) && p.status === 'OPEN');
    const hasEntry = this.orders.some((o) => o.action === 'BUY_TAKER'
      && o.marketId === currentId && o.windowStart === Number(market.start));

    const state = record.sideStates[side];
    if (now < Number(market.start) + ENTRY_DELAY_MS) {
      state.orderStatus = 'WAITING_FOR_FIRST_MINUTE';
      state.reason = 'Allowing the first 1-minute sample to form before prediction.';
      this.modelStatus = this.freqaiWorker?.snapshot?.().status || 'WAITING';
      return;
    }

    const decision = this.getDecision(record, now);
    if (!decision) {
      this.modelStatus = this.freqaiWorker?.snapshot?.().status || 'WAITING';
      state.orderStatus = 'WAITING_FOR_MODEL';
      state.reason = 'Waiting for a current-window FreqAI prediction or fresh Binance warm-up direction.';
      return;
    }
    const audit = decision.source === 'FREQAI'
      ? this.recordPredictionAudit(decision, record, now) : null;
    this.modelStatus = decision.source === 'FREQAI' ? 'READY' : 'WARMUP_FALLBACK';
    if (decision.side !== side) {
      state.orderStatus = 'WAITING_FOR_SELECTED_SIDE_BOOK';
      state.reason = `${decision.source === 'FREQAI' ? 'FreqAI' : 'Warm-up'} selected ${decision.side}; waiting for its live asks.`;
      return;
    }

    // Same-side predictions never add to the current holding.
    if (held.some((p) => p.side === side)) {
      if (audit) this.recordPredictionAudit(decision, record, now, 'HOLDING_SAME_SIDE',
        `Model selects held ${side}; no same-side add or flip.`);
      return;
    }
    if (hasEntry && (decision.source !== 'FREQAI'
      || !(Number(side === 'UP' ? decision.pUp : decision.pDown) > FLIP_PROBABILITY))) {
      state.orderStatus = 'HOLDING_UNTIL_STRONG_REVERSAL';
      state.reason = 'A flip requires an opposite fresh FreqAI probability strictly above 60%.';
      if (audit) this.recordPredictionAudit(decision, record, now, 'FLIP_THRESHOLD_NOT_MET',
        `Opposite score ${(Number(side === 'UP' ? decision.pUp : decision.pDown) * 100).toFixed(1)}%; threshold is strictly above 60%.`);
      return;
    }
    if (!isFresh(quote, now) || !quote.asks?.length) {
      state.orderStatus = 'WAITING_FOR_LIQUIDITY';
      state.reason = 'Waiting for fresh asks on the newly selected side.';
      if (audit) this.recordPredictionAudit(decision, record, now, hasEntry ? 'WAITING_FOR_OPPOSITE_ASKS' : 'WAITING_FOR_INITIAL_ASKS', state.reason);
      return;
    }
    for (const position of held) {
      if (!sellForFlip(this, record, position, now)) {
        state.orderStatus = 'WAITING_FOR_FLIP_SELL';
        state.reason = 'Waiting for fresh visible bids to finish selling before the replacement buy.';
        if (audit) this.recordPredictionAudit(decision, record, now, 'WAITING_FOR_HELD_BIDS', state.reason);
        return;
      }
    }

    const age = Number(quote?.updatedAt);
    if (!fresh(age, now, 2000) || !Array.isArray(quote.asks) || !quote.asks.length) {
      state.orderStatus = 'WAITING_FOR_LIQUIDITY';
      state.reason = `${decision.side} was selected; waiting for a fresh executable ask book.`;
      if (audit) this.recordPredictionAudit(decision, record, now, hasEntry ? 'WAITING_FOR_OPPOSITE_ASKS' : 'WAITING_FOR_INITIAL_ASKS', state.reason);
      return;
    }

    const marketId = String(market.id || market.slug);
    const tokenId = String(market.tokens?.[side] || '');
    const feeRate = feeRateFor(market);
    if (feeRate == null) {
      state.orderStatus = 'BLOCKED_INVALID_FEE';
      state.reason = 'Market fee rate is invalid; no paper order was recorded.';
      if (audit) this.recordPredictionAudit(decision, record, now, 'BLOCKED_INVALID_FEE', state.reason);
      return;
    }
    const recoveryDeficit = hasEntry ? Math.max(0, -windowNet(this, record)) : 0;
    const requestedShares = hasEntry
      ? recoveryShares(quote, recoveryDeficit, feeRate, SHARES_PER_WINDOW)
      : SHARES_PER_WINDOW;
    if (requestedShares == null) {
      state.orderStatus = 'WAITING_FOR_RECOVERY_DEPTH';
      state.reason = `Visible asks cannot yet support a buy covering the $${recoveryDeficit.toFixed(2)} window deficit.`;
      if (audit) this.recordPredictionAudit(decision, record, now, 'WAITING_FOR_RECOVERY_DEPTH', state.reason);
      return;
    }

    let remaining = requestedShares;
    let cost = 0;
    let fees = 0;
    const fills = [];
    for (const level of [...quote.asks].sort((a, b) => Number(a.price) - Number(b.price))) {
      const price = Number(level.price);
      const available = Number(level.size);
      if (!Number.isFinite(price) || price <= 0 || price > MAX_BUY_PRICE
        || !Number.isFinite(available) || available <= 0) continue;
      const shares = Math.min(remaining, available);
      if (shares <= 0) break;
      const fee = shares * feeRate * price * (1 - price);
      fills.push({ price, shares, fee });
      cost += shares * price;
      fees += fee;
      remaining -= shares;
      if (remaining <= 1e-8) break;
    }
    const filledShares = requestedShares - remaining;
    if (filledShares <= 1e-8) {
      state.orderStatus = 'WAITING_FOR_EXECUTABLE_ASKS';
      state.reason = `No visible asks at or below $${MAX_BUY_PRICE.toFixed(2)}; will retry while this window is open.`;
      if (audit) this.recordPredictionAudit(decision, record, now, hasEntry ? 'WAITING_FOR_RECOVERY_DEPTH' : 'WAITING_FOR_INITIAL_ASKS', state.reason);
      return;
    }
    const totalCost = cost + fees;
    if (this.availableCash() + 1e-8 < totalCost) {
      state.orderStatus = 'WAITING_FOR_PAPER_CASH';
      state.reason = `Paper cash is short of the $${totalCost.toFixed(2)} entry cost.`;
      if (audit) this.recordPredictionAudit(decision, record, now, 'WAITING_FOR_PAPER_CASH', state.reason);
      return;
    }

    const orderId = `freqai-entry-${++this.orderSequence}`;
    const order = {
      id: orderId,
      strategyId: this.strategyId,
      marketId,
      marketSlug: market.slug || null,
      marketTitle: market.title || null,
      asset: 'BTC',
      timeframe: '5m',
      windowStart: Number(market.start),
      windowEnd: Number(market.end),
      side,
      action: 'BUY_TAKER',
      orderType: 'PAPER_MARKETABLE_SWEEP',
      status: remaining > 1e-8 ? 'PARTIALLY_FILLED' : 'FILLED',
      requestedShares,
      filledShares,
      unfilledShares: remaining,
      averageFillPrice: cost / filledShares,
      limitPrice: MAX_BUY_PRICE,
      fees,
      fills,
      placedAt: now,
      filledAt: now,
      placedSequence: sequence,
      signalSource: decision.source,
      modelProbabilityUp: decision.pUp,
      modelProbabilityDown: decision.pDown,
      modelCandleStart: decision.candleStart,
      model: decision.model,
      recoveryDeficit,
      isRecoveryFlip: hasEntry,
      fillRule: `Sweep fresh visible asks up to $${MAX_BUY_PRICE.toFixed(2)}; unfilled remainder is cancelled.`,
    };
    const position = {
      id: `freqai-position-${++this.positionSequence}`,
      orderId,
      marketId,
      tokenId,
      marketSlug: market.slug || null,
      marketTitle: market.title || null,
      asset: 'BTC',
      timeframe: '5m',
      side,
      windowStart: Number(market.start),
      windowEnd: Number(market.end),
      entryAt: now,
      entryPrice: cost / filledShares,
      requestedShares,
      shares: filledShares,
      originalShares: filledShares,
      totalCost: cost,
      fees,
      estimatedMakerRebate: 0,
      realizedPnl: null,
      status: 'OPEN',
      markBid: Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null,
      markUpdatedAt: quote.updatedAt,
      markStatus: 'LIVE',
      unrealizedPnl: Number.isFinite(Number(quote.bestBid))
        ? Number(quote.bestBid) * filledShares - totalCost - fees
        : null,
      signalSource: decision.source,
      modelProbabilityUp: decision.pUp,
      modelProbabilityDown: decision.pDown,
      modelCandleStart: decision.candleStart,
      model: decision.model,
      recoveryDeficit,
      isRecoveryFlip: hasEntry,
    };

    this.cash -= totalCost;
    this.lastDecision = {
      ...decision, at: now, windowStart: Number(market.start), windowEnd: Number(market.end),
      isRecoveryFlip: hasEntry, requestedShares, recoveryDeficit,
    };
    this.orders.unshift(order);
    this.positions.unshift(position);
    record.triggeredSide = side;
    state.entryConsumed = true;
    state.orderId = orderId;
    state.orderStatus = order.status;
    state.requestedShares = requestedShares;
    state.filledShares = filledShares;
    state.limitPrice = MAX_BUY_PRICE;
    const decisionSummary = decision.source === 'FREQAI'
      ? `${(decision.pUp * 100).toFixed(1)}% UP / ${(decision.pDown * 100).toFixed(1)}% DOWN`
      : 'no model score; fresh Binance spot direction';
    state.reason = `${decision.source === 'FREQAI' ? 'FreqAI' : 'Binance warm-up'} selected ${side} (${decisionSummary}); swept ${filledShares.toFixed(2)} shares at $${(cost / filledShares).toFixed(3)} average.`;
    const other = record.sideStates[side === 'UP' ? 'DOWN' : 'UP'];
    other.orderStatus = 'WAITING_FOR_STRONG_REVERSAL';
    other.reason = `${side} is held; an opposite FreqAI signal above 60% can trigger a recovery flip.`;
    this.cash = Math.max(0, this.cash);
    this.log(
      `${decision.source === 'FREQAI' ? 'FreqAI' : 'Binance warm-up'} chose BTC ${side}: ${filledShares.toFixed(2)} / ${requestedShares} shares at $${(cost / filledShares).toFixed(3)} average; fee $${fees.toFixed(3)}.`,
      {
        asset: 'BTC',
        timeframe: '5m',
        side,
        outcome: 'neutral',
        type: hasEntry ? 'RECOVERY_BUY' : decision.source === 'FREQAI' ? 'FREQAI_ENTRY' : 'WARMUP_ENTRY',
        now,
      },
    );
    if (audit) this.recordPredictionAudit(decision, record, now,
      hasEntry ? 'FLIP_EXECUTED' : 'ENTRY_EXECUTED',
      `${hasEntry ? 'Opposite signal executed' : 'Initial entry executed'}: ${filledShares.toFixed(2)} ${side} shares filled at $${(cost / filledShares).toFixed(3)} average.`);
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
  }

  checkTakeProfits() {}

  checkStopLosses() {}

  updateSizingAfterClose(position) {
    position.sizingApplied = true;
  }

  snapshot() {
    const state = super.snapshot();
    const worker = this.freqaiWorker?.snapshot?.() || {};
    const prediction = worker.lastPrediction || null;
    const currentMarket = state.markets?.find((market) => market.asset === 'BTC'
      && market.timeframe === '5m' && market.marketStatus === 'OPEN');
    const currentPrediction = currentMarket && prediction
      && Number(prediction.windowStart) === Number(currentMarket.start)
      ? prediction
      : null;
    state.statusReason = this.statusReason;
    state.strategy = { ...STRATEGY };
    state.scanner = {
      ...state.scanner,
      assets: ['BTC'],
      timeframes: ['5m'],
      totalMarkets: 1,
      marketData: 'BTC spot features from FreqAI/Binance; Polymarket CLOB WebSocket for paper execution and marking.',
    };
    state.sizingByAsset = {
      BTC: {
        baseShares: SHARES_PER_WINDOW,
        sharesPerWindow: SHARES_PER_WINDOW,
        flipProbabilityAbove: FLIP_PROBABILITY,
        resetEachWindow: true,
      },
    };
    state.freqai = {
      status: worker.status || this.modelStatus,
      lastError: worker.lastError || null,
      startedAt: worker.startedAt || null,
      restartCount: worker.restartCount || 0,
      prediction: currentPrediction,
      latestPrediction: prediction,
      model: 'Freqtrade FreqAI LightGBMClassifier',
      input: 'Binance 1-minute OHLCV only; no Polymarket order-book pressure features.',
      resolutionLabel: 'Direction of the enclosing BTC 5-minute candle at its official window close.',
      warmupFallback: 'Fresh Binance spot candle direction after 80 seconds only if FreqAI has no current-window prediction.',
      auditTrail: this.flipAudit.slice(0, 40).map(({ _lastCheckSignature, ...row }) => ({
        ...row,
        checks: row.checks.slice(-6),
      })),
      auditPersistence: { ...this.auditPersistenceState },
    };
    state.currentDecision = this.lastDecision;
    const record = this.records.get('BTC:5m');
    state.recovery = {
      baseShares: SHARES_PER_WINDOW,
      flipProbabilityAbove: FLIP_PROBABILITY,
      windowRealizedPnl: record?.market ? windowNet(this, record) : 0,
      deficit: record?.market ? Math.max(0, -windowNet(this, record)) : 0,
      resetEachWindow: true,
    };
    return state;
  }

}

FreqAIBtcBot.STRATEGY = STRATEGY;
FreqAIBtcBot._test = { STRATEGY, ENTRY_DELAY_MS, SHARES_PER_WINDOW, MAX_BUY_PRICE, fresh, FLIP_PROBABILITY };
module.exports = FreqAIBtcBot;
