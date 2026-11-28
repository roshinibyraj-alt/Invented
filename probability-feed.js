'use strict';
const { probabilityModel } = require('./probability-model');

class ProbabilityFeed {
  constructor({ now = Date.now, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.now = now; this.fetch = fetchImpl; this.WebSocket = WebSocketImpl;
    this.binance = []; this.chainlink = []; this.reference = null;
    this.socket = null; this.closed = true; this.nextHistory = 0; this.nextReference = 0;
    this.historyError = null; this.referenceError = null; this.socketError = null;
    this.socketStatus = 'WAITING';
  }
  async json(url) {
    const r = await this.fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`${new URL(url).hostname}: HTTP ${r.status}`);
    return r.json();
  }
  ingest(message) {
    const p = message?.payload;
    if (!p || p.symbol !== 'btc/usd' || !['crypto_prices_chainlink', 'crypto_prices'].includes(message.topic)
      || (message.topic === 'crypto_prices' && message.type !== 'subscribe')) return;
    const points = Array.isArray(p.data) ? p.data : [p];
    const map = new Map(this.chainlink.map(x => [x.at, x]));
    for (const row of points) {
      const at = Number(row.timestamp), price = Number(row.value);
      if (Number.isFinite(at) && at <= this.now() && at >= this.now() - 900000
        && Number.isFinite(price) && price > 0) map.set(at, { at, price });
    }
    this.chainlink = [...map.values()].filter(x => x.at >= this.now() - 900000).sort((a, b) => a.at - b.at);
    if (this.chainlink.length) this.socketError = null;
  }
  start() { this.closed = false; this.connect(); }
  connect() {
    if (this.closed) return;
    this.socketStatus = 'CONNECTING';
    let ws;
    try { ws = this.socket = new this.WebSocket('wss://ws-live-data.polymarket.com'); }
    catch (e) { this.socketError = e.message; this.retry(); return; }
    const heartbeat = () => {
      if (ws.readyState === 1) ws.send('PING');
      if (this.now() - (this.chainlink.at(-1)?.at || 0) > 20000) ws.close();
    };
    ws.addEventListener('open', () => {
      if (this.closed || ws !== this.socket) return;
      this.socketStatus = 'CONNECTED';
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [
        { topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol: 'btc/usd' }) },
      ] }));
      clearInterval(this.ping); this.ping = setInterval(heartbeat, 5000); this.ping.unref?.();
    });
    ws.addEventListener('message', e => {
      if (this.closed || ws !== this.socket) return;
      try { this.ingest(JSON.parse(String(e.data))); } catch (_) { /* heartbeat/non-price frame */ }
    });
    ws.addEventListener('error', () => { this.socketError = 'Chainlink WebSocket connection error'; });
    ws.addEventListener('close', () => {
      if (ws !== this.socket) return;
      clearInterval(this.ping); this.socketStatus = 'DISCONNECTED'; this.retry();
    });
  }
  retry() {
    if (this.closed) return;
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => this.connect(), 2000); this.reconnect.unref?.();
  }
  stop() {
    this.closed = true; clearTimeout(this.reconnect); clearInterval(this.ping);
    this.socket?.close(); this.socket = null;
  }
  async refreshHistory() {
    const now = this.now();
    if (now < this.nextHistory) return;
    this.nextHistory = now + 5000;
    try {
      const warm = this.binance.length >= 540 && now - this.binance.at(-1).at < 10000;
      const rows = await this.json('https://data-api.binance.vision/api/v3/klines?'
        + new URLSearchParams({ symbol: 'BTCUSDT', interval: '1s', endTime: String(now - 1), limit: warm ? '15' : '650' }));
      if (!Array.isArray(rows)) throw new Error('Invalid Binance one-second history response.');
      const updates = rows.filter(r => Number(r[6]) < this.now()).map(r => ({
        at: Number(r[6]), price: Number(r[4]),
      })).filter(p => Number.isFinite(p.price) && p.price > 0);
      this.binance = [...new Map([...this.binance, ...updates].map(p => [p.at, p])).values()]
        .filter(p => p.at >= this.now() - 650000).sort((a, b) => a.at - b.at);
      this.historyError = null;
    } catch (e) { this.historyError = e.message; }
  }
  async refreshReference(market) {
    if (!market || this.reference?.start === market.start || this.now() < this.nextReference) return;
    this.nextReference = this.now() + 10000;
    try {
      const description = String(market.raw?.description || '');
      if (!/chainlink/i.test(description) || !/TWAP|time.weighted/i.test(description)
        || !/60s/i.test(String(market.raw?.resolutionSource || '')))
        throw new Error('Unsupported settlement rules: expected Chainlink 60-second TWAP.');
      const result = await this.json('https://polymarket.com/api/crypto/crypto-price?'
        + new URLSearchParams({ symbol: 'BTC', eventStartTime: new Date(market.start).toISOString(),
          variant: 'fiveminute', endDate: new Date(market.end).toISOString() }));
      if (!Number.isFinite(result.openPrice) || result.openPrice <= 0
        || !Number.isFinite(result.timestamp) || result.timestamp < market.start || result.timestamp > this.now() + 1000)
        throw new Error('Missing or mismatched official opening reference.');
      this.reference = { start: market.start, price: result.openPrice, at: this.now(),
        source: 'Polymarket crypto-price opening reference / Chainlink TWAP rules' };
      this.referenceError = null;
    } catch (e) { this.referenceError = e.message; }
  }
  evaluate(market) {
    return probabilityModel({ now: this.now(), end: market.end,
      beatPrice: this.reference?.start === market.start ? this.reference.price : null,
      binance: this.binance, chainlink: this.chainlink });
  }
  snapshot() {
    return { chainlink: { status: this.socketStatus, latest: this.chainlink.at(-1) || null, error: this.socketError },
      binance: { samples: this.binance.length, latest: this.binance.at(-1) || null, error: this.historyError },
      reference: this.reference, referenceError: this.referenceError };
  }
}
module.exports = ProbabilityFeed;
