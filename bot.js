'use strict';

const cfg = require('./config');
const { getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS } = require('./polymarket-market');
const { fetchWindowCandles } = require('./btc-candles');
const { getPullbackSignal } = require('./candle-strategy');

const POLL_MS = 1000;
const SETTLEMENT_POLL_MS = 1000;
const SETTLEMENT_GIVE_UP_MS = 15 * 60_000;
const MAX_LOG = 300;
const WINDOW_MS = WINDOW_SECONDS * 1000;
const RESOLVE_RETRY_MS = 3000;
const DONE = new Set(['no_signal', 'fired', 'void_no_fill', 'void_no_data']);

class Bot {
  /** @param trader an authenticated PolymarketTrader */
  constructor(trader, opts = {}) {
    this.trader = trader;
    this.live = !!opts.live;
    this.getCandles = opts.getCandles || fetchWindowCandles;
    this.w = null;                                 // current window state
    this.pending = [];                             // filled bets awaiting real resolution
    this.stats = { wins: 0, losses: 0, noSignal: 0, voidNoFill: 0, voidNoData: 0, realizedPnl: 0 };
    this.outcomes = new Map();                     // window openTs -> {winner:'UP'|'DOWN', source:'price'|'resolution'}
    this._resolveTried = new Map();                // openTs -> last official-resolution lookup time
    this.lastSignal = null;                        // most recent BTC candle signal
    this.walletBalance = null;
    this.error = null;
    this.log = [];
    this.startedAt = Date.now();
    this.capital = this.live ? null : cfg.DEMO_CAPITAL;   // demo: fixed play money; live: first wallet balance seen
    this.cash = this.live ? null : cfg.DEMO_CAPITAL;
    this.trades = [];                              // settled trades (newest last)
    this.equity = [{ ts: Date.now(), v: this.capital }];
    this.peak = this.capital; this.maxDD = 0;
    this.prices = null;                            // live UP/DOWN quotes for the current window
    this.priceSeries = []; this._seriesSlug = null;
    this.counts = { UP: 0, DOWN: 0 };              // how many windows each side has won this session
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
    this._priceLoop();
  }

  async _loop() {
    while (this._running) {
      try {
        await this._tick();
      } catch (e) {
        this.error = `tick error: ${e.message}`;
        this._push({ event: 'ERROR', note: this.error });
      }
      // poll faster during the last seconds of a window, when winners are decided
      const inWindowMs = Date.now() % WINDOW_MS;
      await sleep(inWindowMs >= WINDOW_MS - cfg.END_WATCH_MS ? 400 : POLL_MS);
    }
  }

  /** Live UP/DOWN prices every second (bid / ask / mid) for the dashboard + chart. */
  async _priceLoop() {
    while (this._running) {
      const w = this.w;
      if (w && w.window) {
        try {
          const [bu, bd] = await Promise.all([this.trader.getOrderBook(w.window.tokenUp), this.trader.getOrderBook(w.window.tokenDown)]);
          const up = quote(bu), down = quote(bd);
          this.prices = { slug: w.slug, ts: Date.now(), up, down };
          if (this._seriesSlug !== w.slug) { this._seriesSlug = w.slug; this.priceSeries = []; }
          if (up.mid != null && down.mid != null) {
            this.priceSeries.push({ t: Math.round((Date.now() - w.openTs * 1000) / 1000), up: round(up.mid, 3), down: round(down.mid, 3) });
          }
        } catch (_) { /* keep last quote */ }
      }
      await sleep(1000);
    }
  }

  // ---- per-window flow -------------------------------------------------------
  async _tick() {
    const now = Date.now();
    const openTs = currentWindowOpenTs(now);
    const slug = slugForTs(openTs);
    if (!this.w || this.w.slug !== slug) {
      const previous = this.w;
      if (previous && !DONE.has(previous.status) && previous.status !== 'firing') {
        if (!previous.window || !previous.hasCandleData) {
          this._voidNoData(previous, 'BTC 5-minute candle data was unavailable before the window ended');
        } else {
          this._skipNoSignal(previous, 'no qualifying BTC pullback with a fresh side ask below ' + (cfg.MAX_ENTRY_ASK * 100) + '¢ before this window closed');
        }
      }
      this.w = { slug, openTs, status: 'starting', window: null, signal: null, candleSetup: null,
        hasCandleData: false, outcomeDone: false };
    }
    const w = this.w;
    const elapsed = now - openTs * 1000;

    if (!w.window) {
      const { window, reason } = await getActiveWindow(now);
      if (window) { this.error = null; w.window = window; } else { this.error = reason; }
    }

    // Track every window winner during the closing seconds for settlement and dashboard history.
    if (w.window && !w.outcomeDone && elapsed >= WINDOW_MS - cfg.END_WATCH_MS) await this._watchEnd(w);

    await this._entryStep(w, elapsed);
  }

  /** Last END_WATCH_MS of the window: a side priced above WIN_PRICE is the winner. */
  async _watchEnd(w) {
    let books;
    try {
      books = await Promise.all([this.trader.getOrderBook(w.window.tokenUp), this.trader.getOrderBook(w.window.tokenDown)]);
    } catch (_) { return; }
    const up = sidePrice(books[0]);
    const down = sidePrice(books[1]);
    const upWins = up !== null && up > cfg.WIN_PRICE;
    const downWins = down !== null && down > cfg.WIN_PRICE;
    if (upWins === downWins) return;                 // neither (or both, nonsense) -- keep watching
    this._setWindowOutcome(w.openTs, upWins ? 'UP' : 'DOWN', 'price', upWins ? up : down, upWins ? down : up);
    w.outcomeDone = true;
  }

  _setWindowOutcome(openTs, winner, source, price, loser) {
    if (this.outcomes.has(openTs)) return;
    this.outcomes.set(openTs, { winner, source, price: price == null ? null : round(price, 3), loser: loser == null ? null : round(loser, 3) });
    this.counts[winner] += 1;
    if (this.outcomes.size > 60) this.outcomes.delete(this.outcomes.keys().next().value);
    this._push({ event: 'OUTCOME', slug: slugForTs(openTs), side: winner,
      note: `${winner} won: price ${round(price, 3)} > ${cfg.WIN_PRICE} in last ${cfg.END_WATCH_MS / 1000}s, ${winner === 'UP' ? 'DOWN' : 'UP'} lost at ${loser == null ? '~0' : round(loser, 3)}` });
  }

  async _entryStep(w, elapsed) {
    if (DONE.has(w.status) || w.status === 'firing') return;
    if (!w.window) return;
    if (elapsed >= WINDOW_MS) return this._skipNoSignal(w, '5-minute window closed before the BTC and side-price filters passed');
    if (elapsed < cfg.ENTRY_DELAY_MS) return;

    w.status = 'armed';
    let candles;
    try {
      candles = await this.getCandles(w.openTs);
    } catch (e) {
      w.candleSetup = { ready: false, reason: e.message, elapsedMs: elapsed };
      this._warnOnce('btc-feed:' + w.slug, { event: 'ERROR', slug: w.slug,
        note: 'BTC 5-minute candle feed unavailable: ' + e.message });
      return;
    }
    if (!candles || !candles.previous || !candles.current) {
      w.candleSetup = { ready: false, reason: 'waiting for the aligned live BTC 5-minute candle', elapsedMs: elapsed };
      return;
    }

    const previous = candles.previous, current = candles.current;
    w.hasCandleData = true;
    const previousColor = previous.close > previous.open ? 'GREEN'
      : previous.close < previous.open ? 'RED' : 'DOJI';
    const side = getPullbackSignal(previous, current);
    const prior = { open: previous.open, high: previous.high, low: previous.low, close: previous.close, openTs: previous.openTs };
    const live = { price: current.close, high: current.high, low: current.low, openTs: current.openTs };

    // Require a fresh best ask for the signalled Polymarket side, strictly below the configured threshold.
    const quoteState = this.prices;
    const quoteFresh = !!quoteState && quoteState.slug === w.slug && Date.now() - quoteState.ts <= 3000;
    const sideQuote = side && quoteFresh ? (side === 'UP' ? quoteState.up : quoteState.down) : null;
    const sideAsk = sideQuote && Number.isFinite(sideQuote.ask) ? sideQuote.ask : null;
    const priceQualified = side !== null && sideAsk !== null && sideAsk < cfg.MAX_ENTRY_ASK;
    w.candleSetup = { ready: true, previousColor, previous: prior, current: live, side,
      sideAsk, priceQualified, elapsedMs: elapsed };
    if (!side || !priceQualified) return;

    w.signal = { side, previousColor, previousClose: previous.close, currentPrice: current.close, sideAsk };
    this.lastSignal = { slug: w.slug, side, previousColor, previousClose: previous.close,
      previousBoundary: side === 'UP' ? previous.low : previous.high, currentPrice: current.close, sideAsk, ts: Date.now() };
    this._push({ event: 'SIGNAL', slug: w.slug, side, shares: cfg.BASE_SHARES,
      note: 'BTC pullback and ' + side + ' best ask ' + (sideAsk * 100).toFixed(1) + '¢ below ' + (cfg.MAX_ENTRY_ASK * 100) + '¢; fixed ' + cfg.BASE_SHARES + 'sh' });
    await this._fire(w, side, side === 'UP' ? w.window.tokenUp : w.window.tokenDown,
      Math.min(cfg.PRICE_CAP, sideAsk));
  }

  _skipNoSignal(w, why) {
    if (DONE.has(w.status)) return;
    w.status = 'no_signal';
    this.stats.noSignal += 1;
    this._push({ event: 'NO_TRADE', slug: w.slug, note: why });
  }

  _voidNoData(w, why) {
    w.status = 'void_no_data';
    this.stats.voidNoData += 1;
    this._push({ event: 'VOID', slug: w.slug, note: why });
  }

  async _fire(w, side, token, priceLimit = cfg.PRICE_CAP) {
    const orderLimit = Number.isFinite(priceLimit) ? Math.min(cfg.PRICE_CAP, priceLimit) : cfg.PRICE_CAP;
    w.status = 'firing';
    const shares = cfg.BASE_SHARES;
    this._push({ event: 'FIRING', slug: w.slug, side, shares,
      note: 'buying fixed ' + shares + 'sh ' + side + ' (FOK limit ' + orderLimit + ')' });

    let result;
    try {
      result = await this.trader.placeFokLimitOrder(token, 'BUY', orderLimit, shares);
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

    const fee = shares * cfg.TAKER_FEE_RATE * price * (1 - price);
    const cost = shares * price + fee;
    if (!this.live && cost > this.cash) return this._void(w, side, shares, `demo balance too low ($${this.cash.toFixed(2)} < $${cost.toFixed(2)})`);
    if (!this.live) this.cash -= cost;

    w.status = 'fired';
    this.pending.push({ slug: w.slug, openTs: w.openTs, closeTs: w.window.closeTs, side, shares, price, fee, cost, firedAt: Date.now() });
    this._push({ event: 'ENTRY_FILLED', slug: w.slug, side, shares, price: round(price, 4),
      note: `filled ${shares}sh ${side} @ ${round(price, 4)} (status ${st || 'n/a'}) -- holding to resolution` });
  }

  _void(w, side, shares, why) {
    w.status = 'void_no_fill';
    this.stats.voidNoFill += 1;
    this._push({ event: 'VOID', slug: w.slug, side, shares, note: `${why} -- void, no position opened` });
  }

  // ---- real settlement -----------------------------------------------------------
  async _settlementLoop() {
    while (this._running) {
      await sleep(SETTLEMENT_POLL_MS);
      if (!this.pending.length) continue;
      const now = Date.now();
      const keep = [];
      for (const p of this.pending) {
        if (now < p.closeTs * 1000) { keep.push(p); continue; }
        const o = this.outcomes.get(p.openTs);       // winner read from the last-seconds price
        const winner = o ? o.winner : null;
        if (winner === null) {
          if (now - p.firedAt > SETTLEMENT_GIVE_UP_MS) {
            this._push({ event: 'SETTLEMENT_TIMEOUT', slug: p.slug, side: p.side, shares: p.shares,
              note: `winner never observed (no side above ${cfg.WIN_PRICE}) -- position left unsettled, check manually` });
          } else keep.push(p);
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
    p.final = true;

    const fee = p.fee, cost = p.cost;
    const pnl = win ? p.shares - cost : -cost;
    if (win) this.stats.wins += 1; else this.stats.losses += 1;
    this.stats.realizedPnl += pnl;
    if (win && !this.live) this.cash += p.shares;      // winning shares pay $1 each
    this.trades.push({ slug: p.slug, openTs: p.openTs, side: p.side, winner, outcome, shares: p.shares,
      price: round(p.price, 4), cost: round(cost, 2), fee: round(fee, 3), pnl: round(pnl, 2), ts: Date.now() });
    if (this.trades.length > 200) this.trades.shift();
    if (this.capital != null) {
      const eq = this.capital + this.stats.realizedPnl;
      this.equity.push({ ts: Date.now(), v: round(eq, 2) });
      if (this.equity.length > 500) this.equity.shift();
      this.peak = Math.max(this.peak, eq);
      this.maxDD = Math.max(this.maxDD, this.peak - eq);
    }
    this._push({ event: win ? 'SETTLED_WIN' : 'SETTLED_LOSS', slug: p.slug, side: p.side, shares: p.shares,
      pnl: round(pnl, 2),
      note: winner + ' won ($1/share) -- ' + outcome + ' on ' + p.side + ' ' + p.shares + 'sh, est. pnl ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' (incl. est. fee)' });
  }

  async _balanceLoop() {
    while (this._running) {
      try {
        this.walletBalance = await this.trader.getBalance();
        if (this.live && this.capital == null && this.walletBalance != null) {
          this.capital = this.walletBalance; this.peak = this.capital; this.equity = [{ ts: Date.now(), v: this.capital }];
        }
      }
      catch (e) { this._push({ event: 'ERROR', note: `balance check failed: ${e.message}` }); }
      await sleep(30_000);
    }
  }

  snapshot() {
    const w = this.w, px = this.prices, now = Date.now();
    const pending = this.pending.slice(-10).map((p) => {
      const mark = px && px.slug === p.slug ? (p.side === 'UP' ? px.up.mid : px.down.mid) : null;
      return { ...p, mark, unrealized: mark != null ? p.shares * mark - p.cost : null };
    });
    const openValue = pending.reduce((s, p) => s + (p.mark != null ? p.shares * p.mark : p.cost), 0);
    const cash = this.live ? this.walletBalance : this.cash;
    const tradeBy = new Map(this.trades.map((t) => [t.openTs, t]));
    const pendBy = new Map(this.pending.map((p) => [p.openTs, p]));
    return {
      now,
      mode: this.live ? 'LIVE' : 'DEMO',
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      error: this.error,
      walletBalance: this.walletBalance,
      walletAddress: this.trader.depositWallet || this.trader.address,
      account: { capital: this.capital, cash, openValue, equity: cash == null ? null : cash + openValue, maxDrawdown: this.maxDD },
      window: w ? { slug: w.slug, status: w.status, side: w.signal ? w.signal.side : null, openTs: w.openTs, closeTs: w.openTs + WINDOW_SECONDS } : null,
      candleSetup: w ? w.candleSetup : null,
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      counts: this.counts,
      recentOutcomes: [...this.outcomes.entries()].slice(-24).map(([t, o]) => {
        const tr = tradeBy.get(t), pd = pendBy.get(t);
        return { openTs: t, winner: o.winner, source: o.source, price: o.price, loser: o.loser,
          traded: tr ? tr.side : pd ? pd.side : null, result: tr ? tr.outcome : null, pnl: tr ? tr.pnl : null };
      }),
      lastSignal: this.lastSignal,
      pending,
      trades: this.trades.slice(-60).reverse(),
      equity: this.equity,
      stats: this.stats,
      cfg: { base: cfg.BASE_SHARES, maxEntryAsk: cfg.MAX_ENTRY_ASK, winPrice: cfg.WIN_PRICE, endWatchMs: cfg.END_WATCH_MS, entryDelayMs: cfg.ENTRY_DELAY_MS, windowSec: WINDOW_SECONDS },
      log: this.log.slice(-100).reverse(),
    };
  }
}

/** Best bid / best ask / mid of one order book (mid falls back to the bid when there are no asks). */
function quote(book) {
  const num = (x) => parseFloat(x);
  const bids = ((book && book.bids) || []).filter((b) => num(b.price) > 0 && num(b.size) > 0).map((b) => num(b.price));
  const asks = ((book && book.asks) || []).filter((a) => num(a.price) > 0 && num(a.size) > 0).map((a) => num(a.price));
  const bid = bids.length ? Math.max(...bids) : null, ask = asks.length ? Math.min(...asks) : null;
  return { bid, ask, mid: bid == null ? null : ask == null ? bid : (bid + ask) / 2 };
}

/** A side's price = mid of best bid/ask; with no asks, the best bid. No bids -> null (nobody would pay). */
function sidePrice(book) {
  const num = (x) => parseFloat(x);
  const bids = ((book && book.bids) || []).filter((b) => num(b.price) > 0 && num(b.size) > 0).map((b) => num(b.price));
  const asks = ((book && book.asks) || []).filter((a) => num(a.price) > 0 && num(a.size) > 0).map((a) => num(a.price));
  if (!bids.length) return null;
  const bid = Math.max(...bids);
  return asks.length ? (bid + Math.min(...asks)) / 2 : bid;
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = Bot;
