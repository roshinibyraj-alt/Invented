'use strict';

const cfg = require('./config');
const {
  getActiveWindow, fetchResolvedOutcomeBySlug, currentWindowOpenTs, slugForTs, WINDOW_SECONDS,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');

const EPSILON = 1e-8;
const MAX_LOG = 300;
const MIN_BOOK_CHECK_INTERVAL_MS = 500;
const SIDES = ['UP', 'DOWN'];

class Bot {
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.logger = opts.logger || null;
    this.resolveMarketOutcome = opts.resolveMarketOutcome || fetchResolvedOutcomeBySlug;
    this.demoMode = !!(trader && trader.demoMode === true);
    this.strategyBlocked = !this.demoMode;
    this.error = this.strategyBlocked
      ? 'Polymarket paper strategy requires DemoTrader; live execution is removed.' : null;
    this.executionHalt = this.strategyBlocked;
    this.startedAt = Date.now();
    this.capital = cfg.DEMO_CAPITAL;
    this.cash = cfg.DEMO_CAPITAL;
    this.w = null;
    this.prices = null;
    this.priceSeries = [];
    this._seriesSlug = null;
    this._lastSeriesAt = 0;
    this._quotesByToken = new Map();
    this._marketFeedStop = null;
    this._marketFeedSlug = null;
    this._lastQuoteAt = 0;
    this._lastWebSocketQuoteAt = 0;
    this._lastRestFetchAt = 0;
    this._lastHeartbeatAt = 0;
    this._running = false;
    this._warned = new Set();
    this._positionId = 0;
    this.lossStreak = { UP: 0, DOWN: 0 };
    this._entryOrderId = 0;
    this._nextResolutionCheckAt = new Map();
    this._resolutionCheckInFlight = new Set();
    this._resolutionStateBySlug = new Map();
    this.pending = [];
    this.trades = [];
    this.log = [];
    this.stats = {
      entries: 0, exits: 0, settlements: 0, wins: 0, losses: 0,
      realizedPnl: 0, estimatedFees: 0,
    };
    this.peak = this.capital;
    this.maxDrawdown = 0;
    this.equity = [{ ts: Date.now(), value: this.capital }];
  }

  _push(entry) {
    const record = { ts: Date.now(), ...entry };
    this.log.push(record);
    if (this.log.length > MAX_LOG) this.log.shift();
    try {
      const { ts, ...fields } = record;
      const line = '[bot] ' + JSON.stringify({ at: new Date(ts).toISOString(), ...fields });
      if (typeof this.logger === 'function') this.logger(line);
      else if (this.logger && typeof this.logger.log === 'function') this.logger.log(line);
    } catch (_) {
      // Logging must not interrupt the demo bot.
    }
  }

  _warnOnce(key, entry) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this._push(entry);
  }

  start() {
    if (this._running || this.strategyBlocked) {
      if (this.strategyBlocked) {
        this._warnOnce('demo-only', {
          event: 'EXECUTION_BLOCKED',
          note: 'Only the local DemoTrader is supported; no live order client is loaded.',
        });
      }
      return;
    }
    this._running = true;
    this._push({
      event: 'BOT_STARTED',
      note: 'Polymarket-only paper bot started; independent UP/DOWN limit orders share a $'
        + cfg.DEMO_CAPITAL.toFixed(2) + ' demo cash pool. No live order client is loaded.',
    });
    void this._loop();
  }

  stop() {
    this._running = false;
    if (this._marketFeedStop) {
      try { this._marketFeedStop(); } catch (_) {}
    }
    this._marketFeedStop = null;
    this._marketFeedSlug = null;
  }

  async _loop() {
    while (this._running) {
      try {
        await this._tick();
      } catch (error) {
        this.error = 'bot tick failed: ' + error.message;
        this._push({ event: 'ERROR', note: this.error });
      }
      await sleep(cfg.LOOP_MS);
    }
  }

  async _tick(now = Date.now()) {
    if (this.strategyBlocked) return;

    const openTs = currentWindowOpenTs(now);
    const slug = slugForTs(openTs);
    if (!this.w || this.w.slug !== slug) {
      if (this.w && !this.w.closed) await this._finishWindow(this.w, now, 'WINDOW_ROLLOVER');
      this._stopMarketFeed();
      this.w = makeWindowState(slug, openTs);
      this.prices = { slug, ts: now, up: emptyQuote(), down: emptyQuote() };
      this._quotesByToken = new Map();
      this._lastQuoteAt = 0;
      this._lastWebSocketQuoteAt = 0;
      this._lastRestFetchAt = 0;
      this.priceSeries = [];
      this._seriesSlug = slug;
      this._push({
        event: 'WINDOW_STARTED', slug,
        upLossStreak: this.lossStreak.UP, downLossStreak: this.lossStreak.DOWN,
        upTargetShares: this._sharesForSide('UP'), downTargetShares: this._sharesForSide('DOWN'),
        note: 'New five-minute window; independent UP and DOWN paper limit orders will be placed at $'
          + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2) + ' when the market tokens are available.',
      });
    }

    await this._pollExpiredResolutions(now);

    const w = this.w;
    if (!w.window && now >= w.nextDiscoveryAt) {
      w.nextDiscoveryAt = now + cfg.MARKET_DISCOVERY_POLL_MS;
      const result = await getActiveWindow(now);
      if (result.window && result.window.slug === w.slug) {
        this.error = null;
        w.window = result.window;
        w.status = 'watching_entries';
        this._placeEntryOrders(w);
        this._push({
          event: 'WINDOW_READY', slug: w.slug,
          note: 'Market tokens found; both independent $0.40 paper limit orders are active and CLOB books are being monitored.',
        });
        await this._ensureMarketFeed(w);
      } else {
        const reason = result.reason || 'active market not listed yet';
        this.error = reason;
        w.status = 'waiting_for_market';
        if (w.marketWaitReason !== reason) {
          w.marketWaitReason = reason;
          this._push({ event: 'MARKET_WAIT', slug: w.slug, note: reason });
        }
      }
    }

    if (!w.window) {
      this._maybeHeartbeat(w, now);
      return;
    }
    this._placeEntryOrders(w);
    if (this._marketFeedSlug !== w.slug) await this._ensureMarketFeed(w);
    if (now - this._lastQuoteAt >= cfg.PRICE_FEED_FALLBACK_MS
      && now - this._lastRestFetchAt >= cfg.PRICE_FEED_FALLBACK_MS) {
      await this._seedQuotes(w);
    }

    await Promise.all(SIDES.map((side) => this._processSide(w, side, now)));
    if (now >= windowCloseMs(w)) await this._finishWindow(w, now, 'WINDOW_EXPIRED');
    this._maybeHeartbeat(w, now);
    this._recordEquity(now);
  }

  _stopMarketFeed() {
    if (this._marketFeedStop) {
      try { this._marketFeedStop(); } catch (_) {}
    }
    this._marketFeedStop = null;
    this._marketFeedSlug = null;
  }

  _sharesForSide(sideName) {
    const streak = Math.max(0, Number(this.lossStreak[sideName]) || 0);
    const shares = cfg.BASE_SHARES * (cfg.MARTINGALE_MULTIPLIER ** streak);
    return Number.isFinite(shares) ? shares : Number.MAX_VALUE;
  }

  _recordSideResult(position, pnl) {
    const side = position.side;
    const previousLossStreak = Math.max(0, Number(this.lossStreak[side]) || 0);
    if (pnl > EPSILON) {
      this.lossStreak[side] = 0;
      this._push({
        event: 'SIDE_MARTINGALE_RESET', slug: position.slug, side,
        previousLossStreak, lossStreak: 0, nextShares: cfg.BASE_SHARES,
        note: 'This side won; only its own loss streak resets to the 10-share base.',
      });
    } else if (pnl < -EPSILON) {
      this.lossStreak[side] = previousLossStreak + 1;
      this._push({
        event: 'SIDE_MARTINGALE_STEP_UP', slug: position.slug, side,
        previousLossStreak, lossStreak: this.lossStreak[side],
        nextShares: round(this._sharesForSide(side), 4),
        note: 'This side lost; only its next share size increases by '
          + cfg.MARTINGALE_MULTIPLIER.toFixed(1) + '×.',
      });
    }
  }

  _reservedCash() {
    const w = this.w;
    if (!w) return 0;
    return SIDES.reduce((total, sideName) => {
      const order = w.sides[sideName].tranches[0].entryOrder;
      return total + (order && order.status === 'resting' ? order.reservedUsd : 0);
    }, 0);
  }

  _reserveForShares(shares) {
    const notional = shares * cfg.ENTRY_LIMIT_PRICE_USD;
    return notional + estimateTakerFee(shares, cfg.ENTRY_LIMIT_PRICE_USD);
  }

  _placeEntryOrders(w) {
    if (!w || w !== this.w || !w.window || w.closed || this.strategyBlocked) return;
    const priority = Math.floor(w.openTs / WINDOW_SECONDS) % 2 === 0
      ? ['UP', 'DOWN'] : ['DOWN', 'UP'];
    for (const sideName of priority) {
      const tranche = w.sides[sideName].tranches[0];
      if (tranche.entryOrder && tranche.entryOrder.status === 'resting') continue;
      if (tranche.state === 'done_for_window' || tranche.state === 'in_position') continue;

      const targetShares = this._sharesForSide(sideName);
      const reserve = this._reserveForShares(targetShares);
      const available = this.cash - this._reservedCash();
      if (!Number.isFinite(reserve) || reserve > available + EPSILON) {
        tranche.state = 'capital_blocked';
        if (Date.now() - tranche.lastEntryBlockLogAt >= 5000) {
          tranche.lastEntryBlockLogAt = Date.now();
          this._push({
            event: 'ENTRY_LIMIT_BLOCKED_CAPITAL', slug: w.slug, side: sideName,
            targetShares: round(targetShares, 4), requiredReserveUsd: round(reserve, 2),
            availableCashUsd: round(Math.max(0, available), 2),
            note: 'Shared demo cash cannot reserve the full side order; size is not scaled.',
          });
        }
        continue;
      }

      const tokenId = sideName === 'UP' ? w.window.tokenUp : w.window.tokenDown;
      const order = {
        id: 'paper-limit-' + (++this._entryOrderId),
        tokenId, side: sideName, limitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
        targetShares, remainingShares: targetShares, filledShares: 0,
        reservedUsd: reserve, status: 'resting', placedAt: Date.now(),
        consumedByPrice: {}, lastBookSignature: null,
      };
      tranche.entryOrder = order;
      tranche.targetShares = targetShares;
      tranche.initialBudgetUsd = targetShares * cfg.ENTRY_LIMIT_PRICE_USD;
      tranche.availableUsd = reserve;
      tranche.state = 'limit_order_open';
      this._push({
        event: 'ENTRY_LIMIT_PLACED', slug: w.slug, side: sideName,
        orderId: order.id, limitPrice: order.limitPrice,
        targetShares: round(targetShares, 4),
        reservedUsd: round(reserve, 2), lossStreak: this.lossStreak[sideName],
        note: 'Resting demo limit buy placed at $'
          + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2) + '; remains active until filled or window close.',
      });
    }
  }

  async _ensureMarketFeed(w) {
    if (!w || !w.window || this._marketFeedSlug === w.slug) return;
    this._stopMarketFeed();
    this._marketFeedSlug = w.slug;
    try {
      this._marketFeedStop = startMarketFeed(
        [w.window.tokenUp, w.window.tokenDown],
        (tokenId, quote) => {
          void this._onQuote(w.slug, tokenId, quote, 'websocket').catch((error) => {
            this._push({ event: 'QUOTE_PROCESS_ERROR', slug: w.slug, note: error.message });
          });
        },
        (error) => this._warnOnce('feed-' + w.slug, {
          event: 'CLOB_FEED_ERROR', slug: w.slug, note: error.message,
        }),
      );
    } catch (error) {
      this._warnOnce('feed-start-' + w.slug, {
        event: 'CLOB_FEED_ERROR', slug: w.slug, note: error.message,
      });
    }
    await this._seedQuotes(w);
  }

  async _seedQuotes(w) {
    if (!w || !w.window || this._marketFeedSlug !== w.slug) return;
    this._lastRestFetchAt = Date.now();
    const results = await Promise.allSettled([
      this.trader.getOrderBook(w.window.tokenUp),
      this.trader.getOrderBook(w.window.tokenDown),
    ]);
    if (this._marketFeedSlug !== w.slug) return;
    const tokenIds = [w.window.tokenUp, w.window.tokenDown];
    for (let index = 0; index < tokenIds.length; index += 1) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        await this._onQuote(w.slug, tokenIds[index], quoteFromBook(result.value), 'rest');
      } else {
        this._warnOnce('book-' + w.slug + '-' + index, {
          event: 'CLOB_BOOK_ERROR', slug: w.slug, note: result.reason.message,
        });
      }
    }
  }

  async _onQuote(slug, tokenId, update, source = 'websocket') {
    const w = this.w;
    if (!w || w.slug !== slug || !w.window || w.closed) return;
    const now = Date.now();
    if (now >= windowCloseMs(w)) return;
    const sideName = tokenId === w.window.tokenUp ? 'UP'
      : tokenId === w.window.tokenDown ? 'DOWN' : null;
    if (!sideName) return;

    const previous = this._quotesByToken.get(tokenId) || emptyQuote();
    const hasBid = update && Object.prototype.hasOwnProperty.call(update, 'bid');
    const hasAsk = update && Object.prototype.hasOwnProperty.call(update, 'ask');
    const next = {
      bid: hasBid ? validPrice(update.bid) : previous.bid,
      ask: hasAsk ? validPrice(update.ask) : previous.ask,
      ts: now,
      bidTs: hasBid ? now : previous.bidTs,
      askTs: hasAsk ? now : previous.askTs,
    };
    next.mid = next.bid == null || next.ask == null ? null : (next.bid + next.ask) / 2;
    this._quotesByToken.set(tokenId, next);
    if (typeof this.trader.updateQuote === 'function') this.trader.updateQuote(tokenId, next);

    const up = this._quotesByToken.get(w.window.tokenUp) || emptyQuote();
    const down = this._quotesByToken.get(w.window.tokenDown) || emptyQuote();
    this.prices = { slug, ts: now, up: { ...up }, down: { ...down } };
    this._lastQuoteAt = now;
    if (source === 'websocket') this._lastWebSocketQuoteAt = now;
    if (up.ask != null && down.ask != null && now - this._lastSeriesAt >= 250) {
      if (this._seriesSlug !== slug) {
        this._seriesSlug = slug;
        this.priceSeries = [];
      }
      this.priceSeries.push({
        t: Math.max(0, Math.round((now - w.openTs * 1000) / 1000)),
        up: round(up.ask, 3), down: round(down.ask, 3),
      });
      if (this.priceSeries.length > 600) this.priceSeries.shift();
      this._lastSeriesAt = now;
    }

    this._markPositions(w, now);
    await this._processSide(w, sideName, now);
    this._recordEquity(now);
  }

  async _processSide(w, sideName, now = Date.now()) {
    const side = w && w.sides && w.sides[sideName];
    if (!side || this.strategyBlocked || w !== this.w || !w.window || w.closed) return;
    if (side.processing) {
      side.dirty = true;
      return side.processingPromise;
    }

    side.processing = true;
    side.processingPromise = (async () => {
      let currentNow = now;
      do {
        side.dirty = false;
        await this._evaluateSide(w, sideName, currentNow);
        currentNow = Date.now();
      } while (side.dirty && !w.closed);
    })();
    try {
      await side.processingPromise;
    } finally {
      side.processing = false;
      side.processingPromise = null;
    }
  }

  async _evaluateSide(w, sideName, now) {
    const side = w.sides[sideName];
    const quote = this._quoteFor(sideName, w);
    const closeMs = windowCloseMs(w);
    if (now >= closeMs || !quote) return;
    const tranche = side.tranches[0];
    const entryOrder = tranche.entryOrder;

    if (entryOrder && entryOrder.status === 'resting'
      && quote.ask != null && quote.ask <= entryOrder.limitPrice + EPSILON) {
      await this._tryFillLimitBuy(w, sideName, tranche, now);
    }

    const position = tranche.position;
    if (position && position.openShares > EPSILON
      && quote.bid != null && quote.bid + EPSILON >= cfg.TAKE_PROFIT_BID_USD) {
      await this._sellPosition(w, tranche, position, 'TAKE_PROFIT', cfg.TAKE_PROFIT_BID_USD, now);
    }
  }

  async _tryFillLimitBuy(w, sideName, tranche, now) {
    const order = tranche.entryOrder;
    if (!order || order.status !== 'resting' || order.fillPending) return;
    const checkNow = Date.now();
    if (checkNow - (order.lastBookCheckAt || 0) < MIN_BOOK_CHECK_INTERVAL_MS) return;
    order.lastBookCheckAt = checkNow;
    order.fillPending = true;
    try {
      const fill = await this.trader.simulateLimitBuy(
        order.tokenId, order.remainingShares, order.limitPrice, order,
      );
      if (!fill || !(fill.shares > EPSILON) || !(fill.notional > EPSILON)) return;
      if (w.closed || Date.now() >= windowCloseMs(w)) {
        this._push({
          event: 'ENTRY_FILL_IGNORED_AFTER_EXPIRY', slug: w.slug, side: sideName,
          orderId: order.id, shares: round(fill.shares, 5),
          note: 'The paper fill response arrived after window close and was not added to the ledger.',
        });
        return;
      }

      const shares = Math.min(order.remainingShares, fill.shares);
      const notional = fill.notional * (shares / fill.shares);
      const averagePrice = positive(fill.avgPrice) || notional / shares;
      const fee = estimateTakerFee(shares, averagePrice);
      const cost = notional + fee;
      const nextRemaining = Math.max(0, order.remainingShares - shares);
      const nextReserve = this._reserveForShares(nextRemaining);
      const otherReserved = this._reservedCash() - order.reservedUsd;
      if (this.cash - cost - otherReserved - nextReserve < -EPSILON) {
        this._push({
          event: 'ENTRY_FILL_REJECTED_CAPITAL', slug: w.slug, side: sideName,
          orderId: order.id, shares: round(shares, 5),
          note: 'The simulated fill would exceed shared demo cash; no fill was recorded.',
        });
        return;
      }

      this.cash -= cost;
      order.remainingShares = nextRemaining;
      order.filledShares += shares;
      order.reservedUsd = nextReserve;
      if (order.remainingShares <= EPSILON) {
        order.remainingShares = 0;
        order.reservedUsd = 0;
        order.status = 'filled';
      }
      tranche.availableUsd = order.reservedUsd;
      tranche.cycle = 1;

      let position = tranche.position;
      if (!position) {
        position = {
          id: ++this._positionId,
          slug: w.slug, openTs: w.openTs,
          closeTs: Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS,
          side: sideName, trancheId: tranche.id, cycle: tranche.cycle, tokenId: order.tokenId,
          orderId: order.id, entryBudgetUsd: order.targetShares * order.limitPrice,
          entryNotional: 0, entryFee: 0, entryPrice: 0,
          shares: 0, openShares: 0, remainingEntryCost: 0,
          takeProfitPrice: cfg.TAKE_PROFIT_BID_USD,
          exitProceeds: 0, exitFees: 0, netExitProceeds: 0, realizedPnl: 0,
          clobExitProceeds: 0, clobExitShares: 0, lastClobExitPrice: null,
          lastMark: this._quoteFor(sideName, w)?.bid ?? averagePrice,
          resolutionOutcome: null, resolutionPricePerShare: null,
          openedAt: now, closedAt: null, status: 'open', finalized: false,
        };
        tranche.position = position;
      }

      position.shares += shares;
      position.openShares += shares;
      position.entryNotional += notional;
      position.entryFee += fee;
      position.entryPrice = position.entryNotional / position.shares;
      position.remainingEntryCost += cost;
      position.status = 'open';
      position.lastMark = this._quoteFor(sideName, w)?.bid ?? averagePrice;
      if (!this.pending.includes(position)) this.pending.push(position);
      this.stats.entries += 1;
      this.stats.estimatedFees += fee;
      w.status = 'position_open';
      tranche.state = order.status === 'filled' ? 'in_position' : 'partially_filled';
      this._push({
        event: 'ENTRY_LIMIT_FILLED', slug: w.slug, side: sideName,
        orderId: order.id, tranche: tranche.id, cycle: tranche.cycle,
        limitPrice: order.limitPrice, avgEntry: round(averagePrice, 4),
        shares: round(shares, 5), totalShares: round(position.shares, 5),
        remainingOrderShares: round(order.remainingShares, 5),
        spentUsd: round(notional, 4), fee: round(fee, 4),
        note: 'Paper limit fill used visible CLOB asks at or below $'
          + order.limitPrice.toFixed(2) + '; actual displayed fill prices and fees were booked.',
      });
    } finally {
      order.fillPending = false;
    }
  }

  async _sellPosition(w, tranche, position, reason, minimumPrice, now = Date.now()) {
    if (!position || position.openShares <= EPSILON || position.exitPending
      || now - (position.lastExitAttemptAt || 0) < MIN_BOOK_CHECK_INTERVAL_MS) return false;
    position.lastExitAttemptAt = now;
    position.exitPending = true;
    try {
      const order = await this.trader.placeFakMarketOrder(
        position.tokenId, 'SELL', position.openShares,
        { priceLimit: minimumPrice > 0 ? minimumPrice : 0 },
      );
      if (w.closed || Date.now() >= windowCloseMs(w)) {
        this._push({
          event: 'EXIT_IGNORED_AFTER_EXPIRY', slug: w.slug, side: position.side,
          tranche: position.trancheId,
          note: 'The simulated exit response arrived after expiry; remaining shares await official market resolution.',
        });
        return false;
      }
      const sharesSold = positive(order && order.raw && order.raw.makingAmount);
      const proceeds = positive(order && order.raw && order.raw.takingAmount);
      if (sharesSold == null || proceeds == null) {
        this._logExitUnfilled(w, position, reason, now);
        return false;
      }

      const sold = Math.min(position.openShares, sharesSold);
      const clobGrossProceeds = proceeds * (sold / sharesSold);
      const clobAverageExit = clobGrossProceeds / sold;
      const grossProceeds = clobGrossProceeds;
      const averageExit = grossProceeds / sold;
      const fee = estimateTakerFee(sold, clobAverageExit);
      const entryCostAllocated = position.openShares > EPSILON
        ? position.remainingEntryCost * (sold / position.openShares) : 0;
      position.openShares = Math.max(0, position.openShares - sold);
      position.remainingEntryCost = Math.max(0, position.remainingEntryCost - entryCostAllocated);
      position.exitProceeds += grossProceeds;
      position.exitFees += fee;
      position.netExitProceeds += grossProceeds - fee;
      position.clobExitProceeds += clobGrossProceeds;
      position.clobExitShares += sold;
      const realizedDelta = grossProceeds - fee - entryCostAllocated;
      position.realizedPnl += realizedDelta;
      this.stats.realizedPnl += realizedDelta;
      position.lastExitPrice = averageExit;
      position.lastClobExitPrice = clobAverageExit;
      position.lastMark = position.openShares > EPSILON
        ? this._quoteFor(position.side, w)?.bid ?? clobAverageExit : averageExit;
      this.cash += grossProceeds - fee;
      this.stats.estimatedFees += fee;
      this.stats.exits += 1;

      this._push({
        event: position.openShares <= EPSILON ? 'POSITION_EXITED' : 'POSITION_EXIT_PARTIAL',
        slug: w.slug, side: position.side, tranche: position.trancheId,
        reason, sharesSold: round(sold, 5), remainingShares: round(position.openShares, 5),
        avgExit: round(averageExit, 4), clobAvgExit: round(clobAverageExit, 4),
        proceeds: round(grossProceeds, 2),
        fee: round(fee, 4), realizedPnl: round(position.realizedPnl, 2),
        note: 'Simulated sale used available CLOB bids at or above the $'
          + minimumPrice.toFixed(2) + ' take-profit limit; actual average was $'
          + clobAverageExit.toFixed(4) + '.'
          + (position.openShares > EPSILON ? '; remaining shares stay open for another exit attempt.' : '.'),
      });

      if (position.openShares <= EPSILON) {
        position.openShares = 0;
        if (tranche.entryOrder && tranche.entryOrder.status === 'resting') {
          position.status = 'entry_order_open';
          this.pending = this.pending.filter((item) => item !== position);
          tranche.state = 'limit_order_open';
        } else {
          position.closedAt = now;
          position.status = 'closed';
          tranche.position = null;
          tranche.state = 'done_for_window';
          this._finalizeTrade(position, reason);
        }
      } else {
        position.status = 'tp_partial';
      }
      this._recordEquity(now);
      return position.openShares <= EPSILON;
    } finally {
      position.exitPending = false;
    }
  }

  _logExitUnfilled(w, position, reason, now) {
    if (now - (position.lastExitUnfilledLogAt || 0) < 1000) return;
    position.lastExitUnfilledLogAt = now;
    this._push({
      event: 'EXIT_UNFILLED', slug: w.slug, side: position.side,
      tranche: position.trancheId, reason,
      shares: round(position.openShares, 5),
      note: 'TP threshold was reached, but no executable CLOB bids at or above $'
        + cfg.TAKE_PROFIT_BID_USD.toFixed(2) + ' were available; retrying on the next quote.',
    });
  }

  _cancelEntryOrder(w, sideName, tranche, reason) {
    const order = tranche.entryOrder;
    if (!order || order.status !== 'resting') return;
    order.status = 'cancelled';
    order.reservedUsd = 0;
    tranche.availableUsd = 0;
    if (tranche.position && tranche.position.openShares <= EPSILON) {
      tranche.position.status = 'closed';
      tranche.position.closedAt = Date.now();
      tranche.state = 'done_for_window';
      const position = tranche.position;
      tranche.position = null;
      this._finalizeTrade(position, reason);
    } else if (!tranche.position) {
      tranche.state = 'done_for_window';
    }
    this._push({
      event: 'ENTRY_LIMIT_CANCELLED', slug: w.slug, side: sideName,
      orderId: order.id, remainingShares: round(order.remainingShares, 5),
      note: 'Unfilled limit remainder released at window close; ' + reason + '.',
    });
  }

  async _finishWindow(w, now, event) {
    if (!w || w.closed) return;
    await Promise.all(SIDES.map(async (sideName) => {
      const processing = w.sides[sideName].processingPromise;
      if (processing) await processing;
    }));
    for (const sideName of SIDES) {
      const tranche = w.sides[sideName].tranches[0];
      this._cancelEntryOrder(w, sideName, tranche, 'window expired');
      if (tranche.position && tranche.position.openShares <= EPSILON) {
        const position = tranche.position;
        tranche.position = null;
        tranche.state = 'done_for_window';
        position.status = 'closed';
        position.closedAt = now;
        this._finalizeTrade(position, 'LIMIT_ORDER_COMPLETE');
      }
      if (!tranche.position && tranche.state !== 'done_for_window') {
        tranche.state = 'done_for_window';
      }
    }
    w.closed = true;
    w.closedAt = now;
    w.status = this._positionsForWindow(w).length ? 'awaiting_resolution' : 'window_closed';
    for (const position of this._positionsForWindow(w)) {
      position.lastKnownMark = position.lastMark;
      position.lastKnownMarkAt = position.lastMarkAt || null;
      position.status = 'pending_resolution';
      const tranche = w.sides[position.side].tranches.find((item) => item.id === position.trancheId);
      if (tranche) tranche.state = 'pending_resolution';
    }
    this._push({
      event: 'WINDOW_CLOSED', slug: w.slug,
      note: event + ': resting limit orders are cancelled; open shares remain held for Gamma final outcome settlement. No forced exit or stop loss is used.',
    });
    if (this._marketFeedSlug === w.slug) this._stopMarketFeed();
  }

  async _pollExpiredResolutions(now = Date.now()) {
    const slugs = [...new Set(this.pending
      .filter((position) => position.openShares > EPSILON
        && now >= (Number(position.closeTs) || position.openTs + WINDOW_SECONDS) * 1000)
      .map((position) => position.slug))];
    const checks = slugs.filter((slug) => !this._resolutionCheckInFlight.has(slug)
      && now >= (this._nextResolutionCheckAt.get(slug) || 0));

    await Promise.all(checks.map(async (slug) => {
      this._resolutionCheckInFlight.add(slug);
      this._nextResolutionCheckAt.set(slug, now + cfg.RESOLUTION_POLL_MS);
      try {
        const resolution = await this.resolveMarketOutcome(slug);
        if (!resolution || resolution.resolved !== true) {
          this._noteResolutionState(
            slug,
            'pending',
            resolution && resolution.reason
              ? resolution.reason : 'Waiting for Gamma to confirm the final binary outcome.',
          );
          return;
        }
        if (!this._settleResolvedWindow(slug, resolution, now)) return;
        this._resolutionStateBySlug.delete(slug);
        this._nextResolutionCheckAt.delete(slug);
      } catch (error) {
        this._noteResolutionState(slug, 'lookup_error', 'Gamma resolution check failed: ' + error.message);
      } finally {
        this._resolutionCheckInFlight.delete(slug);
      }
    }));
  }

  _noteResolutionState(slug, state, note) {
    if (this._resolutionStateBySlug.get(slug) === state) return;
    this._resolutionStateBySlug.set(slug, state);
    this._push({
      event: state === 'lookup_error' ? 'MARKET_RESOLUTION_CHECK_FAILED' : 'MARKET_RESOLUTION_PENDING',
      slug, note: note || 'Waiting for Gamma to confirm the final binary outcome.',
    });
  }

  _settleResolvedWindow(slug, resolution, now) {
    const positions = this.pending.filter((position) => position.slug === slug
      && position.openShares > EPSILON);
    if (!positions.length) return true;

    const payouts = positions.map((position) => ({
      position,
      payoutPerShare: Number(resolution.payoutPerShare && resolution.payoutPerShare[position.side]),
    }));
    if (payouts.some(({ payoutPerShare }) => payoutPerShare !== 0 && payoutPerShare !== 1)) {
      this._noteResolutionState(
        slug, 'invalid_outcome',
        'Gamma resolution was missing an unambiguous $0/$1 payout for UP and DOWN.',
      );
      return false;
    }

    for (const { position, payoutPerShare } of payouts) {
      const sharesSettled = position.openShares;
      const payout = sharesSettled * payoutPerShare;
      const entryCostAllocated = position.remainingEntryCost;
      const realizedDelta = payout - entryCostAllocated;

      position.openShares = 0;
      position.remainingEntryCost = 0;
      position.exitProceeds += payout;
      position.netExitProceeds += payout;
      position.realizedPnl += realizedDelta;
      position.lastExitPrice = payoutPerShare;
      position.lastMark = payoutPerShare;
      position.closedAt = now;
      position.status = 'settled';
      position.resolutionOutcome = resolution.winningSide;
      position.resolutionPricePerShare = payoutPerShare;
      this.cash += payout;
      this.stats.realizedPnl += realizedDelta;
      this.stats.settlements += 1;

      const tranche = this._trancheFor(position);
      if (tranche && tranche.position === position) {
        tranche.position = null;
        tranche.state = 'settled';
      }

      this._push({
        event: 'POSITION_SETTLED', slug, side: position.side,
        tranche: position.trancheId, cycle: position.cycle,
        outcome: resolution.winningSide, payoutPerShare,
        sharesSettled: round(sharesSettled, 5), payout: round(payout, 4),
        realizedPnl: round(position.realizedPnl, 2),
        note: 'Official Gamma binary resolution booked at $'
          + payoutPerShare.toFixed(2) + ' per remaining share.',
      });
      this._finalizeTrade(position, 'MARKET_RESOLUTION');
    }
    this._recordEquity(now);
    return true;
  }

  _finalizeTrade(position, reason) {
    if (!position || position.finalized) return;
    position.finalized = true;
    const pnl = position.realizedPnl;
    this._recordSideResult(position, pnl);
    if (pnl >= 0) this.stats.wins += 1;
    else this.stats.losses += 1;
    const trade = {
      slug: position.slug, openTs: position.openTs, side: position.side,
      tranche: position.trancheId, cycle: position.cycle,
      shares: position.shares, entryPrice: round(position.entryPrice, 4),
      exitPrice: position.shares > 0 ? round(position.exitProceeds / position.shares, 4) : null,
      clobExitPrice: position.clobExitShares > 0
        ? round(position.clobExitProceeds / position.clobExitShares, 4) : null,
      entryNotional: round(position.entryNotional, 4),
      exitProceeds: round(position.exitProceeds, 4),
      netExitProceeds: round(position.netExitProceeds, 4),
      fees: round(position.entryFee + position.exitFees, 4),
      resolutionOutcome: position.resolutionOutcome || null,
      resolutionPricePerShare: position.resolutionPricePerShare ?? null,
      pnl: round(pnl, 2), reason,
      lossStreakAfter: this.lossStreak[position.side],
      nextShares: round(this._sharesForSide(position.side), 4),
      ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    this._push({
      event: 'TRADE_CLOSED', slug: position.slug, side: position.side,
      tranche: position.trancheId, pnl: round(pnl, 2), reason,
      lossStreak: this.lossStreak[position.side],
      nextShares: round(this._sharesForSide(position.side), 4),
      note: 'Trade closed with estimated net P&L ' + (pnl >= 0 ? '+' : '') + '$' + round(pnl, 2) + '.',
    });
  }

  _trancheFor(position) {
    if (!this.w || this.w.openTs !== position.openTs) return null;
    return this.w.sides[position.side].tranches.find((item) => item.id === position.trancheId) || null;
  }

  _positionsForWindow(w) {
    return this.pending.filter((position) => position.openTs === w.openTs && position.openShares > EPSILON);
  }

  _quoteFor(side, w = this.w) {
    if (!w || !this.prices || this.prices.slug !== w.slug) return null;
    return this.prices[side.toLowerCase()] || null;
  }

  _markPositions(w, now) {
    for (const position of this.pending) {
      if (position.openTs !== w.openTs) continue;
      const quote = this._quoteFor(position.side, w);
      const mark = quote && quote.bid;
      if (mark != null) {
        position.lastMark = mark;
        position.lastMarkAt = now;
      }
    }
  }

  _accountValuation() {
    const isMarkedCurrent = (position) => this.w && !this.w.closed
      && Date.now() < windowCloseMs(this.w)
      && position.status !== 'pending_resolution'
      && position.openTs === this.w.openTs;
    const markedPositions = this.pending.filter(isMarkedCurrent);
    const unresolvedPositions = this.pending.filter((position) => !isMarkedCurrent(position));
    const openValue = markedPositions.reduce((total, position) => {
      const mark = Number.isFinite(Number(position.lastMark))
        ? Number(position.lastMark) : Number(position.entryPrice);
      return total + position.openShares * (Number.isFinite(mark) ? mark : 0);
    }, 0);
    const unrealizedPnl = markedPositions.reduce((total, position) => {
      const mark = Number.isFinite(Number(position.lastMark))
        ? Number(position.lastMark) : Number(position.entryPrice);
      const value = Number.isFinite(mark) ? mark : 0;
      return total + position.openShares * value - position.remainingEntryCost;
    }, 0);
    const hasUnresolved = unresolvedPositions.length > 0;
    const equity = hasUnresolved ? null : this.cash + openValue;
    return {
      openValue,
      unrealizedPnl,
      equity,
      totalPnl: equity == null ? null : equity - this.capital,
      unresolvedPositions,
      unresolvedShares: unresolvedPositions.reduce((sum, position) => sum + position.openShares, 0),
      unresolvedEntryCost: unresolvedPositions.reduce((sum, position) => sum + position.remainingEntryCost, 0),
    };
  }

  _recordEquity(now = Date.now()) {
    const valuation = this._accountValuation();
    if (valuation.equity == null) return;
    const equity = valuation.equity;
    this.peak = Math.max(this.peak, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peak - equity);
    const last = this.equity[this.equity.length - 1];
    if (!last || Math.abs(equity - last.value) >= 0.01 || now - last.ts >= 1000) {
      this.equity.push({ ts: now, value: round(equity, 2) });
      if (this.equity.length > 500) this.equity.shift();
    }
  }

  _maybeHeartbeat(w, now = Date.now()) {
    if (now - this._lastHeartbeatAt < cfg.BOT_LOG_HEARTBEAT_MS) return;
    this._lastHeartbeatAt = now;
    const age = (ts) => ts > 0 ? Math.max(0, now - ts) : null;
    const px = this.prices && this.prices.slug === w.slug ? this.prices : null;
    this._push({
      event: 'BOT_HEARTBEAT', slug: w.slug, status: w.status,
      marketReady: !!w.window, feedStarted: this._marketFeedSlug === w.slug,
      upBid: px && px.up.bid != null ? round(px.up.bid, 4) : null,
      upAsk: px && px.up.ask != null ? round(px.up.ask, 4) : null,
      downBid: px && px.down.bid != null ? round(px.down.bid, 4) : null,
      downAsk: px && px.down.ask != null ? round(px.down.ask, 4) : null,
      lastQuoteAgeMs: age(this._lastQuoteAt),
      lastWebSocketQuoteAgeMs: age(this._lastWebSocketQuoteAt),
      error: this.error || null,
      note: 'CLOB-only demo loop is active; no external spot feed or live-order client is used.',
    });
  }

  snapshot() {
    const now = Date.now();
    this._recordEquity(now);
    const valuation = this._accountValuation();
    const w = this.w;
    const window = w ? {
      slug: w.slug, status: w.status, openTs: w.openTs,
      closeTs: Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS,
      secondsRemaining: Math.max(0, ((Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000 - now) / 1000),
      closed: w.closed,
      sides: Object.fromEntries(SIDES.map((name) => {
        const side = w.sides[name];
        return [name, {
          lossStreak: this.lossStreak[name],
          nextShares: round(this._sharesForSide(name), 4),
          quote: this._quoteFor(name, w),
          tranches: side.tranches.map((tranche) => ({
            id: tranche.id, entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
            targetShares: round(tranche.targetShares, 4), initialBudgetUsd: round(tranche.initialBudgetUsd, 2),
            availableUsd: round(tranche.availableUsd, 2), state: tranche.state, cycle: tranche.cycle,
            entryOrder: tranche.entryOrder ? {
              id: tranche.entryOrder.id, status: tranche.entryOrder.status,
              limitPrice: tranche.entryOrder.limitPrice,
              targetShares: round(tranche.entryOrder.targetShares, 4),
              remainingShares: round(tranche.entryOrder.remainingShares, 4),
              reservedUsd: round(tranche.entryOrder.reservedUsd, 2),
            } : null,
            position: tranche.position ? {
              id: tranche.position.id, entryPrice: tranche.position.entryPrice,
              takeProfitPrice: tranche.position.takeProfitPrice,
              shares: tranche.position.shares, openShares: tranche.position.openShares,
              status: tranche.position.status,
            } : null,
          })),
        }];
      })),
      positions: this._positionsForWindow(w).map((position) => this._positionSnapshot(position)),
    } : null;
    return {
      now, mode: 'DEMO', uptimeSec: Math.floor((now - this.startedAt) / 1000),
      error: this.error, executionHalt: this.executionHalt,
      account: {
        capital: this.capital, cash: round(this.cash, 2),
        reservedCash: round(this._reservedCash(), 2),
        availableCash: round(Math.max(0, this.cash - this._reservedCash()), 2),
        openValue: round(valuation.openValue, 2),
        equity: valuation.equity == null ? null : round(valuation.equity, 2),
        totalPnl: valuation.totalPnl == null ? null : round(valuation.totalPnl, 2),
        unrealizedPnl: round(valuation.unrealizedPnl, 2),
        unresolvedPositions: valuation.unresolvedPositions.length,
        unresolvedShares: round(valuation.unresolvedShares, 5),
        unresolvedEntryCost: round(valuation.unresolvedEntryCost, 2),
        maxDrawdown: valuation.unresolvedPositions.length ? null : round(this.maxDrawdown, 2),
      },
      strategy: {
        demoCapital: cfg.DEMO_CAPITAL, sharedCapital: true,
        baseShares: cfg.BASE_SHARES, entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
        takeProfitBid: cfg.TAKE_PROFIT_BID_USD, hardStopLossBid: null,
        martingaleMultiplier: cfg.MARTINGALE_MULTIPLIER,
      },
      martingale: {
        independent: true,
        UP: { lossStreak: this.lossStreak.UP, nextShares: round(this._sharesForSide('UP'), 4) },
        DOWN: { lossStreak: this.lossStreak.DOWN, nextShares: round(this._sharesForSide('DOWN'), 4) },
      },
      window, prices: this.prices, priceSeries: this.priceSeries,
      pending: this.pending.map((position) => this._positionSnapshot(position)),
      trades: this.trades.slice(-60).reverse(),
      stats: { ...this.stats }, equity: this.equity,
      cfg: {
        demoCapital: this.capital, baseShares: cfg.BASE_SHARES,
        entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
        takeProfitBid: cfg.TAKE_PROFIT_BID_USD,
        hardStopLossBid: null,
        martingaleMultiplier: cfg.MARTINGALE_MULTIPLIER,
        windowSec: WINDOW_SECONDS,
      },
      log: this.log.slice(-100).reverse(),
    };
  }

  _positionSnapshot(position) {
    const currentWindow = this.w && !this.w.closed
      && position.openTs === this.w.openTs
      && Date.now() < windowCloseMs(this.w);
    const awaitingResolution = position.status === 'pending_resolution' || !currentWindow;
    const mark = awaitingResolution ? null
      : Number.isFinite(Number(position.lastMark)) ? Number(position.lastMark) : position.entryPrice;
    const lastKnownMark = position.lastKnownMark ?? position.lastMark ?? null;
    const costBasis = Number(position.remainingEntryCost) || 0;
    return {
      ...position, mark,
      status: awaitingResolution ? 'pending_resolution' : position.status,
      lastMark: awaitingResolution ? null : position.lastMark,
      lastKnownMark: awaitingResolution ? lastKnownMark : null,
      lastKnownMarkAt: awaitingResolution ? (position.lastKnownMarkAt ?? position.lastMarkAt ?? null) : null,
      unrealized: awaitingResolution ? null : position.openShares * mark - costBasis,
    };
  }
}

function makeWindowState(slug, openTs) {
  return {
    slug, openTs, status: 'waiting_for_market', window: null,
    marketWaitReason: null, nextDiscoveryAt: 0,
    closed: false, closedAt: null,
    sides: {
      UP: makeSide('UP'),
      DOWN: makeSide('DOWN'),
    },
  };
}

function makeSide(name) {
  return {
    name, processing: false, processingPromise: null, dirty: false,
    tranches: [makeTranche('SINGLE')],
  };
}

function makeTranche(id) {
  return {
    id, targetShares: null,
    initialBudgetUsd: 0, availableUsd: 0,
    state: 'waiting_for_market', cycle: 0,
    entryOrder: null, position: null, lastEntryBlockLogAt: 0,
  };
}

function emptyQuote() {
  return { bid: null, ask: null, mid: null, ts: null, bidTs: null, askTs: null };
}

function quoteFromBook(book) {
  const bids = sortedLevels(book && book.bids, 'desc');
  const asks = sortedLevels(book && book.asks, 'asc');
  const bid = bids.length ? bids[0].price : null;
  const ask = asks.length ? asks[0].price : null;
  return { bid, ask };
}

function sortedLevels(levels, direction) {
  return (levels || [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => validPrice(level.price) != null && level.size > 0 && Number.isFinite(level.size))
    .sort(direction === 'asc' ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);
}

function estimateTakerFee(shares, price) {
  const quantity = Number(shares);
  const fillPrice = Number(price);
  if (!Number.isFinite(quantity) || !Number.isFinite(fillPrice) || quantity <= 0 || fillPrice <= 0 || fillPrice >= 1) return 0;
  return quantity * fillPrice * (1 - fillPrice) * cfg.TAKER_FEE_RATE;
}

function validPrice(value) {
  if (value == null || value === '') return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 && price <= 1 ? price : null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function windowCloseMs(w) {
  return (Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000;
}

const round = (value, digits = 2) => Number.isFinite(Number(value))
  ? Math.round(Number(value) * (10 ** digits)) / (10 ** digits) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = Bot;
module.exports.makeWindowState = makeWindowState;
module.exports.estimateTakerFee = estimateTakerFee;
module.exports.quoteFromBook = quoteFromBook;
