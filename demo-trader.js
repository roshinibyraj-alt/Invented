'use strict';

// Public CLOB book reader and local paper-fill simulator.
// This class has no wallet, signing, authentication, or live-order methods.
const CLOB_HOST = 'https://clob.polymarket.com';
const config = require('./config');

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

    if (levels.length === 0) {
      const cached = this.quotes.get(String(tokenId));
      const age = cached ? Date.now() - cached.updatedAt : Infinity;
      const fallbackPrice = Number(cached && (buying ? cached.ask : cached.bid));
      const priceAllowed = validPrice(fallbackPrice) != null
        && (!hasPriceLimit || (buying ? fallbackPrice <= priceLimit : fallbackPrice >= priceLimit));
      if (cached && age >= 0 && age <= config.PRICE_STALE_MS && priceAllowed) {
        levels = [{ price: fallbackPrice, size: Infinity }];
      }
    }

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
