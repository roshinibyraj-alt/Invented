'use strict';

const cfg = require('./config');
const {
  getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');
const { simulateLimitBuy, queueAheadAtLimit } = require('./paper-limit-order');

const EPSILON = 1e-8;
const CLOSE_WINNER_THRESHOLD = 0.98;
const CLOSE_SAMPLE_SECONDS = 3;
const MAX_LOG = 300;
const SIDES = ['UP', 'DOWN'];

class Bot {
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.logger = opts.logger || null;
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
    this._booksByToken = new Map();
    this._lastHeartbeatAt = 0;
    this._running = false;
    this._warned = new Set();
    this._positionId = 0;
    this.lossStreak = 0;
    this._entryOrderId = 0;
    this._exitOrderId = 0;
    this.pending = [];
    this.trades = [];
    this.log = [];
    this.stats = {
      entries: 0, exits: 0, settlements: 0, wins: 0, losses: 0,
      realizedPnl: 0, estimatedFees: 0, makerFeeEquivalent: 0,
      estimatedMakerRebate: 0,
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
      note: 'Polymarket-only paper bot started; paired UP/DOWN $'
        + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2) + ' limit orders share a $'
        + cfg.DEMO_CAPITAL.toFixed(2)
        + ' demo cash pool. First fill cancels the opposite order. No live order client is loaded.',
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
      this._booksByToken = new Map();
      this.priceSeries = [];
      this._seriesSlug = slug;
      this._push({
        event: 'WINDOW_STARTED', slug,
        lossStreak: this.lossStreak,
        targetShares: this._sharesForNextTrade(),
        entryAt: openTs * 1000,
        note: 'New five-minute window; equal-size UP and DOWN paper limit buys will be posted at $'
          + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2)
          + ' as soon as the market is discovered. The first side to fill cancels the other.',
      });
    }

    const w = this.w;
    if (!w.window && now >= w.nextDiscoveryAt) {
      w.nextDiscoveryAt = now + cfg.MARKET_DISCOVERY_POLL_MS;
      const result = await getActiveWindow(now);
      if (result.window && result.window.slug === w.slug) {
        this.error = null;
        w.window = result.window;
        w.status = 'watching_entries';
        this._push({
          event: 'WINDOW_READY', slug: w.slug,
          entryAt: w.openTs * 1000,
          note: 'Market tokens found; the bot can now post its paired $'
            + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2)
            + ' paper limit buys, subject to modeled order-arrival latency.',
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
    if (this._marketFeedSlug !== w.slug) await this._ensureMarketFeed(w);
    if (now - this._lastRestFetchAt >= cfg.PRICE_FEED_FALLBACK_MS) {
      await this._seedQuotes(w);
    }

    this._processEntryBooks(w, Date.now());
    await this._maybePlaceLimitEntries(w, Date.now());
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

  _sharesForNextTrade() {
    const streak = Math.max(0, Number(this.lossStreak) || 0);
    const shares = cfg.BASE_SHARES * (cfg.MARTINGALE_MULTIPLIER ** streak);
    return Number.isFinite(shares) ? shares : Number.MAX_VALUE;
  }

  _recordTradeResult(position, pnl) {
    const previousLossStreak = Math.max(0, Number(this.lossStreak) || 0);
    if (pnl > EPSILON) {
      this.lossStreak = 0;
      this._push({
        event: 'MARTINGALE_RESET', slug: position.slug, side: position.side,
        previousLossStreak, lossStreak: 0, nextShares: cfg.BASE_SHARES,
        note: 'The one position in this window won; the shared next-window size resets to 10 shares.',
      });
    } else if (pnl < -EPSILON) {
      this.lossStreak = previousLossStreak + 1;
      this._push({
        event: 'MARTINGALE_STEP_UP', slug: position.slug, side: position.side,
        previousLossStreak, lossStreak: this.lossStreak,
        nextShares: round(this._sharesForNextTrade(), 4),
        note: 'The one position in this window lost; next-window shares increase by '
          + cfg.MARTINGALE_MULTIPLIER.toFixed(1) + '×.',
      });
    }
  }

  async _maybePlaceLimitEntries(w, now = Date.now()) {
    if (!w || w !== this.w || !w.window || w.closed || this.strategyBlocked
      || now >= windowCloseMs(w)) return;
    if (w.entryOrdersPlacedAt != null) return;

    const placedAt = Date.now();
    const targetShares = this._sharesForNextTrade();
    w.entryOrdersPlacedAt = placedAt;
    w.targetShares = targetShares;
    w.status = 'entry_orders_posting';
    for (const sideName of SIDES) {
      const tokenId = sideName === 'UP' ? w.window.tokenUp : w.window.tokenDown;
      const tranche = w.sides[sideName].tranches[0];
      tranche.targetShares = targetShares;
      tranche.cycle = 1;
      tranche.entryOrder = {
        id: 'paper-limit-' + (++this._entryOrderId),
        tokenId, side: 'BUY', orderType: 'LIMIT',
        limitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
        targetShares, filledShares: 0, remainingShares: targetShares,
        unfilledShares: targetShares, cancelledShares: 0,
        notional: 0, fees: 0, totalCost: 0, averagePrice: null,
        fills: [], reservedUsd: 0, placedAt,
        arrivalAt: placedAt + cfg.ENTRY_ORDER_LATENCY_MS,
        restingAt: null, status: 'waiting_to_post',
        queueAheadShares: 0, lastBookTs: null, seenTradeKeys: {},
      };
      tranche.state = 'entry_order_posting';
    }
    this._push({
      event: 'PAIRED_LIMIT_ORDERS_PLACED', slug: w.slug,
      limitPrice: cfg.ENTRY_LIMIT_PRICE_USD, targetShares,
      orderIds: {
        UP: w.sides.UP.tranches[0].entryOrder.id,
        DOWN: w.sides.DOWN.tranches[0].entryOrder.id,
      },
      modeledLatencyMs: cfg.ENTRY_ORDER_LATENCY_MS,
      note: 'Paper limit buys are resting independently on UP and DOWN; the first side to receive any fill cancels the other order.',
    });

    const results = await Promise.allSettled(SIDES.map((sideName) => {
      const tokenId = sideName === 'UP' ? w.window.tokenUp : w.window.tokenDown;
      return this.trader.getOrderBook(tokenId);
    }));
    if (w !== this.w || w.closed) return;
    const completedAt = Date.now();
    for (let index = 0; index < SIDES.length; index += 1) {
      const result = results[index];
      const sideName = SIDES[index];
      const tokenId = sideName === 'UP' ? w.window.tokenUp : w.window.tokenDown;
      if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.asks)) {
        this._booksByToken.set(tokenId, { book: result.value, ts: completedAt });
      }
    }
    for (let index = 0; index < SIDES.length; index += 1) {
      const sideName = SIDES[index];
      const result = results[index];
      if (result.status !== 'fulfilled' || !result.value || !Array.isArray(result.value.asks)) {
        this._push({
          event: 'ENTRY_BOOK_WAITING', slug: w.slug, side: sideName,
          note: result.status === 'rejected' ? String(result.reason && result.reason.message || result.reason)
            : 'CLOB order book is unavailable; the paper limit remains posted and awaits later data.',
        });
        continue;
      }
      const tokenId = sideName === 'UP' ? w.window.tokenUp : w.window.tokenDown;
      await this._onQuote(w.slug, tokenId, quoteFromBook(result.value), 'rest');
    }
    this._processEntryBooks(w, Date.now());
  }

  _processEntryBooks(w, now = Date.now()) {
    if (!w || w !== this.w || w.closed || !w.window || now >= windowCloseMs(w)) return;
    const priority = Math.floor(w.openTs / WINDOW_SECONDS) % 2 === 0
      ? ['UP', 'DOWN'] : ['DOWN', 'UP'];
    for (const sideName of priority) {
      const tranche = w.sides[sideName].tranches[0];
      const order = tranche.entryOrder;
      if (!order || !isLivePaperOrder(order.status) || now < order.arrivalAt) continue;
      if (w.entryWinnerSide && w.entryWinnerSide !== sideName) continue;
      if (order.status === 'waiting_to_post' || order.status === 'posting') {
        order.status = 'resting';
        order.restingAt = now;
        tranche.state = 'limit_order_resting';
      }
      const cached = this._booksByToken.get(order.tokenId);
      if (!cached || now - cached.ts > cfg.PRICE_STALE_MS || order.lastBookTs === cached.ts) continue;
      order.lastBookTs = cached.ts;
      if (!order.queueInitialized) {
        order.queueAheadShares = queueAheadAtLimit(cached.book, order.limitPrice);
        order.queueInitialized = true;
        this._push({
          event: 'ENTRY_LIMIT_RESTING', slug: w.slug, side: sideName,
          orderId: order.id, limitPrice: order.limitPrice,
          targetShares: round(order.targetShares, 4),
          queueAheadShares: round(order.queueAheadShares, 4),
          note: 'Modeled limit order has reached the public CLOB book after latency; it can fill only at or below its $0.30 limit.',
        });
      }
      if (cached.ts < order.arrivalAt) continue;
      const plan = simulateLimitBuy(
        cached.book, order.remainingShares, order.limitPrice,
        Math.max(0, this.cash), cfg.TAKER_FEE_RATE,
      );
      if (plan.filledShares > EPSILON) {
        this._applyEntryFill(w, sideName, plan.fills.map((fill) => ({ ...fill, maker: false })),
          now, order, 'CROSSING_ASK');
      }
    }
    if (w.entryWinnerSide) w.status = 'position_open';
    else if (w.status !== 'window_closed') w.status = 'watching_limit_orders';
  }

  _cancelEntryOrder(w, sideName, reason) {
    const tranche = w.sides[sideName].tranches[0];
    const order = tranche.entryOrder;
    if (!order || !isLivePaperOrder(order.status)) return false;
    const remaining = Math.max(0, order.remainingShares);
    order.cancelledShares = remaining;
    order.unfilledShares = remaining;
    order.remainingShares = 0;
    order.status = reason === 'OPPOSITE_FILLED' ? 'cancelled_opposite' : 'cancelled_window';
    tranche.state = tranche.position && tranche.position.openShares > EPSILON
      ? 'in_position' : 'done_for_window';
    this._push({
      event: 'ENTRY_LIMIT_CANCELLED', slug: w.slug, side: sideName,
      orderId: order.id, reason, cancelledShares: round(remaining, 5),
      note: reason === 'OPPOSITE_FILLED'
        ? 'The other outcome received the first fill; this unfilled paper order was cancelled.'
        : 'Unfilled paper limit shares were cancelled at the five-minute window close.',
    });
    return true;
  }

  _applyEntryFill(w, sideName, fills, now, order, source) {
    if (!fills.length || w.closed || (w.entryWinnerSide && w.entryWinnerSide !== sideName)) return false;
    const tranche = w.sides[sideName].tranches[0];
    const tokenId = order.tokenId;
    let filled = 0;
    let notional = 0;
    let fees = 0;
    for (const fill of fills) {
      const price = Number(fill.price);
      const desired = Number(fill.shares);
      if (!Number.isFinite(price) || price <= 0 || price > order.limitPrice + EPSILON
        || !Number.isFinite(desired) || desired <= 0) continue;
      const feePerShare = fill.maker ? 0 : cfg.TAKER_FEE_RATE * price * (1 - price);
      const affordable = Math.max(0, this.cash) / (price + feePerShare);
      const shares = Math.min(desired, order.remainingShares - filled, affordable);
      if (shares <= EPSILON) continue;
      const cost = shares * price;
      const fee = shares * feePerShare;
      filled += shares;
      notional += cost;
      fees += fee;
      order.fills.push({
        price, shares, notional: cost, fee, totalCost: cost + fee,
        maker: !!fill.maker, source: fill.source || source, ts: now,
      });
    }
    if (filled <= EPSILON) return false;

    const totalCost = notional + fees;
    this.cash = Math.max(0, this.cash - totalCost);
    this.stats.estimatedFees += fees;
    order.filledShares += filled;
    order.remainingShares = Math.max(0, order.targetShares - order.filledShares);
    order.unfilledShares = order.remainingShares;
    order.notional += notional;
    order.fees += fees;
    order.totalCost += totalCost;
    order.averagePrice = order.filledShares > EPSILON ? order.notional / order.filledShares : null;
    order.status = order.remainingShares <= EPSILON ? 'filled' : 'partially_filled';

    let position = tranche.position;
    const isFirstFill = !position;
    if (!position) {
      position = {
        id: ++this._positionId,
        slug: w.slug, openTs: w.openTs,
        closeTs: Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS,
        side: sideName, trancheId: tranche.id, cycle: tranche.cycle, tokenId,
        orderId: order.id, entryBudgetUsd: 0, entryNotional: 0, entryFee: 0,
        entryPrice: null, shares: 0, openShares: 0, remainingEntryCost: 0,
        takeProfitPrice: cfg.TAKE_PROFIT_BID_USD, takeProfitOrder: null,
        makerFeeEquivalent: 0, estimatedMakerRebate: 0,
        exitProceeds: 0, exitFees: 0, netExitProceeds: 0, realizedPnl: 0,
        clobExitProceeds: 0, clobExitShares: 0, lastClobExitPrice: null,
        lastMark: this._quoteFor(sideName, w)?.bid ?? order.averagePrice,
        resolutionOutcome: null, resolutionPricePerShare: null,
        openedAt: now, closedAt: null, status: 'open', finalized: false,
      };
      tranche.position = position;
      position.takeProfitOrder = this._newTakeProfitOrder(position, 0, now);
      this.pending.push(position);
      this.stats.entries += 1;
    }
    position.shares += filled;
    position.openShares += filled;
    position.entryNotional += notional;
    position.entryFee += fees;
    position.entryBudgetUsd += totalCost;
    position.remainingEntryCost += totalCost;
    position.entryPrice = position.shares > EPSILON ? position.entryNotional / position.shares : null;
    position.status = 'open';
    position.lastMark = this._quoteFor(sideName, w)?.bid ?? position.lastMark ?? position.entryPrice;
    if (position.takeProfitOrder.status === 'filled'
      || position.takeProfitOrder.status === 'cancelled') {
      position.takeProfitOrder.status = 'waiting_to_post';
      position.takeProfitOrder.placedAt = now;
      position.takeProfitOrder.restingAt = null;
    }
    position.takeProfitOrder.targetShares += filled;
    position.takeProfitOrder.remainingShares += filled;
    if (!this.pending.includes(position)) this.pending.push(position);

    if (w.entryWinnerSide == null) {
      w.entryWinnerSide = sideName;
      const otherSide = sideName === 'UP' ? 'DOWN' : 'UP';
      this._cancelEntryOrder(w, otherSide, 'OPPOSITE_FILLED');
      this._push({
        event: 'FIRST_SIDE_FILLED', slug: w.slug, side: sideName,
        orderId: order.id, oppositeSide: otherSide,
        note: 'This is the only eligible position for the window; the opposite limit order is cancelled.',
      });
    }
    tranche.state = order.remainingShares > EPSILON ? 'partially_filled' : 'in_position';
    w.status = 'position_open';
    this._activatePostOnlyOrders(w, sideName, now);
    this._push({
      event: source === 'CROSSING_ASK' ? 'ENTRY_LIMIT_TAKER_FILL' : 'ENTRY_LIMIT_MAKER_FILL',
      slug: w.slug, side: sideName, orderId: order.id,
      orderType: order.orderType, fillSource: source,
      fillShares: round(filled, 5), cumulativeShares: round(order.filledShares, 5),
      remainingShares: round(order.remainingShares, 5),
      fillNotional: round(notional, 5), takerFee: round(fees, 6),
      averagePrice: round(order.averagePrice, 5), limitPrice: order.limitPrice,
      note: source === 'CROSSING_ASK'
        ? 'A limit order was marketable at modeled arrival; only visible asks at or below $0.30 filled and taker fees were applied.'
        : 'A resting paper limit filled from an eligible public SELL print, subject to estimated visible queue ahead; no maker fee is modeled.',
    });
    return isFirstFill || filled > EPSILON;
  }

  _fillMakerEntry(w, sideName, tranche, trade, tradeAt, now, tradePrice, tradeSize) {
    const order = tranche.entryOrder;
    if (!order || !['resting', 'partially_filled'].includes(order.status)
      || !isLivePaperOrder(order.status) || tradeAt < Number(order.restingAt || 0)
      || tradePrice > order.limitPrice + EPSILON
      || !order.queueInitialized
      || (w.entryWinnerSide && w.entryWinnerSide !== sideName)) return false;
    if (!markTradeSeen(order, trade, tradeAt, tradePrice, tradeSize, 'SELL')) return false;
    let eligibleSize = tradeSize;
    if (Math.abs(tradePrice - order.limitPrice) <= EPSILON && order.queueAheadShares > EPSILON) {
      const consumed = Math.min(eligibleSize, order.queueAheadShares);
      order.queueAheadShares = Math.max(0, order.queueAheadShares - consumed);
      eligibleSize -= consumed;
    }
    const fillable = Math.min(order.remainingShares, eligibleSize,
      Math.max(0, this.cash) / order.limitPrice);
    if (fillable <= EPSILON) return false;
    return this._applyEntryFill(w, sideName, [{
      price: order.limitPrice, shares: fillable, maker: true, source: 'PUBLIC_SELL_PRINT',
    }], now, order, 'PUBLIC_SELL_PRINT');
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
        (tokenId, trade) => this._onTrade(w.slug, tokenId, trade),
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
    const fetchedAt = Date.now();
    for (let index = 0; index < tokenIds.length; index += 1) {
      if (results[index].status === 'fulfilled') {
        this._booksByToken.set(tokenIds[index], { book: results[index].value, ts: fetchedAt });
      }
    }
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
      bidTs: hasBid ? (validPrice(update.bid) == null ? null : now) : previous.bidTs,
      askTs: hasAsk ? now : previous.askTs,
    };
    next.mid = next.bid == null || next.ask == null ? null : (next.bid + next.ask) / 2;
    this._quotesByToken.set(tokenId, next);
    if (typeof this.trader.updateQuote === 'function') this.trader.updateQuote(tokenId, next);

    const up = this._quotesByToken.get(w.window.tokenUp) || emptyQuote();
    const down = this._quotesByToken.get(w.window.tokenDown) || emptyQuote();
    this.prices = { slug, ts: now, up: { ...up }, down: { ...down } };
    if (next.bid != null && Number.isFinite(Number(next.bidTs))) {
      const closeMs = windowCloseMs(w);
      const sample = { bid: next.bid, ts: Number(next.bidTs) };
      w.lastClobQuoteBySide[sideName] = sample;
      if (sample.ts >= closeMs - CLOSE_SAMPLE_SECONDS * 1000 && sample.ts < closeMs) {
        w.finalThreeSecondQuoteBySide[sideName] = sample;
      }
    }
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

    this._activatePostOnlyOrders(w, sideName, now);
    if (source === 'rest') this._processEntryBooks(w, now);
    this._markPositions(w, now);
    this._recordEquity(now);
  }

  _activatePostOnlyOrders(w, sideName, now = Date.now()) {
    if (!w || w !== this.w || !w.window || w.closed) return;
    const tranche = w.sides[sideName].tranches[0];
    const quote = this._quoteFor(sideName, w);
    if (!quote) return;
    const fresh = (ts) => Number.isFinite(Number(ts))
      && Number(ts) <= now && now - Number(ts) <= cfg.PRICE_STALE_MS;

    const position = tranche.position;
    const takeProfitOrder = position && position.takeProfitOrder;
    if (takeProfitOrder && ['waiting_to_post', 'posting'].includes(takeProfitOrder.status)
      && quote.bid != null && fresh(quote.bidTs)) {
      if (quote.bid < takeProfitOrder.limitPrice - EPSILON) {
        if (takeProfitOrder.status === 'waiting_to_post') {
          takeProfitOrder.status = 'posting';
          takeProfitOrder.restingAt = now + cfg.PAPER_ORDER_LATENCY_MS;
          takeProfitOrder.lastPostOnlyState = 'posting';
          this._push({
            event: 'TAKE_PROFIT_LIMIT_POSTING', slug: w.slug, side: sideName,
            orderId: takeProfitOrder.id, limitPrice: takeProfitOrder.limitPrice,
            remainingShares: round(takeProfitOrder.remainingShares, 5),
            bestBid: quote.bid, modeledLatencyMs: cfg.PAPER_ORDER_LATENCY_MS,
            note: 'Quote is non-crossing; paper take-profit is modeled as reaching the book after the configured latency.',
          });
        } else if (now >= takeProfitOrder.restingAt) {
          takeProfitOrder.status = 'resting';
          takeProfitOrder.lastPostOnlyState = 'resting';
          this._push({
            event: 'TAKE_PROFIT_LIMIT_POSTED', slug: w.slug, side: sideName,
            orderId: takeProfitOrder.id, limitPrice: takeProfitOrder.limitPrice,
            remainingShares: round(takeProfitOrder.remainingShares, 5),
            bestBid: quote.bid,
            note: 'Post-only paper take-profit is now modeled as resting above the best bid; it can fill only on a later opposing BUY trade print.',
          });
        }
      } else if (takeProfitOrder.status === 'posting') {
        takeProfitOrder.status = 'waiting_to_post';
        takeProfitOrder.restingAt = null;
        takeProfitOrder.lastPostOnlyState = 'marketable';
        this._push({
          event: 'TAKE_PROFIT_POST_ONLY_REJECTED', slug: w.slug, side: sideName,
          orderId: takeProfitOrder.id, limitPrice: takeProfitOrder.limitPrice,
          bestBid: quote.bid,
          note: 'The bid crossed the sell limit before modeled book arrival; post-only order rejected and will wait for a non-crossing quote.',
        });
      } else if (takeProfitOrder.lastPostOnlyState !== 'marketable') {
        takeProfitOrder.lastPostOnlyState = 'marketable';
        this._push({
          event: 'TAKE_PROFIT_WAITING_POST_ONLY', slug: w.slug, side: sideName,
          orderId: takeProfitOrder.id, limitPrice: takeProfitOrder.limitPrice,
          bestBid: quote.bid,
          note: 'Best bid is at or above the sell limit, so a post-only order would cross; it waits for a non-crossing quote.',
        });
      }
    }
  }

  _onTrade(slug, tokenId, trade) {
    const w = this.w;
    if (!w || w.slug !== slug || !w.window || w.closed || !trade) return false;
    const now = Date.now();
    if (now >= windowCloseMs(w)) return false;
    const sideName = tokenId === w.window.tokenUp ? 'UP'
      : tokenId === w.window.tokenDown ? 'DOWN' : null;
    const tradeSide = String(trade.side || '').toUpperCase();
    const price = validPrice(trade.price);
    const size = positive(trade.size);
    if (!sideName || !['BUY', 'SELL'].includes(tradeSide) || price == null || size == null) return false;
    const tradeAt = normalizeTradeTimestamp(trade.timestamp, now);
    if (tradeAt > now + 5000) return false;

    const tranche = w.sides[sideName].tranches[0];
    this._processEntryBooks(w, now);
    this._activatePostOnlyOrders(w, sideName, now);
    const filled = tradeSide === 'BUY'
      ? this._fillMakerTakeProfit(w, sideName, tranche, trade, tradeAt, now, price, size)
      : this._fillMakerEntry(w, sideName, tranche, trade, tradeAt, now, price, size);
    if (filled) this._recordEquity(now);
    return filled;
  }

  _newTakeProfitOrder(position, shares, now) {
    return {
      id: 'paper-tp-' + (++this._exitOrderId),
      tokenId: position.tokenId, side: 'SELL',
      limitPrice: cfg.TAKE_PROFIT_BID_USD,
      targetShares: shares, remainingShares: shares,
      status: 'waiting_to_post', placedAt: now, restingAt: null,
      seenTradeKeys: {},
    };
  }

  _fillMakerTakeProfit(w, sideName, tranche, trade, tradeAt, now, tradePrice, tradeSize) {
    const position = tranche.position;
    const order = position && position.takeProfitOrder;
    if (!position || position.openShares <= EPSILON || !order || order.status !== 'resting'
      || tradeAt < Number(order.restingAt || 0)
      || tradePrice + EPSILON < order.limitPrice) return false;
    if (!markTradeSeen(order, trade, tradeAt, tradePrice, tradeSize, 'BUY')) return false;

    const sold = Math.min(position.openShares, order.remainingShares, tradeSize);
    if (sold <= EPSILON) return false;
    // The requested paper convention credits $1/share when the $0.99 TP prints.
    const averageExit = 1;
    const proceeds = sold * averageExit;
    const fee = 0;
    const entryCostAllocated = position.openShares > EPSILON
      ? position.remainingEntryCost * (sold / position.openShares) : 0;
    position.openShares = Math.max(0, position.openShares - sold);
    position.remainingEntryCost = Math.max(0, position.remainingEntryCost - entryCostAllocated);
    order.remainingShares = Math.max(0, order.remainingShares - sold);
    position.exitProceeds += proceeds;
    position.exitFees += fee;
    position.netExitProceeds += proceeds;
    position.clobExitProceeds += proceeds;
    position.clobExitShares += sold;
    const realizedDelta = proceeds - entryCostAllocated;
    position.realizedPnl += realizedDelta;
    this.stats.realizedPnl += realizedDelta;
    position.lastExitPrice = averageExit;
    position.lastClobExitPrice = averageExit;
    position.lastMark = position.openShares > EPSILON
      ? this._quoteFor(sideName, w)?.bid ?? averageExit : averageExit;
    this.cash += proceeds;
    const rebate = this._accrueMakerRebate(position, sold, order.limitPrice);
    this.stats.exits += 1;
    if (order.remainingShares <= EPSILON) {
      order.remainingShares = 0;
      order.status = 'filled';
    }

    this._push({
      event: position.openShares <= EPSILON ? 'TAKE_PROFIT_LIMIT_FILLED' : 'TAKE_PROFIT_LIMIT_PARTIAL',
      slug: w.slug, side: sideName, tranche: position.trancheId,
      orderId: order.id, sharesSold: round(sold, 5),
      remainingShares: round(position.openShares, 5),
      limitPrice: order.limitPrice, avgExit: round(averageExit, 4),
      tradePrintPrice: tradePrice, proceeds: round(proceeds, 4), fee,
      makerFeeEquivalent: round(rebate.feeEquivalent, 6),
      rebateEstimate: round(rebate.estimate, 6),
      realizedPnl: round(position.realizedPnl, 2),
      note: 'A later public BUY print reached the $'
        + order.limitPrice.toFixed(2) + ' TP. Paper proceeds use the requested $1.00/share convention; no maker fee is charged and queue position is estimated.',
    });

    if (position.openShares <= EPSILON) {
      position.openShares = 0;
      if (tranche.entryOrder && isLivePaperOrder(tranche.entryOrder.status)) {
        position.status = 'entry_order_open';
        this.pending = this.pending.filter((item) => item !== position);
        tranche.state = tranche.entryOrder.status === 'waiting_to_post'
          ? 'post_only_waiting' : 'limit_order_open';
      } else {
        position.closedAt = now;
        position.status = 'closed';
        tranche.position = null;
        tranche.state = 'done_for_window';
        this._finalizeTrade(position, 'TAKE_PROFIT');
      }
    } else {
      position.status = 'tp_partial';
    }
    this._recordEquity(now);
    return true;
  }

  _accrueMakerRebate(position, shares, price) {
    const feeEquivalent = shares * cfg.REBATE_FEE_EQUIVALENT_RATE * price * (1 - price);
    const estimate = feeEquivalent * cfg.MAKER_REBATE_RATE;
    position.makerFeeEquivalent = (position.makerFeeEquivalent || 0) + feeEquivalent;
    position.estimatedMakerRebate = (position.estimatedMakerRebate || 0) + estimate;
    this.stats.makerFeeEquivalent += feeEquivalent;
    this.stats.estimatedMakerRebate += estimate;
    return { feeEquivalent, estimate };
  }

  async _finishWindow(w, now, event) {
    if (!w || w.closed) return;
    for (const sideName of SIDES) {
      const tranche = w.sides[sideName].tranches[0];
      this._cancelEntryOrder(w, sideName, 'WINDOW_CLOSE');
      const takeProfitOrder = tranche.position && tranche.position.takeProfitOrder;
      if (takeProfitOrder && isLivePaperOrder(takeProfitOrder.status)) {
        takeProfitOrder.status = 'cancelled';
        this._push({
          event: 'TAKE_PROFIT_LIMIT_CANCELLED', slug: w.slug, side: sideName,
          orderId: takeProfitOrder.id,
          remainingShares: round(takeProfitOrder.remainingShares, 5),
          note: 'Unfilled post-only take-profit remainder cancelled at window close before paper settlement.',
        });
      }
      if (tranche.position && tranche.position.openShares <= EPSILON) {
        const position = tranche.position;
        tranche.position = null;
        tranche.state = 'done_for_window';
        position.status = 'closed';
        position.closedAt = now;
        this._finalizeTrade(position, 'POSITION_COMPLETE');
      }
      if (!tranche.position && tranche.state !== 'done_for_window') {
        tranche.state = 'done_for_window';
      }
    }
    w.closed = true;
    w.closedAt = now;
    w.status = 'window_closed';
    if (this._positionsForWindow(w).length) this._settleClobClose(w, now);
    this._push({
      event: 'WINDOW_CLOSED', slug: w.slug,
      note: event + ': post-only orders are cancelled; remaining shares were finalized from CLOB bids using the paper close-price rule. No forced sale or stop loss is used.',
    });
    if (this._marketFeedSlug === w.slug) this._stopMarketFeed();
  }

  _settleClobClose(w, now) {
    const positions = this._positionsForWindow(w);
    if (!positions.length) return null;

    const closeMs = windowCloseMs(w);
    const closeQuotes = Object.fromEntries(SIDES.map((side) => {
      const finalQuote = w.finalThreeSecondQuoteBySide[side];
      const fallbackQuote = w.lastClobQuoteBySide[side];
      return [side, finalQuote || fallbackQuote || null];
    }));
    const usedFinal = SIDES.map((side) => !!w.finalThreeSecondQuoteBySide[side]);
    const source = usedFinal.every(Boolean) ? 'FINAL_3_SECONDS'
      : usedFinal.some(Boolean) ? 'FINAL_3_SECONDS_WITH_LAST_WINDOW_FALLBACK'
        : 'LAST_WINDOW_QUOTE';
    const bids = Object.fromEntries(SIDES.map((side) => [
      side, closeQuotes[side] ? Number(closeQuotes[side].bid) : null,
    ]));
    const aboveThreshold = SIDES.filter((side) => bids[side] != null
      && bids[side] > CLOSE_WINNER_THRESHOLD);
    let winner;
    let tieBreak = null;

    if (aboveThreshold.length === 1) {
      winner = aboveThreshold[0];
    } else {
      const upBid = bids.UP == null ? -1 : bids.UP;
      const downBid = bids.DOWN == null ? -1 : bids.DOWN;
      if (upBid > downBid) winner = 'UP';
      else if (downBid > upBid) winner = 'DOWN';
      else {
        const upTs = closeQuotes.UP ? Number(closeQuotes.UP.ts) : -1;
        const downTs = closeQuotes.DOWN ? Number(closeQuotes.DOWN.ts) : -1;
        if (upTs > downTs) {
          winner = 'UP';
          tieBreak = 'FRESHEST_QUOTE';
        } else if (downTs > upTs) {
          winner = 'DOWN';
          tieBreak = 'FRESHEST_QUOTE';
        } else {
          winner = 'UP';
          tieBreak = 'DETERMINISTIC_UP_FALLBACK';
        }
      }
    }

    const thresholdMatched = aboveThreshold.includes(winner);
    const resolution = w.closeResolution = {
      method: 'CLOB_CLOSE_PRICE',
      winner,
      loser: winner === 'UP' ? 'DOWN' : 'UP',
      bids,
      quoteTimestamps: Object.fromEntries(SIDES.map((side) => [
        side, closeQuotes[side] ? closeQuotes[side].ts : null,
      ])),
      source,
      threshold: CLOSE_WINNER_THRESHOLD,
      thresholdMatched,
      tieBreak,
      decidedAt: now,
      windowCloseAt: closeMs,
      note: 'Internal paper classification from Polymarket CLOB best bids; not Polymarket official settlement.',
    };
    w.status = 'window_closed';

    for (const position of positions) {
      const payoutPerShare = position.side === winner ? 1 : 0;
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
      position.resolutionOutcome = winner;
      position.resolutionPricePerShare = payoutPerShare;
      position.settlementMethod = 'CLOB_CLOSE_PRICE';
      position.settlementSource = source;
      position.settlementBid = bids[position.side];
      position.settlementBidUp = bids.UP;
      position.settlementBidDown = bids.DOWN;
      position.settlementThresholdMatched = thresholdMatched;
      this.cash += payout;
      this.stats.realizedPnl += realizedDelta;
      this.stats.settlements += 1;

      const tranche = this._trancheFor(position);
      if (tranche && tranche.position === position) {
        tranche.position = null;
        tranche.state = 'settled';
      }

      this._push({
        event: 'POSITION_SETTLED_CLOB_CLOSE', slug: w.slug, side: position.side,
        tranche: position.trancheId, cycle: position.cycle,
        outcome: winner, payoutPerShare,
        sharesSettled: round(sharesSettled, 5), payout: round(payout, 4),
        closeBidUp: bids.UP, closeBidDown: bids.DOWN, quoteSource: source,
        threshold: CLOSE_WINNER_THRESHOLD, thresholdMatched, tieBreak,
        realizedPnl: round(position.realizedPnl, 2),
        note: 'Paper close-price outcome booked at $' + payoutPerShare.toFixed(2)
          + ' per remaining share. This is not official Polymarket settlement.',
      });
      this._finalizeTrade(position, 'CLOB_CLOSE_PRICE');
    }
    this._recordEquity(now);
    this._push({
      event: 'WINDOW_CLOB_CLOSE_CLASSIFIED', slug: w.slug,
      outcome: winner, closeBidUp: bids.UP, closeBidDown: bids.DOWN,
      quoteSource: source, threshold: CLOSE_WINNER_THRESHOLD,
      thresholdMatched, tieBreak,
      note: w.closeResolution.note,
    });
    return w.closeResolution;
  }

  _finalizeTrade(position, reason) {
    if (!position || position.finalized) return;
    position.finalized = true;
    const pnl = position.realizedPnl;
    this._recordTradeResult(position, pnl);
    if (pnl > EPSILON) this.stats.wins += 1;
    else if (pnl < -EPSILON) this.stats.losses += 1;
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
      makerFeeEquivalent: round(position.makerFeeEquivalent || 0, 6),
      estimatedMakerRebate: round(position.estimatedMakerRebate || 0, 6),
      resolutionOutcome: position.resolutionOutcome || null,
      resolutionPricePerShare: position.resolutionPricePerShare ?? null,
      settlementMethod: position.settlementMethod || null,
      settlementSource: position.settlementSource || null,
      settlementBidUp: position.settlementBidUp ?? null,
      settlementBidDown: position.settlementBidDown ?? null,
      settlementThresholdMatched: position.settlementThresholdMatched ?? null,
      pnl: round(pnl, 2), reason,
      lossStreakAfter: this.lossStreak,
      nextShares: round(this._sharesForNextTrade(), 4),
      ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    this._push({
      event: 'TRADE_CLOSED', slug: position.slug, side: position.side,
      tranche: position.trancheId, pnl: round(pnl, 2), reason,
      estimatedMakerRebate: round(position.estimatedMakerRebate || 0, 6),
      lossStreak: this.lossStreak,
      nextShares: round(this._sharesForNextTrade(), 4),
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
      closeSettlement: 'CLOB_CLOSE_PRICE_PAPER',
      note: 'CLOB-only demo loop is active; close outcomes use a CLOB price proxy, not official settlement. No live-order client is used.',
    });
  }

  snapshot() {
    const now = Date.now();
    this._recordEquity(now);
    const valuation = this._accountValuation();
    const w = this.w;
    const window = w ? {
      slug: w.slug, status: w.status, openTs: w.openTs,
      entryOrdersPlacedAt: w.entryOrdersPlacedAt || null,
      entryWinnerSide: w.entryWinnerSide || null,
      targetShares: round(w.targetShares, 4),
      entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
      closeTs: Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS,
      secondsRemaining: Math.max(0, ((Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000 - now) / 1000),
      closed: w.closed,
      closeResolution: w.closeResolution || null,
      sides: Object.fromEntries(SIDES.map((name) => {
        const side = w.sides[name];
        return [name, {
          lossStreak: this.lossStreak,
          nextShares: round(this._sharesForNextTrade(), 4),
          quote: this._quoteFor(name, w),
          tranches: side.tranches.map((tranche) => ({
            id: tranche.id, entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
            targetShares: round(tranche.targetShares, 4),
            state: tranche.state, cycle: tranche.cycle,
            entryOrder: tranche.entryOrder ? {
              id: tranche.entryOrder.id, status: tranche.entryOrder.status,
              orderType: tranche.entryOrder.orderType,
              limitPrice: tranche.entryOrder.limitPrice,
              averagePrice: round(tranche.entryOrder.averagePrice, 5),
              targetShares: round(tranche.entryOrder.targetShares, 4),
              filledShares: round(tranche.entryOrder.filledShares, 4),
              unfilledShares: round(tranche.entryOrder.unfilledShares, 4),
              cancelledShares: round(tranche.entryOrder.cancelledShares, 4),
              totalCost: round(tranche.entryOrder.totalCost, 4),
              fees: round(tranche.entryOrder.fees, 6),
              reservedUsd: round(tranche.entryOrder.reservedUsd, 2),
              limitingFactor: tranche.entryOrder.limitingFactor,
              fills: tranche.entryOrder.fills,
            } : null,
            position: tranche.position ? {
              id: tranche.position.id, entryPrice: tranche.position.entryPrice,
              takeProfitPrice: tranche.position.takeProfitPrice,
              shares: tranche.position.shares, openShares: tranche.position.openShares,
              makerFeeEquivalent: round(tranche.position.makerFeeEquivalent || 0, 6),
              estimatedMakerRebate: round(tranche.position.estimatedMakerRebate || 0, 6),
              takeProfitOrder: tranche.position.takeProfitOrder ? {
                id: tranche.position.takeProfitOrder.id,
                status: tranche.position.takeProfitOrder.status,
                limitPrice: tranche.position.takeProfitOrder.limitPrice,
                remainingShares: round(tranche.position.takeProfitOrder.remainingShares, 5),
              } : null,
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
        reservedCash: 0,
        availableCash: round(Math.max(0, this.cash), 2),
        openValue: round(valuation.openValue, 2),
        equity: valuation.equity == null ? null : round(valuation.equity, 2),
        totalPnl: valuation.totalPnl == null ? null : round(valuation.totalPnl, 2),
        unrealizedPnl: round(valuation.unrealizedPnl, 2),
        makerFeeEquivalent: round(this.stats.makerFeeEquivalent, 6),
        estimatedMakerRebate: round(this.stats.estimatedMakerRebate, 6),
        rebateIncludedInEquity: false,
        unresolvedPositions: valuation.unresolvedPositions.length,
        unresolvedShares: round(valuation.unresolvedShares, 5),
        unresolvedEntryCost: round(valuation.unresolvedEntryCost, 2),
        maxDrawdown: valuation.unresolvedPositions.length ? null : round(this.maxDrawdown, 2),
      },
      strategy: {
        demoCapital: cfg.DEMO_CAPITAL, sharedCapital: true,
        baseShares: cfg.BASE_SHARES,
        entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
        entryPriceCap: cfg.ENTRY_LIMIT_PRICE_USD,
        entryOrderLatencyMs: cfg.ENTRY_ORDER_LATENCY_MS,
        firstFillCancelsOpposite: true,
        takeProfitBid: cfg.TAKE_PROFIT_BID_USD, hardStopLossBid: null,
        takeProfitCreditPerShare: 1,
        entryOrderType: 'LIMIT', takeProfitOrderType: 'POST_ONLY',
        takerFeeRate: cfg.TAKER_FEE_RATE,
        takeProfitMakerFeesCharged: 0, makerRebateRate: cfg.MAKER_REBATE_RATE,
        rebateEstimateIsCash: false,
        takeProfitPaperOrderLatencyMs: cfg.PAPER_ORDER_LATENCY_MS,
        martingaleMultiplier: cfg.MARTINGALE_MULTIPLIER,
        settlementMethod: 'CLOB_CLOSE_PRICE',
        settlementCloseSampleSeconds: CLOSE_SAMPLE_SECONDS,
        settlementWinnerThreshold: CLOSE_WINNER_THRESHOLD,
        settlementFallback: 'HIGHER_BID_THEN_FRESHEST_THEN_UP',
      },
      martingale: {
        independent: false,
        scope: 'SHARED_ONE_TRADE_PER_WINDOW',
        lossStreak: this.lossStreak,
        nextShares: round(this._sharesForNextTrade(), 4),
        UP: { lossStreak: this.lossStreak, nextShares: round(this._sharesForNextTrade(), 4) },
        DOWN: { lossStreak: this.lossStreak, nextShares: round(this._sharesForNextTrade(), 4) },
      },
      window, prices: this.prices, priceSeries: this.priceSeries,
      pending: this.pending.map((position) => this._positionSnapshot(position)),
      trades: this.trades.slice(-60).reverse(),
      stats: {
        ...this.stats,
        makerFeeEquivalent: round(this.stats.makerFeeEquivalent, 6),
        estimatedMakerRebate: round(this.stats.estimatedMakerRebate, 6),
      },
      equity: this.equity,
      cfg: {
        demoCapital: this.capital, baseShares: cfg.BASE_SHARES,
        entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
        entryOrderLatencyMs: cfg.ENTRY_ORDER_LATENCY_MS,
        firstFillCancelsOpposite: true,
        entryPriceCap: cfg.ENTRY_LIMIT_PRICE_USD, takerFeeRate: cfg.TAKER_FEE_RATE,
        takeProfitBid: cfg.TAKE_PROFIT_BID_USD,
        takeProfitCreditPerShare: 1,
        takeProfitMakerFeesCharged: 0, makerRebateRate: cfg.MAKER_REBATE_RATE,
        rebateFeeEquivalentRate: cfg.REBATE_FEE_EQUIVALENT_RATE,
        takeProfitPaperOrderLatencyMs: cfg.PAPER_ORDER_LATENCY_MS,
        hardStopLossBid: null,
        martingaleMultiplier: cfg.MARTINGALE_MULTIPLIER,
        windowSec: WINDOW_SECONDS,
      },
      log: this.log.slice(-100).reverse(),
    };
  }

  _positionSnapshot(position) {
    const mark = Number.isFinite(Number(position.lastMark))
      ? Number(position.lastMark) : position.entryPrice;
    const costBasis = Number(position.remainingEntryCost) || 0;
    const takeProfitOrder = position.takeProfitOrder ? {
      id: position.takeProfitOrder.id,
      side: position.takeProfitOrder.side,
      limitPrice: position.takeProfitOrder.limitPrice,
      targetShares: position.takeProfitOrder.targetShares,
      remainingShares: position.takeProfitOrder.remainingShares,
      status: position.takeProfitOrder.status,
      placedAt: position.takeProfitOrder.placedAt,
      restingAt: position.takeProfitOrder.restingAt,
    } : null;
    return {
      ...position, takeProfitOrder, mark,
      unrealized: position.openShares * mark - costBasis,
    };
  }
}

function makeWindowState(slug, openTs) {
  return {
    slug, openTs, status: 'waiting_for_market', window: null,
    marketWaitReason: null, nextDiscoveryAt: 0,
    entryOrdersPlacedAt: null, entryWinnerSide: null, targetShares: null,
    closed: false, closedAt: null,
    lastClobQuoteBySide: { UP: null, DOWN: null },
    finalThreeSecondQuoteBySide: { UP: null, DOWN: null },
    closeResolution: null,
    sides: {
      UP: makeSide('UP'),
      DOWN: makeSide('DOWN'),
    },
  };
}

function makeSide(name) {
  return {
    name,
    tranches: [makeTranche('SINGLE')],
  };
}

function makeTranche(id) {
  return {
    id, targetShares: null,
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

function estimateMakerRebate(shares, price) {
  const quantity = Number(shares);
  const fillPrice = Number(price);
  if (!Number.isFinite(quantity) || !Number.isFinite(fillPrice) || quantity <= 0 || fillPrice <= 0 || fillPrice >= 1) return 0;
  return quantity * fillPrice * (1 - fillPrice)
    * cfg.REBATE_FEE_EQUIVALENT_RATE * cfg.MAKER_REBATE_RATE;
}

function isLivePaperOrder(status) {
  return status === 'waiting_to_post' || status === 'posting'
    || status === 'resting' || status === 'partially_filled';
}

function normalizeTradeTimestamp(value, fallback) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function markTradeSeen(order, trade, tradeAt, price, size, side) {
  if (!order.seenTradeKeys) order.seenTradeKeys = {};
  const key = [
    trade.transactionHash || trade.transaction_hash || '',
    tradeAt, side, price, size,
  ].join('|');
  if (order.seenTradeKeys[key]) return false;
  order.seenTradeKeys[key] = true;
  const keys = Object.keys(order.seenTradeKeys);
  if (keys.length > 200) {
    for (const oldKey of keys.slice(0, keys.length - 150)) delete order.seenTradeKeys[oldKey];
  }
  return true;
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
module.exports.estimateMakerRebate = estimateMakerRebate;
module.exports.normalizeTradeTimestamp = normalizeTradeTimestamp;
module.exports.quoteFromBook = quoteFromBook;
