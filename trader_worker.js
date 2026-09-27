'use strict';

const readline = require('readline');
const { ensureWebCrypto } = require('./trader_crypto');
ensureWebCrypto();
const PolymarketTrader = require('./trader_client');
const { placeBuy } = require('./trader_buy');

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  process.stdout.write(`${JSON.stringify({
    event: 'error',
    error: 'PRIVATE_KEY is not configured',
  })}\n`);
  process.exit(1);
}

const trader = new PolymarketTrader(privateKey, (message) => {
  process.stderr.write(`[trader] ${message}\n`);
});

const reply = (id, ok, result, error) => {
  process.stdout.write(`${JSON.stringify({ id, ok, result, error })}\n`);
};

async function run(command, args) {
  if (command === 'balance') return trader.balance();
  if (command === 'book') return trader.book(args.tokenId);
  if (command === 'verify_buy') {
    return trader.verifyBuy(args.tokenId, args.openTs, args.orderId);
  }
  if (command === 'shutdown') {
    process.exit(0);
  }
  if (command !== 'buy') {
    throw new Error(`Unknown trader command: ${command}`);
  }

  return placeBuy(trader, args);
}

(async () => {
  try {
    const address = await trader.authenticate();
    process.stdout.write(`${JSON.stringify({ event: 'ready', address })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ event: 'error', error: error.message })}\n`);
    process.exit(1);
  }

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
      const result = await run(message.command, message.args || {});
      reply(message.id, true, result);
    } catch (error) {
      reply(message.id, false, null, error.message);
    }
  }
})();
