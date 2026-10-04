'use strict';

const cfg = require('./config');
const {
  getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS, fetchResolution,
} = require('./polymarket-market');
const startMarketFeed = require('./clob-feed');
const { estimateMakerRebate } = require('./strategy');

const EPSILON = 1e-8;
const MAX_LOG = 300;
const SIDES = ['UP', 'DOWN'];

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
    this._resolveTried = new Map();
    this._clobTried = new Map();
    this._warned = new Set();
    this.stats = {
      wins: 0, losses: 0, pairedEntries: 0,
      estimatedMakerRebates: 0, realizedPnl: 0,
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
    this.currentOrderShares = cfg.BASE_SHARES;
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
        this._warnOnce('paired-strategy-blocked', {
          event: 'LIVE_BLOCKED',
          note: 'Paired limit orders require DemoTrader; no live order methods will be called.',
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
    if (this.w) void this._cancelEntryOrders(this.w, 'BOT_STOP');
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
        w.status = 'preparing_entry_orders';
        this._push({
          event: 'WINDOW_READY', slug: w.slug,
          note: 'BTC 5-minute market active; preparing UP and DOWN resting BUY limits.',
        });
        await this._ensureMarketFeed(w);
      } else {
        this.error = result.reason || 'active market unavailable';
        w.status = 'waiting_for_market';
      }
    }

    if (!w.window) return;
    if (!w.entryOrdersStarted && !w.closed) await this._placeEntryOrders(w);
    if (w.entryOrdersStarted && !w.closed) await this._checkEntryOrders(w);
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
    const next = {
      bid: update && Object.prototype.hasOwnProperty.call(update, 'bid') ? update.bid : previous.bid,
      ask: update && Object.prototype.hasOwnProperty.call(update, 'ask') ? update.ask : previous.ask,
    };
    next.mid = next.bid == null || next.ask == null ? null : (next.bid + next.ask) / 2;
    this._quotesByToken.set(tokenId, next);
    if (typeof this.trader.updateQuote === 'function') this.trader.updateQuote(tokenId, next);
    const up = this._quotesByToken.get(w.window.tokenUp) || emptyQuote();
    const down = this._quotesByToken.get(w.window.tokenDown) || emptyQuote();
    const now = Date.now();
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

    if (w.entryOrdersStarted) {
      void this._checkEntryOrders(w).catch((error) => {
        this._push({ event: 'ENTRY_ORDER_CHECK_ERROR', slug, note: error.message });
      });
    }
    for (const position of this.pending.filter((item) => item.openTs === w.openTs && item.side === side)) {
      const mark = next.bid == null ? next.mid : next.bid;
      if (mark != null && Number.isFinite(Number(mark))) position.lastClobMark = Number(mark);
      if (!this._settlePositionAtClobPrice(position, next.mid, next.bid)) this._recordEquity();
    }
  }

  async _placeEntryOrders(w) {
    if (this.strategyBlocked || !w || this.w !== w || !w.window || w.closed
      || w.entryOrdersStarted || Date.now() >= windowCloseMs(w)) return false;
    w.entryOrdersStarted = true;
    w.orderShares = this.currentOrderShares;
    const requiredPairCost = w.orderShares * cfg.ENTRY_LIMIT_PRICE_USD * SIDES.length;
    if (this.cash == null || this.cash + EPSILON < requiredPairCost) {
      w.status = 'insufficient_cash';
      this._push({
        event: 'ENTRY_PAIR_NO_CASH', slug: w.slug, shares: w.orderShares,
        note: 'Not enough demo cash to cover both ' + w.orderShares + '-share limits at $'
          + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2) + ' each; no orders were posted.',
      });
      return false;
    }

    try {
      for (const side of SIDES) {
        const tokenId = side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
        const result = await this.trader.placeGtcOrder(
          tokenId, 'BUY', cfg.ENTRY_LIMIT_PRICE_USD, w.orderShares,
        );
        if (!result || !result.id) throw new Error(side + ' GTC order returned no order ID');
        w.entryOrders[side] = {
          side, tokenId, orderId: result.id, price: cfg.ENTRY_LIMIT_PRICE_USD,
          shares: w.orderShares, matchedShares: 0, rebateRecorded: 0,
          status: normalizeOrderStatus(result.status || 'LIVE'),
          placedAt: Date.now(), cancelPending: false,
        };
        this._push({
          event: 'ENTRY_LIMIT_POSTED', slug: w.slug, side, shares: w.orderShares,
          price: cfg.ENTRY_LIMIT_PRICE_USD,
          note: 'Posted a ' + w.orderShares + '-share resting BUY limit for ' + side
            + ' at $' + cfg.ENTRY_LIMIT_PRICE_USD.toFixed(2) + '.',
        });
      }
      if (Object.keys(w.entryOrders).length === SIDES.length) await this._checkEntryOrders(w);
      else w.status = 'entry_orders_open';
      this._recordEquity();
      return true;
    } catch (error) {
      await this._cancelEntryOrders(w, 'ENTRY_PAIR_ERROR');
      w.status = 'entry_order_error';
      this._push({
        event: 'ENTRY_PAIR_ERROR', slug: w.slug,
        note: 'Could not establish both sides of the entry pair; canceled any remaining order: ' + error.message,
      });
      return false;
    }
  }

  async _checkEntryOrders(w) {
    if (!w || this.w !== w || !w.entryOrdersStarted || w.closed || w.entryCheckBusy) return false;
    const records = Object.values(w.entryOrders);
    if (!records.length) return false;
    w.entryCheckBusy = true;
    try {
      const observations = await Promise.all(records.map(async (entry) => ({
        entry,
        state: await this.trader.getOrder(entry.orderId).catch(() => null),
      })));
      const newlyMatched = observations
        .filter(({ entry, state }) => state && matchedShares(state) > entry.matchedShares + EPSILON)
        .sort((a, b) => {
          const aTime = Number(a.state.matchedAt) || a.entry.placedAt;
          const bTime = Number(b.state.matchedAt) || b.entry.placedAt;
          return aTime - bTime || SIDES.indexOf(a.entry.side) - SIDES.indexOf(b.entry.side);
        });
      if (!w.entrySide && newlyMatched.length) {
        const first = newlyMatched[0];
        w.entrySide = first.entry.side;
        w.entryTaken = true;
        this._push({
          event: 'OCO_SIDE_FILLED', slug: w.slug, side: w.entrySide,
          note: w.entrySide + ' filled first; canceling the opposite resting order.',
        });
        this._applyEntryOrderState(w, first.entry, first.state);
        await this._cancelOtherEntryOrder(w, w.entrySide);
        // Reconcile the selected side from the fetched snapshot. The opposite
        // side is refreshed by _cancelOtherEntryOrder after cancellation.
        for (const { entry, state } of observations) {
          if (entry.side === w.entrySide && state) this._applyEntryOrderState(w, entry, state);
        }
      } else {
        for (const { entry, state } of observations) {
          if (state) this._applyEntryOrderState(w, entry, state);
        }
      }

      if (w.entrySide) {
        w.status = this._activePositions(w).length ? 'position_open' : 'entry_filled';
      } else if (records.every((entry) => ['CANCELED', 'CANCELLED', 'FILLED'].includes(entry.status))) {
        w.status = 'entry_orders_closed';
      } else {
        w.status = 'entry_orders_open';
      }
      return !!w.entrySide;
    } finally {
      w.entryCheckBusy = false;
    }
  }

  _applyEntryOrderState(w, entry, state) {
    const matched = Math.max(0, Math.min(entry.shares, matchedShares(state)));
    const delta = Math.max(0, matched - entry.matchedShares);
    entry.status = normalizeOrderStatus(state.status || entry.status);
    if (matched >= entry.shares - EPSILON) entry.status = 'FILLED';
    else if (matched > EPSILON && entry.status === 'LIVE') entry.status = 'PARTIALLY_FILLED';
    if (delta <= EPSILON) {
      entry.matchedShares = Math.max(entry.matchedShares, matched);
      return;
    }

    if (!w.entrySide) {
      w.entrySide = entry.side;
      w.entryTaken = true;
    } else if (w.entrySide !== entry.side) {
      this._push({
        event: 'OCO_RACE_FILL', slug: w.slug, side: entry.side, shares: round(delta, 4),
        note: 'The opposite order also filled before cancellation completed; recording both demo fills.',
      });
    }

    const price = positive(state.price) || entry.price;
    const notional = delta * price;
    const reportedRebate = Number(state.makerRebateEstimate);
    const cumulativeRebate = Number.isFinite(reportedRebate)
      ? Math.max(entry.rebateRecorded, reportedRebate)
      : entry.rebateRecorded + estimateMakerRebate(delta, price);
    const rebateDelta = Math.max(0, cumulativeRebate - entry.rebateRecorded);
    entry.rebateRecorded = cumulativeRebate;
    entry.matchedShares = matched;

    let position = w.positions.find((item) => item.side === entry.side && !item.settled);
    if (!position) {
      position = makePosition(w, entry);
      w.positions.push(position);
      this.pending.push(position);
      if (!w.position) w.position = position;
    }
    position.shares += delta;
    position.openShares += delta;
    position.entryNotional += notional;
    position.entryPrice = position.shares > 0 ? position.entryNotional / position.shares : entry.price;
    position.makerRebateEstimate += rebateDelta;
    position.cost = position.entryNotional;
    position.lastClobMark = entry.side === 'UP'
      ? (this.prices && this.prices.up && this.prices.up.bid) || price
      : (this.prices && this.prices.down && this.prices.down.bid) || price;
    position.orderShares = entry.shares;
    position.status = position.openShares >= position.orderShares - EPSILON
      ? 'position_open' : 'partially_filled';
    this.cash -= notional;
    this.stats.estimatedMakerRebates += rebateDelta;
    w.entryTaken = true;
    this.stats.pairedEntries += 1;
    this._recordEquity();
    this._push({
      event: 'ENTRY_LIMIT_FILLED', slug: w.slug, side: entry.side,
      shares: round(delta, 4), price: round(price, 4),
      rebate: round(rebateDelta, 5),
      note: 'Resting BUY fill: ' + round(delta, 4) + ' ' + entry.side
        + ' shares at $' + price.toFixed(2) + '.'
        + (rebateDelta > 0 ? ' Estimated maker rebate $' + rebateDelta.toFixed(5) + '.' : ''),
    });
  }

  async _cancelOtherEntryOrder(w, filledSide) {
    const otherSide = filledSide === 'UP' ? 'DOWN' : 'UP';
    const entry = w.entryOrders[otherSide];
    if (!entry || entry.cancelPending
      || !['LIVE', 'PARTIALLY_FILLED', 'OPEN'].includes(entry.status)) return;
    entry.cancelPending = true;
    try {
      await this.trader.cancelOrder(entry.orderId);
      const state = await this.trader.getOrder(entry.orderId).catch(() => null);
      if (state) this._applyEntryOrderState(w, entry, state);
      if (entry.status === 'LIVE' || entry.status === 'PARTIALLY_FILLED') entry.status = 'CANCELED';
      this._push({
        event: 'OCO_CANCEL', slug: w.slug, side: otherSide,
        note: 'Canceled the unfilled ' + otherSide + ' resting BUY after ' + filledSide + ' filled.',
      });
    } catch (error) {
      entry.cancelPending = false;
      this._push({
        event: 'OCO_CANCEL_ERROR', slug: w.slug, side: otherSide,
        note: 'Could not confirm cancellation of the ' + otherSide + ' order: ' + error.message,
      });
    }
  }

  async _cancelEntryOrders(w, reason) {
    if (!w || !w.entryOrders) return;
    for (const entry of Object.values(w.entryOrders)) {
      try {
        const before = await this.trader.getOrder(entry.orderId).catch(() => null);
        if (before) this._applyEntryOrderState(w, entry, before);
        if (['LIVE', 'PARTIALLY_FILLED', 'OPEN'].includes(entry.status)) {
          await this.trader.cancelOrder(entry.orderId);
          const after = await this.trader.getOrder(entry.orderId).catch(() => null);
          if (after) this._applyEntryOrderState(w, entry, after);
          if (entry.status === 'LIVE' || entry.status === 'PARTIALLY_FILLED') entry.status = 'CANCELED';
          this._push({
            event: 'ENTRY_LIMIT_CANCELED', slug: w.slug, side: entry.side,
            note: 'Canceled the remaining ' + entry.side + ' entry order (' + reason + ').',
          });
        }
      } catch (error) {
        this._push({
          event: 'ENTRY_CANCEL_ERROR', slug: w.slug, side: entry.side,
          note: 'Could not cancel the ' + entry.side + ' entry order: ' + error.message,
        });
      }
    }
  }

  async _closeWindow(w) {
    if (!w || w.closed || w.closing) return;
    w.closing = true;
    if (w.entryOrdersStarted) {
      await this._checkEntryOrders(w);
      await this._cancelEntryOrders(w, 'WINDOW_CLOSED');
    }
    const positions = this._activePositions(w);
    if (positions.length) {
      for (const position of positions) {
        position.status = 'awaiting_resolution';
        this._push({
          event: 'EXPIRY_HOLD', slug: w.slug, side: position.side,
          shares: round(position.openShares, 4),
          note: 'Window closed; remaining shares are watched for CLOB thresholds, then official resolution.',
        });
      }
    }
    w.closed = true;
    w.closing = false;
    w.status = positions.length ? 'awaiting_resolution' : 'window_closed';
    this._push({
      event: 'WINDOW_CLOSED', slug: w.slug,
      note: 'Window ended; no new entry orders will be placed.',
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
    for (const position of this.pending.slice()) {
      if (position.settled) continue;
      const closeTime = Number(position.closeTs) * 1000;
      const activeWindow = this.w && this.w.openTs === position.openTs && !this.w.closed;
      if (activeWindow && this.prices && this.prices.slug === position.slug
        && now - this.prices.ts <= cfg.PRICE_STALE_MS) {
        const currentQuote = position.side === 'UP' ? this.prices.up : this.prices.down;
        if (currentQuote) {
          const mark = currentQuote.bid == null ? currentQuote.mid : currentQuote.bid;
          if (mark != null && Number.isFinite(Number(mark))) position.lastClobMark = Number(mark);
        }
        if (currentQuote
          && this._settlePositionAtClobPrice(position, currentQuote.mid, currentQuote.bid)) continue;
      }
      if (now < closeTime) continue;
      if (this.w && this.w.openTs === position.openTs && !this.w.closed) {
        if (this.w.closing) continue;
        await this._closeWindow(this.w);
      }

      let winner = this.outcomes.get(position.openTs)?.winner || null;
      const lastClobCheck = this._clobTried.get(position) || 0;
      if (!winner && now - lastClobCheck >= cfg.RESOLUTION_RETRY_MS) {
        this._clobTried.set(position, now);
        try {
          const heldQuote = quote(await this.trader.getOrderBook(position.tokenId));
          const mark = heldQuote.bid == null ? heldQuote.mid : heldQuote.bid;
          if (mark != null && Number.isFinite(Number(mark))) position.lastClobMark = Number(mark);
          if (this._settlePositionAtClobPrice(position, heldQuote.mid, heldQuote.bid)) continue;
          this._recordEquity();
        } catch (error) {
          this._warnOnce('clob-settlement-' + position.slug, {
            event: 'ERROR', slug: position.slug,
            note: 'CLOB threshold check failed; waiting for another quote or official result: ' + error.message,
          });
        }
      }

      const lastTried = this._resolveTried.get(position.openTs) || 0;
      if (!winner && now - lastTried >= cfg.RESOLUTION_RETRY_MS) {
        this._resolveTried.set(position.openTs, now);
        try { winner = await fetchResolution(position.slug); }
        catch (error) {
          this._warnOnce('resolution-' + position.openTs, {
            event: 'ERROR', slug: position.slug,
            note: 'Official result lookup failed: ' + error.message,
          });
        }
        if (winner) this._recordOutcome(position.openTs, position.slug, winner);
      }
      if (winner !== 'UP' && winner !== 'DOWN') continue;
      const payout = winner === position.side ? position.openShares : 0;
      this.cash += payout + position.makerRebateEstimate;
      position.exitProceeds += payout;
      position.openShares = 0;
      position.resolutionPayout = payout;
      this._removeFromWindow(position);
      this._finalizePosition(position, winner === position.side ? 'WIN' : 'LOSS', 'RESOLUTION', winner);
      this._resolveTried.delete(position.openTs);
      this._clobTried.delete(position);
    }
  }

  _settlePositionAtClobPrice(position, midpoint, bestBid) {
    if (!position || position.settled || position.openShares <= EPSILON) return false;
    const mid = midpoint == null || midpoint === '' ? null : Number(midpoint);
    const bid = bestBid == null || bestBid === '' ? null : Number(bestBid);
    const validMid = Number.isFinite(mid) && mid >= 0 && mid <= 1 ? mid : null;
    const validBid = Number.isFinite(bid) && bid >= 0 && bid <= 1 ? bid : null;
    const won = validMid != null && validMid >= cfg.CLOB_WIN_SETTLEMENT_PRICE;
    const lost = validBid != null && validBid <= cfg.CLOB_LOSS_SETTLEMENT_PRICE;
    if (!won && !lost) return false;

    const settlementPrice = won ? validMid : validBid;
    const settlementBasis = won ? 'MIDPOINT' : 'BEST_BID';
    const remainingShares = position.openShares;
    const payout = won ? remainingShares : 0;
    const winner = won ? position.side : (position.side === 'UP' ? 'DOWN' : 'UP');
    this.cash += payout + position.makerRebateEstimate;
    position.exitProceeds += payout;
    position.openShares = 0;
    position.resolutionPayout = payout;
    position.clobThresholdPrice = settlementPrice;
    position.clobSettlementBasis = settlementBasis;
    this._clobTried.delete(position);
    this._resolveTried.delete(position.openTs);
    this._recordOutcome(position.openTs, position.slug, winner);
    this._removeFromWindow(position);
    this._push({
      event: 'CLOB_THRESHOLD_SETTLEMENT',
      slug: position.slug,
      side: position.side,
      price: round(settlementPrice, 4),
      settlementBasis,
      shares: round(remainingShares, 4),
      payout: round(payout, 2),
      note: 'Held-side CLOB ' + (won ? 'midpoint' : 'best bid') + ' reached $'
        + settlementPrice.toFixed(4) + '; demo settlement counts ' + round(remainingShares, 4)
        + ' remaining shares at $' + (won ? '1.00' : '0.00') + ' each.',
    });
    this._finalizePosition(position, won ? 'WIN' : 'LOSS', 'CLOB_THRESHOLD', winner);
    return true;
  }

  _removeFromWindow(position) {
    if (!this.w || this.w.openTs !== position.openTs) return;
    this.w.positions = this.w.positions.filter((item) => item !== position);
    if (this.w.position === position) this.w.position = this.w.positions[0] || null;
    const active = this._activePositions(this.w);
    this.w.status = active.length ? 'position_open'
      : (this.w.entrySide ? 'position_settled' : this.w.closed ? 'window_closed' : 'entry_orders_closed');
  }

  _recordOutcome(openTs, slug, winner) {
    if (this.outcomes.has(openTs)) return;
    this.outcomes.set(openTs, { winner, source: 'clob-or-official', price: 1, loser: 0 });
    this.counts[winner] = (this.counts[winner] || 0) + 1;
    if (this.outcomes.size > 60) this.outcomes.delete(this.outcomes.keys().next().value);
    this._push({ event: 'OUTCOME', slug, side: winner, note: 'Window outcome recorded as ' + winner + '.' });
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
      this.currentOrderShares = cfg.BASE_SHARES;
    } else if (outcome === 'LOSS') {
      this.stats.losses += 1;
      this.currentOrderShares += cfg.SHARES_INCREMENT_AFTER_LOSS;
    }
    const trade = {
      slug: position.slug, openTs: position.openTs, side: position.side,
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
      nextShares: this.currentOrderShares,
      note: reason + ' · ' + outcome + ' · demo P&L '
        + (pnl >= 0 ? '+' : '') + '$' + round(pnl, 2)
        + '; next stake is ' + this.currentOrderShares + ' shares.',
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
        ? position.entryNotional * (position.openShares / position.shares) : 0;
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
        entrySide: w.entrySide,
        orderShares: w.orderShares || this.currentOrderShares,
        positions: this._activePositions(w).map((position) => ({
          side: position.side, openShares: position.openShares, entryPrice: position.entryPrice,
        })),
        positionSide: w.entrySide || null,
        openShares: this._activePositions(w).reduce((sum, position) => sum + position.openShares, 0),
        entryOrders: Object.values(w.entryOrders).map((entry) => ({
          side: entry.side, price: entry.price, shares: entry.shares,
          matchedShares: entry.matchedShares, status: entry.status,
        })),
        entryTaken: !!w.entryTaken,
      } : null,
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      strategy: {
        baseShares: cfg.BASE_SHARES,
        sharesIncrementAfterLoss: cfg.SHARES_INCREMENT_AFTER_LOSS,
        currentOrderShares: this.currentOrderShares,
        demoCapital: cfg.DEMO_CAPITAL,
        entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
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
        baseShares: cfg.BASE_SHARES,
        sharesIncrementAfterLoss: cfg.SHARES_INCREMENT_AFTER_LOSS,
        currentOrderShares: this.currentOrderShares,
        entryLimitPrice: cfg.ENTRY_LIMIT_PRICE_USD,
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
    entryOrders: {}, entryOrdersStarted: false, entryCheckBusy: false,
    entrySide: null, entryTaken: false, orderShares: null,
  };
}

function makePosition(w, entry) {
  return {
    slug: w.slug, openTs: w.openTs,
    closeTs: Number(w.window.closeTs) || w.openTs + WINDOW_SECONDS,
    side: entry.side, tokenId: entry.tokenId,
    orderShares: entry.shares, shares: 0, openShares: 0,
    entryPrice: entry.price, entryNotional: 0,
    makerRebateEstimate: 0, entryFee: 0, exitFees: 0, cost: 0,
    exitProceeds: 0, status: 'position_open', firedAt: Date.now(),
    lastClobMark: entry.price, settled: false,
  };
}

function emptyQuote() { return { bid: null, ask: null, mid: null }; }

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
  return { bid, ask, mid: bid == null || ask == null ? null : (bid + ask) / 2 };
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function matchedShares(order) {
  return Math.max(0, Number(order && (order.size_matched ?? order.matchedShares)) || 0);
}

function normalizeOrderStatus(status) {
  const value = String(status || 'LIVE').toUpperCase();
  if (value === 'MATCHED' || value === 'FILLED') return 'FILLED';
  if (value === 'CANCELLED') return 'CANCELED';
  return value;
}

function windowCloseMs(w) {
  return (Number(w.window && w.window.closeTs) || w.openTs + WINDOW_SECONDS) * 1000;
}

const round = (value, digits = 2) => Number.isFinite(Number(value))
  ? Math.round(Number(value) * (10 ** digits)) / (10 ** digits) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = Bot;
module.exports.makeWindowState = makeWindowState;