'use strict';

// Public CLOB market-data reader only; paper fills are modelled by the bot from public trade prints.
// This class has no wallet, signing, authentication, or live-order methods.
const CLOB_HOST = 'https://clob.polymarket.com';

class DemoTrader {
  constructor() {
    this.demoMode = true;
    this.address = 'DEMO MODE (no wallet, no real orders)';
    this.quotes = new Map();
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
