'use strict';

// This trigger/hedge strategy is demo-only. Fail before loading
// a wallet trader or authenticating if a live-trading flag is present.
const LIVE = process.env.LIVE_TRADING === 'true';

async function main() {
  if (LIVE) {
    console.error('This strategy is demo-only; LIVE_TRADING=true is blocked before wallet authentication.');
    process.exitCode = 1;
    return;
  }

  const Bot = require('./paired-limit-bot');
  const startServer = require('./server');
  const DemoTrader = require('./demo-trader');
  const trader = new DemoTrader();

  const bot = new Bot(trader, { live: false, logger: console });
  bot.start();
  startServer(bot, process.env.PORT || 3000);

  console.log('MODE: DEMO -- simulated trigger/hedge fills only. Live trading is disabled for this strategy.');
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
