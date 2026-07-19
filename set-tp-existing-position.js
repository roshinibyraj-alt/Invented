'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  ONE-OFF: place TP orders on your CURRENTLY HELD real position(s)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Run this once, by hand, to retroactively apply the same 120%-of-entry
 *  TP rule to positions you already hold (taken before the bot had TP
 *  logic built in). It does NOT touch your running bot process — it's
 *  a standalone script using the same trader class.
 *
 *  What it does:
 *    1. Authenticates your wallet (same PRIVATE_KEY as the bot).
 *    2. Pulls your REAL open positions from Polymarket's public Data API
 *       (data-api.polymarket.com/positions) — the same source the
 *       dashboard's "Real Account" panel uses.
 *    3. For each position with nonzero size, computes TP = min(0.99,
 *       avgPrice * 1.20) and places a real GTC (resting) limit SELL
 *       order for the full size at that price.
 *    4. Prints what it found and what it placed — nothing is silent.
 *
 *  Usage:
 *    PRIVATE_KEY=0x... node set-tp-existing-position.js
 *
 *  Optional filters (env vars):
 *    TP_MULTIPLIER=1.60      override the TP multiple (default 1.60 = 160%)
 *    TP_MAX_PRICE=0.99       cap on TP price (default 0.99)
 *    ONLY_ASSET=<token id>   only target this specific token id (asset field)
 *    ONLY_CONDITION_ID=<id>  only target positions on this market's conditionId
 *                            (easier to find than the raw token id — it's in
 *                            the market URL/Gamma API)
 *    DRY_RUN=true            preview what WOULD be placed without sending
 *                            any real orders (default false — this script
 *                            is meant to actually place the order)
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const DATA_API = 'https://data-api.polymarket.com';
const TP_MULTIPLIER = Number(process.env.TP_MULTIPLIER || 1.60);
const TP_MAX_PRICE  = Number(process.env.TP_MAX_PRICE || 0.99);
const ONLY_ASSET        = process.env.ONLY_ASSET || null;
const ONLY_CONDITION_ID = process.env.ONLY_CONDITION_ID || null;
const DRY_RUN       = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';

function round2(n) { return Math.round(n * 100) / 100; }

// CLOB order rejections often carry the real reason in e.response.data / e.data
// rather than e.message (which is frequently just "Request failed with status
// code 400"). Pull whatever's actually there.
function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) {
    try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {}
  }
  return parts.join(' | ');
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'set-tp-existing-position/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchPositionsWithRetry(address, tries = 3, delayMs = 2000) {
  // The Data API can lag a few seconds behind a just-filled order — retry a
  // couple times before concluding "no positions" if you just traded.
  for (let i = 0; i < tries; i++) {
    const positions = await getJSON(`${DATA_API}/positions?user=${address}&sizeThreshold=0`);
    const nonZero = (Array.isArray(positions) ? positions : []).filter(p => Math.abs(p.size) > 0);
    if (nonZero.length > 0 || i === tries - 1) return nonZero;
    console.log(`   …no positions yet (attempt ${i + 1}/${tries}), retrying in ${delayMs / 1000}s — the Data API can lag briefly after a fill`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  return [];
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ Set PRIVATE_KEY in the environment before running this.');
    process.exit(1);
  }

  console.log(`🔑 Authenticating${DRY_RUN ? ' (DRY_RUN — no real orders will be placed)' : ''}...`);
  const trader = new PolymarketTrader(privateKey);
  trader.setLogFn((line) => console.log('   ' + line));
  await trader.authenticate();

  const address = trader.depositWallet || trader.address;
  console.log(`🏦 Wallet: ${address}`);
  if (!trader.depositWallet) {
    console.log(`⚠️  WARNING: no depositWallet resolved — using your EOA (${address}) instead. Your real positions live at the deposit (proxy) wallet, NOT your EOA — if this script finds nothing below, this fallback is almost certainly why. Check why deriveDepositWalletAddress() failed before assuming you have no positions.`);
  }

  console.log(`📡 Fetching real open positions from ${DATA_API}/positions ...`);
  let positions;
  try {
    positions = await fetchPositionsWithRetry(address);
  } catch (e) {
    console.error(`❌ Could not fetch positions: ${describeOrderError(e)}`);
    process.exit(1);
  }

  if (ONLY_CONDITION_ID) positions = positions.filter(p => p.conditionId === ONLY_CONDITION_ID);
  if (ONLY_ASSET) positions = positions.filter(p => p.asset === ONLY_ASSET);

  if (!positions.length) {
    console.log('ℹ️  No open positions found for this wallet' + (ONLY_ASSET ? ` matching asset ${ONLY_ASSET}` : '') + '. Nothing to do.');
    return;
  }

  console.log(`\nFound ${positions.length} open position(s):\n`);
  for (const p of positions) {
    console.log(`  • ${p.title || p.slug || p.asset} — ${p.outcome} — size ${p.size} @ avg ${p.avgPrice} (cur ${p.curPrice ?? '—'}, value $${p.currentValue ?? '—'})`);
  }

  console.log(`\nPlacing TP orders at ${Math.round(TP_MULTIPLIER * 100)}% of each position's entry price (capped at ${TP_MAX_PRICE}):\n`);

  for (const p of positions) {
    const avgPrice = parseFloat(p.avgPrice);
    const size = parseFloat(p.size);
    if (!Number.isFinite(avgPrice) || avgPrice <= 0 || !Number.isFinite(size) || size <= 0) {
      console.log(`  ⏭️  Skipping ${p.title || p.asset} — missing/invalid avgPrice or size`);
      continue;
    }
    const tpPrice = Math.min(TP_MAX_PRICE, round2(avgPrice * TP_MULTIPLIER));

    if (DRY_RUN) {
      console.log(`  🧪 [DRY RUN] Would place: SELL ${size}sh of "${p.title || p.asset}" (${p.outcome}) @ ${tpPrice} (entry ${avgPrice})`);
      continue;
    }

    try {
      const order = await trader.placeGtcOrder(p.asset, 'SELL', tpPrice, size);
      console.log(`  ✅ Placed TP: SELL ${size}sh of "${p.title || p.asset}" (${p.outcome}) @ ${tpPrice} (entry ${avgPrice}) — order id ${order.id}`);
    } catch (e) {
      console.log(`  ❌ Failed to place TP for "${p.title || p.asset}" (${p.outcome}): ${describeOrderError(e)}`);
      console.log(`     asset (token id): ${p.asset}`);
      console.log(`     conditionId: ${p.conditionId}`);
      console.log(`     If this keeps failing, re-run with ONLY_ASSET=${p.asset} to isolate just this position and see the full error.`);
    }
  }

  console.log('\nDone. Check your Polymarket account\'s open orders to confirm these are resting correctly.');
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
