'use strict';

// https://docs.polymarket.com/trading/fees — fee amounts rounded to 5 decimals.
function planTakerBuy(record, side, now, cash) {
  const m = record.market, q = record.quotes?.[side];
  if (!m || record.marketStatus !== 'OPEN' || now < Number(m.start) + 45000
    || now >= Number(m.end) || !q || q.updatedAt == null
    || !Number.isFinite(Number(q.updatedAt)) || now < Number(q.updatedAt)
    || now - Number(q.updatedAt) > 2000 || !Array.isArray(q.asks)
    || (q.tokenId && q.tokenId !== String(m.tokens[side]))
    || (q.marketId && q.marketId !== String(m.id || m.slug))
    || (q.windowStart != null && Number(q.windowStart) !== Number(m.start))) return null;
  const feeRate = m.feesEnabled === false ? 0 : Number(m.feeSchedule?.rate ?? 0.05);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) return null;
  let remaining = 100, cost = 0, fees = 0;
  const fills = [];
  for (const level of [...q.asks].sort((a, b) => Number(a.price) - Number(b.price))) {
    const price = Number(level.price), size = Number(level.size);
    if (!(price > 0 && price < 1) || !Number.isFinite(size) || size <= 0) continue;
    const shares = Math.min(remaining, size);
    const fee = Number((shares * feeRate * price * (1 - price)).toFixed(5));
    fills.push({ price, shares, fee, liquidity: 'TAKER', at: now });
    cost += shares * price; fees += fee; remaining -= shares;
    if (remaining <= 1e-8) break;
  }
  if (!fills.length || !Number.isFinite(cash) || cost + fees > cash + 1e-8) return null;
  return { shares: 100 - remaining, totalCost: cost, fees, fills,
    entryPrice: cost / (100 - remaining), unfilledShares: remaining,
    status: remaining > 1e-8 ? 'PARTIALLY_FILLED' : 'FILLED',
    markBid: q.bestBid == null ? null : Number(q.bestBid), markUpdatedAt: q.updatedAt,
    signalAsk: q.bestAsk, feeRate };
}
module.exports = { planTakerBuy };
