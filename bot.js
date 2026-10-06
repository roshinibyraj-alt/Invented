'use strict';

const cfg = require('./config');
const {
  getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');

const EPSILON = 1e-8;
const MAX_LOG = 300;
const SIDES = ['UP', 'DOWN'];

class Bot {
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.logger = opts.logger || null;
    this.demoMode = !!(trader && trader.demoMode === true);
    this.strategyBlocked = !this.demoMode;
    this.error = this.strategyBlocked
      ? 'CLOB tranche strategy requires DemoTrader; live execution is removed.' : null;
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
    this.pending = [];
    this.trades = [];
    this.log = [];
    this.stats = {
      entries: 0, exits: 0, wins: 0, losses: 0,
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
      note: 'Demo-only independent UP/DOWN tranches started; prices and books come from Polymarket CLOB.',
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
      this._push({ event: 'WINDOW_STARTED', slug, note: 'New five-minute UP/DOWN window; each side has two independent $250 tranches.' });
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
          note: 'Market tokens found; subscribing to both CLOB books and watching entry asks.',
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
    const sideName = tokenId === w.window.tokenUp ? 'UP'
      : tokenId === w.window.tokenDown ? 'DOWN' : null;
    if (!sideName) return;

    const previous = this._quotesByToken.get(tokenId) || emptyQuote();
    const hasBid = update && Object.prototype.hasOwnProperty.call(update, 'bid');
    const hasAsk = update && Object.prototype.hasOwnProperty.call(update, 'ask');
    const now = Date.now();
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
    const cutoff = closeMs - cfg.FORCED_EXIT_BUFFER_SECONDS * 1000;
    if (now >= closeMs) return;
    if (now >= cutoff) {
      await this._forceExitSide(w, sideName, now);
      return;
    }

    if (!quote) return;
    for (const tranche of side.tranches) {
      if (tranche.position) {
        const position = tranche.position;
        if (quote.bid != null && quote.bid + EPSILON >= position.takeProfitPrice) {
          await this._sellPosition(w, tranche, position, 'TAKE_PROFIT', position.takeProfitPrice, now);
        }
        continue;
      }

      const ask = quote.ask;
      if (ask == null || ask <= 0 || ask > cfg.MAX_ENTRY_ASK_USD + EPSILON) continue;
      if (tranche.state === 'waiting_reentry') {
        if (ask <= tranche.reentryPrice + EPSILON) {
          await this._buyTranche(w, sideName, tranche, ask, true, now);
        }
      } else if (tranche.state === 'waiting_entry' && ask + EPSILON >= tranche.entryTrigger) {
        await this._buyTranche(w, sideName, tranche, ask, false, now);
      }
    }
  }

  async _buyTranche(w, sideName, tranche, triggerAsk, isReentry, now) {
    const budgetUsd = Number(tranche.availableUsd);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= EPSILON) {
      tranche.state = 'no_budget';
      return null;
    }
    const tokenId = sideName === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    const order = await this.trader.placeFakMarketOrder(
      tokenId, 'BUY', budgetUsd, { priceLimit: cfg.MAX_ENTRY_ASK_USD },
    );
    if (w.closed || Date.now() >= windowCloseMs(w) - cfg.FORCED_EXIT_BUFFER_SECONDS * 1000) {
      this._push({
        event: 'ENTRY_IGNORED_CUTOFF', slug: w.slug, side: sideName, tranche: tranche.id,
        note: 'The demo fill returned at or after the forced-exit cutoff; no late entry was recorded.',
      });
      return null;
    }
    const shares = positive(order && order.raw && order.raw.takingAmount);
    const notional = positive(order && order.raw && order.raw.makingAmount);
    if (shares == null || notional == null) {
      this._push({
        event: 'ENTRY_UNFILLED', slug: w.slug, side: sideName, tranche: tranche.id,
        triggerAsk: round(triggerAsk, 4), budgetUsd: round(budgetUsd, 2),
        note: 'No CLOB asks at or below $' + cfg.MAX_ENTRY_ASK_USD.toFixed(2) + ' filled this tranche.',
      });
      return null;
    }

    const averagePrice = positive(order.avgPrice) || notional / shares;
    const fee = estimateTakerFee(shares, averagePrice);
    const cost = notional + fee;
    if (cost > this.cash + EPSILON) {
      this._push({
        event: 'ENTRY_REJECTED_CASH', slug: w.slug, side: sideName, tranche: tranche.id,
        note: 'Simulated fill plus estimated taker fee exceeded the demo account cash.',
      });
      return null;
    }

    this.cash -= cost;
    tranche.availableUsd = Math.max(0, budgetUsd - notional);
    tranche.cycle += 1;
    const position = {
      id: ++this._positionId,
      slug: w.slug, openTs: w.openTs, closeTs: Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS,
      side: sideName, trancheId: tranche.id, cycle: tranche.cycle, tokenId,
      entryBudgetUsd: budgetUsd, entryNotional: notional, entryFee: fee,
      entryPrice: averagePrice, shares, openShares: shares,
      remainingEntryCost: cost, takeProfitPrice: averagePrice + cfg.TAKE_PROFIT_OFFSET_USD,
      takeProfitReachable: averagePrice + cfg.TAKE_PROFIT_OFFSET_USD <= 1 + EPSILON,
      exitProceeds: 0, exitFees: 0, netExitProceeds: 0, realizedPnl: 0,
      lastMark: this._quoteFor(sideName, w)?.bid ?? averagePrice,
      openedAt: now, closedAt: null, status: 'open',
    };
    tranche.position = position;
    tranche.state = 'in_position';
    tranche.reentryPrice = null;
    this.pending.push(position);
    this.stats.entries += 1;
    this.stats.estimatedFees += fee;
    w.status = 'position_open';
    this._push({
      event: isReentry ? 'REENTRY_FILLED' : 'ENTRY_FILLED',
      slug: w.slug, side: sideName, tranche: tranche.id, cycle: tranche.cycle,
      triggerAsk: round(triggerAsk, 4), budgetUsd: round(budgetUsd, 2),
      spentUsd: round(notional, 2), shares: round(shares, 5),
      avgEntry: round(averagePrice, 4), takeProfit: round(position.takeProfitPrice, 4),
      note: (isReentry ? 'Re-entry' : 'Initial entry') + ' filled from the CLOB book at average $'
        + averagePrice.toFixed(4) + '; TP is best bid at $'
        + position.takeProfitPrice.toFixed(4)
        + (position.takeProfitReachable ? '.' : ' and is above the $1 binary-share ceiling; forced exit only.'),
    });
    return position;
  }

  async _sellPosition(w, tranche, position, reason, minimumPrice, now = Date.now()) {
    if (!position || position.openShares <= EPSILON || position.exitPending) return false;
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
          note: 'The simulated exit response arrived after expiry; the position remains unresolved.',
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
      const grossProceeds = proceeds * (sold / sharesSold);
      const averageExit = grossProceeds / sold;
      const fee = estimateTakerFee(sold, averageExit);
      const entryCostAllocated = position.openShares > EPSILON
        ? position.remainingEntryCost * (sold / position.openShares) : 0;
      position.openShares = Math.max(0, position.openShares - sold);
      position.remainingEntryCost = Math.max(0, position.remainingEntryCost - entryCostAllocated);
      position.exitProceeds += grossProceeds;
      position.exitFees += fee;
      position.netExitProceeds += grossProceeds - fee;
      position.realizedPnl += grossProceeds - fee - entryCostAllocated;
      position.lastExitPrice = averageExit;
      position.lastMark = averageExit;
      this.cash += grossProceeds - fee;
      this.stats.estimatedFees += fee;
      this.stats.exits += 1;

      this._push({
        event: position.openShares <= EPSILON ? 'POSITION_EXITED' : 'POSITION_EXIT_PARTIAL',
        slug: w.slug, side: position.side, tranche: position.trancheId,
        reason, sharesSold: round(sold, 5), remainingShares: round(position.openShares, 5),
        avgExit: round(averageExit, 4), proceeds: round(grossProceeds, 2),
        fee: round(fee, 4),
        note: (reason === 'TAKE_PROFIT' ? 'Take-profit sale' : 'Forced window-exit sale')
          + ' simulated at average best bid $' + averageExit.toFixed(4)
          + (position.openShares > EPSILON ? '; remaining shares stay open for another exit attempt.' : '.'),
      });

      if (position.openShares <= EPSILON) {
        position.openShares = 0;
        position.closedAt = now;
        position.status = 'closed';
        tranche.position = null;
        tranche.availableUsd += position.netExitProceeds;
        const canReenter = reason === 'TAKE_PROFIT'
          && now < windowCloseMs(w) - cfg.FORCED_EXIT_BUFFER_SECONDS * 1000;
        if (canReenter) {
          tranche.reentryPrice = position.takeProfitPrice - cfg.REENTRY_PULLBACK_USD;
          tranche.state = 'waiting_reentry';
        } else {
          tranche.state = 'done_for_window';
        }
        this._finalizeTrade(position, reason);
      } else {
        position.status = reason === 'TAKE_PROFIT' ? 'tp_partial' : 'forced_exit_partial';
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
      note: reason === 'TAKE_PROFIT'
        ? 'TP was reached, but no executable CLOB bids at or above the TP price were available.'
        : 'Forced exit has no executable CLOB bid available yet; retrying before expiry.',
    });
  }

  async _forceExitSide(w, sideName, now) {
    const side = w.sides[sideName];
    for (const tranche of side.tranches) {
      if (tranche.position) {
        await this._sellPosition(w, tranche, tranche.position, 'FORCED_WINDOW_EXIT', 0, now);
      } else if (tranche.state === 'waiting_entry' || tranche.state === 'waiting_reentry') {
        tranche.state = 'window_exit_started';
      }
    }
    w.status = 'forced_exit';
  }

  async _finishWindow(w, now, event) {
    if (!w || w.closed) return;
    if (w.window) {
      if (now < windowCloseMs(w)) {
        for (const sideName of SIDES) {
          const side = w.sides[sideName];
          if (side.processingPromise) await side.processingPromise;
          await this._forceExitSide(w, sideName, now);
        }
      } else {
        for (const sideName of SIDES) {
          for (const tranche of w.sides[sideName].tranches) {
            if (!tranche.position && (tranche.state === 'waiting_entry' || tranche.state === 'waiting_reentry')) {
              tranche.state = 'window_exit_started';
            }
          }
        }
      }
    }
    w.closed = true;
    w.closedAt = now;
    w.status = this._positionsForWindow(w).length ? 'unresolved_exit' : 'window_closed';
    for (const position of this._positionsForWindow(w)) {
      position.status = 'unresolved_exit';
      const tranche = w.sides[position.side].tranches.find((item) => item.id === position.trancheId);
      if (tranche) tranche.state = 'unresolved_exit';
    }
    this._push({
      event: 'WINDOW_CLOSED', slug: w.slug,
      note: event + ': no further entries or re-entries; any unfilled position remains visible as unresolved.',
    });
    if (this._marketFeedSlug === w.slug) this._stopMarketFeed();
  }

  _finalizeTrade(position, reason) {
    const pnl = position.realizedPnl;
    this.stats.realizedPnl += pnl;
    if (pnl >= 0) this.stats.wins += 1;
    else this.stats.losses += 1;
    const trade = {
      slug: position.slug, openTs: position.openTs, side: position.side,
      tranche: position.trancheId, cycle: position.cycle,
      shares: position.shares, entryPrice: round(position.entryPrice, 4),
      exitPrice: position.shares > 0 ? round(position.exitProceeds / position.shares, 4) : null,
      entryNotional: round(position.entryNotional, 4),
      exitProceeds: round(position.exitProceeds, 4),
      netExitProceeds: round(position.netExitProceeds, 4),
      fees: round(position.entryFee + position.exitFees, 4),
      pnl: round(pnl, 2), reason, ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    this._push({
      event: 'TRADE_CLOSED', slug: position.slug, side: position.side,
      tranche: position.trancheId, pnl: round(pnl, 2), reason,
      nextBudgetUsd: round(this._trancheFor(position)?.availableUsd || 0, 2),
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

  _recordEquity(now = Date.now()) {
    const openValue = this.pending.reduce((total, position) => {
      const mark = Number.isFinite(Number(position.lastMark))
        ? Number(position.lastMark) : Number(position.entryPrice);
      return total + position.openShares * (Number.isFinite(mark) ? mark : 0);
    }, 0);
    const equity = this.cash + openValue;
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
    const openValue = this.pending.reduce((sum, position) => sum
      + position.openShares * (Number(position.lastMark) || 0), 0);
    const equity = this.cash + openValue;
    const w = this.w;
    const window = w ? {
      slug: w.slug, status: w.status, openTs: w.openTs,
      closeTs: Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS,
      secondsRemaining: Math.max(0, ((Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000 - now) / 1000),
      closed: w.closed,
      sides: Object.fromEntries(SIDES.map((name) => {
        const side = w.sides[name];
        return [name, {
          quote: this._quoteFor(name, w),
          tranches: side.tranches.map((tranche) => ({
            id: tranche.id, entryTrigger: tranche.entryTrigger, initialBudgetUsd: tranche.initialBudgetUsd,
            availableUsd: round(tranche.availableUsd, 2), state: tranche.state, cycle: tranche.cycle,
            reentryPrice: tranche.reentryPrice,
            position: tranche.position ? {
              id: tranche.position.id, entryPrice: tranche.position.entryPrice,
              takeProfitPrice: tranche.position.takeProfitPrice,
              takeProfitReachable: tranche.position.takeProfitReachable,
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
        capital: this.capital, cash: round(this.cash, 2), openValue: round(openValue, 2),
        equity: round(equity, 2), totalPnl: round(equity - this.capital, 2),
        unrealizedPnl: round(openValue - this.pending.reduce((sum, p) => sum + p.remainingEntryCost, 0), 2),
        maxDrawdown: round(this.maxDrawdown, 2),
      },
      strategy: {
        sideBudgetUsd: cfg.SIDE_BUDGET_USD, trancheBudgetUsd: cfg.TRANCHE_BUDGET_USD,
        firstEntryAsk: cfg.FIRST_ENTRY_ASK_USD, secondEntryAsk: cfg.SECOND_ENTRY_ASK_USD,
        takeProfitOffset: cfg.TAKE_PROFIT_OFFSET_USD, reentryPullback: cfg.REENTRY_PULLBACK_USD,
        maxEntryAsk: cfg.MAX_ENTRY_ASK_USD, forcedExitBufferSeconds: cfg.FORCED_EXIT_BUFFER_SECONDS,
      },
      window, prices: this.prices, priceSeries: this.priceSeries,
      pending: this.pending.map((position) => this._positionSnapshot(position)),
      trades: this.trades.slice(-60).reverse(),
      stats: { ...this.stats }, equity: this.equity,
      cfg: {
        demoCapital: this.capital, sideBudgetUsd: cfg.SIDE_BUDGET_USD,
        trancheBudgetUsd: cfg.TRANCHE_BUDGET_USD,
        firstEntryAsk: cfg.FIRST_ENTRY_ASK_USD, secondEntryAsk: cfg.SECOND_ENTRY_ASK_USD,
        takeProfitOffset: cfg.TAKE_PROFIT_OFFSET_USD, reentryPullback: cfg.REENTRY_PULLBACK_USD,
        maxEntryAsk: cfg.MAX_ENTRY_ASK_USD, forcedExitBufferSeconds: cfg.FORCED_EXIT_BUFFER_SECONDS,
        windowSec: WINDOW_SECONDS,
      },
      log: this.log.slice(-100).reverse(),
    };
  }

  _positionSnapshot(position) {
    const mark = Number.isFinite(Number(position.lastMark)) ? Number(position.lastMark) : position.entryPrice;
    const costBasis = position.shares > 0
      ? (position.entryNotional + position.entryFee) * (position.openShares / position.shares) : 0;
    return {
      ...position, mark,
      unrealized: position.openShares * mark - costBasis,
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
    tranches: [
      makeTranche('A', cfg.FIRST_ENTRY_ASK_USD),
      makeTranche('B', cfg.SECOND_ENTRY_ASK_USD),
    ],
  };
}

function makeTranche(id, entryTrigger) {
  return {
    id, entryTrigger,
    initialBudgetUsd: cfg.TRANCHE_BUDGET_USD,
    availableUsd: cfg.TRANCHE_BUDGET_USD,
    state: 'waiting_entry', cycle: 0,
    reentryPrice: null, position: null,
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
