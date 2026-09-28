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
    this.trades = [];                              // recent filled trades, including settled positions
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
      this.w = {
        slug, openTs, status: 'starting', window: null, signal: null, lastAsk: null,
        marketWinner: null, marketWinnerQuote: null,
      };
      this.marketPrices = null;
      this.lastSignal = null;
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
          note: `no order was attempted before the ${cfg.ENTRY_DEADLINE_MS / 1000}s entry cutoff -- void, ladder unchanged` });
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
        note: `last ${cfg.STREAK_LEN} candles all ${sig.colors[0]} -> attempt ${sig.side} order after ${cfg.ENTRY_DELAY_MS / 1000}s (max price $${cfg.PRICE_CAP})` });
    }

    if (w.status !== 'watching' || elapsed < cfg.ENTRY_DELAY_MS) return;

    const side = w.signal.side;
    const token = side === 'UP' ? w.window.tokenUp : w.window.tokenDown;
    const ask = bestAsk(await this.trader.getOrderBook(token));
    w.lastAsk = ask;
    await this._fire(w, side, token, ask);
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

    if (window && this.w?.slug === window.slug && !this.w.marketWinner) {
      const up = quotes.get(window.tokenUp) || quoteFromBook(null);
      const down = quotes.get(window.tokenDown) || quoteFromBook(null);
      const winner = winnerFromMidpoints(up.midpoint, down.midpoint, cfg.SETTLEMENT_PRICE_THRESHOLD);
      if (winner) {
        this.w.marketWinner = winner;
        this.w.marketWinnerQuote = {
          upMidpoint: up.midpoint,
          downMidpoint: down.midpoint,
          updatedAt,
        };
        this._push({ event: 'WINNER_THRESHOLD', slug: window.slug, side: winner,
          note: `${winner} CLOB midpoint reached $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)}; winner latched` });
      }
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
      p.markStatus = p.markPrice === null
        ? 'No two-sided CLOB quote; market value and open P&L are unavailable'
        : 'Marked using the UP/DOWN token bid-ask midpoint';

      const observedWinner = winnerFromMidpoints(up.midpoint, down.midpoint, cfg.SETTLEMENT_PRICE_THRESHOLD);
      if (!p.settlementWinner && observedWinner) {
        p.settlementWinner = observedWinner;
        p.settlementQuote = {
          upMidpoint: up.midpoint,
          downMidpoint: down.midpoint,
          updatedAt,
        };
        this._push({ event: 'WINNER_THRESHOLD', slug: p.slug, side: observedWinner, shares: p.shares,
          note: `${observedWinner} CLOB midpoint reached $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)}; settling this position` });
      }
    }
  }

  async _fire(w, side, token, ask) {
    w.status = 'firing';
    const shares = this._stake(side);
    this._push({ event: 'FIRING', slug: w.slug, side, shares,
      note: `signal confirmed -> attempting ${shares}sh at the available ask (max $${cfg.PRICE_CAP}; FOK); current ask ${ask == null ? 'unavailable' : '$' + ask}` });

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
    const position = {
      id: result.id, tokenId: token, tokenUp: w.window.tokenUp, tokenDown: w.window.tokenDown,
      slug: w.slug, openTs: w.openTs, closeTs: w.window.closeTs, side, shares, price, firedAt: Date.now(),
      status: 'OPEN', winner: null, settlementWinner: w.marketWinner || null,
      settledAt: null, realizedPnl: null,
      settlementQuote: w.marketWinnerQuote ? { ...w.marketWinnerQuote } : null,
      upMidpoint: null, downMidpoint: null, markPrice: null, marketValue: null, unrealizedPnl: null,
      quoteUpdatedAt: null, markStatus: 'Waiting for the first CLOB quote',
    };
    this.pending.push(position);
    this.trades.push(position);
    while (this.trades.length > 100) {
      const settledIndex = this.trades.findIndex((trade) => trade.status !== 'OPEN');
      if (settledIndex === -1) break;
      this.trades.splice(settledIndex, 1);
    }
    if (!this.live) this.walletBalance = this.trader.balance;
    this._push({ event: 'ENTRY_FILLED', slug: w.slug, side, shares, price: round(price, 4),
      note: `filled ${shares}sh ${side} @ ${round(price, 4)} (status ${st || 'n/a'}) -- holding to resolution` });
  }

  _void(w, side, shares, why) {
    w.status = 'void_no_fill';
    this.stats.voidNoFill += 1;
    this._push({ event: 'VOID', slug: w.slug, side, shares, note: `${why} -- void, ladder unchanged` });
  }

  // ---- CLOB midpoint winner-threshold settlement --------------------------------
  async _settlementLoop() {
    while (this._running) {
      await sleep(SETTLEMENT_POLL_MS);
      if (!this.pending.length) continue;
      let now = Date.now();
      const staleDueQuote = this.pending.some((p) => !p.settlementWinner
        && (!p.quoteUpdatedAt || now - p.quoteUpdatedAt > SETTLEMENT_QUOTE_MAX_AGE_MS));
      if (staleDueQuote) {
        await this._refreshMarketData(this.w?.window || null);
        now = Date.now();
      }
      const keep = [];
      for (const p of this.pending) {
        if (!p.settlementWinner) {
          if (!p.settlementWarningLogged && now - p.openTs * 1000 > SETTLEMENT_WARNING_MS) {
            this._push({ event: 'SETTLEMENT_TIMEOUT', slug: p.slug, side: p.side, shares: p.shares,
              note: `${describeSettlement(p)} -- keeping position open and checking again` });
            p.settlementWarningLogged = true;
          }
          keep.push(p);
          continue;
        }
        this._settle(p, p.settlementWinner);
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
    p.status = win ? 'SETTLED_WIN' : 'SETTLED_LOSS';
    p.winner = winner;
    p.realizedPnl = round(pnl, 2);
    p.settledAt = Date.now();
    const quoteDetail = p.settlementQuote
      ? ` UP ${formatMidpoint(p.settlementQuote.upMidpoint)} / DOWN ${formatMidpoint(p.settlementQuote.downMidpoint)}`
      : '';
    this._push({ event: win ? 'SETTLED_WIN' : 'SETTLED_LOSS', slug: p.slug, side: p.side, shares: p.shares,
      pnl: round(pnl, 2),
      note: `${winner} CLOB midpoint reached $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)}${quoteDetail} -- ${outcome} on ${p.side} ${p.shares}sh, est. pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (incl. est. fee) -- next ${p.side} stake ${this._stake(p.side)}sh` });
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
      return {
        slug: p.slug,
        side: p.side,
        shares: p.shares,
        entryPrice: p.price,
        markPrice: p.markPrice,
        marketValue: p.marketValue,
        unrealizedPnl: p.unrealizedPnl,
        markStatus: p.markStatus,
        settlementQuote: p.settlementQuote,
        settlementWinner: p.settlementWinner,
        resultCheck: describeSettlement(p),
        quoteUpdatedAt: p.quoteUpdatedAt,
      };
    });
    const recentTrades = this.trades.slice(-50).reverse().map((p) => {
      const open = p.status === 'OPEN';
      return {
        slug: p.slug,
        side: p.side,
        shares: p.shares,
        openedAt: p.firedAt,
        entryPrice: p.price,
        markPrice: open ? p.markPrice : null,
        marketValue: open ? p.marketValue : null,
        pnl: open ? p.unrealizedPnl : p.realizedPnl,
        pnlType: open ? 'unrealized' : 'realized',
        status: p.status,
        statusDetail: open
          ? `${p.markStatus}; ${describeSettlement(p)}`
          : `Winner ${p.winner} after a CLOB midpoint reached $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)}${p.settlementQuote
            ? ` (UP ${formatMidpoint(p.settlementQuote.upMidpoint)} / DOWN ${formatMidpoint(p.settlementQuote.downMidpoint)})`
            : ''}`,
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
      capitalStatus: capital === null
        ? (positions.length ? 'Equity estimate unavailable because at least one open position has no two-sided midpoint' : 'Waiting for starting capital')
        : 'Estimated from starting capital, realized P&L, and midpoint-marked open positions',
      unrealizedPnl,
      walletAddress: this.trader.depositWallet || this.trader.address,
      window: w ? {
        slug: w.slug,
        status: w.status,
        lastAsk: w.lastAsk,
        side: w.signal ? w.signal.side : null,
         reason: describeWindow(w, now),
        prices: this.marketPrices?.slug === w.slug
          ? { up: this.marketPrices.up, down: this.marketPrices.down, updatedAt: this.marketPrices.updatedAt }
          : null,
      } : null,
      lastSignal: this.lastSignal,
      stakes: { DOWN: this._stake('DOWN'), UP: this._stake('UP') },
      pending: positions,
      trades: recentTrades,
      stats: this.stats,
      log: this.log.slice(-100).reverse(),
    };
  }
}

function describeWindow(w, now) {
  const elapsed = now - w.openTs * 1000;
  const colors = w.signal?.colors?.join('/') || 'not available';
  switch (w.status) {
    case 'starting':
      return 'Waiting for the active market and three closed candles.';
    case 'watching':
      if (elapsed < cfg.ENTRY_DELAY_MS) {
        return `Three-candle ${w.signal.side} signal confirmed; first order attempt in ${Math.ceil((cfg.ENTRY_DELAY_MS - elapsed) / 1000)}s.`;
      }
      return `Three-candle ${w.signal.side} signal confirmed; attempting an order up to $${cfg.PRICE_CAP}.`;
    case 'firing':
      return `Submitting the ${w.signal?.side || ''} FOK order, capped at $${cfg.PRICE_CAP}.`;
    case 'fired':
      return w.marketWinner
        ? `Entry filled. ${w.marketWinner} already reached a $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)} CLOB midpoint.`
        : `Entry filled. Holding until either CLOB midpoint reaches $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)}.`;
    case 'no_signal':
      return `No trade: the last ${cfg.STREAK_LEN} closed candles were ${colors}, not a same-color streak.`;
    case 'void_no_trigger':
      return `Skipped: no entry order was attempted before the ${cfg.ENTRY_DEADLINE_MS / 1000}s cutoff.`;
    case 'void_no_fill':
      return `Signal found, but the FOK order did not fill at or below $${cfg.PRICE_CAP}; no shares were entered.`;
    case 'void_no_data':
      return `Skipped: market or candle data was unavailable before the ${cfg.ENTRY_DEADLINE_MS / 1000}s cutoff.`;
    default:
      return `Window status: ${w.status}.`;
  }
}

function describeSettlement(position) {
  if (position.settlementWinner) {
    return `${position.settlementWinner} midpoint reached $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)}; applying that winner`;
  }
  const up = formatMidpoint(position.upMidpoint);
  const down = formatMidpoint(position.downMidpoint);
  return `No CLOB midpoint has reached $${cfg.SETTLEMENT_PRICE_THRESHOLD.toFixed(2)} yet (UP ${up} / DOWN ${down}); holding open`;
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

function formatMidpoint(value) {
  return Number.isFinite(value) ? `$${value.toFixed(3)}` : 'unavailable';
}

function winnerFromMidpoints(upMidpoint, downMidpoint, threshold) {
  const upWins = Number.isFinite(upMidpoint) && upMidpoint >= threshold;
  const downWins = Number.isFinite(downMidpoint) && downMidpoint >= threshold;
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
