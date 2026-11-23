'use strict';

async function main() {
  if (process.env.LIVE_TRADING === 'true') {
    console.error('Live execution was removed. Unset LIVE_TRADING; this bot runs in demo mode only.');
    process.exitCode = 1;
    return;
  }

  const Bot = require('./cross-pair-bot');
  const startServer = require('./server');
  const fs = require('node:fs');
  const path = require('node:path');
  const PaperLedgerStore = require('./paper-ledger-store');
  const ledgerPath = process.env.PAPER_LEDGER_PATH || null;
  const ledgerStore = ledgerPath ? new PaperLedgerStore(ledgerPath) : null;
  if (ledgerPath && !fs.existsSync(path.dirname(ledgerStore.filePath))) {
    throw new Error(`Paper-history storage is not mounted at ${path.dirname(ledgerStore.filePath)}.`);
  }
  const bot = new Bot({ ledgerStore });
  const savedLedger = ledgerStore?.load() || PaperLedgerStore.decodeBootstrap(process.env.PAPER_LEDGER_BOOTSTRAP);
  const savedStrategyId = savedLedger?.snapshot?.strategy?.id || savedLedger?.strategyId;
  if (savedLedger && savedStrategyId === Bot.STRATEGY.id) {
    bot.restoreLedger(savedLedger);
    await bot.flushLedger();
  } else if (savedLedger) {
    bot.log('Paper history reset for the inverse-pair exit and TP/SL strategy.', {
      type: 'LEDGER_RESET',
      now: Date.now(),
    });
    await bot.flushLedger();
  }
  bot.start();
  const server = startServer(bot, process.env.PORT || 3000);

  console.log('MODE: DEMO -- BTC/ETH 5-minute inverse-pair strategy; no live orders are sent.');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    bot.stop();
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

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
