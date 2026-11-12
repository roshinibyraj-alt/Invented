'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const marketData = require('../wick-market-data');
const MispricingBot = require('../mispricing-bot');

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }
}

test('Polymarket stream subscribes to both outcome tokens and forwards updates', async () => {
  FakeWebSocket.instances = [];
  const received = [];
  const stream = marketData.connectMarketStream(['up-token', 'down-token', 'up-token'], {
    WebSocketImpl: FakeWebSocket,
    heartbeatMs: 60_000,
    reconnect: false,
    onMessage: (message) => received.push(message),
  });
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://ws-subscriptions-clob.polymarket.com/ws/market');
  socket.readyState = 1;
  socket.emit('open');
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    assets_ids: ['up-token', 'down-token'],
    type: 'market',
    custom_feature_enabled: true,
  });
  const payload = { event_type: 'book', asset_id: 'up-token', bids: [], asks: [] };
  socket.emit('message', { data: JSON.stringify(payload) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [payload]);
  stream.close();
});

test('market book events update visible depth for paper fills', () => {
  let now = 1000;
  const bot = new MispricingBot({ now: () => now, marketData: {}, priceFeed: { snapshot: () => ({}) } });
  bot.market = { tokens: { UP: 'up-token', DOWN: 'down-token' } };
  bot.handleMarketMessage({
    event_type: 'book',
    asset_id: 'up-token',
    timestamp: '900',
    bids: [{ price: '0.38', size: '120' }],
    asks: [{ price: '0.41', size: '150' }],
  });
  assert.equal(bot.liveQuotes.UP.bestAsk, 0.41);
  assert.equal(bot.liveQuotes.UP.askLevels[0].availableSize, 150);
  now += 100;
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '1000',
    price_changes: [{ asset_id: 'up-token', side: 'SELL', price: '0.40', size: '80' }],
  });
  assert.equal(bot.liveQuotes.UP.bestAsk, 0.4);
  assert.equal(bot.liveQuotes.UP.askLevels[0].availableSize, 80);
});
