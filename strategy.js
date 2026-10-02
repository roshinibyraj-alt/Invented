'use strict';

const cfg = require('./config');

function buyLimitTouched(bestAsk, limitPrice) {
  const ask = Number(bestAsk);
  const limit = Number(limitPrice);
  return Number.isFinite(ask) && Number.isFinite(limit) && ask > 0 && ask <= limit;
}

function takeProfitTouched(bestBid, limitPrice) {
  const bid = Number(bestBid);
  const limit = Number(limitPrice);
  return Number.isFinite(bid) && Number.isFinite(limit) && bid > 0 && bid >= limit;
}

// Demo estimate only: Polymarket distributes a daily, market-specific rebate
// pool. This applies the Crypto pool share to this fill's fee-curve equivalent.
function estimateMakerRebate(shares, price) {
  const quantity = Number(shares);
  const p = Number(price);
  if (!Number.isFinite(quantity) || quantity <= 0
    || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const feeEquivalent = quantity * cfg.CRYPTO_TAKER_FEE_RATE * p * (1 - p);
  const estimate = feeEquivalent * cfg.CRYPTO_MAKER_REBATE_POOL_SHARE;
  return Math.round((estimate + Number.EPSILON) * 100000) / 100000;
}

function estimateTakerFee(shares, price) {
  const quantity = Number(shares);
  const p = Number(price);
  if (!Number.isFinite(quantity) || quantity <= 0
    || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const fee = quantity * cfg.CRYPTO_TAKER_FEE_RATE * p * (1 - p);
  return Math.round((fee + Number.EPSILON) * 100000) / 100000;
}

module.exports = { buyLimitTouched, takeProfitTouched, estimateMakerRebate, estimateTakerFee };