'use strict';

// Demo stand-in for PolymarketTrader: reads the REAL public order book, simulates the fill
// (walks the asks up to the limit, exactly like the live FOK), and never signs or sends
// anything. No private key or wallet is touched.
const CLOB_HOST = 'https://clob.polymarket.com';
const cfg = require('./config');

class DemoTrader {
  constructor() {
    this.address = 'DEMO MODE (no wallet, no real orders)';
    this.depositWallet = null;
    this._n = 0;
    this.balance = cfg.DEMO_STARTING_CAPITAL;
    this._orders = new Map();
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
    const avgPrice = cost / size;
    const fee = size * cfg.TAKER_FEE_RATE * avgPrice * (1 - avgPrice);
    const totalCost = cost + fee;
    if (totalCost > this.balance) {
      throw new Error(`demo: insufficient capital ($${this.balance.toFixed(2)} available, $${totalCost.toFixed(2)} required)`);
    }
    const id = `demo-${++this._n}`;
    this.balance -= totalCost;
    this._orders.set(id, { shares: size });
    return {
      id, status: 'matched', isFilled: true, avgPrice,
      raw: { status: 'matched', makingAmount: String(cost), takingAmount: String(size) },
    };
  }

  async getOrder() { return { status: 'matched' }; }
  async getBalance() { return this.balance; }

  settleDemoOrder(id, won) {
    const order = this._orders.get(id);
    if (!order) throw new Error(`demo: unknown order ${id}`);
    if (won) this.balance += order.shares;
    this._orders.delete(id);
  }
}

module.exports = DemoTrader;
