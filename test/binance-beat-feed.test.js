'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceBeatFeed = require('../binance-beat-feed');

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.readyState = 1;
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

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

test('connects to Binance public aggregate trades and records beat snapshots', () => {
  FakeWebSocket.instances = [];
  const now = 1_800_000_000_000;
  const feed = new BinanceBeatFeed({ WebSocketImpl: FakeWebSocket, now: () => now });
  feed.start();
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.url, /data-stream\.binance\.vision\/ws\/btcusdt@aggTrade/);
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ e: 'aggTrade', p: '62012.5', T: now - 250 }) });
  const beat = feed.getBeatPriceAt(now);
  assert.equal(feed.status, 'CONNECTED');
  assert.equal(beat.value, 62_012.5);
  assert.equal(beat.source, 'BINANCE_WS_ESTIMATE');
  assert.equal(beat.offsetMs, -250);
  assert.equal(beat.exact, false);
  feed.stop();
});

test('uses the rolling 60-second BTC high-low range for a $2 to $100 tolerance', () => {
  const now = 1_800_000_000_000;
  const feed = new BinanceBeatFeed({ now: () => now });
  feed.recordTick(62_000, now - 20_000);
  feed.recordTick(62_003, now - 5_000);
  let stats = feed.getVolatilityBand(now);
  assert.equal(stats.ready, true);
  assert.equal(stats.rangeUsd, 3);
  assert.equal(stats.bandUsd, 3);

  feed.recordTick(62_200, now - 1_000);
  stats = feed.getVolatilityBand(now);
  assert.equal(stats.rangeUsd, 200);
  assert.equal(stats.bandUsd, 100);
});

test('floors calm-market tolerance at $2 and refuses stale Binance ticks', () => {
  const now = 1_800_000_000_000;
  const feed = new BinanceBeatFeed({ now: () => now });
  feed.recordTick(62_000, now - 4_000);
  feed.recordTick(62_001, now - 2_000);
  assert.equal(feed.getVolatilityBand(now).bandUsd, 2);
  assert.equal(feed.getVolatilityBand(now).ready, true);

  const stale = new BinanceBeatFeed({ now: () => now });
  stale.recordTick(62_000, now - 20_000);
  stale.recordTick(62_001, now - 10_000);
  assert.equal(stale.getVolatilityBand(now).ready, false);
});

test('does not use a Binance tick too far from the market start', () => {
  const now = 1_800_000_000_000;
  const feed = new BinanceBeatFeed({ now: () => now });
  feed.recordTick(62_000, now - 4_000);
  assert.equal(feed.getBeatPriceAt(now), null);
});
