'use strict';

const BINANCE_STREAM_URL = 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade';
const BINANCE_KLINES_URL = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=8';
const WINDOW_MS = 5 * 60 * 1000;

class BinanceTickFeed {
  constructor({ fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.status = 'WAITING';
    this.historyStatus = 'WAITING';
    this.error = null;
    this.price = null;
    this.tickAt = null;
    this.currentCandle = null;
    this.candles = [];
    this.socket = null;
    this.retryTimer = null;
    this.historyTimer = null;
    this.stopped = true;
    this.reconnectCount = 0;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refreshHistory();
    this.connect();
    this.historyTimer = setInterval(() => {
      this.refreshHistory().catch((error) => this.setError(error));
    }, 60 * 1000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.historyTimer);
    clearTimeout(this.retryTimer);
    this.historyTimer = null;
    this.retryTimer = null;
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
    this.socket = null;
    this.status = 'STOPPED';
  }

  async refreshHistory() {
    if (typeof this.fetchImpl !== 'function') {
      this.historyStatus = 'ERROR';
      this.error = 'Fetch is unavailable for Binance candle history.';
      return;
    }
    try {
      const response = await this.fetchImpl(BINANCE_KLINES_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Binance candle request failed (${response.status}).`);
      const rows = await response.json();
      const now = this.now();
      const parsed = rows.map((row) => ({
        start: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        closeAt: Number(row[6]),
      })).filter((candle) => Number.isFinite(candle.start) && candle.open > 0 && candle.close > 0);
      const currentStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      this.candles = parsed.filter((candle) => candle.closeAt < now).slice(-3);
      const live = parsed.find((candle) => candle.start === currentStart);
      if (live && (!this.currentCandle
        || this.currentCandle.start !== currentStart
        || this.currentCandle.openSource !== 'BINANCE_KLINE')) {
        this.currentCandle = {
          start: live.start,
          open: live.open,
          high: Math.max(live.high, this.currentCandle?.start === currentStart ? this.currentCandle.high : live.high),
          low: Math.min(live.low, this.currentCandle?.start === currentStart ? this.currentCandle.low : live.low),
          close: this.currentCandle?.start === currentStart ? this.currentCandle.close : live.close,
          openSource: 'BINANCE_KLINE',
        };
        if (this.price == null) this.price = live.close;
      }
      this.historyStatus = this.candles.length === 3 ? 'READY' : 'WAITING';
      if (this.historyStatus === 'READY') this.error = null;
    } catch (error) {
      this.historyStatus = this.candles.length === 3 ? 'READY' : 'ERROR';
      this.setError(error);
    }
  }

  connect() {
    if (this.stopped) return;
    if (typeof this.WebSocketImpl !== 'function') {
      this.status = 'ERROR';
      this.error = 'WebSocket is unavailable in this Node runtime.';
      return;
    }
    this.status = 'CONNECTING';
    try {
      const socket = new this.WebSocketImpl(BINANCE_STREAM_URL);
      this.socket = socket;
      socket.addEventListener('open', () => {
        this.status = 'CONNECTED';
        this.error = null;
      });
      socket.addEventListener('message', (event) => this.handleMessage(event.data));
      socket.addEventListener('error', () => {
        this.error = 'Binance tick stream reported a WebSocket error.';
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null;
        if (this.stopped) return;
        this.status = 'RECONNECTING';
        this.reconnectCount += 1;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), 1000);
      });
    } catch (error) {
      this.setError(error);
      this.status = 'RECONNECTING';
      this.reconnectCount += 1;
      this.retryTimer = setTimeout(() => this.connect(), 1000);
    }
  }

  handleMessage(raw) {
    try {
      const message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
      const price = Number(message.p);
      const tickAt = Number(message.T || message.E || this.now());
      if (!(price > 0) || !Number.isFinite(tickAt)) return;
      this.price = price;
      this.tickAt = tickAt;
      const start = Math.floor(tickAt / WINDOW_MS) * WINDOW_MS;
      if (!this.currentCandle || this.currentCandle.start !== start) {
        const previousStart = this.currentCandle?.start;
        this.currentCandle = {
          start,
          open: price,
          high: price,
          low: price,
          close: price,
          openSource: 'FIRST_TICK',
        };
        if (previousStart !== start) {
          void this.refreshHistory();
        }
      }
      this.currentCandle.high = Math.max(this.currentCandle.high, price);
      this.currentCandle.low = Math.min(this.currentCandle.low, price);
      this.currentCandle.close = price;
    } catch (error) {
      this.setError(error);
    }
  }

  setError(error) {
    this.error = error instanceof Error ? error.message : String(error);
  }

  snapshot() {
    const tickAgeMs = this.tickAt == null ? null : Math.max(0, this.now() - this.tickAt);
    return {
      status: this.status,
      historyStatus: this.historyStatus,
      error: this.error,
      price: this.price,
      tickAt: this.tickAt,
      tickAgeMs,
      currentCandle: this.currentCandle ? { ...this.currentCandle } : null,
      candles: this.candles.map((candle) => ({ ...candle })),
      reconnectCount: this.reconnectCount,
    };
  }
}

module.exports = BinanceTickFeed;
module.exports.BINANCE_STREAM_URL = BINANCE_STREAM_URL;
module.exports.BINANCE_KLINES_URL = BINANCE_KLINES_URL;
