'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeMarketEvent } = require('../clob-feed');

test('decodes current nested last_trade_price messages with aggressor side and fill metadata', () => {
  const [event] = decodeMarketEvent({
    event_type: 'last_trade_price',
    payload: {
      asset_id: 'token-up',
      price: '0.45',
      size: '6',
      side: 'SELL',
      timestamp: '1782753357257',
      transaction_hash: '0xabc',
    },
  });
  assert.equal(event.kind, 'trade');
  assert.equal(event.assetId, 'token-up');
  assert.deepEqual(event.trade, {
    price: 0.45, size: 6, side: 'SELL',
    timestamp: '1782753357257', transactionHash: '0xabc',
  });
});

test('supports legacy flattened trade events and normalizes side case', () => {
  const [event] = decodeMarketEvent({
    type: 'last_trade_price',
    assetId: 'token-down',
    price: 0.99,
    size: 10,
    side: 'buy',
    timestamp: 1782753357257,
    transactionHash: '0xdef',
  });
  assert.equal(event.kind, 'trade');
  assert.equal(event.assetId, 'token-down');
  assert.equal(event.trade.side, 'BUY');
  assert.equal(event.trade.price, 0.99);
  assert.equal(event.trade.size, 10);
});

test('continues decoding nested book messages and ignores unsupported events', () => {
  const [book] = decodeMarketEvent({
    event_type: 'book',
    payload: {
      asset_id: 'token-up',
      bids: [{ price: '0.41', size: '12' }, { price: '0.44', size: '2' }],
      asks: [{ price: '0.49', size: '8' }, { price: '0.46', size: '1' }],
    },
  });
  assert.deepEqual(book, {
    kind: 'quote', assetId: 'token-up',
    quote: { bid: 0.44, ask: 0.46 },
  });
  assert.deepEqual(decodeMarketEvent({ event_type: 'tick_size_change', payload: {} }), []);
});

