'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Bot = require('../bot');

const emptyBook = { bids: [], asks: [] };

function bookAtMidpoint(midpoint) {
  return {
    bids: [{ price: String(midpoint - 0.01), size: '50' }],
    asks: [{ price: String(midpoint + 0.01), size: '50' }],
  };
}

function makeBot(books, withPosition = true) {
  const trader = {
    balance: 5000,
    getOrderBook: async (tokenId) => books[tokenId] || emptyBook,
    placeFokLimitOrder: async () => ({
      id: 'filled-order',
      avgPrice: 0.5,
      isFilled: true,
      raw: { status: 'matched', makingAmount: '50', takingAmount: '100' },
    }),
  };
  const bot = new Bot(trader);
  const window = { slug: 'test-window', tokenUp: 'up', tokenDown: 'down', closeTs: 600 };
  bot.w = {
    slug: window.slug,
    openTs: 300,
    status: 'fired',
    signal: { side: 'DOWN' },
    window,
    marketWinner: null,
    marketWinnerQuote: null,
  };
  const position = {
    id: 'position-1',
    tokenId: 'down',
    tokenUp: 'up',
    tokenDown: 'down',
    slug: window.slug,
    openTs: 300,
    closeTs: 600,
    side: 'DOWN',
    shares: 100,
    price: 0.5,
    firedAt: Date.now(),
    status: 'OPEN',
    winner: null,
    settlementWinner: null,
    settledAt: null,
    realizedPnl: null,
    settlementQuote: null,
    upMidpoint: null,
    downMidpoint: null,
    markPrice: null,
    marketValue: null,
    unrealizedPnl: null,
    quoteUpdatedAt: null,
    markStatus: 'Waiting for the first CLOB quote',
  };
  bot.pending = withPosition ? [position] : [];
  return { bot, window, position };
}

test('latches either side at exactly $0.99 and retains it after books disappear', async (t) => {
  for (const [side, books] of [
    ['UP', { up: bookAtMidpoint(0.99), down: emptyBook }],
    ['DOWN', { up: emptyBook, down: bookAtMidpoint(0.99) }],
  ]) {
    await t.test(`${side} qualifies with the opposing quote unavailable`, async () => {
      const { bot, window, position } = makeBot(books);
      await bot._refreshMarketData(window);
      assert.equal(position.settlementWinner, side);
      assert.equal(bot.w.marketWinner, side);

      bot.trader.getOrderBook = async () => emptyBook;
      await bot._refreshMarketData(window);
      assert.equal(position.settlementWinner, side);
      assert.equal(position.settlementQuote.updatedAt > 0, true);
    });
  }
});

test('empty, zero, and sub-$0.99 midpoints remain unresolved', async () => {
  for (const books of [
    { up: emptyBook, down: emptyBook },
    { up: { bids: [{ price: '0', size: '50' }], asks: [] }, down: emptyBook },
    { up: bookAtMidpoint(0.989), down: bookAtMidpoint(0.5) },
  ]) {
    const { bot, window, position } = makeBot(books);
    await bot._refreshMarketData(window);
    assert.equal(position.settlementWinner, null);
    assert.match(bot.snapshot().pending[0].resultCheck, /No CLOB midpoint has reached/);
  }
});

test('carries an earlier window winner into a later fill and marks the other side as a loss', async () => {
  const { bot, window } = makeBot({ up: bookAtMidpoint(0.99), down: emptyBook }, false);
  await bot._refreshMarketData(window);
  assert.equal(bot.w.marketWinner, 'UP');

  await bot._fire(bot.w, 'DOWN', 'down', 0.5);
  const position = bot.pending[0];
  assert.equal(position.settlementWinner, 'UP');
  bot._settle(position, position.settlementWinner);
  assert.equal(position.status, 'SETTLED_LOSS');
  assert.equal(position.winner, 'UP');
});

test('does not guess when both sides simultaneously meet the threshold', async () => {
  const { bot, window, position } = makeBot({
    up: bookAtMidpoint(0.99),
    down: bookAtMidpoint(0.99),
  });
  await bot._refreshMarketData(window);
  assert.equal(position.settlementWinner, null);
  assert.equal(bot.w.marketWinner, null);
});