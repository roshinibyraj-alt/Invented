"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../config.js");
const Bot = require("../wick-bot.js");
const MultiBot = require("../multi-bot.js");
const marketData = require("../wick-market-data.js");

const WINDOW_5M = config.WINDOW_MS_5M;
const WINDOW_15M = config.WINDOW_MS_15M;
const FIRST_START = 1_800_000_000_000;
const TAKER_RATE = config.CRYPTO_TAKER_FEE_RATE;

function makeBot(timeframe = "5m") {
  const windowMs = timeframe === "15m" ? WINDOW_15M : WINDOW_5M;
  const bot = new Bot({ timeframe, windowMs, capital: 5000 });
  bot.log = () => {};
  bot.market = {
    id: `${timeframe}-test-market`,
    slug: `btc-updown-${timeframe}-test`,
    title: `BTC ${timeframe} test`,
    start: FIRST_START,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: true,
    feeSchedule: { rate: TAKER_RATE, exponent: 1 },
  };
  bot.openStrategyWindow(FIRST_START, FIRST_START);
  return bot;
}

function quote(bot, side, updatedAt, { bid, ask, bidSize = 1000, askSize = 1000, askLevels }) {
  bot.liveQuotes[side] = {
    status: "LIVE",
    updatedAt,
    mid: (bid + ask) / 2,
    bestBid: bid,
    bestAsk: ask,
    bidSize,
    askSize,
    askLevels: askLevels || [{ price: ask, size: askSize }],
  };
}

function quotePair(bot, updatedAt, { upBid = 0.19, upAsk = 0.20, downBid = 0.29, downAsk = 0.30, upLevels, downLevels } = {}) {
  quote(bot, "UP", updatedAt, { bid: upBid, ask: upAsk, askLevels: upLevels });
  quote(bot, "DOWN", updatedAt, { bid: downBid, ask: downAsk, askLevels: downLevels });
}

function fire(bot, elapsedMs, prices = {}) {
  const at = FIRST_START + elapsedMs;
  quotePair(bot, at, prices);
  return bot.processScheduledEntry(at);
}

function fee(price, shares) {
  return TAKER_RATE * price * (1 - price) * shares;
}

test("both BTC timeframe bots share the $10,000 demo allocation", () => {
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ["5m", "15m"]);
  assert.equal(multi.bots["5m"].capital, 5000);
  assert.equal(multi.bots["15m"].capital, 5000);
  assert.equal(multi.snapshot().account.capital, 10000);
  assert.deepEqual(multi.snapshot().strategy.timeframes, ["5m", "15m"]);
});

test("5-minute schedule buys cheap side 0–1m, then expensive side 1–3m", () => {
  const bot = makeBot("5m");
  fire(bot, 1000, { upAsk: 0.20, downAsk: 0.30 });
  fire(bot, 9999, { upAsk: 0.20, downAsk: 0.30 });
  assert.equal(bot.positions.length, 1, "do not fire more than once within one 10-second slot");
  assert.equal(bot.positions[0].side, "UP");
  assert.equal(bot.positions[0].shares, 10);
  assert.equal(bot.positions[0].phase, "cheap");

  fire(bot, 10_000, { upAsk: 0.30, downAsk: 0.15 });
  assert.equal(bot.positions[0].side, "DOWN");
  assert.equal(bot.positions[0].shares, 15);
  fire(bot, 20_000, { upAsk: 0.10, downAsk: 0.20 });
  assert.equal(bot.positions[0].side, "UP");
  assert.equal(bot.positions[0].shares, 22.5);
  const accumulated = bot.snapshot().inventory;
  assert.equal(accumulated.UP.shares, 32.5);
  assert.equal(accumulated.DOWN.shares, 15);
  assert.ok(accumulated.UP.averageCost > 0);

  fire(bot, 60_000, { upAsk: 0.60, downAsk: 0.20 });
  assert.equal(bot.positions[0].phase, "expensive");
  assert.equal(bot.positions[0].side, "UP");
  assert.equal(bot.positions[0].shares, 50);
  fire(bot, 80_000, { upAsk: 0.60, downAsk: 0.20 });
  assert.equal(bot.positions[0].shares, 75);

  const beforeInactivePhase = bot.positions.length;
  assert.equal(fire(bot, 180_000, { upAsk: 0.60, downAsk: 0.20 }), false);
  assert.equal(bot.positions.length, beforeInactivePhase);
});

test("15-minute schedule scales phase lengths and intervals by three", () => {
  const bot = makeBot("15m");
  assert.equal(bot.schedule.scale, 3);
  assert.equal(bot.schedule.cheap.endMs, 180_000);
  assert.equal(bot.schedule.cheap.intervalMs, 30_000);
  assert.equal(bot.schedule.expensive.startMs, 180_000);
  assert.equal(bot.schedule.expensive.endMs, 540_000);
  assert.equal(bot.schedule.expensive.intervalMs, 60_000);

  fire(bot, 1000, { upAsk: 0.10, downAsk: 0.20 });
  assert.equal(bot.positions[0].shares, 10);
  fire(bot, 30_000, { upAsk: 0.20, downAsk: 0.10 });
  assert.equal(bot.positions[0].shares, 15);
  fire(bot, 180_000, { upAsk: 0.60, downAsk: 0.30 });
  assert.equal(bot.positions[0].phase, "expensive");
  assert.equal(bot.positions[0].shares, 50);
  fire(bot, 240_000, { upAsk: 0.60, downAsk: 0.30 });
  assert.equal(bot.positions[0].shares, 75);
  const count = bot.positions.length;
  assert.equal(fire(bot, 540_000, { upAsk: 0.60, downAsk: 0.30 }), false);
  assert.equal(bot.positions.length, count);
});

test("15-minute market lookup uses the BTC 15m market slug and token IDs", async () => {
  const originalFetch = global.fetch;
  const requested = [];
  try {
    global.fetch = async url => {
      requested.push(String(url));
      return {
        ok: true,
        json: async () => [{
          id: "gamma-15m-market",
          slug: `btc-updown-15m-${Math.floor(FIRST_START / 1000)}`,
          question: "BTC up or down 15m",
          outcomes: '["Up","Down"]',
          clobTokenIds: '["up-15m-token","down-15m-token"]',
          feesEnabled: true,
        }],
      };
    };
    const market = await marketData.getBtcMarket(FIRST_START, WINDOW_15M);
    assert.ok(requested[0].includes(`btc-updown-15m-${Math.floor(FIRST_START / 1000)}`));
    assert.equal(market.id, "gamma-15m-market");
    assert.equal(market.tokens.UP, "up-15m-token");
    assert.equal(market.tokens.DOWN, "down-15m-token");
    assert.equal(market.end, FIRST_START + WINDOW_15M);
  } finally {
    global.fetch = originalFetch;
  }
});

test("taker buys sweep displayed ask levels and charge the configured fee", () => {
  const bot = makeBot();
  fire(bot, 1000, {
    upAsk: 0.10,
    downAsk: 0.30,
    upLevels: [{ price: 0.10, size: 5 }, { price: 0.20, size: 5 }],
  });
  const position = bot.positions[0];
  assert.equal(position.side, "UP");
  assert.equal(position.shares, 10);
  assert.equal(position.cost, 1.5);
  assert.equal(position.avgEntry, 0.15);
  const expectedFee = fee(0.10, 5) + fee(0.20, 5);
  assert.ok(Math.abs(position.fees - expectedFee) < 1e-9);
  assert.equal(position.totalCost, 1.5 + expectedFee);
  assert.equal(bot.cash, 5000 - position.totalCost);
  const buy = bot.orders.find(order => order.action === "BUY");
  assert.equal(buy.status, "FILLED");
  assert.equal(buy.orderType, "MARKET");
  assert.ok(Math.abs(buy.fee - expectedFee) < 1e-9);
});

test("limited displayed depth records the actual partial fill", () => {
  const bot = makeBot();
  fire(bot, 1000, {
    upAsk: 0.10,
    downAsk: 0.30,
    upLevels: [{ price: 0.10, size: 4 }],
  });
  const position = bot.positions[0];
  const buy = bot.orders.find(order => order.action === "BUY");
  assert.equal(position.shares, 4);
  assert.equal(position.requestedShares, 10);
  assert.equal(buy.status, "PARTIALLY_FILLED");
  assert.equal(buy.cancelledRemainderShares, 6);
  assert.equal(bot.orders.find(order => order.action === "SELL").shares, 4);
});

test("each phase compounds its share size by 1.5 within the window", () => {
  const bot = makeBot();
  const cheapSizes = [];
  for (const seconds of [0, 10, 20, 30, 40, 50]) {
    fire(bot, seconds * 1000 + 1000, { upAsk: 0.10, downAsk: 0.20 });
    cheapSizes.push(bot.positions[0].shares);
  }
  assert.deepEqual(cheapSizes, [10, 15, 22.5, 33.75, 50.625, 75.9375]);

  const expensiveSizes = [];
  for (const seconds of [60, 80, 100, 120, 140, 160]) {
    fire(bot, seconds * 1000, { upAsk: 0.70, downAsk: 0.30 });
    expensiveSizes.push(bot.positions[0].shares);
  }
  assert.deepEqual(expensiveSizes, [50, 75, 112.5, 168.75, 253.125, 379.6875]);
});

test("a $0.99 TP trigger records $1 per share and includes entry fees in P&L", () => {
  const bot = makeBot();
  fire(bot, 1000, { upAsk: 0.20, downAsk: 0.30 });
  const position = bot.positions[0];
  const takeProfit = bot.orders.find(order => order.action === "SELL");
  assert.equal(takeProfit.limitPrice, 0.99);
  assert.equal(takeProfit.shares, 10);
  quote(bot, "UP", FIRST_START + 2000, { bid: 0.99, ask: 1, askSize: 1000 });
  bot.processPendingTakeProfitOrders(FIRST_START + 2000);

  const entryCost = 2 + fee(0.20, 10);
  assert.equal(position.status, "SETTLED_EXIT");
  assert.equal(position.payout, 1);
  assert.equal(position.proceeds, 10);
  assert.ok(Math.abs(position.realizedPnl - (10 - entryCost)) < 1e-9);
  assert.equal(takeProfit.fillPrice, 0.99);
  assert.equal(position.strategyOutcome, "WIN");
  assert.ok(Math.abs(bot.snapshot().account.takerFees - fee(0.20, 10)) < 1e-9);
});

test("positions missing TP at window end wait for official resolution", async () => {
  const bot = makeBot();
  fire(bot, 1000, { upAsk: 0.20, downAsk: 0.30 });
  const position = bot.positions[0];
  const nextStart = FIRST_START + WINDOW_5M;
  await bot.closePreviousWindows(nextStart, nextStart);
  assert.equal(position.status, "PENDING_RESOLUTION");
  assert.equal(position.strategyOutcome, undefined);

  const originalGetMarket = marketData.getMarket;
  try {
    marketData.getMarket = async () => ({
      closed: true,
      outcomes: ["Up", "Down"],
      outcomePrices: ["1", "0"],
    });
    await bot.resolvePendingPositions(nextStart + config.RESOLUTION_POLL_MS);
  } finally {
    marketData.getMarket = originalGetMarket;
  }
  const entryCost = 2 + fee(0.20, 10);
  assert.equal(position.status, "SETTLED_EXIT");
  assert.equal(position.settlementBasis, "POLYMARKET_RESOLUTION");
  assert.equal(position.payout, 1);
  assert.equal(position.proceeds, 10);
  assert.ok(Math.abs(position.realizedPnl - (10 - entryCost)) < 1e-9);
  assert.equal(position.strategyOutcome, "WIN");
});
