'use strict';

const cfg = require('./config');
const {
  getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');
const { estimateTakerFee } = require('./strategy');

const EPSILON = 1e-8;
const MAX_LOG = 300;

class Bot {
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.live = !!opts.live;
    this.demoMode = !this.live && !!(trader && trader.demoMode === true);
    this.strategyBlocked = this.live || !this.demoMode;
    this.w = null;
    this.pending = [];
    this.trades = [];
    this.outcomes = new Map();
    this._warned = new Set();
    this.stats = {
      wins: 0, losses: 0, primaryEntries: 0, stopLossHedges: 0,
      estimatedTakerFees: 0, realizedPnl: 0,
    };
    this.counts = { UP: 0, DOWN: 0 };
    this.walletBalance = null;
    this.error = this.strategyBlocked
      ? 'This strategy is demo-only; order submission is disabled outside DemoTrader.' : null;
    this.executionHalt = this.strategyBlocked;
    this.log = [];
    this.startedAt = Date.now();
    this.capital = this.demoMode ? cfg.DEMO_CAPITAL : null;
    this.cash = this.demoMode ? cfg.DEMO_CAPITAL : null;
    this.currentStakeUsd = cfg.BASE_STAKE_USD;
    this.peak = this.capital;
    this.maxDD = 0;
    this.equity = this.capital == null ? [] : [{ ts: Date.now(), v: this.capital }];
    this.prices = null;
    this.priceSeries = [];
    this._seriesSlug = null;
    this._lastSeriesAt = 0;
    this._quotesByToken = new Map();
    this._marketFeedStop = null;
    this._marketFeedSlug = null;
    this._lastMarketEventAt = 0;
    this._lastRestFetchAt = 0;
    this._running = false;
  }

  _push(entry) {
    this.log.push({ ts: Date.now(), ...entry });
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  _warnOnce(key, entry) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this._push(entry);
  }

  start() {
    if (this._running || this.strategyBlocked) {
      if (this.strategyBlocked) {
        this._warnOnce('trigger-strategy-blocked', {
          event: 'LIVE_BLOCKED',
          note: 'The trigger strategy requires DemoTrader; no live order methods will be called.',
        });
      }
      return;
    }
    this._running = true;
    void this._loop();
    void this._priceLoop();
    void this._settlementLoop();
    void this._balanceLoop();
  }

  stop() {
    this._running = false;
    if (this._marketFeedStop) { try { this._marketFeedStop(); } catch (_) {} }
    this._marketFeedStop = null;
    this._marketFeedSlug = null;
  }

  async _loop() {
    while (this._running) {
      try { await this._tick(); }
      catch (error) {
        this.error = 'tick error: ' + error.message;
        this._push({ event: 'ERROR', note: this.error });
      }
      await sleep(cfg.LOOP_MS);
    }
  }

  async _tick() {
    if (this.strategyBlocked) return;
    const now = Date.now();
    const openTs = currentWindowOpenTs(now);
    const slug = slugForTs(openTs);
    if (!this.w || this.w.slug !== slug) {
      if (this.w) await this._closeWindow(this.w);
      this.w = makeWindowState(slug, openTs);
    }

    const w = this.w;
    if (!w.window) {
      const result = await getActiveWindow(now);
      if (result.window) {
        this.error = null;
        w.window = result.window;
        w.status = 'watching_entry_trigger';
        this._push({
          event: 'WINDOW_READY', slug: w.slug,
          note: 'BTC 5-minute market active; watching UP and DOWN for the $0.69 entry trigger.',
        });
        await this._ensureMarketFeed(w);
      } else {
        this.error = result.reason || 'active market unavailable';
        w.status = 'waiting_for_market';
      }
    }

    if (!w.window) return;
    const closeTs = Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS;
    if (Date.now() >= closeTs * 1000) await this._closeWindow(w);
  }

  async _priceLoop() {
    while (this._running) {
      const w = this.w;
      if (w && w.window && !w.closed) {
        if (this._marketFeedSlug !== w.slug) await this._ensureMarketFeed(w);
        const now = Date.now();
        if (now - this._lastMarketEventAt >= cfg.PRICE_STALE_MS
          && now - this._lastRestFetchAt >= cfg.PRICE_FEED_FALLBACK_MS) {
          await this._seedQuotes(w);
        }
      }
      await sleep(cfg.LOOP_MS);
    }
  }

  async _ensureMarketFeed(w) {
    if (!w || !w.window || this._marketFeedSlug === w.slug) return;
    if (this._marketFeedStop) { try { this._marketFeedStop(); } catch (_) {} }
    this._marketFeedSlug = w.slug;
    this._quotesByToken = new Map();
    this.prices = { slug: w.slug, ts: Date.now(), up: emptyQuote(), down: emptyQuote() };
    this._lastMarketEventAt = 0;
    this._lastRestFetchAt = 0;
    try {
      this._marketFeedStop = startMarketFeed(
        [w.window.tokenUp, w.window.tokenDown],
        (tokenId, quoteValue) => this._onQuote(w.slug, tokenId, quoteValue),
        (error) => this._warnOnce('clob-ws-' + w.slug, {
          event: 'ERROR', slug: w.slug, note: 'Polymarket CLOB feed error: ' + error.message,
        }),
      );
    } catch (error) {
      this._warnOnce('clob-start-' + w.slug, {
        event: 'ERROR', slug: w.slug, note: 'Polymarket CLOB feed start failed: ' + error.message,
      });
    }
    await this._seedQuotes(w);
  }

  async _seedQuotes(w) {
    if (!w || !w.window || this._marketFeedSlug !== w.slug) return;
    this._lastRestFetchAt = Date.now();
    try {
      const books = await Promise.all([
        this.trader.getOrderBook(w.window.tokenUp),
        this.trader.getOrderBook(w.window.tokenDown),
      ]);
      if (this._marketFeedSlug !== w.slug) return;
      this._onQuote(w.slug, w.window.tokenUp, quote(books[0]));
      this._onQuote(w.slug, w.window.tokenDown, quote(books[1]));
    } catch (error) {
      this._warnOnce('seed-' + w.slug, {
        event: 'ERROR', slug: w.slug, note: 'CLOB quote refresh failed: ' + error.message,
      });
    }
  }

  _onQuote(slug, tokenId, update) {
    const w = this.w;
    if (!w || w.slug !== slug || !w.window || w.closed) return;
    const side = tokenId === w.window.tokenUp ? 'UP'
      : tokenId === w.window.tokenDown ? 'DOWN' : null;
    if (!side) return;
    const previous = this._quotesByToken.get(tokenId) || emptyQuote();
    const now = Date.now();
    const next = {
      bid: update && Object.prototype.hasOwnProperty.call(update, 'bid') ? update.bid : previous.bid,
      ask: update && Object.prototype.hasOwnProperty.call(update, 'ask') ? update.ask : previous.ask,
      ts: now,
    };
    next.mid = next.bid == null || next.ask == null ? null : (next.bid + next.ask) / 2;
    this._quotesByToken.set(tokenId, next);
    if (typeof this.trader.updateQuote === 'function') this.trader.updateQuote(tokenId, next);
    const up = this._quotesByToken.get(w.window.tokenUp) || emptyQuote();
    const down = this._quotesByToken.get(w.window.tokenDown) || emptyQuote();
    this.prices = { slug, ts: now, up: { ...up }, down: { ...down } };
    this._lastMarketEventAt = now;
    if (up.ask != null && down.ask != null) {
      if (this._seriesSlug !== slug) { this._seriesSlug = slug; this.priceSeries = []; }
      if (now - this._lastSeriesAt >= 250) {
        this.priceSeries.push({
          t: Math.round((now - w.openTs * 1000) / 1000),
          up: round(up.ask, 3), down: round(down.ask, 3),
        });
        if (this.priceSeries.length > 600) this.priceSeries.shift();
        this._lastSeriesAt = now;
      }
    }

    const earlyPriceWinner = clob297PriceWinner(this.prices, w, now);
    if (earlyPriceWinner) {
      this._confirmClobOutcome(w, earlyPriceWinner, 'clob_297_price');
    } else {
      const clobWinner = clobPairWinner(this.prices);
      if (clobWinner) this._confirmClobOutcome(w, clobWinner);
    }
    const triggerTask = this._evaluateEntryTriggers(w, side).catch((error) => {
      this._push({ event: 'ENTRY_TRIGGER_ERROR', slug, side, note: error.message });
    });
    for (const position of this.pending.filter((item) => item.openTs === w.openTs && item.side === side)) {
      const mark = next.bid == null ? next.mid : next.bid;
      if (mark != null && Number.isFinite(Number(mark))) position.lastClobMark = Number(mark);
      this._recordEquity();
    }
    return triggerTask;
  }

  _confirmClobOutcome(w, winner, source = 'clob_pair') {
    if (!w || w.clobConfirmedOutcome) return false;
    w.clobConfirmedOutcome = winner;
    w.clobOutcomeSource = source;
    w.clobConfirmedAt = Date.now();
    w.status = 'clob_confirmed';
    this._recordOutcome(w.openTs, w.slug, winner, source);
    const loser = winner === 'UP' ? 'DOWN' : 'UP';
    const earlyPriceResult = source === 'clob_297_price';
    this._push({
      event: earlyPriceResult ? 'CLOB_297_PRICE_CONFIRMED' : 'CLOB_PAIR_CONFIRMED',
      slug: w.slug, side: winner, loser,
      note: earlyPriceResult
        ? 'During the final ' + cfg.CLOB_EARLY_RESOLUTION_SECONDS_BEFORE_CLOSE
          + ' seconds, the ' + winner + ' midpoint exceeded $'
          + cfg.CLOB_EARLY_RESOLUTION_PRICE_USD.toFixed(2) + '; recording '
          + winner + ' as winner and ' + loser + ' as loser.'
        : 'UP and DOWN CLOB prices jointly confirmed ' + winner
          + '; settling positions and updating the primary stake now.',
    });
    this._settlePositionsForOpenTs(
      w.openTs, w.slug, winner,
      earlyPriceResult ? 'CLOB_297_PRICE_THRESHOLD' : 'CLOB_PAIR_CONFIRMATION',
    );
    w.status = 'clob_confirmed';
    return true;
  }

  _settlePositionsForOpenTs(openTs, slug, winner, reason) {
    for (const position of this.pending.filter((item) => item.openTs === openTs).slice()) {
      const payout = winner === position.side ? position.openShares : 0;
      this.cash += payout + position.makerRebateEstimate;
      position.exitProceeds += payout;
      position.openShares = 0;
      position.resolutionPayout = payout;
      this._removeFromWindow(position);
      this._finalizePosition(position, winner === position.side ? 'WIN' : 'LOSS', reason, winner);
    }
  }

  async _evaluateEntryTriggers(w, updatedSide) {
    if (this.strategyBlocked || !w || this.w !== w || !w.window || w.closed
      || w.clobConfirmedOutcome
      || Date.now() >= windowCloseMs(w)) return false;
    if (w.entryTriggerBusy) {
      this._latchPendingHedgeTrigger(w, updatedSide);
      return false;
    }

    if (w.primaryPosition && !w.primaryPosition.settled && !w.hedgeAttempted) {
      const hedgeSide = w.primarySide === 'UP' ? 'DOWN' : 'UP';
      const hedgeQuote = this.prices && this.prices.slug === w.slug
        ? this.prices[hedgeSide.toLowerCase()] : null;
      const hedgeAsk = hedgeQuote == null ? NaN : Number(hedgeQuote.ask);
      const triggerLatched = w.hedgeTriggerPending;
      if (!Number.isFinite(hedgeAsk)
        || (!triggerLatched && hedgeAsk < cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD)) {
        return false;
      }

      const triggerPrice = triggerLatched ? w.hedgeTriggerPendingPrice : hedgeAsk;
      w.hedgeAttempted = true;
      w.hedgeTriggerPending = false;
      w.hedgeTriggerPendingPrice = null;
      w.entryTriggerBusy = true;
      w.status = 'stop_loss_hedge_pending';
      this._push({
        event: 'STOP_LOSS_HEDGE_TRIGGERED', slug: w.slug, side: hedgeSide,
        price: round(triggerPrice, 4),
        stakeUsd: round(w.primaryStakeUsd * cfg.HEDGE_STAKE_RATIO, 2),
        note: hedgeSide + ' ask reached $' + cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD.toFixed(2)
          + (triggerLatched
            ? ' while the primary BUY was pending; placing the scaled hedge at the current ask.'
            : '; placing the scaled opposite-side stop-loss hedge.'),
      });
      try {
        return !!(await this._executeStake(
          w, hedgeSide, w.primaryStakeUsd * cfg.HEDGE_STAKE_RATIO,
          'STOP_LOSS_HEDGE', hedgeAsk,
        ));
      } finally {
        w.entryTriggerBusy = false;
      }
    }

    if (w.primaryAttempted || !updatedSide) return false;
    const primaryQuote = this.prices && this.prices.slug === w.slug
      ? this.prices[updatedSide.toLowerCase()] : null;
    const primaryAsk = primaryQuote == null ? NaN : Number(primaryQuote.ask);
    if (!Number.isFinite(primaryAsk) || primaryAsk < cfg.ENTRY_TRIGGER_PRICE_USD) return false;

    const previousPrimaryOpen = this.pending.find((position) =>
      position.role === 'PRIMARY' && !position.settled && position.openTs < w.openTs);
    if (previousPrimaryOpen) {
      if (w.status !== 'awaiting_previous_primary_settlement') {
        this._push({
          event: 'ENTRY_HELD_PREVIOUS_PRIMARY', slug: w.slug, side: updatedSide,
          previousSlug: previousPrimaryOpen.slug, previousSide: previousPrimaryOpen.side,
          note: updatedSide + ' ask reached $' + cfg.ENTRY_TRIGGER_PRICE_USD.toFixed(2)
            + ', but the primary from ' + previousPrimaryOpen.slug + ' is still open. '
            + 'This entry is held until the previous window is resolved by the final-3-second price rule.',
        });
      }
      w.status = 'awaiting_previous_primary_settlement';
      return false;
    }

    w.primaryAttempted = true;
    w.primarySide = updatedSide;
    w.primaryStakeUsd = this.currentStakeUsd;
    w.status = 'primary_entry_pending';
    this._push({
      event: 'ENTRY_TRIGGERED', slug: w.slug, side: updatedSide,
      price: round(primaryQuote.ask, 4), stakeUsd: round(w.primaryStakeUsd, 2),
      note: updatedSide + ' ask reached $' + cfg.ENTRY_TRIGGER_PRICE_USD.toFixed(2)
        + '; placing the primary BUY for $' + round(w.primaryStakeUsd, 2) + '.',
    });

    let position = null;
    w.entryTriggerBusy = true;
    try {
      position = await this._executeStake(w, updatedSide, w.primaryStakeUsd, 'PRIMARY', primaryAsk);
    } finally {
      w.entryTriggerBusy = false;
      if (!w.primaryPosition) {
        w.hedgeTriggerPending = false;
        w.hedgeTriggerPendingPrice = null;
      }
    }

    if (position) {
      const hedgeSide = w.primarySide === 'UP' ? 'DOWN' : 'UP';
      const hedgeQuote = this.prices && this.prices.slug === w.slug
        ? this.prices[hedgeSide.toLowerCase()] : null;
      const hedgeAsk = hedgeQuote == null ? NaN : Number(hedgeQuote.ask);
      if (w.hedgeTriggerPending
        || (Number.isFinite(hedgeAsk) && hedgeAsk >= cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD)) {
        return this._evaluateEntryTriggers(w, hedgeSide);
      }
    }
    return !!position;
  }

  _latchPendingHedgeTrigger(w, updatedSide) {
    if (!w.primaryAttempted || w.primaryPosition || w.hedgeAttempted
      || !updatedSide || w.hedgeTriggerPending) return false;
    const hedgeSide = w.primarySide === 'UP' ? 'DOWN' : 'UP';
    if (updatedSide !== hedgeSide) return false;
    const hedgeQuote = this.prices && this.prices.slug === w.slug
      ? this.prices[hedgeSide.toLowerCase()] : null;
    const hedgeAsk = hedgeQuote == null ? NaN : Number(hedgeQuote.ask);
    if (!Number.isFinite(hedgeAsk) || hedgeAsk < cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD) return false;

    w.hedgeTriggerPending = true;
    w.hedgeTriggerPendingPrice = hedgeAsk;
    this._push({
      event: 'STOP_LOSS_HEDGE_TRIGGER_LATCHED', slug: w.slug, side: hedgeSide,
      price: round(hedgeAsk, 4),
      note: hedgeSide + ' ask reached $' + cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD.toFixed(2)
        + ' while the primary BUY was pending; the hedge will be attempted after a primary fill.',
    });
    return true;
  }

  async _executeStake(w, side, stakeUsd, role, priceReference) {
    const minimumCash = stakeUsd * (1 + cfg.CRYPTO_TAKER_FEE_RATE);
    if (this.cash == null || this.cash + EPSILON < minimumCash) {
      w.status = 'insufficient_cash';
      this._push({
        event: 'STAKE_NO_CASH', slug: w.slug, side, role, stakeUsd: round(stakeUsd, 2),
        note: 'Demo cash cannot cover the $' + round(stakeUsd, 2)
          + ' stake plus a conservative taker-fee reserve.',
      });
      return null;
    }

    const tokenId = side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    if (typeof this.trader.placeFakMarketOrder !== 'function') {
      throw new Error('DemoTrader does not support marketable BUY orders');
    }
    const maxBuyPrice = Math.min(
      cfg.MAX_BINARY_PRICE_USD,
      priceReference * (1 + cfg.MAX_BUY_SLIPPAGE_PERCENT / 100),
    );
    const order = await this.trader.placeFakMarketOrder(
      tokenId, 'BUY', stakeUsd, { priceLimit: maxBuyPrice },
    );
    const shares = positive(order && order.raw && order.raw.takingAmount);
    const notional = positive(order && order.raw && order.raw.makingAmount);
    if (shares == null || notional == null) {
      w.status = role === 'PRIMARY' ? 'entry_unfilled' : 'stop_loss_hedge_unfilled';
      this._push({
        event: role === 'PRIMARY' ? 'ENTRY_UNFILLED' : 'STOP_LOSS_HEDGE_UNFILLED',
        slug: w.slug, side, role, stakeUsd: round(stakeUsd, 2),
        note: 'No ' + side + ' shares filled from the visible order book; no position was opened.',
      });
      return null;
    }

    const averagePrice = positive(order.avgPrice) || notional / shares;
    const fee = estimateTakerFee(shares, averagePrice);
    if (notional + fee > this.cash + EPSILON) {
      w.status = 'insufficient_cash';
      this._push({
        event: 'STAKE_REJECTED_CASH', slug: w.slug, side, role,
        note: 'The simulated fill plus estimated taker fee exceeded available demo cash.',
      });
      return null;
    }

    const quoteNow = this.prices && this.prices.slug === w.slug
      ? this.prices[side.toLowerCase()] : null;
    const position = makePosition(w, {
      side, tokenId, role, stakeUsd, shares, price: averagePrice,
      notional, fee, mark: quoteNow && quoteNow.bid,
    });
    this.cash -= position.cost;
    this.pending.push(position);
    w.positions.push(position);
    if (!w.position) w.position = position;
    if (role === 'PRIMARY') {
      w.primaryPosition = position;
      w.status = 'position_open';
      this.stats.primaryEntries += 1;
    } else {
      w.hedgePosition = position;
      w.status = 'position_open_with_hedge';
      this.stats.stopLossHedges += 1;
    }
    this.stats.estimatedTakerFees += fee;
    this._recordEquity();
    this._push({
      event: role === 'PRIMARY' ? 'ENTRY_FILLED' : 'STOP_LOSS_HEDGE_FILLED',
      slug: w.slug, side, role, stakeUsd: round(stakeUsd, 2),
      shares: round(shares, 4), price: round(averagePrice, 4), fee: round(fee, 5),
      note: role + ' BUY filled ' + round(shares, 4) + ' ' + side
        + ' shares for $' + round(notional, 2) + ' at average $'
        + averagePrice.toFixed(4) + '; estimated taker fee $' + fee.toFixed(5) + '.',
    });
    return position;
  }

  async _closeWindow(w) {
    if (!w || w.closed || w.closing) return;
    w.closing = true;
    const positions = this._activePositions(w);
    if (positions.length) {
      for (const position of positions) {
        position.status = 'awaiting_297s_price_threshold';
        this._push({
          event: 'WINDOW_HOLD_NO_297_PRICE_TRIGGER', slug: w.slug, side: position.side,
          shares: round(position.openShares, 4),
          note: 'No fresh UP or DOWN midpoint exceeded $'
            + cfg.CLOB_EARLY_RESOLUTION_PRICE_USD.toFixed(2) + ' during the final '
            + cfg.CLOB_EARLY_RESOLUTION_SECONDS_BEFORE_CLOSE
            + ' seconds. Position remains unsettled; no official-result fallback is used.',
        });
      }
    }
    w.closed = true;
    w.closing = false;
    w.status = w.clobConfirmedOutcome ? 'clob_confirmed'
      : positions.length ? 'awaiting_297s_price_threshold'
          : w.primaryAttempted ? 'window_closed' : 'no_entry';
    this._push({
      event: 'WINDOW_CLOSED', slug: w.slug,
      note: 'Window ended; no new trigger entries will be placed.',
    });
  }

  _activePositions(w) {
    return this.pending.filter((position) => position.openTs === w.openTs
      && position.openShares > EPSILON && !position.settled);
  }

  async _settlementLoop() {
    while (this._running) {
      await sleep(cfg.SETTLEMENT_POLL_MS);
      await this._settleClosedPositions(Date.now());
    }
  }

  async _settleClosedPositions(now = Date.now()) {
    const checkedWindows = new Set();
    for (const position of this.pending.slice()) {
      if (position.settled || checkedWindows.has(position.openTs)) continue;
      const openTs = position.openTs;
      checkedWindows.add(openTs);
      const closeTime = Number(position.closeTs) * 1000;
      const activeWindow = this.w && this.w.openTs === openTs && !this.w.closed;
      if (activeWindow && this.prices && this.prices.slug === position.slug) {
        const windowPositions = this.pending.filter((item) => item.openTs === openTs);
        for (const pendingPosition of windowPositions) {
          const currentQuote = pendingPosition.side === 'UP' ? this.prices.up : this.prices.down;
          const mark = currentQuote && (currentQuote.bid == null ? currentQuote.mid : currentQuote.bid);
          if (mark != null && Number.isFinite(Number(mark))) pendingPosition.lastClobMark = Number(mark);
        }
        const earlyPriceWinner = clob297PriceWinner(this.prices, this.w, now);
        if (earlyPriceWinner) {
          this._confirmClobOutcome(this.w, earlyPriceWinner, 'clob_297_price');
          continue;
        }
        const clobWinner = clobPairWinner(this.prices);
        if (clobWinner) {
          this._confirmClobOutcome(this.w, clobWinner);
          continue;
        }
        this._recordEquity();
      }
      if (now < closeTime) continue;
      if (activeWindow) {
        if (this.w.closing) continue;
        await this._closeWindow(this.w);
      }

      const winner = this.outcomes.get(openTs)?.winner || null;
      if (winner === 'UP' || winner === 'DOWN') {
        this._settlePositionsForOpenTs(openTs, position.slug, winner, 'CLOB_PRICE_RULE');
      }
    }
  }

  _removeFromWindow(position) {
    if (!this.w || this.w.openTs !== position.openTs) return;
    this.w.positions = this.w.positions.filter((item) => item !== position);
    if (this.w.position === position) this.w.position = this.w.positions[0] || null;
    const active = this._activePositions(this.w);
    this.w.status = active.length ? 'position_open'
      : this.w.closed ? 'window_closed'
        : this.w.primaryAttempted ? 'position_settled' : 'watching_entry_trigger';
  }

  _recordOutcome(openTs, slug, winner, source = 'clob_pair') {
    if (this.outcomes.has(openTs)) return;
    const loser = winner === 'UP' ? 'DOWN' : 'UP';
    this.outcomes.set(openTs, { winner, loser, source, price: 1, loserPrice: 0 });
    this.counts[winner] = (this.counts[winner] || 0) + 1;
    if (this.outcomes.size > 60) this.outcomes.delete(this.outcomes.keys().next().value);
    this._push({
      event: 'OUTCOME', slug, side: winner, loser,
      note: 'Window outcome recorded: ' + winner + ' wins and ' + loser + ' loses.',
    });
  }

  _finalizePosition(position, outcome, reason, winner = null) {
    if (position.settled) return;
    position.settled = true;
    position.status = 'closed';
    const pnl = position.exitProceeds + position.makerRebateEstimate
      - position.entryNotional - position.entryFee - position.exitFees;
    this.stats.realizedPnl += pnl;
    if (outcome === 'WIN') {
      this.stats.wins += 1;
    } else if (outcome === 'LOSS') {
      this.stats.losses += 1;
    }
    if (position.role === 'PRIMARY') {
      this.currentStakeUsd = outcome === 'WIN'
        ? cfg.BASE_STAKE_USD : this.currentStakeUsd * 2;
    }
    const trade = {
      slug: position.slug, openTs: position.openTs, side: position.side,
      role: position.role, stakeUsd: round(position.stakeUsd, 2),
      shares: position.shares, entryPrice: round(position.entryPrice, 4),
      exitPrice: position.shares > 0 ? round(position.exitProceeds / position.shares, 4) : null,
      entryNotional: round(position.entryNotional, 4),
      exitProceeds: round(position.exitProceeds, 4),
      fee: round(position.entryFee + position.exitFees, 4),
      makerRebateEstimate: round(position.makerRebateEstimate, 4),
      outcome, reason, winner, pnl: round(pnl, 2), ts: Date.now(),
    };
    this.trades.push(trade);
    if (this.trades.length > 200) this.trades.shift();
    this.pending = this.pending.filter((item) => item !== position);
    this._push({
      event: outcome === 'WIN' ? 'SETTLED_WIN' : 'SETTLED_LOSS',
      slug: position.slug, side: position.side, pnl: round(pnl, 2),
      role: position.role, nextStakeUsd: this.currentStakeUsd,
      note: reason + ' · ' + outcome + ' · demo P&L '
        + (pnl >= 0 ? '+' : '') + '$' + round(pnl, 2)
        + (position.role === 'PRIMARY'
          ? '; next primary stake is $' + round(this.currentStakeUsd, 2) + '.'
          : '; primary stake progression is unchanged.'),
    });
    this._recordEquity();
  }

  _recordEquity() {
    if (this.capital == null || this.cash == null) return;
    const now = Date.now();
    const openValue = this.pending.reduce((sum, position) => {
      const mark = position.lastClobMark != null && Number.isFinite(Number(position.lastClobMark))
        ? Number(position.lastClobMark) : Number(position.entryPrice);
      return sum + position.openShares * (Number.isFinite(mark) ? mark : 0);
    }, 0);
    const equity = this.cash + openValue;
    this.peak = Math.max(this.peak == null ? equity : this.peak, equity);
    this.maxDD = Math.max(this.maxDD, this.peak - equity);
    const last = this.equity[this.equity.length - 1];
    if (!last || Math.abs(equity - last.v) >= 0.01 || now - last.ts >= 1000) {
      this.equity.push({ ts: now, v: round(equity, 2) });
      if (this.equity.length > 500) this.equity.shift();
    }
  }

  async _balanceLoop() {
    while (this._running) {
      try { this.walletBalance = await this.trader.getBalance(); }
      catch (error) { this._push({ event: 'ERROR', note: 'Balance check failed: ' + error.message }); }
      await sleep(30_000);
    }
  }

  snapshot() {
    const now = Date.now();
    const w = this.w;
    const px = this.prices;
    const allPending = this.pending.map((position) => {
      const q = px && px.slug === position.slug ? (position.side === 'UP' ? px.up : px.down) : null;
      const currentMark = q ? (q.bid == null ? q.mid : q.bid) : null;
      const mark = currentMark == null
        ? (position.lastClobMark != null && Number.isFinite(Number(position.lastClobMark))
          ? Number(position.lastClobMark)
          : (Number.isFinite(Number(position.entryPrice)) ? Number(position.entryPrice) : null))
        : currentMark;
      const costBasis = position.shares > 0
        ? (position.entryNotional + position.entryFee)
          * (position.openShares / position.shares) : 0;
      return { ...position, mark, unrealized: mark == null
        ? null : position.openShares * mark - costBasis };
    });
    const openValue = allPending.reduce((sum, position) =>
      sum + (position.mark != null ? position.openShares * position.mark : 0), 0);
    const unrealizedPnl = allPending.reduce((sum, position) => sum + (position.unrealized || 0), 0);
    const equity = this.cash == null ? null : this.cash + openValue;
    const elapsed = w ? Math.max(0, (now - w.openTs * 1000) / 1000) : 0;
    return {
      now, mode: this.live ? 'LIVE' : 'DEMO', uptimeSec: Math.floor((now - this.startedAt) / 1000),
      error: this.error, executionHalt: this.executionHalt, walletBalance: this.walletBalance,
      walletAddress: this.trader.depositWallet || this.trader.address,
      account: {
        capital: this.capital, cash: this.cash, openValue, unrealizedPnl,
        equity, totalPnl: equity == null || this.capital == null ? null : equity - this.capital,
        maxDrawdown: this.maxDD,
      },
      window: w ? {
        slug: w.slug, status: w.status, openTs: w.openTs,
        closeTs: Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS,
        elapsedSeconds: elapsed, closed: w.closed,
        entrySide: w.primarySide,
        primarySide: w.primarySide,
        clobConfirmedOutcome: w.clobConfirmedOutcome || null,
        clobOutcomeSource: w.clobOutcomeSource || null,
        primaryStakeUsd: w.primaryStakeUsd || null,
        hedgeStakeUsd: w.hedgePosition ? w.hedgePosition.stakeUsd : null,
        primaryEntry: w.primaryPosition ? {
          side: w.primaryPosition.side, stakeUsd: w.primaryPosition.stakeUsd,
          entryPrice: w.primaryPosition.entryPrice, status: w.primaryPosition.status,
          settled: w.primaryPosition.settled,
        } : null,
        hedgeEntry: w.hedgePosition ? {
          side: w.hedgePosition.side, stakeUsd: w.hedgePosition.stakeUsd,
          entryPrice: w.hedgePosition.entryPrice, status: w.hedgePosition.status,
          settled: w.hedgePosition.settled,
        } : null,
        positions: [w.primaryPosition, w.hedgePosition].filter(Boolean).map((position) => ({
          side: position.side, role: position.role, stakeUsd: position.stakeUsd,
          openShares: position.openShares, entryPrice: position.entryPrice,
          status: position.status, settled: position.settled,
        })),
        positionSide: w.primarySide || null,
        openShares: this._activePositions(w).reduce((sum, position) => sum + position.openShares, 0),
        primaryAttempted: !!w.primaryAttempted,
        hedgeAttempted: !!w.hedgeAttempted,
        entryTaken: !!w.primaryPosition,
      } : null,
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      strategy: {
        baseStakeUsd: cfg.BASE_STAKE_USD,
        currentStakeUsd: this.currentStakeUsd,
        hedgeStakeRatio: cfg.HEDGE_STAKE_RATIO,
        currentHedgeStakeUsd: round(this.currentStakeUsd * cfg.HEDGE_STAKE_RATIO, 2),
        demoCapital: cfg.DEMO_CAPITAL,
        entryTriggerPrice: cfg.ENTRY_TRIGGER_PRICE_USD,
        stopLossHedgeTriggerPrice: cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD,
        earlyResolutionPrice: cfg.CLOB_EARLY_RESOLUTION_PRICE_USD,
        earlyResolutionSecondsBeforeClose: cfg.CLOB_EARLY_RESOLUTION_SECONDS_BEFORE_CLOSE,
        clobWinSettlementPrice: cfg.CLOB_WIN_SETTLEMENT_PRICE,
        clobLossSettlementPrice: cfg.CLOB_LOSS_SETTLEMENT_PRICE,
      },
      counts: this.counts,
      pending: allPending.slice(-20),
      trades: this.trades.slice(-60).reverse(),
      equity: this.equity,
      stats: this.stats,
      cfg: {
        demoCapital: cfg.DEMO_CAPITAL,
        baseStakeUsd: cfg.BASE_STAKE_USD,
        currentStakeUsd: this.currentStakeUsd,
        entryTriggerPrice: cfg.ENTRY_TRIGGER_PRICE_USD,
        stopLossHedgeTriggerPrice: cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD,
        earlyResolutionPrice: cfg.CLOB_EARLY_RESOLUTION_PRICE_USD,
        earlyResolutionSecondsBeforeClose: cfg.CLOB_EARLY_RESOLUTION_SECONDS_BEFORE_CLOSE,
        windowSec: WINDOW_SECONDS,
      },
      log: this.log.slice(-100).reverse(),
    };
  }
}

function makeWindowState(slug, openTs) {
  return {
    slug, openTs, status: 'waiting_for_market', window: null,
    closed: false, closing: false, positions: [], position: null,
    primarySide: null, primaryPosition: null, hedgePosition: null,
    primaryStakeUsd: null, primaryAttempted: false, hedgeAttempted: false,
    hedgeTriggerPending: false, hedgeTriggerPendingPrice: null,
    entryTriggerBusy: false, clobConfirmedOutcome: null, clobConfirmedAt: null,
    clobOutcomeSource: null,
  };
}

function makePosition(w, entry) {
  return {
    slug: w.slug, openTs: w.openTs,
    closeTs: Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS,
    tokenUp: w.window.tokenUp, tokenDown: w.window.tokenDown,
    side: entry.side, tokenId: entry.tokenId, role: entry.role,
    stakeUsd: entry.stakeUsd, shares: entry.shares, openShares: entry.shares,
    entryPrice: entry.price, entryNotional: entry.notional,
    makerRebateEstimate: 0, entryFee: entry.fee, exitFees: 0,
    cost: entry.notional + entry.fee,
    exitProceeds: 0, status: 'position_open', firedAt: Date.now(),
    lastClobMark: positive(entry.mark) || entry.price, settled: false,
  };
}

function emptyQuote() { return { bid: null, ask: null, mid: null, ts: null }; }

function sortedLevels(levels, order) {
  return (levels || [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0
      && Number.isFinite(level.size) && level.size > 0)
    .sort(order === 'asc' ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);
}

function quote(book) {
  const bids = sortedLevels(book && book.bids, 'desc');
  const asks = sortedLevels(book && book.asks, 'asc');
  const bid = bids.length ? bids[0].price : null;
  const ask = asks.length ? asks[0].price : null;
  return { bid, ask, mid: bid == null || ask == null ? null : (bid + ask) / 2, ts: Date.now() };
}

function clobPairWinner(prices) {
  if (!isFreshQuotePair(prices)) return null;
  const upMid = validPrice(prices.up.mid);
  const downMid = validPrice(prices.down.mid);
  const upBid = validPrice(prices.up.bid);
  const downBid = validPrice(prices.down.bid);
  const upConfirmed = upMid != null && upMid >= cfg.CLOB_WIN_SETTLEMENT_PRICE
    && downBid != null && downBid <= cfg.CLOB_LOSS_SETTLEMENT_PRICE;
  const downConfirmed = downMid != null && downMid >= cfg.CLOB_WIN_SETTLEMENT_PRICE
    && upBid != null && upBid <= cfg.CLOB_LOSS_SETTLEMENT_PRICE;
  if (upConfirmed === downConfirmed) return null;
  return upConfirmed ? 'UP' : 'DOWN';
}

function clob297PriceWinner(prices, w, now = Date.now()) {
  if (!w || !w.window) return null;
  const closeMs = windowCloseMs(w);
  const decisionMs = closeMs - cfg.CLOB_EARLY_RESOLUTION_SECONDS_BEFORE_CLOSE * 1000;
  if (now < decisionMs || now >= closeMs) return null;

  const candidates = ['UP', 'DOWN'].filter((side) => {
    const sideQuote = prices && prices[side.toLowerCase()];
    const mid = validPrice(sideQuote && sideQuote.mid);
    return mid != null && mid > cfg.CLOB_EARLY_RESOLUTION_PRICE_USD
      && isFreshQuote(sideQuote, now);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function isFreshQuote(sideQuote, now = Date.now()) {
  const ts = Number(sideQuote && sideQuote.ts);
  return Number.isFinite(ts) && now - ts >= 0 && now - ts <= cfg.PRICE_STALE_MS;
}

function isFreshQuotePair(prices, now = Date.now()) {
  if (!prices || !prices.up || !prices.down) return false;
  return isFreshQuote(prices.up, now) && isFreshQuote(prices.down, now);
}

function validPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function windowCloseMs(w) {
  return (Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000;
}

const round = (value, digits = 2) => Number.isFinite(Number(value))
  ? Math.round(Number(value) * (10 ** digits)) / (10 ** digits) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = Bot;
module.exports.makeWindowState = makeWindowState;