'use strict';

async function main() {
  if (process.env.LIVE_TRADING === 'true') {
    console.error('Live execution was removed. Unset LIVE_TRADING; this bot runs in demo mode only.');
    process.exitCode = 1;
    return;
  }

  const Bot = require('./cross-timeframe-arbitrage-bot');
  const startServer = require('./server');
  const bot = new Bot();
  bot.start();
  startServer(bot, process.env.PORT || 3000);

  console.log('MODE: DEMO -- BTC paired strategy attempts one entry every 5m; no live orders are sent.');
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
