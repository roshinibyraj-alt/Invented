'use strict';

// Demo stand-in for PolymarketTrader: reads the REAL public order book, simulates the fill
// (walks the asks up to the limit, exactly like the live FOK), and never signs or sends
// anything. No private key or wallet is touched.
const CLOB_HOST = 'https://clob.polymarket.com';

class DemoTrader {
  constructor() {
    this.address = 'DEMO MODE (no wallet, no real orders)';
    this.depositWallet = null;
    this._n = 0;
  }

  async getOrderBook(tokenId) {
    try {
      const res = await fetch(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  async placeFokLimitOrder(tokenId, side, price, size) {
    const book = await this.getOrderBook(tokenId);
    const asks = ((book && book.asks) || [])
      .map((a) => ({ p: parseFloat(a.price), s: parseFloat(a.size) }))
      .filter((a) => a.p > 0 && a.s > 0 && a.p <= price)
      .sort((a, b) => a.p - b.p);
    let need = size, cost = 0;
    for (const a of asks) {
      const take = Math.min(need, a.s);
      cost += take * a.p;
      need -= take;
      if (need <= 1e-9) break;
    }
    if (need > 1e-9) throw new Error(`demo: only ${(size - need).toFixed(0)} of ${size} shares available up to ${price}`);
    this._n += 1;
    return {
      id: `demo-${this._n}`, status: 'matched', isFilled: true, avgPrice: cost / size,
      raw: { status: 'matched', makingAmount: String(cost), takingAmount: String(size) },
    };
  }

  async getOrder() { return { status: 'matched' }; }
  async getBalance() { return null; }
}

module.exports = DemoTrader;
