'use strict';

// Public CLOB book reader and local paper-fill simulator.
// This class has no wallet, signing, authentication, or live-order methods.
const CLOB_HOST = 'https://clob.polymarket.com';

class DemoTrader {
  constructor() {
    this.demoMode = true;
    this.address = 'DEMO MODE (no wallet, no real orders)';
    this.quotes = new Map();
    this._nextOrderId = 0;
  }

  async getOrderBook(tokenId) {
    try {
      const response = await fetch(
        CLOB_HOST + '/book?token_id=' + encodeURIComponent(tokenId),
        { signal: AbortSignal.timeout(4000) },
      );
      if (!response.ok) return null;
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  async simulateLimitBuy(tokenId, targetShares, limitPrice, orderState = {}) {
    const requested = Math.max(0, Number(targetShares) || 0);
    const limit = validPrice(limitPrice);
    if (requested <= 0 || limit == null) {
      return { shares: 0, notional: 0, avgPrice: 0, fills: [] };
    }

    const book = await this.getOrderBook(tokenId);
    if (!book) return { shares: 0, notional: 0, avgPrice: 0, fills: [] };
    const levels = (book.asks || [])
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => validPrice(level.price) != null
        && Number.isFinite(level.size) && level.size > 0
        && level.price <= limit + 1e-9)
      .sort((a, b) => a.price - b.price);

    const signature = levels.map((level) =>
      `${level.price.toFixed(4)}:${level.size.toFixed(5)}`).join('|');
    if (signature === orderState.lastBookSignature) {
      return { shares: 0, notional: 0, avgPrice: 0, fills: [], unchangedBook: true };
    }
    orderState.lastBookSignature = signature;
    if (!orderState.consumedByPrice || typeof orderState.consumedByPrice !== 'object') {
      orderState.consumedByPrice = {};
    }

    let remaining = requested;
    let shares = 0;
    let notional = 0;
    const fills = [];
    for (const level of levels) {
      const key = level.price.toFixed(4);
      const consumed = Math.max(0, Number(orderState.consumedByPrice[key]) || 0);
      const available = Math.max(0, level.size - consumed);
      const quantity = Math.min(remaining, available);
      if (quantity <= 1e-9) continue;
      shares += quantity;
      notional += quantity * level.price;
      remaining -= quantity;
      orderState.consumedByPrice[key] = consumed + quantity;
      fills.push({ price: level.price, shares: quantity });
      if (remaining <= 1e-9) break;
    }

    return {
      shares,
      notional,
      avgPrice: shares > 0 ? notional / shares : 0,
      fills,
      unchangedBook: false,
    };
  }

  updateQuote(tokenId, quote) {
    this.quotes.set(String(tokenId), {
      bid: validPrice(quote && quote.bid),
      ask: validPrice(quote && quote.ask),
      updatedAt: Date.now(),
    });
  }

  async placeFakMarketOrder(tokenId, side, amount, options = {}) {
    const buying = String(side).toUpperCase() === 'BUY';
    const book = await this.getOrderBook(tokenId);
    const priceLimit = Number(options && options.priceLimit);
    const hasPriceLimit = Number.isFinite(priceLimit) && priceLimit > 0;
    let levels = (buying ? (book && book.asks || []) : (book && book.bids || []))
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => validPrice(level.price) != null
        && Number.isFinite(level.size) && level.size > 0
        && (!hasPriceLimit || (buying ? level.price <= priceLimit : level.price >= priceLimit)))
      .sort(buying ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);

    let remaining = Math.max(0, Number(amount) || 0);
    let shares = 0;
    let notional = 0;
    for (const level of levels) {
      if (buying) {
        const spend = Math.min(remaining, level.price * level.size);
        shares += spend / level.price;
        notional += spend;
        remaining -= spend;
      } else {
        const take = Math.min(remaining, level.size);
        shares += take;
        notional += take * level.price;
        remaining -= take;
      }
      if (remaining <= 1e-9) break;
    }

    const id = 'demo-' + (++this._nextOrderId);
    const raw = buying
      ? {
        status: shares > 0 ? 'matched' : 'unmatched',
        makingAmount: String(notional), takingAmount: String(shares),
      }
      : {
        status: shares > 0 ? 'matched' : 'unmatched',
        makingAmount: String(shares), takingAmount: String(notional),
      };
    return {
      id, status: raw.status, isFilled: shares > 0,
      avgPrice: shares > 0 ? notional / shares : 0, raw,
    };
  }

  async getBalance() {
    return null;
  }
}

function validPrice(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : null;
}

module.exports = DemoTrader;
