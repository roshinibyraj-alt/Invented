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

function quotePair(bot, updatedAt, { upBid = 0.49, upAsk = 0.50, downBid = 0.59, downAsk = 0.60, upLevels, downLevels } = {}) {
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

test("prebuy scans the next market and uses separate signal and entry times", () => {
  const bot = new PrebuyBot();
  const currentStart = FIRST_START;
  assert.equal(bot.getWindowStartToScan(currentStart + WINDOW_5M - 10_001, currentStart),
    currentStart);
  assert.equal(bot.getWindowStartToScan(currentStart + WINDOW_5M - config.PREBUY_SCAN_LEAD_MS, currentStart),
    currentStart + WINDOW_5M);
  assert.equal(bot.getWindowStartToScan(currentStart + WINDOW_5M, currentStart + WINDOW_5M),
    currentStart + WINDOW_5M);
  assert.equal(config.PREBUY_SIGNAL_LEAD_MS, 5000);
  assert.equal(config.PREBUY_ORDER_LEAD_MS, 2000);
});

test("green closed candle buys UP at two seconds before open and activates $0.70 TP at second one", () => {
  const start = FIRST_START + WINDOW_5M;
  const candleFeed = { getMinuteCandles: () => [
    { t: start - 120_000, o: 100, c: 101 },
    { t: start - 60_000, o: 101, c: 99 },
  ] };
  const bot = new PrebuyBot({ candleFeed });
  bot.log = () => {};
  bot.market = {
    id: "5m-prebuy-market", slug: "btc-updown-5m-prebuy",
    title: "BTC 5m prebuy test", start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  const scanAt = start - config.PREBUY_SCAN_LEAD_MS;
  bot.openStrategyWindow(start, scanAt);
  quotePair(bot, scanAt, { upAsk: 0.40, downAsk: 0.60 });

  assert.equal(bot.processPairedEntry(scanAt), false);
  const signalAt = start - config.PREBUY_SIGNAL_LEAD_MS;
  assert.equal(bot.processPairedEntry(signalAt), false);
  assert.equal(bot.entryTriggerSide, "UP");
  assert.equal(bot.entryTriggerCandle.close, 101,
    "the still-forming latest minute must not replace the last closed candle");

  const orderAt = start - config.PREBUY_ORDER_LEAD_MS;
  quotePair(bot, orderAt, { upAsk: 0.40, downAsk: 0.60 });
  assert.equal(bot.processPairedEntry(orderAt), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "UP");
  assert.equal(bot.positions[0].shares, 500);
  assert.equal(bot.positions[0].filledAt, orderAt);
  assert.equal(bot.positions[0].strategyId, "prebuy-5m");
  assert.equal(bot.orders.filter(order => order.action === "BUY").length, 1);
  assert.equal(bot.orders.filter(order => order.action === "SELL").length, 0,
    "TP limits are deferred until one second after the window opens");
  assert.equal(bot.activateDeferredTakeProfits(start + config.PREBUY_TAKE_PROFIT_DELAY_MS - 1), false);
  assert.equal(bot.activateDeferredTakeProfits(start + config.PREBUY_TAKE_PROFIT_DELAY_MS), true);

  const takeProfits = bot.orders.filter(order => order.action === "SELL");
  assert.equal(takeProfits.length, 1);
  assert.equal(takeProfits[0].limitPrice, 0.70);
  assert.equal(bot.activateDeferredTakeProfits(start + config.PREBUY_TAKE_PROFIT_DELAY_MS + 1), false,
    "activation must not create duplicate take-profit orders");
});

test("red candle buys only DOWN and a doji skips the pre-buy", () => {
  const start = FIRST_START + WINDOW_5M;
  const redFeed = { getMinuteCandles: () => [{ t: start - 120_000, o: 101, c: 100 }] };
  const bot = new PrebuyBot({ candleFeed: redFeed });
  bot.log = () => {};
  bot.market = {
    id: "5m-prebuy-market", slug: "btc-updown-5m-prebuy",
    title: "BTC 5m prebuy test", start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  const scanAt = start - config.PREBUY_SCAN_LEAD_MS;
  bot.openStrategyWindow(start, scanAt);
  quotePair(bot, start - config.PREBUY_ORDER_LEAD_MS);
  bot.processPairedEntry(start - config.PREBUY_SIGNAL_LEAD_MS);
  assert.equal(bot.entryTriggerSide, "DOWN");
  assert.equal(bot.processPairedEntry(start - config.PREBUY_ORDER_LEAD_MS), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN");

  const dojiBot = new PrebuyBot({ candleFeed: {
    getMinuteCandles: () => [{ t: start - 120_000, o: 100, c: 100 }],
  } });
  dojiBot.log = () => {};
  dojiBot.market = { ...bot.market, start };
  dojiBot.openStrategyWindow(start, scanAt);
  quotePair(dojiBot, start - config.PREBUY_ORDER_LEAD_MS);
  dojiBot.processPairedEntry(start - config.PREBUY_SIGNAL_LEAD_MS);
  assert.equal(dojiBot.entryAttemptMissed, true);
  assert.equal(dojiBot.positions.length, 0);
});

test("prebuy tick scans early, reads the candle at five seconds, and buys at two seconds", async () => {
  const start = FIRST_START + WINDOW_5M;
  const candleFeed = { getMinuteCandles: () => [{ t: start - 120_000, o: 100, c: 101 }] };
  const bot = new PrebuyBot({ candleFeed });
  bot.log = () => {};
  let now = start - config.PREBUY_SCAN_LEAD_MS;
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
    assert.equal(bot.positions.length, 0);

    now = start - config.PREBUY_SIGNAL_LEAD_MS;
    await bot.tick();
    assert.equal(bot.entryTriggerSide, "UP");
    assert.equal(bot.positions.length, 0);

    now = start - config.PREBUY_ORDER_LEAD_MS;
    await bot.tick();
    assert.equal(bot.positions.length, 1);
    assert.equal(bot.positions[0].side, "UP");
    assert.equal(bot.positions[0].shares, 500);

    now = start + config.PREBUY_TAKE_PROFIT_DELAY_MS;
    await bot.tick();
    assert.equal(bot.orders.filter(order => order.action === "SELL").length, 1);
    assert.equal(bot.orders.filter(order => order.action === "SELL")[0].limitPrice, 0.70);
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
  bot.openStrategyWindow(start, start - config.PREBUY_SCAN_LEAD_MS);
  quotePair(bot, start, { upAsk: 0.40, downAsk: 0.60 });
  assert.equal(bot.processPairedEntry(start), false);
  assert.equal(bot.entryAttemptMissed, true);
  assert.equal(bot.positions.length, 0);
});

test("waits until 4:00, then places all four fixed-price limit buys without the old band", () => {
  const bot = makeBot();
  assert.equal(fire(bot, 239_999, { upAsk: 0.50, downAsk: 0.52 }), false);
  assert.equal(fire(bot, 240_000, { upAsk: 0.42, downAsk: 0.59 }), false);
  assert.equal(bot.positions.length, 0);
  const buys = bot.orders.filter(order => order.action === "BUY");
  assert.equal(buys.length, 4);
  assert.ok(buys.every(order => order.status === "PENDING" && order.orderType === "LIMIT"));
  assert.deepEqual(buys.map(order => order.limitPrice).sort((a, b) => a - b), [0.10, 0.10, 0.20, 0.20]);
});

test("each rung fills only at its fixed limit and immediately receives its own TP", () => {
  const bot = makeBot();
  assert.equal(fire(bot, 240_000, {
    upAsk: 0.20, downAsk: 0.10,
    upLevels: [{ price: 0.20, size: 300 }],
    downLevels: [{ price: 0.10, size: 600 }],
  }), true);
  const up20 = bot.positions.find(position => position.side === "UP" && position.rungId === "0.20");
  const down20 = bot.positions.find(position => position.side === "DOWN" && position.rungId === "0.20");
  const down10 = bot.positions.find(position => position.side === "DOWN" && position.rungId === "0.10");
  assert.equal(bot.positions.length, 3);
  assert.equal(up20.avgEntry, 0.20);
  assert.equal(down20.avgEntry, 0.20);
  assert.equal(down10.avgEntry, 0.10);
  assert.equal(up20.takeProfitPrice, 0.80);
  assert.equal(down20.takeProfitPrice, 0.80);
  assert.equal(down10.takeProfitPrice, 0.90);
  assert.ok(bot.orders.filter(order => order.action === "SELL").every(order => order.status === "PENDING"));
  assert.equal(bot.snapshot().account.takerFees, 0);
  assert.ok(bot.snapshot().account.estimatedMakerRebate > 0);
});

test("a partial limit fill books actual shares and completes without rearming", () => {
  const bot = makeBot();
  fire(bot, 240_000, {
    upAsk: 0.20, downAsk: 0.60,
    upLevels: [{ price: 0.20, size: 4 }],
  });
  const up = bot.positions.find(position => position.side === "UP" && position.rungId === "0.20");
  const upBuy = bot.orders.find(order => order.action === "BUY" && order.side === "UP" && order.rungId === "0.20");
  const upSell = bot.orders.find(order => order.action === "SELL" && order.side === "UP");
  assert.equal(up.shares, 4);
  assert.equal(up.requestedShares, 300);
  assert.equal(upBuy.status, "FILLED");
  assert.equal(upBuy.cancelledRemainderShares, 296);
  assert.equal(upSell.shares, 4);
});

test("the $0.20 TP is $0.80, the $0.10 TP is $0.90, opposite sells retain the $0.99 rule", () => {
  const bot = makeBot();
  fire(bot, 240_000, {
    upAsk: 0.10, downAsk: 0.10,
    upLevels: [{ price: 0.10, size: 600 }],
    downLevels: [{ price: 0.10, size: 600 }],
  });
  const up20 = bot.positions.find(position => position.side === "UP" && position.rungId === "0.20");
  const up10 = bot.positions.find(position => position.side === "UP" && position.rungId === "0.10");
  const down20 = bot.positions.find(position => position.side === "DOWN" && position.rungId === "0.20");
  const down10 = bot.positions.find(position => position.side === "DOWN" && position.rungId === "0.10");
  const up20Tp = bot.orders.find(order => order.action === "SELL" && order.positionId === up20.id);
  const up10Tp = bot.orders.find(order => order.action === "SELL" && order.positionId === up10.id);
  const down20Tp = bot.orders.find(order => order.action === "SELL" && order.positionId === down20.id);
  const down10Tp = bot.orders.find(order => order.action === "SELL" && order.positionId === down10.id);
  assert.equal(up20Tp.limitPrice, 0.80);
  assert.equal(up10Tp.limitPrice, 0.90);
  assert.equal(down20Tp.limitPrice, 0.80);
  assert.equal(down10Tp.limitPrice, 0.90);

  quote(bot, "UP", FIRST_START + 241_000, { bid: 0.80, ask: 0.82 });
  quote(bot, "DOWN", FIRST_START + 241_000, { bid: 0.70, ask: 0.72 });
  bot.processPendingTakeProfitOrders(FIRST_START + 241_000);
  assert.equal(up20.status, "SETTLED_EXIT");
  assert.equal(up20.payout, 0.80);
  assert.equal(up20.proceeds, 240);
  assert.equal(up10.status, "OPEN");
  assert.equal(up10Tp.limitPrice, 0.90);
  assert.equal(down20.status, "OPEN");
  assert.equal(down10.status, "OPEN");
  assert.equal(down20Tp.limitPrice, 0.99);
  assert.equal(down10Tp.limitPrice, 0.99);

  quote(bot, "DOWN", FIRST_START + 242_000, { bid: 0.99, ask: 1 });
  bot.processPendingTakeProfitOrders(FIRST_START + 242_000);
  assert.equal(down20.status, "SETTLED_EXIT");
  assert.equal(down20.payout, 1);
  assert.equal(down20.proceeds, 300);
  assert.equal(down20Tp.fillPrice, 0.99);
  assert.equal(bot.snapshot().account.takerFees, 0);
});

test("take-profit outcome and exit counts follow realized net P&L", () => {
  const bot = makeBot();
  bot.market.feesEnabled = false;
  fire(bot, 240_000, {
    upAsk: 0.20, downAsk: 0.60,
    upLevels: [{ price: 0.20, size: 300 }],
  });
  const up = bot.positions.find(position => position.side === "UP" && position.rungId === "0.20");
  quote(bot, "UP", FIRST_START + 241_000, { bid: 0.80, ask: 0.82 });
  quote(bot, "DOWN", FIRST_START + 241_000, { bid: 0.70, ask: 0.72 });
  bot.processPendingTakeProfitOrders(FIRST_START + 241_000);

  assert.equal(up.realizedPnl, 180);
  assert.equal(up.strategyOutcome, "WIN");
  const account = bot.snapshot().account;
  assert.equal(account.profitableExits, 1);
  assert.equal(account.losingExits, 0);
  assert.equal(account.breakEvenExits, 0);
});

test("positions missing TP at window end wait for official resolution", async () => {
  const bot = makeBot();
  fire(bot, 240_000, {
    upAsk: 0.20, downAsk: 0.20,
    upLevels: [{ price: 0.20, size: 300 }],
    downLevels: [{ price: 0.20, size: 300 }],
  });
  const up = bot.positions.find(position => position.side === "UP" && position.rungId === "0.20");
  const down = bot.positions.find(position => position.side === "DOWN" && position.rungId === "0.20");
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
