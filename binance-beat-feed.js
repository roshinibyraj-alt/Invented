'use strict';

const BINANCE_AGG_TRADE_URL = 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade';
const VOLATILITY_WINDOW_MS = 60_000;
const MAX_TICK_AGE_MS = 5_000;
const MAX_BEAT_OFFSET_MS = 2_000;
const MAX_BUFFER_AGE_MS = 20 * 60_000;
const MAX_TICKS = 50_000;
const MIN_TOLERANCE_USD = 2;
const MAX_TOLERANCE_USD = 100;

function eventData(value) {
  const payload = value && typeof value === 'object' && 'data' in value ? value.data : value;
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString('utf8');
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
  return payload;
}

class BinanceBeatFeed {
  constructor({
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    url = BINANCE_AGG_TRADE_URL,
    volatilityWindowMs = VOLATILITY_WINDOW_MS,
    maxTickAgeMs = MAX_TICK_AGE_MS,
    maxBeatOffsetMs = MAX_BEAT_OFFSET_MS,
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.url = url;
    this.volatilityWindowMs = volatilityWindowMs;
    this.maxTickAgeMs = maxTickAgeMs;
    this.maxBeatOffsetMs = maxBeatOffsetMs;
    this.ticks = [];
    this.running = false;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.reconnectCount = 0;
    this.lastPruneAt = 0;
    this.status = 'STOPPED';
    this.error = null;
    this.connectedAt = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  connect() {
    if (!this.running) return;
    if (typeof this.WebSocketImpl !== 'function') {
      this.status = 'ERROR';
      this.error = 'WebSocket is unavailable in this Node.js runtime.';
      this.scheduleReconnect();
      return;
    }

    this.status = 'CONNECTING';
    this.error = null;
    try {
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;
      this.listen(socket, 'open', () => {
        if (!this.running || socket !== this.socket) return;
        this.status = 'CONNECTED';
        this.connectedAt = this.now();
        this.reconnectAttempt = 0;
        this.error = null;
      });
      this.listen(socket, 'message', (event) => {
        if (!this.running || socket !== this.socket) return;
        this.handleMessage(event);
      });
      this.listen(socket, 'error', (event) => {
        if (socket !== this.socket) return;
        this.error = event?.message || 'Binance aggregate-trade WebSocket error.';
        if (this.status !== 'CONNECTED') this.status = 'ERROR';
      });
      this.listen(socket, 'close', () => {
        if (socket !== this.socket) return;
        this.socket = null;
        this.status = this.running ? 'DISCONNECTED' : 'STOPPED';
        if (this.running) this.scheduleReconnect();
      });
    } catch (error) {
      this.socket = null;
      this.status = 'ERROR';
      this.error = error?.message || 'Could not connect to Binance market data.';
      this.scheduleReconnect();
    }
  }

  listen(socket, type, callback) {
    if (typeof socket.addEventListener === 'function') socket.addEventListener(type, callback);
    else socket[`on${type}`] = callback;
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(15_000, 1_000 * (2 ** Math.min(this.reconnectAttempt, 4)));
    this.reconnectAttempt += 1;
    this.reconnectCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  handleMessage(message) {
    let payload = eventData(message);
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return false;
      }
    }
    if (Array.isArray(payload)) {
      let accepted = false;
      for (const item of payload) accepted = this.handleMessage(item) || accepted;
      return accepted;
    }
    if (!payload || typeof payload !== 'object') return false;

    const price = Number(payload.p ?? payload.price);
    const timestamp = Number(payload.T ?? payload.E ?? payload.timestamp);
    return this.recordTick(price, timestamp);
  }

  recordTick(price, timestamp = this.now()) {
    const normalizedPrice = Number(price);
    const normalizedTimestamp = Number(timestamp);
    if (!(normalizedPrice > 0) || !Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) return false;

    this.ticks.push({ price: normalizedPrice, timestamp: normalizedTimestamp });
    if (this.ticks.length > MAX_TICKS) this.ticks.splice(0, this.ticks.length - MAX_TICKS);
    if (this.ticks.length % 500 === 0 || this.now() - this.lastPruneAt >= 30_000) {
      const cutoff = this.now() - MAX_BUFFER_AGE_MS;
      this.ticks = this.ticks.filter((tick) => tick.timestamp >= cutoff);
      this.lastPruneAt = this.now();
    }
    return true;
  }

  getBeatPriceAt(targetTimestamp) {
    const target = Number(targetTimestamp);
    if (!Number.isFinite(target)) return null;
    let nearest = null;
    for (const tick of this.ticks) {
      const offsetMs = tick.timestamp - target;
      if (Math.abs(offsetMs) > this.maxBeatOffsetMs) continue;
      if (!nearest || Math.abs(offsetMs) < Math.abs(nearest.offsetMs)) {
        nearest = { ...tick, offsetMs };
      }
    }
    if (!nearest) return null;
    return {
      value: nearest.price,
      source: 'BINANCE_WS_ESTIMATE',
      sourceTimestamp: nearest.timestamp,
      exact: false,
      offsetMs: nearest.offsetMs,
      note: 'Nearest BTCUSDT aggregate-trade tick near market start; not the Chainlink resolution price.',
    };
  }

  getVolatilityBand(now = this.now()) {
    const timestamp = Number(now);
    const recent = this.ticks.filter((tick) => tick.timestamp >= timestamp - this.volatilityWindowMs
      && tick.timestamp <= timestamp + 1_000);
    let low = Infinity;
    let high = -Infinity;
    let latest = null;
    for (const tick of this.ticks) {
      if (!latest || tick.timestamp > latest.timestamp) latest = tick;
    }
    for (const tick of recent) {
      low = Math.min(low, tick.price);
      high = Math.max(high, tick.price);
    }
    const rangeUsd = recent.length ? high - low : 0;
    const ageMs = latest ? Math.max(0, timestamp - latest.timestamp) : null;
    const bandUsd = Math.max(MIN_TOLERANCE_USD, Math.min(MAX_TOLERANCE_USD, rangeUsd));

    return {
      ready: recent.length >= 2 && ageMs != null && ageMs <= this.maxTickAgeMs,
      bandUsd,
      rangeUsd,
      sampleCount: recent.length,
      windowMs: this.volatilityWindowMs,
      lastTickAt: latest?.timestamp ?? null,
      lastTickAgeMs: ageMs,
      minBandUsd: MIN_TOLERANCE_USD,
      maxBandUsd: MAX_TOLERANCE_USD,
    };
  }

  stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) {
      try {
        socket.close();
      } catch {
        // A closed socket needs no further cleanup.
      }
    }
    this.status = 'STOPPED';
  }
}

BinanceBeatFeed.constants = {
  BINANCE_AGG_TRADE_URL,
  VOLATILITY_WINDOW_MS,
  MAX_TICK_AGE_MS,
  MAX_BEAT_OFFSET_MS,
  MAX_BUFFER_AGE_MS,
  MIN_TOLERANCE_USD,
  MAX_TOLERANCE_USD,
};

module.exports = BinanceBeatFeed;
