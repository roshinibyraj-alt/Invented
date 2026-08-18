'use strict';

const WebSocket = require('ws');
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

class PriceStream {
  constructor(opts = {}) {
    this.url = opts.url || WS_URL;
    this.onBookUpdate = opts.onBookUpdate || (() => {});
    this.onConnect = opts.onConnect || (() => {});
    this.onDisconnect = opts.onDisconnect || (() => {});
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = 1000;
    this.subscriptions = new Map();
    this._closed = false;
    this._log = opts.log || (() => {});
  }

  connect() {
    if (this._closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._log(`⚠️ WebSocket connect failed: ${e.message}, retrying in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      return;
    }
    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this._log('🔌 WebSocket connected — real-time price streaming active');
      this.onConnect();
      for (const [conditionId, tokenIds] of this.subscriptions) {
        this._sub(conditionId, tokenIds);
      }
    });
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.channel === 'book' && msg.asset_id) {
          const bid = msg.bids && msg.bids[0] ? parseFloat(msg.bids[0].price) : null;
          const ask = msg.asks && msg.asks[0] ? parseFloat(msg.asks[0].price) : null;
          this.onBookUpdate(msg.asset_id, { bid, ask });
        }
        if (msg.channel === 'price' && msg.asset_id) {
          const price = parseFloat(msg.price);
          if (!isNaN(price)) this.onBookUpdate(msg.asset_id, { bid: price, ask: price });
        }
      } catch (_) {}
    });
    this.ws.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this._log('🔌 WebSocket disconnected — falling back to REST polling');
      this.onDisconnect();
      if (!this._closed) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000);
      }
    });
    this.ws.on('error', () => {});
  }

  subscribe(conditionId, tokenIds) {
    this.subscriptions.set(conditionId, tokenIds);
    if (this.connected) this._sub(conditionId, tokenIds);
  }

  _sub(conditionId, tokenIds) {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(JSON.stringify({
        auth: {}, type: 'subscribe', channel: 'book',
        market: conditionId, assets_ids: tokenIds,
      }));
    } catch (_) {}
  }

  close() {
    this._closed = true;
    if (this.ws) try { this.ws.close(); } catch (_) {}
  }
}

module.exports = { PriceStream };
