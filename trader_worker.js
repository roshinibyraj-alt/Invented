'use strict';

const readline = require('readline');
const { ensureWebCrypto } = require('./trader_crypto');
ensureWebCrypto();
const PolymarketTrader = require('./trader_client');
const { marketLimitPrice, roundToTick } = require('./order_utils');

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
  if (command !== 'buy' && command !== 'sell') {
    throw new Error(`Unknown trader command: ${command}`);
  }

  const reference = command === 'buy' ? args.referenceAsk : args.referenceBid;
  let book;
  try {
    book = await trader.book(args.tokenId);
  } catch {
    book = {};
  }
  const marketPrice = command === 'buy' ? book.bestAsk : book.bestBid;
  const executablePrice = Number.isFinite(marketPrice) && marketPrice > 0
    ? marketPrice
    : Number(reference);
  if (!Number.isFinite(executablePrice) || executablePrice <= 0) {
    return { filled: false, status: 'NO_QUOTE', shares: 0 };
  }

  const tickSize = (await trader.clob.getTickSize(args.tokenId)) || '0.01';
  const side = command === 'buy' ? 'BUY' : 'SELL';
  const limitPrice = marketLimitPrice(side, executablePrice, reference, args.slippage, tickSize);
  if (limitPrice === null) {
    return { filled: false, status: 'PRICE_MOVED', shares: 0 };
  }

  // The SDK's FAK market BUY takes USDC; SELL takes shares. Never silently
  // increase the real ladder budget to satisfy a market's minimum.
  const amount = command === 'buy'
    ? Number(args.budgetUsd)
    : roundToTick(Number(args.shares), '0.01', 'down');
  if (!Number.isFinite(amount) || amount <= 0) {
    return { filled: false, status: 'SIZE_TOO_SMALL', shares: 0, limitPrice };
  }
  if (command === 'buy' && (!Number.isInteger(amount) || amount < 1 || amount > 8)) {
    return { filled: false, status: 'BUDGET_OUT_OF_RANGE', shares: 0, limitPrice };
  }

  const result = await trader.order(
    args.tokenId,
    side,
    limitPrice,
    amount,
  );
  return {
    ...result,
    limitPrice,
    budgetUsd: command === 'buy' ? Number(args.budgetUsd) : undefined,
  };
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
