'use strict';

async function main() {
  if (process.env.LIVE_TRADING === 'true') {
    console.error('Live execution was removed. Unset LIVE_TRADING; this bot runs in demo mode only.');
    process.exitCode = 1;
    return;
  }

  const Bot = require('./multi-bot');
  const startServer = require('./server');
  const bot = new Bot();
  bot.start();
  startServer(bot, process.env.PORT || 3000);

  console.log('MODE: DEMO -- BTC 5m candle signals; one 500-share paper market buy opposite each valid signal; no live orders.');
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
