'use strict';

const URL = 'wss://ws-live-data.polymarket.com';
const SYMBOL = 'btc/usd';
const MAX_AGE_MS = 15_000;
const RETAIN_MS = 60 * 60 * 1000;

class ChainlinkPriceFeed {
  constructor({ WebSocketImpl = globalThis.WebSocket, now = Date.now } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.ticks = [];
    this.minuteBars = new Map();
    this.socket = null;
    this.started = false;
    this.status = 'starting';
    this.error = null;
    this.lastUpdateAt = null;
    this.retryMs = 1000;
    this.reconnectTimer = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (typeof this.WebSocketImpl !== 'function') {
      this.status = 'unsupported';
      this.error = 'Node.js WebSocket support is required (Node 22 or newer)';
      return;
    }
    this.connect();
  }

  connect() {
    if (!this.started) return;
    this.status = 'connecting';
    this.error = null;
    let socket;
    try {
      socket = new this.WebSocketImpl(URL);
      this.socket = socket;
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.status = 'subscribing';
      this.retryMs = 1000;
      socket.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol: SYMBOL }) }],
      }));
    });
    socket.addEventListener('message', event => {
      if (this.socket === socket) this.onMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.status = 'error';
        this.error = 'Chainlink price stream connection failed';
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.scheduleReconnect(new Error('Chainlink stream disconnected'));
      }
    });
  }

  scheduleReconnect(error) {
    this.status = 'reconnecting';
    this.error = error?.message || 'Chainlink stream disconnected';
    if (!this.started || this.reconnectTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw || ''));
    } catch (_) {
      return;
    }
    const payload = message?.payload || message;
    const symbol = String(payload?.symbol || '').toLowerCase();
    if (symbol && symbol !== SYMBOL) return;
    const updates = Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload) ? payload
        : payload?.timestamp != null && payload?.value != null ? [payload] : [];
    let accepted = 0;
    for (const update of updates) if (this.addPrice(update)) accepted++;
    if (accepted) {
      this.status = 'live';
      this.error = null;
      this.lastUpdateAt = this.now();
      this.prune();
    }
  }

  addPrice(update) {
    const price = Number(update?.value);
    let timestamp = Number(update?.timestamp);
    if (timestamp < 1e12) timestamp *= 1000;
    if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) return false;
    const tick = { ts: timestamp, price };
    if (!this.ticks.length || timestamp >= this.ticks.at(-1).ts) this.ticks.push(tick);
    else {
      const index = this.ticks.findIndex(x => x.ts > timestamp);
      this.ticks.splice(index < 0 ? this.ticks.length : index, 0, tick);
    }
    const minute = Math.floor(timestamp / 60_000) * 60_000;
    const bar = this.minuteBars.get(minute);
    if (!bar) {
      this.minuteBars.set(minute, { t: minute, o: price, h: price, l: price, c: price, firstTs: timestamp, lastTs: timestamp });
    } else {
      bar.h = Math.max(bar.h, price);
      bar.l = Math.min(bar.l, price);
      if (timestamp < bar.firstTs) { bar.o = price; bar.firstTs = timestamp; }
      if (timestamp >= bar.lastTs) { bar.c = price; bar.lastTs = timestamp; }
    }
    return true;
  }

  prune() {
    const cutoff = this.now() - RETAIN_MS;
    for (const timestamp of this.minuteBars.keys()) if (timestamp < cutoff) this.minuteBars.delete(timestamp);
    while (this.ticks.length && this.ticks[0].ts < cutoff) this.ticks.shift();
  }

  getMinuteCandles() {
    this.start();
    const ageMs = this.lastUpdateAt == null ? null : this.now() - this.lastUpdateAt;
    if (this.lastUpdateAt == null || ageMs > MAX_AGE_MS) {
      if (this.status === 'live') this.status = 'stale';
      if (ageMs != null && ageMs > MAX_AGE_MS && this.socket) this.socket.close?.();
      throw new Error(this.error || `Chainlink BTC/USD feed ${this.status}; waiting for a fresh price update`);
    }
    return [...this.minuteBars.values()].sort((a, b) => a.t - b.t)
      .map(({ t, o, h, l, c }) => ({ t, o, h, l, c, v: 0 }));
  }

  getTicks() {
    this.start();
    const ageMs = this.lastUpdateAt == null ? null : this.now() - this.lastUpdateAt;
    if (this.lastUpdateAt == null || ageMs > MAX_AGE_MS) {
      if (this.status === 'live') this.status = 'stale';
      if (ageMs != null && ageMs > MAX_AGE_MS && this.socket) this.socket.close?.();
      throw new Error(this.error || `Chainlink BTC/USD feed ${this.status}; waiting for a fresh price update`);
    }
    return this.ticks.slice();
  }

  snapshot() {
    const ageMs = this.lastUpdateAt == null ? null : Math.max(0, this.now() - this.lastUpdateAt);
    return {
      source: 'Polymarket RTDS Chainlink BTC/USD',
      symbol: SYMBOL,
      status: ageMs != null && ageMs > MAX_AGE_MS ? 'stale' : this.status,
      lastUpdateAt: this.lastUpdateAt,
      ageMs,
      ticks: this.ticks.length,
      minuteBars: this.minuteBars.size,
      error: this.error,
    };
  }

  stop() {
    this.started = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.status = 'stopped';
  }
}

const feed = new ChainlinkPriceFeed();
module.exports = { ChainlinkPriceFeed, feed, MAX_AGE_MS };
