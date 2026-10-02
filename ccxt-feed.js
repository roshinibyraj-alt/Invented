'use strict';

const DEFAULT_POLL_MS = 500;

function defaultSymbol(exchangeId) {
  return ['binance', 'binanceus', 'okx', 'bybit', 'kucoin'].includes(String(exchangeId).toLowerCase())
    ? 'BTC/USDT' : 'BTC/USD';
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceFromTicker(ticker) {
  if (!ticker || typeof ticker !== 'object') return null;
  const bid = positiveNumber(ticker.bid);
  const ask = positiveNumber(ticker.ask);
  if (bid != null && ask != null && ask >= bid) return (bid + ask) / 2;
  return positiveNumber(ticker.last);
}

class CcxtPriceFeed {
  constructor(options = {}) {
    this.exchangeId = String(options.exchangeId || process.env.CCXT_EXCHANGE || 'kraken').toLowerCase();
    this.symbol = options.symbol || process.env.CCXT_SYMBOL || defaultSymbol(this.exchangeId);
    const requestedPollMs = Math.max(100, Number(options.pollMs) || DEFAULT_POLL_MS);
    this.requestedPollMs = requestedPollMs;
    this.exchange = options.exchange || null;
    this.setupError = null;
    this._running = false;
    this._timer = null;
    this._failures = 0;

    if (!this.exchange) {
      try {
        const ccxt = options.ccxt || require('ccxt');
        const Exchange = ccxt[this.exchangeId];
        if (typeof Exchange !== 'function') {
          throw new Error('unsupported CCXT exchange: ' + this.exchangeId);
        }
        this.exchange = new Exchange({ enableRateLimit: true });
      } catch (error) {
        this.setupError = error;
      }
    }
    const exchangeMinimumMs = Number(this.exchange && this.exchange.rateLimit);
    this.pollMs = Math.max(
      requestedPollMs,
      Number.isFinite(exchangeMinimumMs) && exchangeMinimumMs > 0 ? exchangeMinimumMs : 0,
    );
  }

  start(onPrice, onError = () => {}) {
    if (this._running) return () => this.stop();
    this._running = true;
    this._onPrice = typeof onPrice === 'function' ? onPrice : () => {};
    this._onError = typeof onError === 'function' ? onError : () => {};
    if (this.setupError) {
      this._report(this.setupError);
      return () => this.stop();
    }
    void this._poll();
    return () => this.stop();
  }

  async _poll() {
    if (!this._running || !this.exchange) return;
    const startedAt = Date.now();
    try {
      const ticker = await this.exchange.fetchTicker(this.symbol);
      const receivedAt = Date.now();
      const price = priceFromTicker(ticker);
      if (price == null) throw new Error('CCXT ticker did not include a valid BTC price');
      const rawExchangeTimestamp = ticker.timestamp;
      const exchangeTimestamp = rawExchangeTimestamp == null || rawExchangeTimestamp === ''
        ? null : Number(rawExchangeTimestamp);
      this._failures = 0;
      try {
        this._onPrice({
          exchange: this.exchangeId,
          symbol: this.symbol,
          price,
          bid: positiveNumber(ticker.bid),
          ask: positiveNumber(ticker.ask),
          last: positiveNumber(ticker.last),
          exchangeTimestamp: Number.isFinite(exchangeTimestamp) ? exchangeTimestamp : null,
          sampledAt: startedAt,
          receivedAt,
        });
      } catch (error) {
        this._report(error);
      }
    } catch (error) {
      this._failures += 1;
      this._report(error);
    }

    if (!this._running) return;
    const interval = this._failures
      ? Math.min(this.pollMs * (2 ** Math.min(this._failures, 4)), 8000)
      : this.pollMs;
    const delay = Math.max(0, interval - (Date.now() - startedAt));
    this._timer = setTimeout(() => { void this._poll(); }, delay);
  }

  _report(error) {
    try {
      this._onError(error instanceof Error ? error : new Error(String(error)));
    } catch (_) {}
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (this.exchange && typeof this.exchange.close === 'function') {
      try { void this.exchange.close(); } catch (_) {}
    }
  }
}

module.exports = CcxtPriceFeed;
module.exports.defaultSymbol = defaultSymbol;
module.exports.priceFromTicker = priceFromTicker;