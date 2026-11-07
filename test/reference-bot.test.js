"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../config.js");
const Bot = require("../wick-bot.js");
const PrebuyBot = require("../prebuy-bot.js");
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

test("both independent strategies use separate $10,000 demo accounts on BTC 5-minute windows", () => {
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ["trigger-5m", "prebuy-5m"]);
  assert.equal(multi.bots["trigger-5m"].capital, 10000);
  assert.equal(multi.bots["prebuy-5m"].capital, 10000);
  assert.equal(multi.snapshot().strategies["trigger-5m"].account.capital, 10000);
  assert.equal(multi.snapshot().strategies["prebuy-5m"].account.capital, 10000);
  assert.equal(multi.snapshot().account.capital, 20000);
  assert.deepEqual(multi.snapshot().strategy.timeframes, ["5m"]);
});

test("prebuy strategy selects the next market 10 seconds before its window", () => {
  const bot = new PrebuyBot();
  const currentStart = FIRST_START;
  assert.equal(bot.getWindowStartToScan(currentStart + WINDOW_5M - 10_001, currentStart),
    currentStart);
  assert.equal(bot.getWindowStartToScan(currentStart + WINDOW_5M - 10_000, currentStart),
    currentStart + WINDOW_5M);
  assert.equal(bot.getWindowStartToScan(currentStart + WINDOW_5M, currentStart + WINDOW_5M),
    currentStart + WINDOW_5M);
});

test("prebuy buys 500 shares on each side before open and activates $0.70 TPs at second one", async () => {
  const bot = new PrebuyBot();
  bot.log = () => {};
  const start = FIRST_START + WINDOW_5M;
  bot.market = {
    id: "5m-prebuy-market", slug: "btc-updown-5m-prebuy",
    title: "BTC 5m prebuy test", start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  const entryAt = start - config.PREBUY_LEAD_MS;
  bot.openStrategyWindow(start, entryAt);
  quotePair(bot, entryAt, { upAsk: 0.40, downAsk: 0.60 });

  assert.equal(bot.processPairedEntry(entryAt), true);
  assert.equal(bot.positions.length, 2);
  await bot.closePreviousWindows(start - WINDOW_5M, entryAt);
  assert.ok(bot.positions.every(position => position.status === "OPEN"),
    "the upcoming market's pre-bought positions must not be closed by the previous window");
  assert.ok(bot.positions.every(position => position.shares === 500));
  assert.ok(bot.positions.every(position => position.strategyId === "prebuy-5m"));
  assert.equal(bot.orders.filter(order => order.action === "BUY").length, 2);
  assert.equal(bot.orders.filter(order => order.action === "SELL").length, 0,
    "TP limits are deferred until one second after the window opens");
  assert.equal(bot.activateDeferredTakeProfits(start + 999), false);
  assert.equal(bot.activateDeferredTakeProfits(start + 1000), true);

  const takeProfits = bot.orders.filter(order => order.action === "SELL");
  assert.equal(takeProfits.length, 2);
  assert.ok(takeProfits.every(order => order.limitPrice === 0.70));
  assert.equal(bot.activateDeferredTakeProfits(start + 1001), false,
    "activation must not create duplicate take-profit orders");
});

test("prebuy first TP fill moves only the opposite TP to $0.99", () => {
  const bot = new PrebuyBot();
  bot.log = () => {};
  const start = FIRST_START + WINDOW_5M;
  bot.market = {
    id: "5m-prebuy-market", slug: "btc-updown-5m-prebuy",
    title: "BTC 5m prebuy test", start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  const entryAt = start - config.PREBUY_LEAD_MS;
  bot.openStrategyWindow(start, entryAt);
  quotePair(bot, entryAt, { upAsk: 0.40, downAsk: 0.60 });
  bot.processPairedEntry(entryAt);
  bot.activateDeferredTakeProfits(start + config.PREBUY_TAKE_PROFIT_DELAY_MS);
  const up = bot.positions.find(position => position.side === "UP");
  const down = bot.positions.find(position => position.side === "DOWN");
  const downTp = bot.orders.find(order => order.action === "SELL" && order.side === "DOWN");

  quote(bot, "UP", start + 1200, { bid: 0.70, ask: 0.72 });
  quote(bot, "DOWN", start + 1200, { bid: 0.65, ask: 0.67 });
  bot.processPendingTakeProfitOrders(start + 1200);
  assert.equal(up.status, "SETTLED_EXIT");
  assert.equal(down.status, "OPEN");
  assert.equal(downTp.limitPrice, 0.99);
  assert.equal(down.takeProfitPrice, 0.99);
});

test("prebuy tick fetches the upcoming market early and keeps positions through its open", async () => {
  const bot = new PrebuyBot();
  bot.log = () => {};
  const start = FIRST_START + WINDOW_5M;
  let now = start - config.PREBUY_LEAD_MS;
  const originalNow = Date.now;
  const originalGetBtcMarket = marketData.getBtcMarket;
  const originalGetBook = marketData.getBook;
  Date.now = () => now;
  marketData.getBtcMarket = async marketStart => ({
    id: "5m-prebuy-tick-market", slug: "btc-updown-5m-prebuy-tick",
    title: "BTC 5m prebuy tick test", start: marketStart,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  });
  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === "up-token" ? "0.39" : "0.59", size: "1000" }],
    asks: [{ price: tokenId === "up-token" ? "0.40" : "0.60", size: "1000" }],
  });
  try {
    await bot.tick();
    assert.equal(bot.positions.length, 2);
    assert.ok(bot.positions.every(position => position.status === "OPEN"));

    now = start - 100;
    await bot.tick();
    assert.ok(bot.positions.every(position => position.status === "OPEN"),
      "the future window's positions remain open immediately before the boundary");

    now = start + config.PREBUY_TAKE_PROFIT_DELAY_MS;
    await bot.tick();
    assert.equal(bot.orders.filter(order => order.action === "SELL").length, 2);
    assert.ok(bot.orders.filter(order => order.action === "SELL")
      .every(order => order.limitPrice === 0.70));
  } finally {
    Date.now = originalNow;
    marketData.getBtcMarket = originalGetBtcMarket;
    marketData.getBook = originalGetBook;
  }
});

test("prebuy does not enter after the upcoming window has already opened", () => {
  const bot = new PrebuyBot();
  bot.log = () => {};
  const start = FIRST_START + WINDOW_5M;
  bot.market = {
    id: "5m-prebuy-late-market", slug: "btc-updown-5m-prebuy-late",
    title: "BTC 5m late prebuy test", start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  bot.openStrategyWindow(start, start - config.PREBUY_LEAD_MS);
  quotePair(bot, start, { upAsk: 0.40, downAsk: 0.60 });
  assert.equal(bot.processPairedEntry(start), false);
  assert.equal(bot.entryAttemptMissed, true);
  assert.equal(bot.positions.length, 0);
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
