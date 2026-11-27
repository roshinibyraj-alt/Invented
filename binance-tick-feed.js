'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BINANCE_STREAM_URL = 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade';
const BINANCE_KLINES_URL = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=8';
const BINANCE_1M_KLINES_URL = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=3';
const WINDOW_MS = 5 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

class BinanceTickFeed {
  constructor({
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    intrabarCandlePath = null,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.intrabarCandlePath = intrabarCandlePath;
    this.status = 'WAITING';
    this.historyStatus = 'WAITING';
    this.error = null;
    this.price = null;
    this.tickAt = null;
    this.currentCandle = null;
    this.currentMinuteCandle = null;
    this.candles = [];
    this.recentTrades = [];
    this.socket = null;
    this.retryTimer = null;
    this.historyTimer = null;
    this.intrabarPublishTimer = null;
    this.stopped = true;
    this.reconnectCount = 0;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await Promise.all([this.refreshHistory(), this.refreshMinuteHistory()]);
    this.connect();
    this.historyTimer = setInterval(() => {
      this.refreshHistory().catch((error) => this.setError(error));
    }, 60 * 1000);
    this.intrabarPublishTimer = setInterval(() => this.publishIntrabarCandle(), 5_000);
    this.intrabarPublishTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.historyTimer);
    clearInterval(this.intrabarPublishTimer);
    clearTimeout(this.retryTimer);
    this.historyTimer = null;
    this.intrabarPublishTimer = null;
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

  async refreshMinuteHistory() {
    if (typeof this.fetchImpl !== 'function') return;
    try {
      const response = await this.fetchImpl(BINANCE_1M_KLINES_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Binance 1-minute candle request failed (${response.status}).`);
      const rows = await response.json();
      const now = this.now();
      const start = Math.floor(now / MINUTE_MS) * MINUTE_MS;
      const row = rows.find(item => Number(item[0]) === start);
      if (!row) return;
      const current = this.currentMinuteCandle?.start === start ? this.currentMinuteCandle : null;
      this.currentMinuteCandle = {
        start,
        open: Number(row[1]),
        high: Math.max(Number(row[2]), current?.high ?? -Infinity),
        low: Math.min(Number(row[3]), current?.low ?? Infinity),
        close: current?.close ?? Number(row[4]),
        volume: Math.max(Number(row[5]) || 0, current?.volume ?? 0),
        updatedAt: now,
        openSource: 'BINANCE_1M_KLINE',
      };
    } catch (error) {
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
      const quantity = Number(message.q);
      if (quantity > 0 && typeof message.m === 'boolean') {
        this.recentTrades.push({
          price,
          quantity,
          notional: price * quantity,
          aggressor: message.m ? 'SELL' : 'BUY',
          timestamp: tickAt,
        });
        this.pruneRecentTrades(tickAt);
      }
      const minuteStart = Math.floor(tickAt / MINUTE_MS) * MINUTE_MS;
      if (!this.currentMinuteCandle || this.currentMinuteCandle.start !== minuteStart) {
        const previousMinuteStart = this.currentMinuteCandle?.start;
        this.currentMinuteCandle = {
          start: minuteStart,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: quantity > 0 ? quantity : 0,
          updatedAt: tickAt,
          openSource: 'FIRST_STREAM_TRADE',
        };
        if (previousMinuteStart !== minuteStart) void this.refreshMinuteHistory();
      } else {
        this.currentMinuteCandle.high = Math.max(this.currentMinuteCandle.high, price);
        this.currentMinuteCandle.low = Math.min(this.currentMinuteCandle.low, price);
        this.currentMinuteCandle.close = price;
        if (quantity > 0) this.currentMinuteCandle.volume += quantity;
        this.currentMinuteCandle.updatedAt = tickAt;
      }
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

  publishIntrabarCandle() {
    const candle = this.currentMinuteCandle;
    const now = this.now();
    if (!this.intrabarCandlePath || !candle
      || now < candle.start || now - candle.updatedAt > 10_000
      || Math.floor(now / MINUTE_MS) * MINUTE_MS !== candle.start) return false;
    try {
      const payload = { ...candle, observedAt: now };
      fs.mkdirSync(path.dirname(this.intrabarCandlePath), { recursive: true });
      const temp = `${this.intrabarCandlePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(payload));
      fs.renameSync(temp, this.intrabarCandlePath);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  setError(error) {
    this.error = error instanceof Error ? error.message : String(error);
  }

  pruneRecentTrades(now = this.now()) {
    this.recentTrades = this.recentTrades
      .filter((trade) => now - trade.timestamp <= 10_000)
      .slice(-5000);
  }

  tradeFlow(now = this.now()) {
    this.pruneRecentTrades(now);
    const start = now - 5000;
    const trades = this.recentTrades.filter((trade) => trade.timestamp >= start);
    const buyNotional = trades
      .filter((trade) => trade.aggressor === 'BUY')
      .reduce((sum, trade) => sum + trade.notional, 0);
    const sellNotional = trades
      .filter((trade) => trade.aggressor === 'SELL')
      .reduce((sum, trade) => sum + trade.notional, 0);
    const totalNotional = buyNotional + sellNotional;
    const first = trades[0];
    const last = trades.at(-1);
    return {
      windowMs: 5000,
      tradeCount: trades.length,
      buyCount: trades.filter((trade) => trade.aggressor === 'BUY').length,
      sellCount: trades.filter((trade) => trade.aggressor === 'SELL').length,
      buyNotional,
      sellNotional,
      signedNotional: buyNotional - sellNotional,
      totalNotional,
      imbalance: totalNotional > 0 ? (buyNotional - sellNotional) / totalNotional : null,
      priceChangePct: first && last && first.price > 0
        ? (last.price - first.price) / first.price
        : null,
      firstTradeAt: first?.timestamp ?? null,
      lastTradeAt: last?.timestamp ?? null,
    };
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
      currentMinuteCandle: this.currentMinuteCandle ? { ...this.currentMinuteCandle } : null,
      candles: this.candles.map((candle) => ({ ...candle })),
      tradeFlow: this.tradeFlow(),
      reconnectCount: this.reconnectCount,
    };
  }
}

module.exports = BinanceTickFeed;
module.exports.BINANCE_STREAM_URL = BINANCE_STREAM_URL;
module.exports.BINANCE_KLINES_URL = BINANCE_KLINES_URL;
module.exports.BINANCE_1M_KLINES_URL = BINANCE_1M_KLINES_URL;
