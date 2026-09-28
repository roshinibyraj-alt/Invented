'use strict';

const PolymarketTrader = require('./polymarket-trader');
const Bot = require('./bot');
const startServer = require('./server');

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Missing PRIVATE_KEY env var -- refusing to start (this bot trades real funds).');
    process.exit(1);
  }

  const trader = new PolymarketTrader(privateKey);
  trader.setLogFn((msg) => console.log(`[trader] ${msg}`));

  console.log('Authenticating with Polymarket...');
  await trader.authenticate();
  await trader.approveAllowance();

  const bot = new Bot(trader);
  bot.start();

  const port = process.env.PORT || 3000;
  startServer(bot, port);

  console.log('Bot running. REAL capital is live -- watch the dashboard.');
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
