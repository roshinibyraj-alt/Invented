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

function fillOneSide(bot, side = "UP", ask = 0.25, now = FIRST_START + 1_000) {
  quote(bot, side, now, { mid: ask, bid: ask - 0.01, ask });
  bot.processPendingLimitOrders(now);
  return bot.positions.find(position => position.windowStart === FIRST_START);
}

test("the live runner remains a single $300 BTC 5-minute demo account", () => {
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ["5m"]);
  assert.equal(multi.bots["5m"].capital, 300);
  assert.equal(multi.snapshot().account.capital, 300);
});

test("window start immediately places both 30-share $0.25 limit buys", () => {
  const bot = makeBot();
  assert.equal(bot.windowOrders.length, 2);
  assert.deepEqual(bot.windowOrders.map(order => order.side).sort(), ["DOWN", "UP"]);
  for (const order of bot.windowOrders) {
    assert.equal(order.limitPrice, 0.25);
    assert.equal(order.shares, 30);
    assert.equal(order.stakeUsd, 7.5);
    assert.equal(order.status, "PENDING");
    assert.equal(order.entryMode, "DUAL_SIDE_OCO");
  }
  assert.equal(bot.windowEntryPlaced, true);
});

test("the first eligible side fills and immediately cancels the opposite order", () => {
  const bot = makeBot();
  quote(bot, "UP", FIRST_START + 1_000, { mid: 0.25, bid: 0.24, ask: 0.25 });
  quote(bot, "DOWN", FIRST_START + 1_000, { mid: 0.24, bid: 0.23, ask: 0.24 });
  bot.processPendingLimitOrders(FIRST_START + 1_000);

  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN", "choose the lower eligible ask when both qualify");
  assert.equal(bot.positions[0].shares, 30);
  assert.equal(bot.positions[0].avgEntry, 0.24);
  assert.equal(bot.windowOrders.find(order => order.side === "DOWN").status, "FILLED");
  assert.equal(bot.windowOrders.find(order => order.side === "UP").status, "CANCELLED_OCO");
  assert.equal(bot.cash, 292.8);
});

test("an ask above $0.25 does not fill and both orders expire without progression", async () => {
  const bot = makeBot();
  quote(bot, "UP", FIRST_START + 1_000, { mid: 0.28, bid: 0.27, ask: 0.28 });
  quote(bot, "DOWN", FIRST_START + 1_000, { mid: 0.29, bid: 0.28, ask: 0.29 });
  bot.processPendingLimitOrders(FIRST_START + 1_000);
  assert.equal(bot.positions.length, 0);

  await bot.closePreviousWindows(FIRST_START + WINDOW, FIRST_START + WINDOW);
  assert.ok(bot.windowOrders.every(order => order.status === "EXPIRED_WINDOW_ROLLOVER"));
  assert.equal(bot.stakeProgression.martingaleLevel, 0);
  assert.equal(bot.stakeProgression.shares, 30);
});

test("there is no stop-loss; the $0.99 take-profit pays $1 per share", async () => {
  const bot = makeBot();
  const position = fillOneSide(bot, "UP", 0.25);
  assert.ok(position);
  const originalGetBook = marketData.getBook;
  try {
    marketData.getBook = async tokenId => ({
      bids: [{ price: tokenId === "up-token" ? 0.10 : 0.20, size: 1000 }],
      asks: [{ price: 0.30, size: 1000 }],
    });
    await bot.refreshLiveQuotes(FIRST_START + 2_000);
    assert.equal(position.status, "OPEN", "a falling bid alone must not trigger an exit");

    marketData.getBook = async tokenId => ({
      bids: [{ price: tokenId === "up-token" ? 0.99 : 0.01, size: 1000 }],
      asks: [{ price: 1, size: 1000 }],
    });
    await bot.refreshLiveQuotes(FIRST_START + 3_000);
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(position.status, "SETTLED_EXIT");
  assert.equal(position.settlementBasis, "TAKE_PROFIT_BID");
  assert.equal(position.proceeds, 30);
  assert.equal(position.realizedPnl, 22.5);
  assert.equal(bot.cash, 322.5);
  assert.equal(bot.stakeProgression.martingaleLevel, 0);
  assert.equal(bot.stakeProgression.shares, 30);
});

test("positions without a take-profit wait for official Polymarket resolution", async () => {
  const bot = makeBot();
  const position = fillOneSide(bot, "UP", 0.25);
  const nextStart = FIRST_START + WINDOW;
  await bot.closePreviousWindows(nextStart, nextStart);

  assert.equal(position.status, "PENDING_RESOLUTION");
  assert.equal(position.settledAt, undefined);
  assert.equal(position.realizedPnl, undefined);
  assert.equal(bot.cash, 292.5);
  assert.equal(bot.snapshot().account.openPositions, 1);

  const originalGetMarket = marketData.getMarket;
  try {
    marketData.getMarket = async () => ({
      closed: true,
      outcomes: ["Up", "Down"],
      outcomePrices: ["0", "1"],
    });
    await bot.resolvePendingPositions(nextStart + config.RESOLUTION_POLL_MS);
  } finally {
    marketData.getMarket = originalGetMarket;
  }

  assert.equal(position.status, "SETTLED_EXIT");
  assert.equal(position.settlementBasis, "POLYMARKET_RESOLUTION");
  assert.equal(position.payout, 0);
  assert.equal(position.realizedPnl, -7.5);
  assert.equal(bot.stakeProgression.martingaleLevel, 1);
  assert.equal(bot.stakeProgression.shares, 42);
});

test("resolved wins reset to 30 shares and seven losses then reset after level seven", () => {
  const bot = makeBot();
  for (let level = 0; level <= config.MAX_MULTIPLIER_LEVELS; level++) {
    bot.updateStakeProgressionAfterClose({
      id: `loss-${level}`,
      progressionApplied: false,
      progressionLevel: level,
      realizedPnl: -1,
    });
    if (level < config.MAX_MULTIPLIER_LEVELS) {
      assert.equal(bot.stakeProgression.martingaleLevel, level + 1);
      assert.equal(
        bot.stakeProgression.shares,
        Number((config.BASE_SHARES * Math.pow(config.LOSS_MULTIPLIER, level + 1)).toFixed(6)),
      );
    } else {
      assert.equal(bot.stakeProgression.martingaleLevel, 0);
      assert.equal(bot.stakeProgression.shares, 30);
    }
  }

  bot.stakeProgression = { baseShares: 30, shares: 82.32, martingaleLevel: 3, lastOutcome: "LOSS" };
  bot.updateStakeProgressionAfterClose({
    id: "win",
    progressionApplied: false,
    progressionLevel: 3,
    realizedPnl: 1,
  });
  assert.equal(bot.stakeProgression.martingaleLevel, 0);
  assert.equal(bot.stakeProgression.shares, 30);
});

test("market outcomes are used only after Polymarket marks the market closed", () => {
  assert.equal(marketData.resolvedWinner({
    closed: true,
    outcomes: '["Up","Down"]',
    outcomePrices: '["1","0"]',
  }), "UP");
  assert.equal(marketData.resolvedWinner({
    closed: false,
    outcomes: ["Up", "Down"],
    outcomePrices: ["1", "0"],
  }), null);
  assert.equal(marketData.resolvedWinner({
    closed: true,
    outcomes: ["Up", "Down"],
    outcomePrices: ["0.5", "0.5"],
  }), null);
});

test("dashboard account reports highest consecutive wins and losses", () => {
  const multi = new MultiBot();
  multi.bots["5m"].positions = [1, 1, -1, -1, -1, 0, 1, 1, 1].map((pnl, index) => ({
    id: `settled-${index}`,
    status: "SETTLED_EXIT",
    realizedPnl: pnl,
    totalCost: 1,
    settledAt: FIRST_START + index,
  }));

  const account = multi.snapshot().account;
  assert.equal(account.maxConsecutiveWins, 3);
  assert.equal(account.maxConsecutiveLosses, 3);
});
