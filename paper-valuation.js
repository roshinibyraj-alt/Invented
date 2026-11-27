'use strict';

const numeric = value => value !== null && value !== undefined && Number.isFinite(Number(value));

function valuationSummary(positions, now, maxAgeMs) {
  const summary = { pricedPositions: 0, unpricedPositions: 0, pendingPositions: 0,
    knownMarkedValue: 0, knownUnrealizedPnl: 0, unpricedCostBasis: 0 };
  for (const p of positions) {
    if (!['OPEN', 'PENDING_RESOLUTION'].includes(p.status)) continue;
    if (p.status === 'PENDING_RESOLUTION') summary.pendingPositions++;
    const priced = p.status === 'OPEN' && p.markStatus === 'LIVE' && numeric(p.markBid)
      && Number(p.markBid) >= 0 && Number(p.markBid) <= 1 && numeric(p.markUpdatedAt)
      && Number(p.markUpdatedAt) <= now && now - Number(p.markUpdatedAt) <= maxAgeMs;
    if (priced) {
      summary.pricedPositions++;
      const value = Number(p.markBid) * Number(p.shares);
      summary.knownMarkedValue += value;
      summary.knownUnrealizedPnl += value - Number(p.totalCost) - Number(p.fees || 0);
    } else {
      summary.unpricedPositions++;
      summary.unpricedCostBasis += Number(p.totalCost) + Number(p.fees || 0);
    }
  }
  summary.status = summary.unpricedPositions ? 'INCOMPLETE' : 'LIVE';
  return summary;
}

// Rebuild from the full closed ledger, not the dashboard's capped trade list.
// A settlement is recorded when it was actually credited, not at window expiry.
function settledBalanceHistory(positions, initialCapital, settledBalance, now, initialAt) {
  const closed = positions.filter(p => numeric(p.realizedPnl));
  const timed = closed.map(p => ({ at: numeric(p.exitAt) ? Number(p.exitAt) : Number(p.resolvedAt),
    pnl: Number(p.realizedPnl) }));
  if (timed.some(p => !Number.isFinite(p.at) || p.at <= 0 || p.at > now)) {
    return { points: [{ at: now, equity: settledBalance }], incomplete: true };
  }
  timed.sort((a, b) => a.at - b.at);
  const start = Math.min(numeric(initialAt) ? Number(initialAt) : now,
    timed.length ? timed[0].at - 1 : now, now);
  let balance = initialCapital;
  const points = [{ at: start, equity: balance }];
  for (const p of timed) {
    balance += p.pnl;
    if (points.at(-1).at === p.at) points.at(-1).equity = balance;
    else points.push({ at: p.at, equity: balance });
  }
  if (points.at(-1).at === now) points.at(-1).equity = settledBalance;
  else points.push({ at: now, equity: settledBalance });
  return { points, incomplete: false };
}

module.exports = { valuationSummary, settledBalanceHistory };
