'use strict';

const cfg = require('./config');
const {
  getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');

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
    this._lastHeartbeatAt = 0;
    this._running = false;
    this._warned = new Set();
    this._positionId = 0;
    this.lossStreak = { UP: 0, DOWN: 0 };
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
          note: 'Market tokens found; independent $0.45 post-only paper bids are reserved and waiting for non-crossing quotes.',
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
      return total + (order && isLivePaperOrder(order.status) ? order.reservedUsd : 0);
    }, 0);
  }

  _reserveForShares(shares) {
    return shares * cfg.ENTRY_LIMIT_PRICE_USD;
  }

  _placeEntryOrders(w) {
    if (!w || w !== this.w || !w.window || w.closed || this.strategyBlocked) return;
    const priority = Math.floor(w.openTs / WINDOW_SECONDS) % 2 === 0
      ? ['UP', 'DOWN'] : ['DOWN', 'UP'];
    for (const sideName of priority) {
      const tranche = w.sides[sideName].tranches[0];
      if (tranche.entryOrder && isLivePaperOrder(tranche.entryOrder.status)) continue;
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
        reservedUsd: reserve, status: 'waiting_to_post', placedAt: Date.now(),
        restingAt: null, seenTradeKeys: {},
      };
      tranche.entryOrder = order;
      tranche.targetShares = targetShares;
      tranche.initialBudgetUsd = targetShares * cfg.ENTRY_LIMIT_PRICE_USD;
      tranche.availableUsd = reserve;
      tranche.state = 'post_only_waiting';
      this._push({
        event: 'ENTRY_LIMIT_PLACED', slug: w.slug, side: sideName,
        orderId: order.id, limitPrice: order.limitPrice,
        targetShares: round(targetShares, 4),
        reservedUsd: round(reserve, 2), lossStreak: this.lossStreak[sideName],
        note: 'Reserved a post-only demo buy at $' + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2)
          + '; it becomes resting only when the best ask is above the limit.',
      });
      this._activatePostOnlyOrders(w, sideName, Date.now());
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

    const entryOrder = tranche.entryOrder;
    if (entryOrder && ['waiting_to_post', 'posting'].includes(entryOrder.status)
      && quote.ask != null && fresh(quote.askTs)) {
      if (quote.ask > entryOrder.limitPrice + EPSILON) {
        if (entryOrder.status === 'waiting_to_post') {
          entryOrder.status = 'posting';
          entryOrder.restingAt = now + cfg.PAPER_ORDER_LATENCY_MS;
          entryOrder.lastPostOnlyState = 'posting';
          this._push({
            event: 'ENTRY_LIMIT_POSTING', slug: w.slug, side: sideName,
            orderId: entryOrder.id, limitPrice: entryOrder.limitPrice,
            bestAsk: quote.ask, modeledLatencyMs: cfg.PAPER_ORDER_LATENCY_MS,
            note: 'Quote is non-crossing; paper order is modeled as reaching the book after the configured latency.',
          });
        } else if (now >= entryOrder.restingAt) {
          entryOrder.status = 'resting';
          entryOrder.lastPostOnlyState = 'resting';
          tranche.state = tranche.position && tranche.position.openShares > EPSILON
            ? 'partially_filled' : 'limit_order_open';
          this._push({
            event: 'ENTRY_LIMIT_POSTED', slug: w.slug, side: sideName,
            orderId: entryOrder.id, limitPrice: entryOrder.limitPrice,
            bestAsk: quote.ask,
            note: 'Post-only paper buy is now modeled as resting below the best ask; it can fill only on a later opposing SELL trade print.',
          });
        }
      } else if (entryOrder.status === 'posting') {
        entryOrder.status = 'waiting_to_post';
        entryOrder.restingAt = null;
        entryOrder.lastPostOnlyState = 'marketable';
        tranche.state = 'post_only_waiting';
        this._push({
          event: 'ENTRY_POST_ONLY_REJECTED', slug: w.slug, side: sideName,
          orderId: entryOrder.id, limitPrice: entryOrder.limitPrice,
          bestAsk: quote.ask,
          note: 'The ask crossed the buy limit before modeled book arrival; post-only order rejected and will wait for a non-crossing quote.',
        });
      } else if (entryOrder.lastPostOnlyState !== 'marketable') {
        entryOrder.lastPostOnlyState = 'marketable';
        tranche.state = 'post_only_waiting';
        this._push({
          event: 'ENTRY_LIMIT_WAITING_POST_ONLY', slug: w.slug, side: sideName,
          orderId: entryOrder.id, limitPrice: entryOrder.limitPrice,
          bestAsk: quote.ask,
          note: 'Best ask is at or below the buy limit, so a post-only order would cross; no maker order is simulated until the ask moves above the limit.',
        });
      }
    }

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
    this._activatePostOnlyOrders(w, sideName, now);
    let filled = false;
    if (tradeSide === 'SELL') {
      filled = this._fillMakerEntry(w, sideName, tranche, trade, tradeAt, now, price, size) || filled;
    }
    if (tradeSide === 'BUY') {
      filled = this._fillMakerTakeProfit(w, sideName, tranche, trade, tradeAt, now, price, size) || filled;
    }
    if (filled) this._recordEquity(now);
    return filled;
  }

  _fillMakerEntry(w, sideName, tranche, trade, tradeAt, now, tradePrice, tradeSize) {
    const order = tranche.entryOrder;
    if (!order || order.status !== 'resting'
      || tradeAt < Number(order.restingAt || 0)
      || tradePrice > order.limitPrice + EPSILON) return false;
    if (!markTradeSeen(order, trade, tradeAt, tradePrice, tradeSize, 'SELL')) return false;

    const shares = Math.min(order.remainingShares, tradeSize);
    if (shares <= EPSILON) return false;
    const averagePrice = order.limitPrice;
    const notional = shares * averagePrice;
    const fee = 0;
    const cost = notional;
    const nextRemaining = Math.max(0, order.remainingShares - shares);
    const nextReserve = this._reserveForShares(nextRemaining);
    const otherReserved = this._reservedCash() - order.reservedUsd;
    if (this.cash - cost - otherReserved - nextReserve < -EPSILON) {
      this._push({
        event: 'ENTRY_FILL_REJECTED_CAPITAL', slug: w.slug, side: sideName,
        orderId: order.id, shares: round(shares, 5),
        note: 'The maker print would exceed shared demo cash; no fill was recorded.',
      });
      return false;
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
        takeProfitPrice: cfg.TAKE_PROFIT_BID_USD, takeProfitOrder: null,
        makerFeeEquivalent: 0, estimatedMakerRebate: 0,
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
    position.closedAt = null;
    position.lastMark = this._quoteFor(sideName, w)?.bid ?? averagePrice;
    if (!this.pending.includes(position)) this.pending.push(position);
    const rebate = this._accrueMakerRebate(position, shares, averagePrice);
    position.takeProfitOrder = this._newTakeProfitOrder(position, position.openShares, now);
    this._activatePostOnlyOrders(w, sideName, now);

    this.stats.entries += 1;
    w.status = 'position_open';
    tranche.state = order.status === 'filled' ? 'in_position' : 'partially_filled';
    this._push({
      event: 'ENTRY_LIMIT_FILLED', slug: w.slug, side: sideName,
      orderId: order.id, tranche: tranche.id, cycle: tranche.cycle,
      limitPrice: order.limitPrice, avgEntry: round(averagePrice, 4),
      shares: round(shares, 5), totalShares: round(position.shares, 5),
      remainingOrderShares: round(order.remainingShares, 5),
      spentUsd: round(notional, 4), fee,
      tradePrintPrice: tradePrice, tradeSize: tradeSize,
      makerFeeEquivalent: round(rebate.feeEquivalent, 6),
      rebateEstimate: round(rebate.estimate, 6),
      note: 'Filled from a later public SELL trade print; shares are booked exactly at the $'
        + order.limitPrice.toFixed(2) + ' post-only limit with zero fees. Queue position and actual rebate payout are not observable.',
    });
    return true;
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
    const averageExit = order.limitPrice;
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
    const rebate = this._accrueMakerRebate(position, sold, averageExit);
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
      note: 'Filled from a later public BUY trade print at the $'
        + order.limitPrice.toFixed(2) + ' post-only take-profit with zero fees. Queue position and actual rebate payout are not observable.',
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

  _cancelEntryOrder(w, sideName, tranche, reason) {
    const order = tranche.entryOrder;
    if (!order || !isLivePaperOrder(order.status)) return;
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
    for (const sideName of SIDES) {
      const tranche = w.sides[sideName].tranches[0];
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
      estimatedMakerRebate: round(position.estimatedMakerRebate || 0, 6),
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
      closeTs: Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS,
      secondsRemaining: Math.max(0, ((Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000 - now) / 1000),
      closed: w.closed,
      closeResolution: w.closeResolution || null,
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
        reservedCash: round(this._reservedCash(), 2),
        availableCash: round(Math.max(0, this.cash - this._reservedCash()), 2),
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
        baseShares: cfg.BASE_SHARES, entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
        takeProfitBid: cfg.TAKE_PROFIT_BID_USD, hardStopLossBid: null,
        entryOrderType: 'POST_ONLY', takeProfitOrderType: 'POST_ONLY',
        makerFeesCharged: 0, makerRebateRate: cfg.MAKER_REBATE_RATE,
        rebateEstimateIsCash: false,
        paperOrderLatencyMs: cfg.PAPER_ORDER_LATENCY_MS,
        martingaleMultiplier: cfg.MARTINGALE_MULTIPLIER,
        settlementMethod: 'CLOB_CLOSE_PRICE',
        settlementCloseSampleSeconds: CLOSE_SAMPLE_SECONDS,
        settlementWinnerThreshold: CLOSE_WINNER_THRESHOLD,
        settlementFallback: 'HIGHER_BID_THEN_FRESHEST_THEN_UP',
      },
      martingale: {
        independent: true,
        UP: { lossStreak: this.lossStreak.UP, nextShares: round(this._sharesForSide('UP'), 4) },
        DOWN: { lossStreak: this.lossStreak.DOWN, nextShares: round(this._sharesForSide('DOWN'), 4) },
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
        takeProfitBid: cfg.TAKE_PROFIT_BID_USD,
        makerFeesCharged: 0, makerRebateRate: cfg.MAKER_REBATE_RATE,
        rebateFeeEquivalentRate: cfg.REBATE_FEE_EQUIVALENT_RATE,
        paperOrderLatencyMs: cfg.PAPER_ORDER_LATENCY_MS,
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

function estimateMakerRebate(shares, price) {
  const quantity = Number(shares);
  const fillPrice = Number(price);
  if (!Number.isFinite(quantity) || !Number.isFinite(fillPrice) || quantity <= 0 || fillPrice <= 0 || fillPrice >= 1) return 0;
  return quantity * fillPrice * (1 - fillPrice)
    * cfg.REBATE_FEE_EQUIVALENT_RATE * cfg.MAKER_REBATE_RATE;
}

function isLivePaperOrder(status) {
  return status === 'waiting_to_post' || status === 'posting' || status === 'resting';
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
