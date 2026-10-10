'use strict';

async function main() {
  if (process.env.LIVE_TRADING === 'true') {
    console.error('Live execution was removed. Unset LIVE_TRADING; this bot runs in demo mode only.');
    process.exitCode = 1;
    return;
  }

  const Bot = require('./arb-bot');
  const startServer = require('./server');
  const bot = new Bot({ predictApiKey: process.env.PREDICT_API_KEY });
  bot.start();
  startServer(bot, process.env.PORT || 3000);

  console.log('MODE: DEMO -- cross-venue non-crypto paper arbitrage only; no live order code is loaded.');
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
