"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../config.js");
const Bot = require("../wick-bot.js");
const MultiBot = require("../multi-bot.js");
const marketData = require("../wick-market-data.js");

const WINDOW = config.WINDOW_MS_5M;
const FIRST_START = 1_800_000_000_000;

function makeBot() {
  const bot = new Bot({ timeframe: "5m", windowMs: WINDOW, capital: 300 });
  bot.log = () => {};
  bot.market = {
    id: "test-market",
    slug: "btc-updown-5m-test",
    title: "BTC 5-minute test",
    start: FIRST_START,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  bot.openStrategyWindow(FIRST_START, FIRST_START);
  bot.placeWindowEntryOrders(FIRST_START, FIRST_START);
  return bot;
}

function quote(bot, side, updatedAt, { mid, bid, ask }) {
  bot.liveQuotes[side] = {
    status: "LIVE",
    updatedAt,
    mid,
    bestBid: bid,
    bestAsk: ask,
    bidSize: 1000,
    askSize: 1000,
  };
}

function fillAt(bot, side, price, now = FIRST_START + 1_000) {
  quote(bot, side, now, { mid: price, bid: Math.max(0.01, price - 0.01), ask: price });
  bot.processPendingLimitOrders(now);
  return bot.positions.find(position => position.side === side && position.avgEntry === price);
}

test("the live runner remains a single $300 BTC 5-minute demo account", () => {
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ["5m"]);
  assert.equal(multi.bots["5m"].capital, 300);
  assert.equal(multi.snapshot().account.capital, 300);
});

test("window start places four independent 100-share limit buys", () => {
  const bot = makeBot();
  const buys = bot.windowOrders.filter(order => order.action === "BUY");
  assert.equal(buys.length, 4);
  assert.deepEqual(
    buys.map(({ side, limitPrice, shares }) => [side, limitPrice, shares])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]),
    [
      ["DOWN", 0.05, 100], ["DOWN", 0.10, 100],
      ["UP", 0.05, 100], ["UP", 0.10, 100],
    ],
  );
  assert.ok(buys.every(order => order.status === "PENDING"));
  assert.ok(buys.every(order => order.expiresAt === FIRST_START + config.ENTRY_ORDER_TTL_MS));
  assert.equal(config.ENTRY_ORDER_TTL_MS, 180_000);
  assert.deepEqual(config.ENTRY_RUNGS.map(rung => [rung.price, rung.takeProfitPrice]), [
    [0.10, 0.20], [0.05, 0.10],
  ]);
  assert.equal(bot.windowEntryPlaced, true);
});

test("a limit buy books exactly its posted price after the ask reaches or betters it", () => {
  const bot = makeBot();
  quote(bot, "UP", FIRST_START + 500, { mid: 0.11, bid: 0.10, ask: 0.11 });
  bot.processPendingLimitOrders(FIRST_START + 500);
  assert.equal(bot.positions.length, 0, "an ask above the limit must not fill");

  quote(bot, "UP", FIRST_START + 1_000, { mid: 0.11, bid: 0.09, ask: 0.10 });
  quote(bot, "DOWN", FIRST_START + 1_000, { mid: 0.30, bid: 0.29, ask: 0.30 });
  bot.processPendingLimitOrders(FIRST_START + 1_000);

  assert.equal(bot.positions.length, 1);
  const position = bot.positions[0];
  assert.equal(position.side, "UP");
  assert.equal(position.shares, 100);
  assert.equal(position.avgEntry, 0.10);
  assert.equal(position.fillPrice, 0.10);
  assert.equal(position.cost, 10);
  assert.equal(position.takeProfitPrice, 0.20);
  assert.equal(bot.cash, 290);
  const entry = bot.orders.find(order => order.id === position.id);
  const takeProfit = bot.orders.find(order => order.id === position.takeProfitOrderId);
  assert.equal(entry.status, "FILLED");
  assert.equal(takeProfit.action, "SELL");
  assert.equal(takeProfit.limitPrice, 0.20);
  assert.equal(takeProfit.shares, 100);
  assert.equal(takeProfit.status, "PENDING");
});

test("fills do not cancel other side or rung entry orders", () => {
  const bot = makeBot();
  fillAt(bot, "UP", 0.10);
  const pendingBuys = bot.orders.filter(order => order.action === "BUY" && order.status === "PENDING");
  assert.equal(pendingBuys.length, 3);
  assert.ok(pendingBuys.every(order => order.side === "UP" || order.side === "DOWN"));
  assert.ok(!bot.orders.some(order => order.status === "CANCELLED_OCO"));
});

test("take-profit resting sell fills only when a fresh bid reaches target", () => {
  const bot = makeBot();
  const position = fillAt(bot, "UP", 0.10);
  const takeProfit = bot.orders.find(order => order.id === position.takeProfitOrderId);
  quote(bot, "UP", FIRST_START + 2_000, { mid: 0.19, bid: 0.19, ask: 0.20 });
  bot.processPendingTakeProfitOrders(FIRST_START + 2_000);
  assert.equal(position.status, "OPEN");

  quote(bot, "UP", FIRST_START + 3_000, { mid: 0.24, bid: 0.24, ask: 0.25 });
  bot.processPendingTakeProfitOrders(FIRST_START + 3_000);
  assert.equal(takeProfit.status, "FILLED");
  assert.equal(takeProfit.fillPrice, 0.20);
  assert.equal(position.status, "SETTLED_EXIT");
  assert.equal(position.settlementBasis, "TAKE_PROFIT_LIMIT");
  assert.equal(position.tpTriggerQuote, 0.24);
  assert.equal(position.exitBid, 0.20);
  assert.equal(position.proceeds, 20);
  assert.equal(position.realizedPnl, 10);
  assert.equal(bot.cash, 310);
  assert.equal(position.strategyOutcome, "WIN");
});

test("all still-pending buys cancel 180 seconds after placement; TP orders are not affected", () => {
  const bot = makeBot();
  const position = fillAt(bot, "UP", 0.10);
  const deadline = FIRST_START + config.ENTRY_ORDER_TTL_MS;
  bot.processPendingLimitOrders(deadline - 1);
  assert.ok(bot.orders.filter(order => order.action === "BUY" && order.status === "PENDING").length > 0);
  bot.processPendingLimitOrders(deadline);

  assert.ok(bot.orders.filter(order => order.action === "BUY").every(order =>
    order.status === "CANCELLED_TIMEOUT" || order.status === "FILLED"));
  assert.equal(bot.orders.find(order => order.id === position.takeProfitOrderId).status, "PENDING");
  assert.equal(position.status, "OPEN");
});

test("unfilled entries cancel at window end and unclosed filled shares await official resolution", async () => {
  const bot = makeBot();
  const position = fillAt(bot, "UP", 0.10);
  const nextStart = FIRST_START + WINDOW;
  await bot.closePreviousWindows(nextStart, nextStart);

  assert.equal(position.status, "PENDING_RESOLUTION");
  assert.equal(position.settledAt, undefined);
  assert.equal(position.realizedPnl, undefined);
  assert.equal(position.strategyOutcome, "LOSS");
  assert.equal(position.strategyOutcomeReason, "TAKE_PROFIT_NOT_HIT_BY_WINDOW_END");
  assert.equal(bot.snapshot().account.openPositions, 1);
  assert.equal(bot.orders.find(order => order.id === position.id).status, "FILLED");
  assert.equal(bot.orders.find(order => order.id === position.takeProfitOrderId).status, "EXPIRED_WINDOW_END");
  assert.ok(bot.orders.filter(order => order.action === "BUY" && order.status !== "FILLED")
    .every(order => order.status === "CANCELLED_WINDOW_END"));

  bot.market = { ...bot.market, start: nextStart };
  bot.openStrategyWindow(nextStart, nextStart);
  bot.placeWindowEntryOrders(nextStart, nextStart);
  assert.ok(bot.windowOrders.filter(order => order.action === "BUY").every(order => order.shares === 100));

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
  assert.equal(position.status, "SETTLED_EXIT");
  assert.equal(position.settlementBasis, "POLYMARKET_RESOLUTION");
  assert.equal(position.payout, 1);
  assert.equal(position.realizedPnl, 90);
  assert.equal(position.strategyOutcome, "LOSS", "resolution must not rewrite the expired-window result");
});

test("dashboard streaks use strategy outcomes, including unresolved positions", () => {
  const multi = new MultiBot();
  const outcomes = ["WIN", "WIN", "LOSS", "LOSS", "LOSS", "WIN", "WIN", "WIN"];
  multi.bots["5m"].positions = outcomes.map((strategyOutcome, index) => ({
    id: `trade-${index}`,
    status: index === 2 ? "PENDING_RESOLUTION" : "SETTLED_EXIT",
    strategyOutcome,
    strategyOutcomeAt: FIRST_START + index,
    realizedPnl: strategyOutcome === "WIN" ? -1 : 1,
    totalCost: 1,
    settledAt: index === 2 ? undefined : FIRST_START + index,
  }));
  const account = multi.snapshot().account;
  assert.equal(account.maxConsecutiveWins, 3);
  assert.equal(account.maxConsecutiveLosses, 3);
});
