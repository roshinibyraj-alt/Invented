'use strict';

const Bot = require('./bot');
const startServer = require('./server');

// DEMO is the default. Real orders only when LIVE_TRADING=true is set in Railway.
const LIVE = process.env.LIVE_TRADING === 'true';

async function main() {
  let trader;
  if (LIVE) {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      console.error('LIVE_TRADING=true but PRIVATE_KEY is missing -- refusing to start.');
      process.exit(1);
    }
    const PolymarketTrader = require('./polymarket-trader');
    trader = new PolymarketTrader(privateKey);
    trader.setLogFn((msg) => console.log(`[trader] ${msg}`));
    console.log('Authenticating with Polymarket...');
    await trader.authenticate();
    await trader.approveAllowance();
  } else {
    const DemoTrader = require('./demo-trader');
    trader = new DemoTrader();
  }

  const bot = new Bot(trader, { live: LIVE });
  bot.start();
  startServer(bot, process.env.PORT || 3000);

  console.log(LIVE
    ? 'MODE: LIVE -- REAL capital, real orders.'
    : 'MODE: DEMO -- simulated fills only. Set LIVE_TRADING=true to trade real funds.');
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
