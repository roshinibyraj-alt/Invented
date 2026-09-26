'use strict';

const readline = require('readline');
const PolymarketTrader = require('./trader_client');

const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  process.stdout.write(`${JSON.stringify({
    event: 'error',
    error: 'POLYMARKET_PRIVATE_KEY is not configured',
  })}\n`);
  process.exit(1);
}

const trader = new PolymarketTrader(privateKey, (message) => {
  process.stderr.write(`[trader] ${message}\n`);
});

const reply = (id, ok, result, error) => {
  process.stdout.write(`${JSON.stringify({ id, ok, result, error })}\n`);
};

const roundUp = (value, tick) => {
  const places = Math.max(0, String(tick).split('.')[1]?.length || 0);
  const factor = 10 ** places;
  return Math.ceil((value - 1e-12) * factor) / factor;
};

const roundDown = (value, tick) => {
  const places = Math.max(0, String(tick).split('.')[1]?.length || 0);
  const factor = 10 ** places;
  return Math.floor((value + 1e-12) * factor) / factor;
};

async function run(command, args) {
  if (command === 'balance') return trader.balance();
  if (command === 'book') return trader.book(args.tokenId);
  if (command === 'shutdown') {
    process.exit(0);
  }
  if (command !== 'buy' && command !== 'sell') {
    throw new Error(`Unknown trader command: ${command}`);
  }

  const book = await trader.book(args.tokenId);
  const reference = command === 'buy' ? args.referenceAsk : args.referenceBid;
  const marketPrice = command === 'buy' ? book.bestAsk : book.bestBid;
  const quote = Number.isFinite(marketPrice) ? marketPrice : reference;
  if (!Number.isFinite(quote) || quote <= 0) {
    return { filled: false, status: 'NO_QUOTE', shares: 0 };
  }

  const tickSize = (await trader.clob.getTickSize(args.tokenId)) || '0.01';
  const slippage = Number(args.slippage || 0.30);
  let limitPrice = command === 'buy'
    ? Math.min(0.99, quote + slippage)
    : Math.max(0.01, quote - slippage);
  limitPrice = command === 'buy'
    ? roundUp(limitPrice, tickSize)
    : roundDown(limitPrice, tickSize);
  limitPrice = Math.min(0.99, Math.max(0.01, limitPrice));

  let size;
  if (command === 'buy') {
    // Budget is a ceiling: even at the worst accepted price, the order
    // cannot exceed the requested dollar amount.
    size = roundDown(Number(args.budgetUsd) / limitPrice, '0.01');
  } else {
    size = roundDown(Number(args.shares), '0.01');
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { filled: false, status: 'SIZE_TOO_SMALL', shares: 0, limitPrice };
  }

  const result = await trader.order(
    args.tokenId,
    command === 'buy' ? 'BUY' : 'SELL',
    limitPrice,
    size,
  );
  return {
    ...result,
    limitPrice,
    budgetUsd: command === 'buy' ? Number(args.budgetUsd) : undefined,
    cost: command === 'buy' ? result.shares * result.avgPrice : undefined,
    proceeds: command === 'sell' ? result.shares * result.avgPrice : undefined,
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
