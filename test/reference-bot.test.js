const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const config = require("../config.js");
const Bot = require("../wick-bot.js");
const MultiBot = require("../multi-bot.js");
const marketData = require("../wick-market-data.js");
const candleStrategy = require("../candle-strategy.js");
const { ChainlinkPriceFeed } = require("../chainlink-price-feed.js");

function makeBot() {
  const start = 1_800_000;
  const minuteCandles = Array.from({ length: 5 }, (_, index) => ({
    t: start - 300_000 + index * 60_000,
    o: 100,
    h: 102,
    l: 99,
    c: 101,
  }));
  const bot = new Bot({
    priceFeed: {
      getTicks: () => [],
      getMinuteCandles: () => minuteCandles,
      snapshot: () => ({ status: "test" }),
      start() {},
      stop() {},
    },
  });
  bot.minuteCandles = minuteCandles;
  bot.market = {
    id: "market",
    slug: "market",
    title: "market",
    start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  bot.marketRegime = { state: "TRENDING", direction: "UP", reason: "test rising BTC" };
  bot.openStrategyWindow(start, start);
  return { bot, start };
}

test("previous-candle signals match the copied source strategy", () => {
  const start = config.WINDOW_MS_5M;
  const minutes = color => Array.from({ length: 5 }, (_, index) => ({
    t: start - 300_000 + index * 60_000,
    o: 100, h: 102, l: 99, c: color === "GREEN" ? 101 : 99,
  }));
  assert.equal(candleStrategy.signalForPrevious(candleStrategy.aggregateCompleteCandles(minutes("GREEN"), 300_000)).side, "UP");
  assert.equal(candleStrategy.signalForPrevious(candleStrategy.aggregateCompleteCandles(minutes("RED"), 300_000)).side, "DOWN");
});

test("named BTC candle formations choose the bullish or bearish signal side", () => {
  const c = (open, high, low, close) => ({
    open, high, low, close,
    color: close > open ? "GREEN" : close < open ? "RED" : "DOJI",
  });
  const cases = [
    [[c(10,10.2,5.8,6),c(5.5,10.6,5.4,10.5)],"BULLISH_ENGULFING","UP"],
    [[c(10,10.2,5.8,6),c(5.8,6,5.7,5.9),c(6,9.6,5.9,9.5)],"MORNING_STAR","UP"],
    [[c(10,10.2,5.8,6),c(7,8.2,5,8)],"BULLISH_HARAMI","UP"],
    [[c(10,10.2,5.8,6),c(5.9,10.6,5.8,10.5)],"BULLISH_ENGULFING","UP"],
    [[c(6,10.2,5.8,10),c(10.1,10.4,10,10.2),c(10.2,10.3,6,6.5)],"EVENING_STAR","DOWN"],
    [[c(6,10.2,5.8,10),c(10.5,10.6,5.4,5.5)],"BEARISH_ENGULFING","DOWN"],
    [[c(6,10.2,5.8,10),c(9,10.4,7.4,8)],"BEARISH_HARAMI","DOWN"],
    [[c(10,10.2,8,8.2),c(8.2,8.4,6.5,6.8),c(6.8,7,5.5,5.7),c(7.9,8.2,5,8.1)],"HAMMER","UP"],
  ];
  for (const [candles, pattern, side] of cases) {
    const matches = candleStrategy.detectPatternCandidates(candles);
    assert.ok(matches.some(match => match.pattern === pattern && match.side === side));
  }
});

test("signal direction follows the latest candle, with doji reversal only after a two-candle run", () => {
  const c = (color) => ({ color, open: 1, close: color === "GREEN" ? 2 : color === "RED" ? 0 : 1,
    high: 2, low: 0 });
  assert.equal(candleStrategy.signalForPrevious([c("RED"), c("GREEN")]).side, "UP");
  assert.equal(candleStrategy.signalForPrevious([c("GREEN"), c("RED")]).side, "DOWN");
  assert.equal(candleStrategy.signalForPrevious([c("RED"), c("RED"), c("DOJI")]).side, "UP");
  assert.equal(candleStrategy.signalForPrevious([c("GREEN"), c("GREEN"), c("DOJI")]).side, "DOWN");
  assert.equal(candleStrategy.signalForPrevious([c("RED"), c("DOJI")]).side, null);
});

test("Chainlink feed retains minute OHLC bars for candle signals", () => {
  let now = 1_800_000_000_000;
  const feed = new ChainlinkPriceFeed({ now: () => now, WebSocketImpl: null });
  feed.started = true;
  feed.addPrice({ timestamp: now - 1_000, value: 100 });
  feed.addPrice({ timestamp: now - 500, value: 103 });
  feed.addPrice({ timestamp: now - 100, value: 99 });
  feed.lastUpdateAt = now;

  assert.deepEqual(feed.getMinuteCandles(), [{
    t: now - 60_000, o: 100, h: 103, l: 99, c: 99, v: 0,
  }]);
  now += 16_000;
  assert.throws(() => feed.getMinuteCandles(), /stale|fresh/i);
  feed.stop();
});

test("Binance history seeds completed 5-minute candles and excludes the active candle", async () => {
  const now = 1_800_000_000_000;
  const bucket = Math.floor(now / 300_000) * 300_000;
  const rows = [
    [bucket - 600_000, "100", "103", "99", "102", "1", bucket - 300_001],
    [bucket - 300_000, "102", "103", "98", "99", "1", bucket - 1],
    [bucket, "99", "104", "97", "103", "1", bucket + 299_999],
  ];
  const feed = new ChainlinkPriceFeed({
    WebSocketImpl: null,
    now: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => rows }),
  });
  await feed.loadHistoricalCandles();
  const candles = feed.getHistoricalCandles();
  assert.equal(feed.historyStatus, "ready");
  assert.equal(candles.length, 2);
  assert.equal(candles[1].color, "RED");
  assert.equal(candles[1].source, "BINANCE_HISTORY");
  assert.equal(candleStrategy.signalForPrevious(candles).side, "DOWN");
  feed.stop();
});

test("Binance-seeded previous candle places the two-rung ladder on its color side", () => {
  const { bot, start } = makeBot();
  bot.minuteCandles = [];
  bot.priceFeed.getHistoricalCandles = () => [{
    start: start - 300_000, end: start, open: 100, high: 102, low: 99, close: 101,
    color: "GREEN", source: "BINANCE_HISTORY",
  }];
  bot.processCandleEntries(start, start + 1_000);
  assert.equal(bot.candleEvaluation.pattern, "PREVIOUS_GREEN");
  assert.equal(bot.windowSignalSide, "UP");
  assert.equal(bot.windowOrders.length, 2);
});

test("a green signal submits $0.30 and $0.20 500-share limits on UP", () => {
  const { bot, start } = makeBot();
  const now = start + 1_000;
  bot.processCandleEntries(start, now);

  assert.equal(bot.windowSignalSide, "UP");
  assert.equal(bot.windowStrategySide, "UP");
  assert.deepEqual(bot.windowOrders.map(order=>[order.side,order.signalSide,order.limitPrice,order.shares,order.status]),[
      ...[0.30,0.20].map(price=>["UP","UP",price,500,"PENDING"]),
  ]);
  assert.equal(bot.windowOrders.reduce((sum,order)=>sum+order.limitPrice*order.shares,0),250);
  assert.equal(bot.snapshot().strategy.entries.orderType,"LIMIT");
  assert.equal(bot.snapshot().strategy.entries.totalShares,1000);
});

test("a red signal submits the two limits on DOWN", () => {
  const { bot, start } = makeBot();
  bot.minuteCandles = Array.from({ length: 5 }, (_, index) => ({
    t: start - 300_000 + index * 60_000,
    o: 100, h: 101, l: 98, c: 99,
  }));
  const now = start + 1_000;
  bot.processCandleEntries(start, now);

  assert.equal(bot.windowSignalSide, "DOWN");
  assert.equal(bot.windowStrategySide,"DOWN");
  assert.ok(bot.windowOrders.every(order=>order.side==="DOWN"&&order.shares===500&&order.status==="PENDING"));
});

test("signal-side limits fill only on a newer fresh ask at or below the limit and estimate rebate", () => {
  const { bot, start } = makeBot();
  bot.market.feesEnabled=true;
  bot.market.feeSchedule={rate:0.07,exponent:1};
  bot.processCandleEntries(start, start + 1_000);

  assert.ok(bot.windowOrders.every(order=>order.status==="PENDING"));
  bot.liveQuotes.UP={status:"LIVE",updatedAt:start+2_000,bestBid:0.1,bestAsk:0.14};
  bot.processPendingLimitOrders(start+2_000);
  assert.equal(bot.windowOrders.filter(order=>order.status==="FILLED").length,2);
  assert.equal(bot.positions.reduce((sum,position)=>sum+position.shares,0),1000);
  assert.equal(bot.positions.reduce((sum,position)=>sum+position.cost,0),250);
  assert.ok(Math.abs(bot.snapshot().account.estimatedMakerRebate-2.59)<1e-8);
});

test("signal-side limits honor the 5-minute entry cutoff", () => {
  const { bot, start } = makeBot();
  bot.processCandleEntries(start, start + 1_000);
  const lateQuoteTime = start + 120_000;
  bot.liveQuotes.UP = {
    status: "LIVE", updatedAt: lateQuoteTime, bestBid: 0.24, bestAsk: 0.25,
  };
  bot.processPendingLimitOrders(lateQuoteTime);

  const byPrice = new Map(bot.windowOrders.map(order => [order.limitPrice, order]));
  assert.equal(byPrice.get(0.30).status, "FILLED");
  assert.equal(byPrice.get(0.20).status, "PENDING");
  assert.ok(bot.windowOrders.every(order => order.expiresAt === start + bot.windowMs));
  bot.processPendingLimitOrders(start + config.ENTRY_CUTOFF_SECONDS_5M * 1_000);
  assert.equal(byPrice.get(0.20).status, "EXPIRED_CUTOFF");
});

test.skip("legacy CLOB catch-up market entry is not part of the reference strategy", () => {
  const { bot, start } = makeBot();
  bot.market.feesEnabled = true;
  bot.market.feeSchedule = { rate: 0.07, exponent: 1 };
  bot.processCandleEntries(start, start + 1_000);
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.34, bestAsk: 0.35 };
  bot.processPendingLimitOrders(start + 60_000);
  assert.equal(bot.windowOrders.filter(order => order.status === "FILLED").length, 2);

  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 119_999, bestBid: 0.64, bestAsk: 0.65 };
  bot.processPendingLimitOrders(start + 119_999);
  assert.equal(bot.catchUpDecision.executed, false);

  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 120_000, bestBid: 0.59, bestAsk: 0.60 };
  bot.processPendingLimitOrders(start + 120_000);
  assert.equal(bot.catchUpDecision.eligible, true);
  assert.equal(bot.catchUpDecision.executed, false);

  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 125_000, bestBid: 0.69, bestAsk: 0.70 };
  bot.processPendingLimitOrders(start + 125_000);
  assert.equal(bot.catchUpDecision.executed, false);

  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 130_000, bestBid: 0.64, bestAsk: 0.65 };
  bot.processPendingLimitOrders(start + 130_000);
  const marketOrders = bot.windowOrders.filter(order => order.orderType === "MARKET");
  assert.equal(marketOrders.length, 1);
  assert.equal(marketOrders[0].status, "FILLED");
  assert.equal(marketOrders[0].shares, 1_000);
  assert.equal(marketOrders[0].fillPrice, 0.65);
  assert.ok(Math.abs(marketOrders[0].fee - 15.925) < 1e-8);
  assert.equal(marketOrders[0].estimatedMakerRebate, 0);
  assert.equal(bot.windowOrders.filter(order => order.status === "CANCELLED_CONSOLIDATED_MARKET_BUY").length, 4);
  assert.equal(bot.positions.reduce((sum, position) => sum + position.shares, 0), 1_500);
  assert.ok(Math.abs(bot.cash - 9_146.575) < 1e-8);
  assert.ok(Math.abs(bot.snapshot().account.takerFees - 15.925) < 1e-8);
  assert.equal(bot.catchUpDecision.executed, true);
  assert.match(bot.snapshot().strategy.entries.catchUp.reason, /bought together/);
});

test.skip("legacy CLOB CHoCH entry is not part of the reference strategy", () => {
  const { bot, start } = makeBot();
  bot.minuteCandles = Array.from({ length: 5 }, (_, index) => ({
    t: start - 300_000 + index * 60_000, o: 100, h: 101, l: 98, c: 99,
  }));
  bot.processCandleEntries(start, start + 1_000);
  assert.equal(bot.windowSignalSide, "DOWN");

  bot.liveQuotes.DOWN = { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.34, bestAsk: 0.35 };
  bot.processPendingLimitOrders(start + 60_000);
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 120_000, bestBid: 0.64, bestAsk: 0.65 };
  bot.liveQuotes.DOWN = { status: "LIVE", updatedAt: start + 120_000, bestBid: 0.54, bestAsk: 0.55 };
  bot.processPendingLimitOrders(start + 120_000);
  assert.equal(bot.catchUpDecision.eligible, true);
  assert.equal(bot.catchUpDecision.executed, false);

  bot.liveQuotes.DOWN = { status: "LIVE", updatedAt: start + 125_000, bestBid: 0.64, bestAsk: 0.65 };
  bot.processPendingLimitOrders(start + 125_000);
  const marketOrder = bot.windowOrders.find(order => order.orderType === "MARKET");
  assert.equal(marketOrder.side, "DOWN");
});

test.skip("legacy CLOB catch-up entry is not part of the reference strategy", () => {
  const { bot, start } = makeBot();
  bot.processCandleEntries(start, start + 1_000);
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 120_000, bestBid: 0.64, bestAsk: 0.65 };
  bot.processPendingLimitOrders(start + 120_000);
  const marketOrder = bot.windowOrders.find(order => order.orderType === "MARKET");
  assert.equal(bot.catchUpDecision.executed, true);
  assert.equal(marketOrder.shares, 1_500);
  assert.equal(bot.windowOrders.filter(order => order.status === "CANCELLED_CONSOLIDATED_MARKET_BUY").length, 6);
});

test.skip("legacy CLOB catch-up entry is not part of the reference strategy", () => {
  const { bot, start } = makeBot();
  bot.processCandleEntries(start, start + 1_000);
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.38, bestAsk: 0.39 };
  bot.processPendingLimitOrders(start + 60_000);
  assert.equal(bot.windowOrders.filter(order => order.status === "FILLED").length, 1);
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 120_000, bestBid: 0.64, bestAsk: 0.65 };
  bot.processPendingLimitOrders(start + 120_000);
  const marketOrder = bot.windowOrders.find(order => order.orderType === "MARKET");
  assert.equal(bot.catchUpDecision.executed, true);
  assert.equal(marketOrder.shares, 1_250);
  assert.equal(bot.windowOrders.filter(order => order.status === "CANCELLED_CONSOLIDATED_MARKET_BUY").length, 5);
});

test.skip("legacy CLOB catch-up entry is not part of the reference strategy", () => {
  const { bot, start } = makeBot();
  bot.processCandleEntries(start, start + 1_000);
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.24, bestAsk: 0.25 };
  bot.processPendingLimitOrders(start + 60_000);
  assert.equal(bot.windowOrders.filter(order => order.status === "FILLED").length, 4);
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: start + 120_000, bestBid: 0.64, bestAsk: 0.65 };
  bot.processPendingLimitOrders(start + 120_000);
  assert.equal(bot.catchUpDecision.status, "not_eligible");
  assert.equal(bot.windowOrders.filter(order => order.orderType === "MARKET").length, 0);
});

test("a later Chainlink feed error does not overwrite the chosen signal reason", () => {
  const { bot, start } = makeBot();
  bot.processCandleEntries(start, start + 1_000);
  const reason = bot.candleEvaluation.reason;
  bot.priceFeed.getMinuteCandles = () => { throw new Error("Chainlink stream disconnected"); };
  bot.updateCandleContext();
  assert.equal(bot.windowSignalSide, "UP");
  assert.equal(bot.candleEvaluation.reason, reason);
  assert.equal(bot.candleFeedError, "Chainlink stream disconnected");
});

test("every window submits a fresh ladder on its own candle side", () => {
  const { bot, start } = makeBot();
  const nextStart = start + config.WINDOW_MS_5M;
  bot.market.start = nextStart;
  bot.minuteCandles = Array.from({ length: 5 }, (_, index) => ({
    t: nextStart - 300_000 + index * 60_000,
    o: 100, h: 101, l: 98, c: 99,
  }));
  bot.openStrategyWindow(nextStart, nextStart);
  const now = nextStart + 1_000;
  bot.processCandleEntries(nextStart, now);

  assert.equal(bot.windowSignalSide, "DOWN");
  assert.equal(bot.windowStrategySide,"DOWN");
  assert.equal(bot.windowOrders.length,2);
  assert.ok(bot.windowOrders.every(order=>order.side==="DOWN"&&order.windowStart===nextStart));
});

test("missing history waits; directional candle colors and doji rules choose sides", () => {
  const { bot, start } = makeBot();
  bot.minuteCandles = bot.minuteCandles.slice(1);
  bot.processCandleEntries(start, start + 1_000);
  assert.equal(bot.windowSignalSide,null);
  assert.equal(bot.candleEvaluation.pattern,"WAITING_FOR_COMPLETE_CANDLE");
  assert.equal(bot.windowOrders.length,0);
  assert.equal(bot.candleOrdersPlaced,false);

  bot.openStrategyWindow(start+bot.windowMs,start+bot.windowMs);
  bot.minuteCandles = Array.from({ length: 5 }, (_, index) => ({
    t: start+bot.windowMs-300_000 + index * 60_000,
    o: 100, h: 102, l: 98, c: 100,
  }));
  bot.market.start=start+bot.windowMs;
  bot.processCandleEntries(start+bot.windowMs,start+bot.windowMs+2_000);
  assert.equal(bot.windowOrders.length,0);
  assert.equal(bot.windowSignalSide,null);
  assert.equal(bot.candleEvaluation.pattern,"DOJI_NO_DIRECTION");
});

test("a $0.30/$0.20 take-profit arms an opposite-signal recovery and martingale resets", () => {
  const { bot, start } = makeBot();
  const nextStart = start + bot.windowMs;
  bot.updateRecoveryAfterClose({
    id: "trigger", windowStart: start, entryType: "SIGNAL_PATTERN_LIMIT",
    avgEntry: 0.30, exitReason: "TAKE_PROFIT_BID",
  });
  assert.equal(bot.recovery.pendingWindowStart, nextStart);

  const enterRecovery = (windowStart, signalSide, level, shares) => {
    bot.market = { ...bot.market, start: windowStart };
    bot.openStrategyWindow(windowStart, windowStart);
    bot.windowSignalSide = signalSide;
    const now = windowStart + 1_000;
    const opposite = signalSide === "UP" ? "DOWN" : "UP";
    bot.liveQuotes[opposite] = {
      status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.41,
    };
    assert.equal(bot.processRecoveryEntry(windowStart, now), true);
    const position = bot.positions[0];
    assert.equal(position.side, opposite);
    assert.equal(position.shares, shares);
    assert.equal(position.martingaleLevel, level);
    return position;
  };
  const first = enterRecovery(nextStart, "DOWN", 0, 500);
  first.realizedPnl = -5;
  bot.updateRecoveryAfterClose(first);
  assert.equal(bot.recovery.shares, 1_000);
  assert.equal(bot.recovery.pendingWindowStart, nextStart + bot.windowMs);

  const secondStart = nextStart + bot.windowMs;
  const second = enterRecovery(secondStart, "UP", 1, 1_000);
  second.realizedPnl = -10;
  bot.updateRecoveryAfterClose(second);
  assert.equal(bot.recovery.shares, 2_000);
  assert.equal(bot.recovery.pendingWindowStart, secondStart + bot.windowMs);

  const thirdStart = secondStart + bot.windowMs;
  const third = enterRecovery(thirdStart, "DOWN", 2, 2_000);
  third.realizedPnl = -20;
  bot.updateRecoveryAfterClose(third);
  assert.equal(bot.recovery.shares, 500);
  assert.equal(bot.recovery.martingaleLevel, 0);
  assert.equal(bot.recovery.pendingWindowStart, null);
});

test("a profitable recovery resets its stake to 500 shares", () => {
  const { bot, start } = makeBot();
  bot.recovery.shares = 1_000;
  bot.recovery.martingaleLevel = 1;
  bot.recovery.activePositionId = "winning-recovery";
  bot.updateRecoveryAfterClose({
    id: "winning-recovery", entryMode: "RECOVERY_MARTINGALE",
    martingaleLevel: 1, realizedPnl: 1,
  });
  assert.equal(bot.recovery.shares, 500);
  assert.equal(bot.recovery.martingaleLevel, 0);
  assert.equal(bot.recovery.pendingWindowStart, null);
});

test.skip("legacy: contrarian bot buys only the opposite side of the signed BTC move", () => {
  assert.equal(config.ENTRY_CHECK_INTERVAL_MS, 5_000);
  assert.equal(config.BASE_ENTRY_SHARES, 50);
  assert.equal(config.LIMIT_PRICE_OFFSET, 0.05);
  assert.equal(config.MIN_ENTRY_PRICE, 0.05);
  assert.equal("MERGE_LOT_SHARES" in config, false);

  const dashboard = fs.readFileSync(path.join(__dirname, "../public/wick.html"), "utf8");
  assert.match(dashboard, /BTC No-Merge Paper Bot/);
  assert.match(dashboard, /Contrarian paper strategy/);
  assert.match(dashboard, /All other positions in that window close at their own current bid/);
  assert.match(dashboard, /official market results are not used/i);
  assert.match(dashboard, /Current-window UP shares/);
  assert.match(dashboard, /cancels its pending entries/);
  assert.match(dashboard, /cancel after 4 seconds/i);
  assert.match(dashboard, /hard \$0\.05 minimum/i);
  assert.match(dashboard, /No shares carry into the next window/);
  assert.match(dashboard, /Download diagnostics JSON/);
  for (const id of ["upShares", "downShares", "upAverageCost", "downAverageCost", "upTotalCost", "downTotalCost", "upBid", "downBid", "upAsk", "downAsk"]) {
    assert.ok(dashboard.includes(`id="${id}"`), `dashboard should render ${id}`);
  }

  const { bot, start } = makeBot();
  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };

  bot.processTimedEntries(start, now);
  assert.equal(bot.windowOrders.length, 1);
  assert.deepEqual(bot.windowOrders.map(order => [order.side, order.limitPrice, order.shares]), [
    ["DOWN", 0.4, 50],
  ]);
  assert.ok(bot.windowOrders.every(order => order.status === "PENDING"));
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.snapshot().strategy.merge.enabled, false);
  assert.equal("mergeStatus" in bot.snapshot(), false);
  assert.equal("merges" in bot.snapshot(), false);
});

test.skip("legacy: contrarian side stays locked for the window when BTC direction later changes", () => {
  const { bot, start } = makeBot();
  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };

  bot.processTimedEntries(start, now);

  assert.equal(bot.windowOrders.length, 1);
  assert.equal(bot.windowOrders[0].side, "DOWN");
  assert.equal(bot.windowOrders[0].shares, 50);
  assert.equal(bot.windowOrders[0].entryMode, "CONTRARIAN");
  assert.equal(bot.windowOrders[0].limitPrice, 0.4);
  bot.marketRegime = { state: "TRENDING", direction: "DOWN", reason: "test falling BTC" };
  bot.processTimedEntries(start, start + 2 * config.ENTRY_CHECK_INTERVAL_MS);
  assert.equal(bot.windowOrders.length, 2);
  assert.ok(bot.windowOrders.every(order => order.side === "DOWN"));
});

test.skip("legacy: contrarian orders remain active until window rollover", () => {
  const { bot, start } = makeBot();
  const placedAt = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, placedAt);
  const downOrder = bot.windowOrders.find(order => order.side === "DOWN");

  bot.liveQuotes.DOWN.updatedAt = placedAt + 500;
  bot.liveQuotes.DOWN.bestAsk = 0.39;
  bot.processPendingLimitOrders(placedAt + 500);
  assert.equal(downOrder.status, "FILLED");
  assert.equal(bot.positions[0].shares, 50);

  const nextCheck = start + 2 * config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes.DOWN.updatedAt = nextCheck;
  bot.liveQuotes.DOWN.bestAsk = 0.50;
  bot.processTimedEntries(start, nextCheck);
  const nextOrder = bot.windowOrders.find(order => order.checkpoint === 2);
  assert.ok(nextOrder);
  bot.processPendingLimitOrders(start + bot.windowMs);
  assert.equal(nextOrder.status, "EXPIRED_UNFILLED");
  assert.equal(bot.positions.length, 1);

});

test.skip("legacy: contrarian side skips sub-$0.05 limits and never fills below the floor", () => {
  const { bot, start } = makeBot();
  const placedAt = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.03, bestAsk: 0.06, mid: 0.09 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.03, bestAsk: 0.06, mid: 0.09 },
  };
  bot.processTimedEntries(start, placedAt);
  assert.deepEqual(bot.windowOrders.map(order => order.status), [
    "SKIPPED_BELOW_MIN_PRICE",
  ]);
  assert.deepEqual(bot.windowOrders.map(order => order.calculatedLimitPrice), [0.04]);

  const next = start + 2 * config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: next, bestBid: 0.09, bestAsk: 0.11, mid: 0.15 },
    DOWN: { status: "LIVE", updatedAt: next, bestBid: 0.09, bestAsk: 0.11, mid: 0.15 },
  };
  bot.processTimedEntries(start, next);
  const pending = bot.windowOrders.filter(order => order.status === "PENDING");
  assert.equal(pending.length, 1);
  bot.liveQuotes.DOWN.updatedAt = next + 500;
  bot.liveQuotes.DOWN.bestAsk = 0.04;
  bot.processPendingLimitOrders(next + 500);
  assert.equal(bot.positions.length, 0);
  assert.ok(pending.every(order => order.limitPrice >= 0.05));
});

test.skip("legacy: pending limits fill only on a later fresh ask at or below the limit and remain separate", () => {
  const { bot, start } = makeBot();
  const placedAt = start + 5_000;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, placedAt);

  bot.liveQuotes.UP.updatedAt = placedAt + 500;
  bot.liveQuotes.UP.bestAsk = 0.51;
  bot.liveQuotes.DOWN.updatedAt = placedAt + 500;
  bot.liveQuotes.DOWN.bestAsk = 0.39;
  bot.processPendingLimitOrders(placedAt + 500);

  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN");
  assert.equal(bot.positions[0].shares, 50);
  assert.equal(bot.windowOrders.length, 1);
  assert.ok(bot.positions.every(position => position.status === "OPEN" && position.shares === 50));
  assert.equal(bot.positions.reduce((sum, position) => sum + position.shares, 0), 50);
  assert.equal(bot.cash, 9_980);
  assert.equal(bot.positions[0].entryQuotes.UP.bestBid, 0.50);
  assert.equal(bot.positions[0].entryQuotes.DOWN.bestBid, 0.40);
  assert.equal(bot.positions[0].submissionQuotes.UP.bestAsk, 0.60);
  assert.equal(bot.positions[0].entryType, "CONTRARIAN_BTC_DIRECTION");
});

test.skip("legacy: unfilled limits expire at the window close and no merge routine is present", () => {
  const { bot, start } = makeBot();
  const placedAt = start + 5_000;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, placedAt);
  bot.processPendingLimitOrders(start + config.WINDOW_MS_5M);

  assert.ok(bot.orders.filter(order => order.windowStart === start).every(order => order.status === "EXPIRED_UNFILLED"));
  assert.equal(bot.positions.length, 0);
  assert.equal(typeof bot.mergeMatchedPairs, "undefined");
});

test("take profit completes the window and clears all same-window shares", async () => {
  const { bot, start } = makeBot();
  bot.positions = [
    { id: "up", side: "UP", status: "OPEN", windowStart: start, shares: 50, totalCost: 25, fees: 0 },
    { id: "down", side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20, fees: 0 },
  ];
  bot.orders = [{ id: "pending", windowStart: start, status: "PENDING", remainingShares: 50 }];
  bot.cash -= 45;
  const exited = bot.positions[0];
  await bot.completeWindow(start, exited, true, "TAKE_PROFIT_BID", 0.99, start);

  assert.equal(exited.status, "SETTLED_EXIT");
  assert.equal(exited.payout, 1);
  assert.equal(exited.proceeds, 50);
  assert.equal(exited.exitFees, 0);
  assert.equal(exited.realizedPnl, 25);
  assert.equal(exited.tpTriggerQuote, 0.99);
  assert.equal(bot.snapshot().account.profitableExits, 1);
  assert.equal(bot.positions[1].status, "SETTLED_EXIT");
  assert.equal(bot.positions[1].settlementBasis, "WINDOW_EXIT_NO_BID");
  assert.equal(bot.positions[1].shares, 50);
  assert.equal(bot.cash, 10_005);
  assert.equal(bot.snapshot().inventory.UP.shares, 0);
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
  assert.equal(bot.orders[0].status, "EXPIRED_WINDOW_COMPLETE");
  assert.equal(bot.snapshot().window.complete, true);
  const orderCount = bot.orders.length;
  bot.processCandleEntries(start, start + config.ENTRY_CHECK_INTERVAL_MS);
  assert.equal(bot.orders.length, orderCount);
});

test("window completion closes remaining shares at their own current CLOB bid", async () => {
  const { bot, start } = makeBot();
  const now = start + 30_000;
  const up = { id: "up", side: "UP", status: "OPEN", windowStart: start, shares: 50, totalCost: 25 };
  const down = { id: "down", side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20 };
  bot.positions = [up, down];
  bot.cash -= 45;
  const originalGetBook = marketData.getBook;
  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === "up-token" ? 0.99 : 0.45, size: 50 }],
    asks: [{ price: tokenId === "up-token" ? 0.995 : 0.5, size: 50 }],
  });
  try {
    await bot.refreshLiveQuotes(now);
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(up.proceeds, 50);
  assert.equal(up.exitQuotes.UP.bestBid, 0.99);
  assert.equal(up.exitQuotes.DOWN.bestBid, 0.45);
  assert.equal(up.settlementBasis, "TAKE_PROFIT_BID");
  assert.equal(down.settlementBasis, "WINDOW_EXIT_BID");
  assert.equal(down.exitBid, 0.45);
  assert.equal(down.proceeds, 22.5);
  assert.equal(down.realizedPnl, 2.5);
  assert.equal(bot.snapshot().account.openPositions, 0);
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
});

test("stop loss pays $0/share and is counted as a losing exit, not an official result", () => {
  const { bot, start } = makeBot();
  const stopped = {
    id: "stopped-up",
    side: "UP",
    status: "OPEN",
    windowStart: start,
    shares: 50,
    totalCost: 20,
    fees: 0,
  };
  bot.positions = [stopped];
  bot.cash -= stopped.totalCost;

  bot.finalizePosition(stopped, false, "STOP_LOSS_BID", 0.01);

  assert.equal(stopped.status, "SETTLED_EXIT");
  assert.equal(stopped.payout, 0);
  assert.equal(stopped.proceeds, 0);
  assert.equal(stopped.exitFees, 0);
  assert.equal(stopped.realizedPnl, -20);
  assert.equal(stopped.stopTriggerQuote, 0.01);
  assert.equal(bot.snapshot().account.losingExits, 1);
  assert.equal(bot.cash, 9_980);
});

test("combined threshold payouts deduct both sides' costs, even when the net is negative", () => {
  const { bot } = makeBot();
  const up = { id: "up", side: "UP", status: "OPEN", shares: 700, totalCost: 350 };
  const down = { id: "down", side: "DOWN", status: "OPEN", shares: 900, totalCost: 450 };
  bot.positions = [up, down];
  bot.cash -= up.totalCost + down.totalCost;

  bot.finalizePosition(up, true, "TAKE_PROFIT_BID", 0.99);
  bot.finalizePosition(down, false, "STOP_LOSS_BID", 0.01);

  const state = bot.snapshot();
  assert.equal(up.proceeds, 700);
  assert.equal(down.proceeds, 0);
  assert.equal(up.status, "SETTLED_EXIT");
  assert.equal(down.status, "SETTLED_EXIT");
  assert.equal(state.account.realizedPnl, -100);
  assert.equal(state.account.cash, 9_900);
  assert.equal(state.account.equity, 9_900);
  assert.equal(state.account.profitableExits, 1);
  assert.equal(state.account.losingExits, 1);
});

test("rollover clears previous-window shares and cancels pending orders", async () => {
  const { bot } = makeBot();
  const currentStart = Math.floor(Date.now() / bot.windowMs) * bot.windowMs;
  bot.market = {
    id: "current",
    slug: "current",
    start: currentStart,
    tokens: { UP: "current-up", DOWN: "current-down" },
  };
  bot.lastMarketAt = Date.now();
  bot.orderWindowStart = currentStart;
  bot.refreshLiveQuotes = async () => {};
  bot.updateMarketRegime = () => {};
  bot.processTimedEntries = () => {};
  const oldStart = currentStart - bot.windowMs;
  bot.positions = [{
    id: "old-down-losing-side",
    side: "DOWN",
    status: "OPEN",
    windowStart: oldStart,
    windowMs: bot.windowMs,
    shares: 150,
    totalCost: 90,
    tokenId: "old-down",
  }];
  bot.orders = [{
    id: "old-pending",
    side: "DOWN",
    status: "PENDING",
    windowStart: oldStart,
    remainingShares: 50,
  }];
  bot.cash -= 90;
  const originalGetBook = marketData.getBook;
  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === "old-down" ? 0.2 : 0.5, size: 150 }],
    asks: [],
  });

  try {
    await bot.tick();
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(bot.positions[0].status, "SETTLED_EXIT");
  assert.equal(bot.positions[0].settlementBasis, "WINDOW_ROLLOVER_BID");
  assert.equal(bot.positions[0].shares, 150);
  assert.equal(bot.positions[0].proceeds, 30);
  assert.equal(bot.cash, bot.capital - 60);
  assert.equal(bot.snapshot().account.openPositions, 0);
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
  assert.match(bot.snapshot().strategy.exit, /No shares carry over/);
  const expiredOrder=bot.orders.find(order=>order.id==="old-pending");
  assert.equal(expiredOrder.status, "EXPIRED_WINDOW_ROLLOVER");
  assert.equal(expiredOrder.remainingShares, 0);
  assert.equal(bot.completedWindows.get(oldStart).reason, "WINDOW_ROLLOVER");
});

test("window rollover closes a position for $0 when its token has no bid", async () => {
  const { bot, start } = makeBot();
  bot.positions = [{
    id: "old-window-no-bid",
    side: "UP",
    status: "OPEN",
    windowStart: start,
    shares: 50,
    totalCost: 25,
    tokenId: "old-up",
  }];
  const originalGetBook = marketData.getBook;
  marketData.getBook = async () => ({ bids: [], asks: [] });

  try {
    await bot.closePreviousWindows(start + bot.windowMs, start + bot.windowMs);
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(bot.positions[0].status, "SETTLED_EXIT");
  assert.equal(bot.positions[0].settlementBasis, "WINDOW_ROLLOVER_NO_BID");
  assert.equal(bot.positions[0].proceeds, 0);
  assert.equal(bot.completedWindows.get(start).reason, "WINDOW_ROLLOVER");
});

test("two consecutive completed windows settle independently without carrying shares", async () => {
  const { bot, start } = makeBot();
  const firstUp = {
    id: "first-up-tp",
    side: "UP",
    status: "OPEN",
    windowStart: start,
    shares: 50,
    totalCost: 25,
  };
  const firstDown = {
    id: "first-down-150",
    side: "DOWN",
    status: "OPEN",
    windowStart: start,
    shares: 150,
    totalCost: 90,
  };
  bot.positions = [firstUp, firstDown];
  bot.orders = [{ id: "first-pending", windowStart: start, status: "PENDING", remainingShares: 50 }];
  bot.cash -= firstUp.totalCost + firstDown.totalCost;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.99 },
    DOWN: { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.2 },
  };

  await bot.completeWindow(start, firstUp, true, "TAKE_PROFIT_BID", 0.99, start + 60_000);

  assert.deepEqual([firstUp.status, firstDown.status], ["SETTLED_EXIT", "SETTLED_EXIT"]);
  assert.deepEqual([firstUp.proceeds, firstDown.proceeds], [50, 30]);
  assert.equal(firstDown.realizedPnl, -60);
  assert.equal(bot.orders[0].status, "EXPIRED_WINDOW_COMPLETE");
  assert.equal(bot.cash, bot.capital - 35);
  assert.equal(bot.snapshot().account.openPositions, 0);
  assert.deepEqual(bot.snapshot().inventory, {
    UP: { shares: 0, cost: 0, averageCost: null, positions: 0 },
    DOWN: { shares: 0, cost: 0, averageCost: null, positions: 0 },
  });

  const secondStart = start + bot.windowMs;
  bot.market = {
    ...bot.market,
    id: "second-window",
    slug: "second-window",
    start: secondStart,
    end: secondStart + bot.windowMs,
  };
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
  const secondUp = {
    id: "second-up",
    side: "UP",
    status: "OPEN",
    windowStart: secondStart,
    shares: 150,
    totalCost: 75,
  };
  const secondDown = {
    id: "second-down-sl",
    side: "DOWN",
    status: "OPEN",
    windowStart: secondStart,
    shares: 50,
    totalCost: 20,
  };
  bot.positions.push(secondUp, secondDown);
  bot.orders.push({ id: "second-pending", windowStart: secondStart, status: "PENDING", remainingShares: 50 });
  bot.cash -= secondUp.totalCost + secondDown.totalCost;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: secondStart + 60_000, bestBid: 0.35 },
    DOWN: { status: "LIVE", updatedAt: secondStart + 60_000, bestBid: 0.01 },
  };

  await bot.completeWindow(secondStart, secondDown, false, "STOP_LOSS_BID", 0.01, secondStart + 60_000);

  assert.deepEqual([secondUp.status, secondDown.status], ["SETTLED_EXIT", "SETTLED_EXIT"]);
  assert.deepEqual([secondUp.proceeds, secondDown.proceeds], [52.5, 0]);
  assert.equal(bot.orders[1].status, "EXPIRED_WINDOW_COMPLETE");
  assert.equal(bot.cash, bot.capital - 77.5);
  const final = bot.snapshot();
  assert.equal(final.account.openPositions, 0);
  assert.equal(final.account.settledTrades, 4);
  assert.equal(final.account.realizedPnl, -77.5);
  assert.equal(final.window.complete, true);
  assert.deepEqual([final.inventory.UP.shares, final.inventory.DOWN.shares], [0, 0]);
  assert.ok(bot.positions.every(position => position.status === "SETTLED_EXIT"));
});

test("old-window positions can still settle from their own token threshold", async () => {
  const { bot } = makeBot();
  const now = Date.now();
  const currentStart = Math.floor(now / bot.windowMs) * bot.windowMs;
  bot.market = {
    id: "current",
    slug: "current",
    start: currentStart,
    tokens: { UP: "current-up", DOWN: "current-down" },
  };
  const oldPosition = {
    id: "old-window",
    side: "UP",
    status: "OPEN",
    windowStart: currentStart - bot.windowMs,
    windowMs: bot.windowMs,
    shares: 50,
    totalCost: 20,
    tokenId: "old-up",
  };
  bot.positions = [oldPosition];
  const originalGetBook = marketData.getBook;
  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === "old-up" ? 0.99 : 0.5, size: 50 }],
    asks: [],
  });

  try {
    await bot.refreshLiveQuotes(now);
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(oldPosition.status, "SETTLED_EXIT");
  assert.equal(oldPosition.payout, 1);
  assert.equal(oldPosition.proceeds, 50);
  assert.equal(oldPosition.realizedPnl, 30);
});

test.skip("legacy: contrarian strategy uses a direction signal even in a choppy regime", () => {
  const { bot, start } = makeBot();
  bot.marketRegime = { state: "CHOPPY", direction: "UP", reason: "test regime" };
  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, now);

  assert.equal(bot.windowOrders.length, 1);
  assert.equal(bot.windowOrders[0].side, "DOWN");
  assert.equal(bot.snapshot().strategy.entries.direction.includes("Contrarian"), true);
});

test.skip("legacy: falling BTC selects UP and missing direction skips entries", () => {
  const { bot, start } = makeBot();
  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.marketRegime = { state: "UNKNOWN", direction: null };
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, now);
  assert.equal(bot.windowOrders.length, 0);

  bot.marketRegime = { state: "TRENDING", direction: "DOWN" };
  bot.processTimedEntries(start, now + config.ENTRY_CHECK_INTERVAL_MS);
  assert.equal(bot.windowOrders.length, 1);
  assert.equal(bot.windowOrders[0].side, "UP");
});

test("snapshot reports weighted average cost for all open UP and DOWN shares", () => {
  const { bot, start } = makeBot();
  bot.positions = [
    { side: "UP", status: "OPEN", windowStart: start, shares: 25, totalCost: 10 },
    { side: "UP", status: "OPEN", windowStart: start, shares: 75, totalCost: 45 },
    { side: "UP", status: "OPEN", windowStart: start, shares: 5, totalCost: 2.5 },
    { side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20 },
    { side: "DOWN", status: "OPEN", windowStart: start, shares: 10, totalCost: 8 },
    { side: "DOWN", status: "SETTLED_EXIT", shares: 40, totalCost: 15 },
    ...Array.from({ length: 55 }, (_, index) => ({
      id: `settled-${index}`,
      side: "UP",
      status: "SETTLED_EXIT",
      shares: 100,
      totalCost: 90,
      settledAt: start + index,
    })),
  ];

  const inventory = bot.snapshot().inventory;
  assert.equal(inventory.UP.shares, 105);
  assert.equal(inventory.UP.cost, 57.5);
  assert.equal(inventory.UP.averageCost, 57.5 / 105);
  assert.equal(inventory.UP.positions, 3);
  assert.equal(inventory.DOWN.shares, 60);
  assert.equal(inventory.DOWN.cost, 28);
  assert.equal(inventory.DOWN.averageCost, 28 / 60);
  assert.equal(inventory.DOWN.positions, 2);
});

test("multi-timeframe snapshot exposes a completed window status", () => {
  const multiBot = new MultiBot();
  multiBot.bots["5m"].status = "window_complete";
  multiBot.bots["15m"].status = "window_complete";
  assert.equal(multiBot.snapshot().status, "window_complete");
});

test("diagnostics export every position, quote pairs, and side-level summaries", () => {
  const multiBot = new MultiBot();
  const bot = multiBot.bots["5m"];
  bot.positions = Array.from({ length: 60 }, (_, index) => ({
    id: `trade-${index}`,
    timeframe: "5m",
    side: index % 2 ? "DOWN" : "UP",
    status: "SETTLED_EXIT",
    openedAt: index,
    settledAt: index + 1,
    entryMode: index % 2 ? "REBALANCE" : "BASE",
    settlementBasis: "WINDOW_EXIT_BID",
    realizedPnl: index % 2 ? -1 : 2,
    totalCost: 10,
    proceeds: index % 2 ? 9 : 12,
    entryQuotes: { UP: { bestBid: 0.5 }, DOWN: { bestBid: 0.4 } },
    exitQuotes: { UP: { bestBid: 0.6 }, DOWN: { bestBid: 0.4 } },
  }));
  bot.orders = [{ id: "retained-order", status: "FILLED", createdAt: 1 }];
  bot.totalOrderAttempts = 1201;

  const diagnostics = multiBot.diagnostics();

  assert.equal(diagnostics.tradeCount, 60);
  assert.equal(diagnostics.trades.length, 60);
  assert.equal(diagnostics.summary.bySide.UP.positions, 30);
  assert.equal(diagnostics.summary.bySide.DOWN.positions, 30);
  assert.equal(diagnostics.orderAttempts, 1201);
  assert.equal(diagnostics.retainedOrderCount, 1);
  assert.equal(diagnostics.orderHistoryTruncated, true);
  assert.ok(diagnostics.trades.every(trade => trade.entryQuotes && trade.exitQuotes));
});
