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

  const { CalibratedBot: Bot } = require('./calibrated-bot');
  const startServer = require('./server');
  const fs = require('node:fs');
  const path = require('node:path');
  const CalibratedWorker = require('./calibrated-worker');
  const PaperLedgerStore = require('./paper-ledger-store');
  const ledgerPath = process.env.PAPER_LEDGER_PATH || null;
  const ledgerStore = ledgerPath ? new PaperLedgerStore(ledgerPath) : null;
  if (ledgerPath && !fs.existsSync(path.dirname(ledgerStore.filePath))) {
    throw new Error(`Paper-history storage is not mounted at ${path.dirname(ledgerStore.filePath)}.`);
  }
  const worker = new CalibratedWorker({
    directory: path.join(ledgerPath ? path.dirname(ledgerPath) : require('node:os').tmpdir(), 'calibrated-dual-models'),
  });
  const bot = new Bot({ ledgerStore, worker });
  const savedLedger = ledgerStore?.load() || PaperLedgerStore.decodeBootstrap(process.env.PAPER_LEDGER_BOOTSTRAP);
  await restoreOrResetLedger(bot, savedLedger, Bot.STRATEGY.id);
  await bot.flushLedger();
  worker.start();
  bot.start();
  const server = startServer(bot, process.env.PORT || 3000);

  console.log('MODE: PAPER ONLY -- separate calibrated LightGBM BTC 5m/15m; 50-share target within 2% cash; net edge >=4 cents; hold official resolution.');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    bot.stop();
    worker.stop();
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
