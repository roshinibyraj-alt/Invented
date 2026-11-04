"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../config.js");
const Bot = require("../wick-bot.js");
const MultiBot = require("../multi-bot.js");

const WINDOW = config.WINDOW_MS_5M;
const FIRST_START = 1_800_000_000_000;

function makeBot({ feesEnabled = false } = {}) {
  const bot = new Bot({ timeframe: "5m", windowMs: WINDOW, capital: 300 });
  bot.log = () => {};
  bot.market = {
    id: "test-market",
    slug: "btc-updown-5m-test",
    title: "BTC 5-minute test",
    start: FIRST_START,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled,
    feeSchedule: { rate: 0.07, exponent: 1 },
  };
  bot.openStrategyWindow(FIRST_START, FIRST_START);
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

function trigger(bot, start, side = "UP", mid = 0.77) {
  const now = start + config.ENTRY_DELAY_MS;
  bot.market = { ...bot.market, start };
  quote(bot, side, now, { mid, bid: mid - 0.01, ask: mid + 0.01 });
  return bot.processThresholdEntry(start, now);
}

function fillAtLimit(bot, start, side = "UP", ask = 0.75) {
  const now = start + config.ENTRY_DELAY_MS + 1000;
  quote(bot, side, now, { mid: ask, bid: ask - 0.01, ask });
  bot.processPendingLimitOrders(now);
  return bot.positions.find(position => position.windowStart === start && position.status === "OPEN");
}

async function stopFilledPosition(bot, start, side = "UP") {
  if (bot.orderWindowStart !== start) bot.openStrategyWindow(start, start);
  assert.equal(trigger(bot, start, side), true);
  const position = fillAtLimit(bot, start, side);
  assert.ok(position, "the resting buy should fill at $0.75");
  await bot.completeWindow(start, position, false, "STOP_LOSS_BID", 0.40, start + 32_000);
  return position;
}

test("the live runner contains only one BTC 5-minute demo account", () => {
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ["5m"]);
  assert.equal(multi.bots["5m"].capital, 300);
  assert.equal(multi.snapshot().account.capital, 300);
});

test("the entry waits 30 seconds and triggers at an inclusive $0.77 midpoint", () => {
  const bot = makeBot();
  quote(bot, "UP", FIRST_START + 20_000, { mid: 0.80, bid: 0.79, ask: 0.81 });
  assert.equal(bot.processThresholdEntry(FIRST_START, FIRST_START + 29_999), false);
  assert.equal(bot.windowOrders.length, 0);

  quote(bot, "UP", FIRST_START + 30_000, { mid: 0.77, bid: 0.76, ask: 0.78 });
  assert.equal(bot.processThresholdEntry(FIRST_START, FIRST_START + 30_000), true);
  const order = bot.windowOrders[0];
  assert.equal(order.side, "UP");
  assert.equal(order.limitPrice, 0.75);
  assert.equal(order.stakeUsd, 3.75);
  assert.equal(order.shares, 5);
  assert.equal(order.status, "PENDING");
  assert.equal(order.orderType, "LIMIT");
});

test("a trigger latches for the window and the resting order fills only at or below $0.75", () => {
  const bot = makeBot();
  assert.equal(trigger(bot, FIRST_START, "DOWN", 0.80), true);
  assert.equal(bot.windowOrders[0].side, "DOWN");

  quote(bot, "DOWN", FIRST_START + 31_000, { mid: 0.76, bid: 0.75, ask: 0.76 });
  bot.processPendingLimitOrders(FIRST_START + 31_000);
  assert.equal(bot.windowOrders[0].status, "PENDING");
  assert.equal(bot.positions.length, 0);

  quote(bot, "DOWN", FIRST_START + 32_000, { mid: 0.75, bid: 0.74, ask: 0.75 });
  bot.processPendingLimitOrders(FIRST_START + 32_000);
  assert.equal(bot.windowOrders[0].status, "FILLED");
  assert.equal(bot.positions[0].avgEntry, 0.75);
  assert.equal(bot.positions[0].cost, 3.75);
  assert.equal(bot.cash, 296.25);

  quote(bot, "UP", FIRST_START + 33_000, { mid: 0.80, bid: 0.79, ask: 0.81 });
  assert.equal(bot.processThresholdEntry(FIRST_START, FIRST_START + 33_000), false);
  assert.equal(bot.windowOrders.length, 1);
});

test("unfilled orders expire at window end and carry the same stake forward", async () => {
  const bot = makeBot();
  assert.equal(trigger(bot, FIRST_START), true);
  quote(bot, "UP", FIRST_START + 31_000, { mid: 0.78, bid: 0.77, ask: 0.79 });
  bot.processPendingLimitOrders(FIRST_START + 31_000);
  assert.equal(bot.windowOrders[0].status, "PENDING");

  const nextStart = FIRST_START + WINDOW;
  await bot.closePreviousWindows(nextStart, nextStart);
  assert.equal(bot.windowOrders[0].status, "EXPIRED_WINDOW_ROLLOVER");
  assert.equal(bot.stakeProgression.stakeUsd, 3.75);
  bot.openStrategyWindow(nextStart, nextStart);
  assert.equal(trigger(bot, nextStart, "DOWN"), true);
  assert.equal(bot.windowOrders[0].stakeUsd, 3.75);
});

test("take-profit credits $1 per share and resets the base to 1.25% of bankroll", async () => {
  const bot = makeBot({ feesEnabled: true });
  assert.equal(trigger(bot, FIRST_START), true);
  const position = fillAtLimit(bot, FIRST_START);
  assert.ok(position);
  await bot.completeWindow(FIRST_START, position, true, "TAKE_PROFIT_BID", 0.99, FIRST_START + 32_000);

  assert.equal(position.proceeds, 5);
  assert.equal(position.exitFees, 0);
  assert.equal(position.realizedPnl, 1.25);
  assert.equal(bot.cash, 301.25);
  assert.equal(bot.stakeProgression.martingaleLevel, 0);
  assert.equal(bot.stakeProgression.baseStakeUsd, 3.77);
  assert.equal(bot.stakeProgression.stakeUsd, 3.77);
});

test("market stop-loss applies taker fees and advances stakes by exactly 5x", async () => {
  const bot = makeBot({ feesEnabled: true });
  const position = await stopFilledPosition(bot, FIRST_START);
  const expectedFee = 0.07 * 0.40 * 0.60 * 5;
  assert.equal(position.exitType, "MARKET");
  assert.ok(Math.abs(position.exitFees - expectedFee) < 1e-10);
  assert.ok(position.realizedPnl < 0);
  assert.equal(bot.stakeProgression.martingaleLevel, 1);
  assert.equal(bot.stakeProgression.stakeUsd, 18.75);
});

test("two multipliers are followed by at most two extra stop-outs, then the bot halts", async () => {
  const bot = makeBot();
  let start = FIRST_START;

  await stopFilledPosition(bot, start);
  assert.equal(bot.stakeProgression.stakeUsd, 18.75);
  start += WINDOW;

  await stopFilledPosition(bot, start, "DOWN");
  assert.equal(bot.stakeProgression.stakeUsd, 93.75);
  assert.equal(bot.stakeProgression.martingaleLevel, 2);
  start += WINDOW;

  await stopFilledPosition(bot, start);
  assert.equal(bot.stakeProgression.extraStakePhase, true);
  assert.equal(bot.stakeProgression.remainingExtraStopOuts, 2);
  assert.equal(bot.stakeProgression.stakeUsd, 93.75);
  start += WINDOW;

  await stopFilledPosition(bot, start, "DOWN");
  assert.equal(bot.stakeProgression.remainingExtraStopOuts, 1);
  assert.equal(bot.stakeProgression.stopped, false);
  start += WINDOW;

  await stopFilledPosition(bot, start);
  assert.equal(bot.stakeProgression.remainingExtraStopOuts, 0);
  assert.equal(bot.stakeProgression.stopped, true);
  assert.equal(bot.status, "strategy_stopped");
  bot.openStrategyWindow(start + WINDOW, start + WINDOW);
  assert.equal(trigger(bot, start + WINDOW), false);
});
