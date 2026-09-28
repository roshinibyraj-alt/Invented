'use strict';

const cfg = require('./config');
const { fetchClosedCandles, evaluateSignal } = require('./candles');
const { getActiveWindow, fetchResolution, currentWindowOpenTs, slugForTs } = require('./polymarket-market');
const { nextStake } = require('./ladder');

const POLL_MS = 1000;
const SETTLEMENT_POLL_MS = 5000;
const SETTLEMENT_GIVE_UP_MS = 15 * 60_000;
const MAX_LOG = 300;
const DONE = new Set(['no_signal', 'fired', 'void_no_trigger', 'void_no_fill', 'void_no_data']);

class Bot {
  /** @param trader an authenticated PolymarketTrader */
  constructor(trader) {
    this.trader = trader;
    this.w = null;                                 // current window state
    this.pending = [];                             // filled bets awaiting real resolution
    this.history = { UP: [], DOWN: [], ALL: [] };  // ladder history: {slug, outcome, final}
    this.stats = { wins: 0, losses: 0, noSignal: 0, voidNoTrigger: 0, voidNoFill: 0, voidNoData: 0, realizedPnl: 0 };
    this.lastSignal = null;                        // {colors, side, slug}
    this.walletBalance = null;
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
    }
    const w = this.w;
    if (DONE.has(w.status)) return;

    const elapsed = now - openTs * 1000;
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

    if (!w.window) {
      const { window, reason } = await getActiveWindow(now);
      if (!window) { this.error = reason; return; }
      this.error = null;
      w.window = window;
    }

    if (!w.signal) {
      let candles;
      try {
        candles = await fetchClosedCandles(now);
      } catch (e) {
        this._warnOnce(`candles-${slug}`, { event: 'ERROR', slug, note: `candle fetch failed: ${e.message} (retrying)` });
        return;
      }
      this._applyProvisional(candles);
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
    this.pending.push({ slug: w.slug, openTs: w.openTs, closeTs: w.window.closeTs, side, shares, price, firedAt: Date.now() });
    this._push({ event: 'ENTRY_FILLED', slug: w.slug, side, shares, price: round(price, 4),
      note: `filled ${shares}sh ${side} @ ${round(price, 4)} (status ${st || 'n/a'}) -- holding to resolution` });
  }

  _void(w, side, shares, why) {
    w.status = 'void_no_fill';
    this.stats.voidNoFill += 1;
    this._push({ event: 'VOID', slug: w.slug, side, shares, note: `${why} -- void, ladder unchanged` });
  }

  /** Candle color of a finished window gives a provisional outcome right away, so the next
   * window is sized correctly even if Gamma hasn't published the real resolution yet. */
  _applyProvisional(candles) {
    for (const p of this.pending) {
      if (p.final) continue;
      const c = candles.find((x) => x.openTs === p.openTs);
      if (!c) continue;
      const winner = c.color === 'GREEN' ? 'UP' : 'DOWN';
      this._setOutcome(p.side, p.slug, winner === p.side ? 'WIN' : 'LOSS', false);
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
        if (now < p.closeTs * 1000 + 5000) { keep.push(p); continue; }
        let winner = null;
        try { winner = await fetchResolution(p.slug); }
        catch (e) { this._push({ event: 'ERROR', slug: p.slug, note: `resolution check failed: ${e.message}` }); }
        if (winner === null) {
          if (now - p.firedAt > SETTLEMENT_GIVE_UP_MS) {
            this._push({ event: 'SETTLEMENT_TIMEOUT', slug: p.slug, side: p.side, shares: p.shares,
              note: 'unresolved after 15 min -- stopped polling, check manually' });
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

    const fee = p.shares * cfg.TAKER_FEE_RATE * p.price * (1 - p.price);
    const cost = p.shares * p.price + fee;
    const pnl = win ? p.shares - cost : -cost;
    if (win) this.stats.wins += 1; else this.stats.losses += 1;
    this.stats.realizedPnl += pnl;
    this._push({ event: win ? 'SETTLED_WIN' : 'SETTLED_LOSS', slug: p.slug, side: p.side, shares: p.shares,
      pnl: round(pnl, 2),
      note: `resolved ${winner} -- ${outcome} on ${p.side} ${p.shares}sh, est. pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (incl. est. fee) -- next ${p.side} stake ${this._stake(p.side)}sh` });
  }

  async _balanceLoop() {
    while (this._running) {
      try { this.walletBalance = await this.trader.getBalance(); }
      catch (e) { this._push({ event: 'ERROR', note: `balance check failed: ${e.message}` }); }
      await sleep(30_000);
    }
  }

  snapshot() {
    const w = this.w;
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      error: this.error,
      walletBalance: this.walletBalance,
      walletAddress: this.trader.depositWallet || this.trader.address,
      window: w ? { slug: w.slug, status: w.status, lastAsk: w.lastAsk, side: w.signal ? w.signal.side : null } : null,
      lastSignal: this.lastSignal,
      stakes: { DOWN: this._stake('DOWN'), UP: this._stake('UP') },
      pending: this.pending.slice(-10),
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
    if (!(p > 0) || !(parseFloat(a.size) > 0)) continue;
    if (best === null || p < best) best = p;
  }
  return best;
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = Bot;
