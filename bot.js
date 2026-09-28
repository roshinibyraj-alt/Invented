'use strict';

const cfg = require('./config');
const { fetchClosedCandles, evaluateSignal } = require('./candles');
const { getActiveWindow, currentWindowOpenTs, slugForTs } = require('./polymarket-market');
const { nextStake } = require('./ladder');

const POLL_MS = 1000;
const SETTLEMENT_POLL_MS = 1000;
const SETTLEMENT_WARNING_MS = 15 * 60_000;
const SETTLEMENT_QUOTE_MAX_AGE_MS = 2500;
const MAX_LOG = 300;
const DONE = new Set(['no_signal', 'fired', 'void_no_trigger', 'void_no_fill', 'void_no_data']);

class Bot {
  /** @param trader an authenticated PolymarketTrader */
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.live = !!opts.live;
    this.w = null;                                 // current window state
    this.pending = [];                             // filled bets awaiting real resolution
    this.marketPrices = null;                      // current window's live CLOB quotes
    this.history = { UP: [], DOWN: [], ALL: [] };  // ladder history: {slug, outcome, final}
    this.stats = { wins: 0, losses: 0, noSignal: 0, voidNoTrigger: 0, voidNoFill: 0, voidNoData: 0, realizedPnl: 0 };
    this.lastSignal = null;                        // {colors, side, slug}
    this.walletBalance = null;
    this.startingCapital = this.live ? null : cfg.DEMO_STARTING_CAPITAL;
    this.error = null;
    this.log = [];
    this.startedAt = Date.now();
    this._running = false;
    this._warned = new Set();
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
    if (this._running) return;
    this._running = true;
    this._loop();
    this._settlementLoop();
    this._balanceLoop();
  }

  async _loop() {
    while (this._running) {
      try {
        await this._tick();
      } catch (e) {
        this.error = `tick error: ${e.message}`;
        this._push({ event: 'ERROR', note: this.error });
      }
      await sleep(POLL_MS);
    }
  }

  // ---- sizing --------------------------------------------------------------
  _key(side) { return cfg.SHARED_LADDER ? 'ALL' : side; }

  _stake(side) {
    const outcomes = this.history[this._key(side)].map((h) => h.outcome);
    return nextStake(outcomes, cfg.BASE_SHARES, cfg.MAX_LOSS_DOUBLINGS, cfg.MAX_WIN_DOUBLINGS);
  }

  _setOutcome(side, slug, outcome, final) {
    const arr = this.history[this._key(side)];
    const item = arr.find((h) => h.slug === slug);
    if (!item) arr.push({ slug, outcome, final });
    else if (!item.final || final) { item.outcome = outcome; item.final = final || item.final; }
  }

  // ---- per-window flow -------------------------------------------------------
  async _tick() {
    const now = Date.now();
    const openTs = currentWindowOpenTs(now);
    const slug = slugForTs(openTs);
    if (!this.w || this.w.slug !== slug) {
      this.w = { slug, openTs, status: 'starting', window: null, signal: null, lastAsk: null };
      this.marketPrices = null;
    }
    const w = this.w;
    if (DONE.has(w.status)) {
      if (w.window) await this._refreshMarketData(w.window);
      return;
    }

    const elapsed = now - openTs * 1000;
    if (!w.window) {
      const { window, reason } = await getActiveWindow(now);
      if (!window) {
        this.error = reason;
        await this._refreshMarketData(null);
        if (elapsed > cfg.ENTRY_DEADLINE_MS) {
          w.status = 'void_no_data';
          this.stats.voidNoData += 1;
          this._push({ event: 'VOID', slug, note: `no market/candle data before ${cfg.ENTRY_DEADLINE_MS / 1000}s -- void` });
        }
        return;
      }
      this.error = null;
      w.window = window;
    }

    await this._refreshMarketData(w.window);
    if (elapsed > cfg.ENTRY_DEADLINE_MS) {
      if (w.status === 'watching') {
        w.status = 'void_no_trigger';
        this.stats.voidNoTrigger += 1;
        this._push({ event: 'VOID', slug, side: w.signal.side,
          note: `price never went below ${cfg.PRICE_TRIGGER} before ${cfg.ENTRY_DEADLINE_MS / 1000}s -- void, ladder unchanged` });
      } else {
        w.status = 'void_no_data';
        this.stats.voidNoData += 1;
        this._push({ event: 'VOID', slug, note: `no market/candle data before ${cfg.ENTRY_DEADLINE_MS / 1000}s -- void` });
      }
      return;
    }

    if (!w.signal) {
      let candles;
      try {
        candles = await fetchClosedCandles(now);
      } catch (e) {
        this._warnOnce(`candles-${slug}`, { event: 'ERROR', slug, note: `candle fetch failed: ${e.message} (retrying)` });
        return;
      }
      const sig = evaluateSignal(candles, openTs);
      if (!sig.ready) {
        this._warnOnce(`wait-${slug}`, { event: 'WAIT', slug, note: `signal not ready: ${sig.reason} (retrying)` });
        return;
      }
      w.signal = sig;
      this.lastSignal = { colors: sig.colors, side: sig.side, slug };
      if (!sig.side) {
        w.status = 'no_signal';
        this.stats.noSignal += 1;
        this._push({ event: 'NO_TRADE', slug, note: `last ${cfg.STREAK_LEN} candles ${sig.colors.join('/')} -- no streak` });
        return;
      }
      w.status = 'watching';
      this._push({ event: 'SIGNAL', slug, side: sig.side,
        note: `last ${cfg.STREAK_LEN} candles all ${sig.colors[0]} -> buy ${sig.side} once ask < ${cfg.PRICE_TRIGGER}` });
    }

    if (w.status !== 'watching' || elapsed < cfg.ENTRY_DELAY_MS) return;

    const side = w.signal.side;
    const token = side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    const ask = bestAsk(await this.trader.getOrderBook(token));
    w.lastAsk = ask;
    if (ask !== null && ask < cfg.PRICE_TRIGGER) await this._fire(w, side, token, ask);
  }

  async _refreshMarketData(window) {
    const tokenIds = new Set();
    if (window?.tokenUp) tokenIds.add(window.tokenUp);
    if (window?.tokenDown) tokenIds.add(window.tokenDown);
    for (const p of this.pending) {
      if (p.tokenUp) tokenIds.add(p.tokenUp);
      if (p.tokenDown) tokenIds.add(p.tokenDown);
    }

    const entries = await Promise.all([...tokenIds].map(async (tokenId) => {
      let book = null;
      try { book = await this.trader.getOrderBook(tokenId); } catch (_) {}
      return [tokenId, quoteFromBook(book)];
    }));
    const quotes = new Map(entries);
    const updatedAt = Date.now();

    if (window) {
      this.marketPrices = {
        slug: window.slug,
        up: quotes.get(window.tokenUp) || quoteFromBook(null),
        down: quotes.get(window.tokenDown) || quoteFromBook(null),
        updatedAt,
      };
    }

    for (const p of this.pending) {
      const up = quotes.get(p.tokenUp) || quoteFromBook(null);
      const down = quotes.get(p.tokenDown) || quoteFromBook(null);
      const mark = quotes.get(p.tokenId) || quoteFromBook(null);
      p.upMidpoint = up.midpoint;
      p.downMidpoint = down.midpoint;
      p.markPrice = mark.midpoint;
      p.marketValue = p.markPrice === null ? null : p.shares * p.markPrice;
      const cost = estimatedPositionCost(p);
      p.unrealizedPnl = p.marketValue === null || cost === null ? null : p.marketValue - cost;
      p.quoteUpdatedAt = updatedAt;
    }
  }

  async _fire(w, side, token, ask) {
    w.status = 'firing';
    const shares = this._stake(side);
    this._push({ event: 'FIRING', slug: w.slug, side, shares,
      note: `ask ${ask} < ${cfg.PRICE_TRIGGER} -> buying ${shares}sh at any price (limit ${cfg.PRICE_CAP})` });

    let result;
    try {
      result = await this.trader.placeFokLimitOrder(token, 'BUY', cfg.PRICE_CAP, shares);
    } catch (e) {
      return this._void(w, side, shares, `order rejected/unfilled: ${e.message}`);
    }

    const raw = result.raw || {};
    const st = String(raw.status || result.status || '').toLowerCase();
    let filled = !!result.isFilled || st === 'matched' || st === 'filled';
    if (!filled && result.id) {
      try {
        const o = await this.trader.getOrder(result.id);
        const os = String(o?.status || '').toLowerCase();
        filled = os === 'matched' || os === 'filled' || parseFloat(o?.size_matched || '0') >= shares;
      } catch (_) { /* keep filled=false */ }
    }
    if (!filled) return this._void(w, side, shares, `FOK not filled (status: ${st || 'none'})`);

    // BUY: makingAmount = USDC paid, takingAmount = shares received
    let price = result.avgPrice;
    const paid = parseFloat(raw.makingAmount), got = parseFloat(raw.takingAmount);
    if (paid > 0 && got > 0) price = paid / got;

    w.status = 'fired';
    this.pending.push({
      id: result.id, tokenId: token, tokenUp: w.window.tokenUp, tokenDown: w.window.tokenDown,
      slug: w.slug, openTs: w.openTs, closeTs: w.window.closeTs, side, shares, price, firedAt: Date.now(),
      upMidpoint: null, downMidpoint: null, markPrice: null, marketValue: null, unrealizedPnl: null, quoteUpdatedAt: null,
    });
    if (!this.live) this.walletBalance = this.trader.balance;
    this._push({ event: 'ENTRY_FILLED', slug: w.slug, side, shares, price: round(price, 4),
      note: `filled ${shares}sh ${side} @ ${round(price, 4)} (status ${st || 'n/a'}) -- holding to resolution` });
  }

  _void(w, side, shares, why) {
    w.status = 'void_no_fill';
    this.stats.voidNoFill += 1;
    this._push({ event: 'VOID', slug: w.slug, side, shares, note: `${why} -- void, ladder unchanged` });
  }

  // ---- midpoint-rule settlement --------------------------------------------------
  async _settlementLoop() {
    while (this._running) {
      await sleep(SETTLEMENT_POLL_MS);
      if (!this.pending.length) continue;
      let now = Date.now();
      const staleDueQuote = this.pending.some((p) => {
        const checkAt = p.openTs * 1000 + cfg.SETTLEMENT_CHECK_AFTER_MS;
        return now >= checkAt && (
          !p.quoteUpdatedAt
          || p.quoteUpdatedAt < checkAt
          || now - p.quoteUpdatedAt > SETTLEMENT_QUOTE_MAX_AGE_MS
        );
      });
      if (staleDueQuote) {
        await this._refreshMarketData(this.w?.window || null);
        now = Date.now();
      }
      const keep = [];
      for (const p of this.pending) {
        const checkAt = p.openTs * 1000 + cfg.SETTLEMENT_CHECK_AFTER_MS;
        if (now < checkAt) { keep.push(p); continue; }
        const quoteIsFresh = p.quoteUpdatedAt >= checkAt
          && now - p.quoteUpdatedAt <= SETTLEMENT_QUOTE_MAX_AGE_MS;
        const winner = quoteIsFresh
          ? winnerFromMidpoints(p.upMidpoint, p.downMidpoint, cfg.SETTLEMENT_PRICE_THRESHOLD)
          : null;
        if (!winner) {
          if (!p.settlementWarningLogged && now - checkAt > SETTLEMENT_WARNING_MS) {
            this._push({ event: 'SETTLEMENT_TIMEOUT', slug: p.slug, side: p.side, shares: p.shares,
              note: 'no unique CLOB midpoint above $0.95 yet -- keeping position open and checking again' });
            p.settlementWarningLogged = true;
          }
          keep.push(p);
          continue;
        }
        this._settle(p, winner);
      }
      this.pending = keep;
    }
  }

  _settle(p, winner) {
    const win = winner === p.side;
    const outcome = win ? 'WIN' : 'LOSS';
    if (typeof this.trader.settleDemoOrder === 'function') {
      this.trader.settleDemoOrder(p.id, win);
      this.walletBalance = this.trader.balance;
    }
    this._setOutcome(p.side, p.slug, outcome, true);

    const fee = p.shares * cfg.TAKER_FEE_RATE * p.price * (1 - p.price);
    const cost = p.shares * p.price + fee;
    const pnl = win ? p.shares - cost : -cost;
    if (win) this.stats.wins += 1; else this.stats.losses += 1;
    this.stats.realizedPnl += pnl;
    this._push({ event: win ? 'SETTLED_WIN' : 'SETTLED_LOSS', slug: p.slug, side: p.side, shares: p.shares,
      pnl: round(pnl, 2),
      note: `297s+ CLOB midpoint rule selected ${winner} -- ${outcome} on ${p.side} ${p.shares}sh, est. pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (incl. est. fee) -- next ${p.side} stake ${this._stake(p.side)}sh` });
  }

  async _balanceLoop() {
    while (this._running) {
      try {
        const balance = await this.trader.getBalance();
        if (Number.isFinite(balance)) {
          this.walletBalance = balance;
          if (this.startingCapital === null) this.startingCapital = balance;
        }
      }
      catch (e) { this._push({ event: 'ERROR', note: `balance check failed: ${e.message}` }); }
      await sleep(30_000);
    }
  }

  snapshot() {
    const w = this.w;
    const now = Date.now();
    const positions = this.pending.map((p) => {
      const checkAt = p.openTs * 1000 + cfg.SETTLEMENT_CHECK_AFTER_MS;
      return {
        slug: p.slug,
        side: p.side,
        shares: p.shares,
        entryPrice: p.price,
        markPrice: p.markPrice,
        marketValue: p.marketValue,
        unrealizedPnl: p.unrealizedPnl,
        resultCheck: now < checkAt
          ? `checks in ${Math.ceil((checkAt - now) / 1000)}s`
          : 'waiting for one midpoint above $0.95',
        quoteUpdatedAt: p.quoteUpdatedAt,
      };
    });
    const marksComplete = positions.every((p) => p.unrealizedPnl !== null);
    const unrealizedPnl = marksComplete
      ? positions.reduce((total, p) => total + p.unrealizedPnl, 0)
      : null;
    const capital = this.startingCapital === null || unrealizedPnl === null
      ? null
      : this.startingCapital + this.stats.realizedPnl + unrealizedPnl;
    return {
      mode: this.live ? 'LIVE' : 'DEMO',
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      error: this.error,
      walletBalance: this.walletBalance,
      startingCapital: this.startingCapital,
      capital,
      unrealizedPnl,
      walletAddress: this.trader.depositWallet || this.trader.address,
      window: w ? {
        slug: w.slug,
        status: w.status,
        lastAsk: w.lastAsk,
        side: w.signal ? w.signal.side : null,
        prices: this.marketPrices?.slug === w.slug
          ? { up: this.marketPrices.up, down: this.marketPrices.down, updatedAt: this.marketPrices.updatedAt }
          : null,
      } : null,
      lastSignal: this.lastSignal,
      stakes: { DOWN: this._stake('DOWN'), UP: this._stake('UP') },
      pending: positions,
      stats: this.stats,
      log: this.log.slice(-100).reverse(),
    };
  }
}

function bestAsk(book) {
  const asks = (book && book.asks) || [];
  let best = null;
  for (const a of asks) {
    const p = parseFloat(a.price);
    if (!(p > 0 && p <= 1) || !(parseFloat(a.size) > 0)) continue;
    if (best === null || p < best) best = p;
  }
  return best;
}

function bestBid(book) {
  const bids = (book && book.bids) || [];
  let best = null;
  for (const b of bids) {
    const p = parseFloat(b.price);
    if (!(p > 0 && p <= 1) || !(parseFloat(b.size) > 0)) continue;
    if (best === null || p > best) best = p;
  }
  return best;
}

function quoteFromBook(book) {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return {
    bestBid: bid,
    bestAsk: ask,
    midpoint: bid !== null && ask !== null ? (bid + ask) / 2 : null,
  };
}

function winnerFromMidpoints(upMidpoint, downMidpoint, threshold) {
  if (!Number.isFinite(upMidpoint) || !Number.isFinite(downMidpoint)) return null;
  const upWins = upMidpoint > threshold;
  const downWins = downMidpoint > threshold;
  if (upWins === downWins) return null;
  return upWins ? 'UP' : 'DOWN';
}

function estimatedPositionCost(position) {
  const shares = Number(position.shares);
  const price = Number(position.price);
  if (!Number.isFinite(shares) || shares < 0 || !Number.isFinite(price) || price < 0 || price > 1) return null;
  const fee = shares * cfg.TAKER_FEE_RATE * price * (1 - price);
  return shares * price + fee;
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = Bot;
