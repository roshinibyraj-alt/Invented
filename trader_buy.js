'use strict';

const { marketLimitPrice, buyBudgetUsd } = require('./order_utils');

async function placeBuy(trader, args) {
  const closeMs = Number(args.closeTs) * 1000;
  if (!Number.isFinite(closeMs) || Date.now() >= closeMs) {
    return { filled: false, status: 'WINDOW_CLOSED', shares: 0 };
  }

  const reference = args.referenceAsk;
  let book;
  try {
    book = await trader.book(args.tokenId);
  } catch {
    book = {};
  }
  const marketPrice = book.bestAsk;
  const executablePrice = Number.isFinite(marketPrice) && marketPrice > 0
    ? marketPrice
    : Number(reference);
  if (!Number.isFinite(executablePrice) || executablePrice <= 0) {
    return { filled: false, status: 'NO_QUOTE', shares: 0 };
  }

  const tickSize = (await trader.clob.getTickSize(args.tokenId)) || '0.01';
  const limitPrice = marketLimitPrice('BUY', executablePrice, reference, args.slippage, tickSize);
  if (limitPrice === null) {
    return { filled: false, status: 'PRICE_MOVED', shares: 0 };
  }

  // Never silently increase the real ladder budget to meet a market minimum.
  const amount = buyBudgetUsd(args.budgetUsd);
  if (amount === null) {
    return { filled: false, status: 'BUDGET_OUT_OF_RANGE', shares: 0, limitPrice };
  }

  if (Date.now() >= closeMs) {
    return { filled: false, status: 'WINDOW_CLOSED', shares: 0, limitPrice };
  }
  const result = await trader.buy(args.tokenId, limitPrice, amount, closeMs);
  return { ...result, limitPrice, budgetUsd: amount };
}

module.exports = { placeBuy };