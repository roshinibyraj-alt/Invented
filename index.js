'use strict';

async function restoreOrResetLedger(bot, savedLedger, strategyId) {
  const savedStrategyId = savedLedger?.snapshot?.strategy?.id || savedLedger?.strategyId;
  if (savedLedger && savedStrategyId === strategyId) {
    bot.restoreLedger(savedLedger);
    await bot.flushLedger();
    return 'restored';
  }
  if (savedLedger) {
    if (!bot.ledgerStore?.archive) throw new Error('Cannot replace the strategy without archiving the prior paper ledger.');
    await bot.ledgerStore.archive(savedLedger);
    bot.log('Previous paper ledger archived; started a fresh ledger for the new strategy.', {
      type: 'LEDGER_RESET',
      now: Date.now(),
    });
    await bot.flushLedger();
    return 'reset';
  }
  return 'fresh';
}

async function main() {
  if (process.env.LIVE_TRADING === 'true') {
    console.error('Live execution was removed. Unset LIVE_TRADING; this bot runs in demo mode only.');
    process.exitCode = 1;
    return;
  }

  const Bot = require('./freqai-resting-btc-bot');
  const startServer = require('./server');
  const fs = require('node:fs');
  const path = require('node:path');
  const BinanceTickFeed = require('./binance-tick-feed');
  const FreqAIWorker = require('./freqai-worker');
  const PaperLedgerStore = require('./paper-ledger-store');
  const ledgerPath = process.env.PAPER_LEDGER_PATH || null;
  const ledgerStore = ledgerPath ? new PaperLedgerStore(ledgerPath) : null;
  if (ledgerPath && !fs.existsSync(path.dirname(ledgerStore.filePath))) {
    throw new Error(`Paper-history storage is not mounted at ${path.dirname(ledgerStore.filePath)}.`);
  }
  const bot = new Bot({ ledgerStore });
  const savedLedger = ledgerStore?.load() || PaperLedgerStore.decodeBootstrap(process.env.PAPER_LEDGER_BOOTSTRAP);
  await restoreOrResetLedger(bot, savedLedger, Bot.STRATEGY.id);
  const binanceFeed = new BinanceTickFeed();
  const freqaiWorker = new FreqAIWorker();
  bot.setMarketDataHelpers({ binanceFeed, freqaiWorker });
  freqaiWorker.start();
  void binanceFeed.start().catch((error) => {
    console.error('[binance-feed] Could not start spot feed:', error?.message || error);
  });
  bot.start();
  const server = startServer(bot, process.env.PORT || 3000);

  console.log('MODE: DEMO -- >58% FreqAI, flat 100-share resting limits at ask minus $0.10 after 45 seconds; no flips or live orders.');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    bot.stop();
    freqaiWorker.stop();
    binanceFeed.stop();
    const forcedExit = setTimeout(() => process.exit(1), 10_000);
    forcedExit.unref?.();
    await bot.flushLedger();
    server.close(() => {
      clearTimeout(forcedExit);
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal startup error:', e);
    process.exit(1);
  });
}

module.exports = { restoreOrResetLedger };
