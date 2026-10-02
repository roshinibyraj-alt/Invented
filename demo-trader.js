'use strict';

// Demo trader reads the public CLOB and simulates orders locally.
// It never signs, sends an order, or accesses a wallet.
const CLOB_HOST = 'https://clob.polymarket.com';
const strategy = require('./strategy');

class DemoTrader {
  constructor() {
    this.demoMode = true;
    this.address = 'DEMO MODE (no wallet, no real orders)';
    this.depositWallet = null;
    this._n = 0;
    this.orders = new Map();
    this.quotes = new Map();
  }

  async prepareMarket() { return true; }

  async getOrderBook(tokenId) {
    try {
      const response = await fetch(CLOB_HOST + '/book?token_id=' + encodeURIComponent(tokenId));
      if (!response.ok) return null;
      return await response.json();
    } catch (_) { return null; }
  }

  async placeFakMarketOrder(tokenId, side, amount, options = {}) {
    const book = await this.getOrderBook(tokenId);
    if (!book) return { id: null, status: 'unmatched', isFilled: false, avgPrice: 0, raw: {} };
    const buying = String(side).toUpperCase() === 'BUY';
    const priceLimit = Number(options && options.priceLimit);
    const hasPriceLimit = Number.isFinite(priceLimit) && priceLimit > 0;
    const levels = (buying ? (book.asks || []) : (book.bids || []))
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => level.price > 0 && level.size > 0
        && (!hasPriceLimit || (buying ? level.price <= priceLimit : level.price >= priceLimit)))
      .sort(buying ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);
    let shares = 0;
    let notional = 0;
    // Market BUY amount is USDC. With a price limit, amount / limit represents
    // the target share quantity, matching the CLOB marketable-limit order.
    let remaining = Math.max(0, Number(amount) || 0);
    if (buying && hasPriceLimit) remaining /= priceLimit;
    for (const level of levels) {
      if (buying) {
        if (hasPriceLimit) {
          const take = Math.min(remaining, level.size);
          shares += take;
          notional += take * level.price;
          remaining -= take;
        } else {
          const spend = Math.min(remaining, level.price * level.size);
          shares += spend / level.price;
          notional += spend;
          remaining -= spend;
        }
      } else {
        const take = Math.min(remaining, level.size);
        shares += take;
        notional += take * level.price;
        remaining -= take;
      }
      if (remaining <= 1e-9) break;
    }
    this._n += 1;
    const id = 'demo-' + this._n;
    const raw = buying
      ? { status: shares > 0 ? 'matched' : 'unmatched', makingAmount: String(notional), takingAmount: String(shares) }
      : { status: shares > 0 ? 'matched' : 'unmatched', makingAmount: String(shares), takingAmount: String(notional) };
    return { id, status: raw.status, isFilled: shares > 0, avgPrice: shares > 0 ? notional / shares : 0, raw };
  }

  async placeGtcOrder(tokenId, side, price, size) {
    const cachedQuote = this.quotes.get(tokenId);
    const book = cachedQuote ? null : await this.getOrderBook(tokenId);
    this._n += 1;
    const id = 'demo-maker-' + this._n;
    const order = {
      id, tokenId, side: String(side).toUpperCase(), price: Number(price),
      original_size: Number(size), size_matched: 0, status: 'LIVE',
      makerOnly: true, makerFee: 0, makerRebateEstimate: 0,
    };
    this.orders.set(id, order);
    if (cachedQuote) this._matchAtPrices(order, cachedQuote.bid, cachedQuote.ask);
    else this._matchAtTouch(order, book);
    return {
      id, status: order.status, makerOnly: true, makerFee: 0,
      makerRebateEstimate: order.makerRebateEstimate, matchedAt: order.matchedAt || null,
    };
  }

  updateQuote(tokenId, quote) {
    const bid = Number(quote && quote.bid);
    const ask = Number(quote && quote.ask);
    const bestBid = Number.isFinite(bid) && bid > 0 ? bid : null;
    const bestAsk = Number.isFinite(ask) && ask > 0 ? ask : null;
    this.quotes.set(tokenId, { bid: bestBid, ask: bestAsk, updatedAt: Date.now() });
    for (const order of this.orders.values()) {
      if (order.tokenId === tokenId && order.status === 'LIVE') this._matchAtPrices(order, bestBid, bestAsk);
    }
  }

  async getOrder(id) {
    const order = this.orders.get(id);
    if (!order) return null;
    if (order.status === 'LIVE') {
      const cachedQuote = this.quotes.get(order.tokenId);
      if (cachedQuote) this._matchAtPrices(order, cachedQuote.bid, cachedQuote.ask);
      else this._matchAtTouch(order, await this.getOrderBook(order.tokenId));
    }
    return { ...order, price: String(order.price), original_size: String(order.original_size), size_matched: String(order.size_matched) };
  }

  _matchAtTouch(order, book) {
    if (!book || order.status !== 'LIVE') return;
    const bids = (book.bids || []).map((level) => Number(level.price)).filter((price) => Number.isFinite(price) && price > 0);
    const asks = (book.asks || []).map((level) => Number(level.price)).filter((price) => Number.isFinite(price) && price > 0);
    const bestBid = bids.length ? Math.max(...bids) : null;
    const bestAsk = asks.length ? Math.min(...asks) : null;
    this._matchAtPrices(order, bestBid, bestAsk);
  }

  _matchAtPrices(order, bestBid, bestAsk) {
    if (order.status !== 'LIVE') return;
    const touched = order.side === 'BUY'
      ? strategy.buyLimitTouched(bestAsk, order.price)
      : strategy.takeProfitTouched(bestBid, order.price);
    if (!touched) return;
    // Demo execution is intentionally all-or-none on an executable price touch.
    // Visible order-book depth is not used to size the simulated fill.
    order.size_matched = order.original_size;
    order.status = 'MATCHED';
    order.matchedAt = Date.now();
    order.makerRebateEstimate = strategy.estimateMakerRebate(order.size_matched, order.price);
  }

  async cancelOrder(id) {
    const order = this.orders.get(id);
    if (!order) return { canceled: [] };
    if (order.status === 'LIVE') order.status = 'CANCELED';
    return { canceled: [id] };
  }

  async cancelMarketOrders(tokenId) {
    for (const order of this.orders.values()) {
      if (order.tokenId === tokenId && order.status === 'LIVE') order.status = 'CANCELED';
    }
    return { canceled: true };
  }

  async getOpenOrders() {
    return [...this.orders.values()].filter((order) => order.status === 'LIVE').map((order) => ({ ...order }));
  }

  async getBalance() { return null; }
}

module.exports = DemoTrader;
