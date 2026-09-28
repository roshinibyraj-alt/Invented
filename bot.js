'use strict';

const cfg = require('./config');
const { getActiveWindow, currentWindowOpenTs, slugForTs, WINDOW_SECONDS } = require('./polymarket-market');
const { nextStake } = require('./ladder');

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
    this.w = null;                                 // current window state
    this.pending = [];                             // filled bets awaiting real resolution
    this.history = { UP: [], DOWN: [], ALL: [] };  // ladder history: {slug, outcome, final}
    this.stats = { wins: 0, losses: 0, noSignal: 0, voidNoFill: 0, voidNoData: 0, realizedPnl: 0 };
    this.outcomes = new Map();                     // window openTs -> {winner:'UP'|'DOWN', source:'price'|'resolution'}
    this._resolveTried = new Map();                // openTs -> last official-resolution lookup time
    this.lastSignal = null;                        // {outcomes, side, slug}
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
      this.w = { slug, openTs, status: 'starting', window: null, signal: null, outcomeDone: false };
    }
    const w = this.w;
    const elapsed = now - openTs * 1000;

    if (!w.window) {
      const { window, reason } = await getActiveWindow(now);
      if (window) { this.error = null; w.window = window; } else { this.error = reason; }
    }

    this._applyProvisional();

    // every window's winner is tracked (traded or not) because it feeds the streak
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

  /** Winner of the window that opened at openTs, from our own last-seconds price reading only (no fallback). */
  async _outcomeFor(openTs) { return this.outcomes.get(openTs) || null; }

  async _entryStep(w, elapsed) {
    if (DONE.has(w.status) || w.status === 'firing') return;

    if (!w.signal) {
      if (elapsed > cfg.SIGNAL_DEADLINE_MS) return this._voidNoData(w, 'signal not available within the first '
        + `${cfg.SIGNAL_DEADLINE_MS / 1000}s (${w.window ? 'previous outcomes unknown' : 'market not found'}) -- skipping window`);
      if (!w.window) return;
      const outs = [];
      for (let k = cfg.STREAK_LEN; k >= 1; k--) {
        const o = await this._outcomeFor(w.openTs - WINDOW_SECONDS * k);
        if (!o) return this._voidNoData(w, `a previous window's winner was not observed (the bot must watch its last ${cfg.END_WATCH_MS / 1000}s) -- skipping, streak unknown`);
        outs.push(o.winner);
      }
      let side = null;
      if (outs.every((o) => o === 'UP')) side = 'DOWN';
      else if (outs.every((o) => o === 'DOWN')) side = 'UP';
      w.signal = { outcomes: outs, side };
      this.lastSignal = { outcomes: outs, side, slug: w.slug };
      if (!side) {
        w.status = 'no_signal';
        this.stats.noSignal += 1;
        this._push({ event: 'NO_TRADE', slug: w.slug, note: `last ${cfg.STREAK_LEN} winners ${outs.join('/')} -- no streak` });
        return;
      }
      w.status = 'armed';
      this._push({ event: 'SIGNAL', slug: w.slug, side,
        note: `last ${cfg.STREAK_LEN} winners all ${outs[0]} -> buy ${side} at ${cfg.ENTRY_DELAY_MS / 1000}s, any price` });
    }

    if (w.status === 'armed' && elapsed >= cfg.ENTRY_DELAY_MS) {
      const side = w.signal.side;
      await this._fire(w, side, side === 'UP' ? w.window.tokenUp : w.window.tokenDown);
    }
  }

  _voidNoData(w, why) {
    w.status = 'void_no_data';
    this.stats.voidNoData += 1;
    this._push({ event: 'VOID', slug: w.slug, note: why });
  }

  async _fire(w, side, token) {
    w.status = 'firing';
    this._applyProvisional();   // make sure the newest known result is in the ladder before sizing
    const shares = this._stake(side);
    this._push({ event: 'FIRING', slug: w.slug, side, shares,
      note: `buying ${shares}sh ${side} at any price (limit ${cfg.PRICE_CAP})` });

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
    this._push({ event: 'VOID', slug: w.slug, side, shares, note: `${why} -- void, ladder unchanged` });
  }

  /** Our own winner record (price-based) gives a provisional outcome as soon as a window ends, so the
   * next window is sized correctly even if Gamma hasn't published the official result yet. */
  _applyProvisional() {
    for (const p of this.pending) {
      if (p.final) continue;
      const o = this.outcomes.get(p.openTs);
      if (o) this._setOutcome(p.side, p.slug, o.winner === p.side ? 'WIN' : 'LOSS', false);
    }
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
    const item = this.history[this._key(p.side)].find((h) => h.slug === p.slug);
    if (item && !item.final && item.outcome !== outcome) {
      this._push({ event: 'MISMATCH', slug: p.slug, note: `candle said ${item.outcome}, real resolution says ${outcome} -- ladder corrected` });
    }
    this._setOutcome(p.side, p.slug, outcome, true);
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
      note: `${winner} won ($1/share) -- ${outcome} on ${p.side} ${p.shares}sh, est. pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (incl. est. fee) -- next ${p.side} stake ${this._stake(p.side)}sh` });
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
    const streak = { side: null, len: 0 };
    if (w) {
      for (let k = 1; ; k++) {
        const o = this.outcomes.get(w.openTs - WINDOW_SECONDS * k);
        if (!o || (streak.side && o.winner !== streak.side)) break;
        streak.side = o.winner; streak.len += 1;
      }
    }
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
      prices: px && w && px.slug === w.slug ? px : null,
      priceSeries: this.priceSeries,
      streak,
      counts: this.counts,
      recentOutcomes: [...this.outcomes.entries()].slice(-24).map(([t, o]) => {
        const tr = tradeBy.get(t), pd = pendBy.get(t);
        return { openTs: t, winner: o.winner, source: o.source, price: o.price, loser: o.loser,
          traded: tr ? tr.side : pd ? pd.side : null, result: tr ? tr.outcome : null, pnl: tr ? tr.pnl : null };
      }),
      lastSignal: this.lastSignal,
      stakes: { DOWN: this._stake('DOWN'), UP: this._stake('UP') },
      pending,
      trades: this.trades.slice(-60).reverse(),
      equity: this.equity,
      stats: this.stats,
      cfg: { streakLen: cfg.STREAK_LEN, base: cfg.BASE_SHARES, maxLoss: cfg.MAX_LOSS_DOUBLINGS, maxWin: cfg.MAX_WIN_DOUBLINGS,
        winPrice: cfg.WIN_PRICE, endWatchMs: cfg.END_WATCH_MS, entryDelayMs: cfg.ENTRY_DELAY_MS, windowSec: WINDOW_SECONDS },
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
