"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../config.js");
const Bot = require("../wick-bot.js");
const MultiBot = require("../multi-bot.js");
const marketData = require("../wick-market-data.js");

const WINDOW_5M = config.WINDOW_MS_5M;
const FIRST_START = 1_800_000_000_000;
const TAKER_RATE = config.CRYPTO_TAKER_FEE_RATE;

function makeBot() {
  const bot = new Bot({ timeframe: "5m", windowMs: WINDOW_5M, capital: config.DEMO_CAPITAL });
  bot.log = () => {};
  bot.market = {
    id: "5m-test-market",
    slug: "btc-updown-5m-test",
    title: "BTC 5m test",
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
  return bot.processPairedEntry(at);
}

function fee(price, shares) {
  return TAKER_RATE * price * (1 - price) * shares;
}

test("only the 5-minute BTC bot runs with the $10,000 demo allocation", () => {
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ["5m"]);
  assert.equal(multi.bots["5m"].capital, 10000);
  assert.equal(multi.snapshot().account.capital, 10000);
  assert.deepEqual(multi.snapshot().strategy.timeframes, ["5m"]);
});

test("does not enter before 4:00 or at the strict price-band boundaries", () => {
  const bot = makeBot();
  assert.equal(fire(bot, 239_999, { upAsk: 0.50, downAsk: 0.52 }), false);
  assert.equal(fire(bot, 240_000, { upAsk: 0.42, downAsk: 0.59 }), false);
  assert.equal(bot.positions.length, 0);
});

test("one qualifying ask triggers 300-share market buys on both sides once", () => {
  const bot = makeBot();
  assert.equal(fire(bot, 240_000, {
    upAsk: 0.50, downAsk: 0.65,
    upLevels: [{ price: 0.50, size: 200 }, { price: 0.52, size: 100 }],
    downLevels: [{ price: 0.65, size: 300 }],
  }), true);
  assert.equal(bot.positions.length, 2);
  const bySide = Object.fromEntries(bot.positions.map(position => [position.side, position]));
  assert.equal(bySide.UP.shares, 300);
  assert.equal(bySide.DOWN.shares, 300);
  assert.ok(bySide.UP.avgEntry > 0.50, "sweeping deeper asks can worsen the average fill");
  assert.equal(bot.orders.filter(order => order.action === "BUY").length, 2);
  assert.ok(bot.orders.filter(order => order.action === "BUY").every(order => order.orderType === "MARKET"));

  fire(bot, 250_000, { upAsk: 0.50, downAsk: 0.52 });
  fire(bot, 299_999, { upAsk: 0.50, downAsk: 0.52 });
  assert.equal(bot.positions.length, 2, "a persistent signal must not repeat buys in one window");
});

test("a seen trigger waits for fresh books without losing the signal", () => {
  const bot = makeBot();
  const at = FIRST_START + 240_000;
  quotePair(bot, at, { upAsk: 0.50, downAsk: 0.52 });
  bot.liveQuotes.DOWN.updatedAt = at - 6000;
  assert.equal(bot.processPairedEntry(at), false);
  assert.equal(bot.entryTriggerLatched, true);
  assert.equal(bot.entryPairPlaced, false);
  quotePair(bot, at + 500, { upAsk: 0.65, downAsk: 0.62 });
  assert.equal(bot.processPairedEntry(at + 500), true);
  assert.equal(bot.positions.length, 2);
});

test("paired market buys sweep ask depth and charge taker fees", () => {
  const bot = makeBot();
  fire(bot, 240_000, {
    upAsk: 0.50, downAsk: 0.55,
    upLevels: [{ price: 0.50, size: 200 }, { price: 0.52, size: 100 }],
    downLevels: [{ price: 0.55, size: 300 }],
  });
  const up = bot.positions.find(position => position.side === "UP");
  const down = bot.positions.find(position => position.side === "DOWN");
  const expectedUpFee = fee(0.50, 200) + fee(0.52, 100);
  assert.equal(up.shares, 300);
  assert.ok(Math.abs(up.cost - 152) < 1e-9);
  assert.ok(Math.abs(up.fees - expectedUpFee) < 1e-9);
  assert.equal(down.shares, 300);
  assert.ok(Math.abs(down.fees - fee(0.55, 300)) < 1e-9);
  assert.equal(up.takeProfitPrice, 0.80);
  assert.equal(down.takeProfitPrice, 0.80);
  assert.equal(bot.orders.filter(order => order.action === "SELL").length, 2);
});

test("limited displayed depth records the actual partial fill on either paired leg", () => {
  const bot = makeBot();
  fire(bot, 1000, {
    upAsk: 0.50,
    downAsk: 0.55,
    upLevels: [{ price: 0.50, size: 4 }],
  });
  assert.equal(bot.positions.length, 0, "entries remain disabled until the last minute");
  fire(bot, 240_000, {
    upAsk: 0.50,
    downAsk: 0.55,
    upLevels: [{ price: 0.50, size: 4 }],
  });
  const up = bot.positions.find(position => position.side === "UP");
  const upBuy = bot.orders.find(order => order.action === "BUY" && order.side === "UP");
  const upSell = bot.orders.find(order => order.action === "SELL" && order.side === "UP");
  assert.equal(up.shares, 4);
  assert.equal(up.requestedShares, 300);
  assert.equal(upBuy.status, "PARTIALLY_FILLED");
  assert.equal(upBuy.cancelledRemainderShares, 296);
  assert.equal(upSell.shares, 4);
});

test("first $0.80 TP moves the other limit sell to $0.99 for $1-per-share payout", () => {
  const bot = makeBot();
  fire(bot, 240_000, { upAsk: 0.50, downAsk: 0.55 });
  const up = bot.positions.find(position => position.side === "UP");
  const down = bot.positions.find(position => position.side === "DOWN");
  const upTp = bot.orders.find(order => order.action === "SELL" && order.side === "UP");
  const downTp = bot.orders.find(order => order.action === "SELL" && order.side === "DOWN");
  assert.equal(upTp.limitPrice, 0.80);
  assert.equal(downTp.limitPrice, 0.80);

  quote(bot, "UP", FIRST_START + 241_000, { bid: 0.80, ask: 0.82 });
  quote(bot, "DOWN", FIRST_START + 241_000, { bid: 0.70, ask: 0.72 });
  bot.processPendingTakeProfitOrders(FIRST_START + 241_000);
  assert.equal(up.status, "SETTLED_EXIT");
  assert.equal(up.payout, 0.80);
  assert.equal(up.proceeds, 240);
  assert.equal(down.status, "OPEN");
  assert.equal(downTp.limitPrice, 0.99);
  assert.equal(down.takeProfitPrice, 0.99);

  quote(bot, "DOWN", FIRST_START + 242_000, { bid: 0.99, ask: 1 });
  bot.processPendingTakeProfitOrders(FIRST_START + 242_000);
  assert.equal(down.status, "SETTLED_EXIT");
  assert.equal(down.payout, 1);
  assert.equal(down.proceeds, 300);
  assert.equal(downTp.fillPrice, 0.99);
  assert.ok(Math.abs(bot.snapshot().account.takerFees -
    (fee(0.50, 300) + fee(0.55, 300))) < 1e-9);
});

test("take-profit outcome and exit counts follow realized net P&L", () => {
  const bot = makeBot();
  bot.market.feesEnabled = false;
  fire(bot, 240_000, { upAsk: 0.80, downAsk: 0.50 });
  const up = bot.positions.find(position => position.side === "UP");
  quote(bot, "UP", FIRST_START + 241_000, { bid: 0.80, ask: 0.82 });
  quote(bot, "DOWN", FIRST_START + 241_000, { bid: 0.70, ask: 0.72 });
  bot.processPendingTakeProfitOrders(FIRST_START + 241_000);

  assert.equal(up.realizedPnl, 0);
  assert.equal(up.strategyOutcome, "BREAK_EVEN");
  const account = bot.snapshot().account;
  assert.equal(account.profitableExits, 0);
  assert.equal(account.losingExits, 0);
  assert.equal(account.breakEvenExits, 1);
});

test("positions missing TP at window end wait for official resolution", async () => {
  const bot = makeBot();
  fire(bot, 240_000, { upAsk: 0.50, downAsk: 0.55 });
  const up = bot.positions.find(position => position.side === "UP");
  const down = bot.positions.find(position => position.side === "DOWN");
  const nextStart = FIRST_START + WINDOW_5M;
  await bot.closePreviousWindows(nextStart, nextStart);
  assert.equal(up.status, "PENDING_RESOLUTION");
  assert.equal(down.status, "PENDING_RESOLUTION");

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
  assert.equal(up.status, "SETTLED_EXIT");
  assert.equal(up.settlementBasis, "POLYMARKET_RESOLUTION");
  assert.equal(up.payout, 1);
  assert.equal(up.proceeds, 300);
  assert.equal(up.strategyOutcome, "WIN");
  assert.equal(down.status, "SETTLED_EXIT");
  assert.equal(down.proceeds, 0);
  assert.equal(down.strategyOutcome, "LOSS");
});
