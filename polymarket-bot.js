'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET FIFA WORLD CUP CROSS-MARKET ARBITRAGE BOT
 *  Strategy: Cross-Market Implied Probability Arbitrage
 * ═══════════════════════════════════════════════════════════════
 *
 *  CONCEPT:
 *  Targets a single live FIFA World Cup match and scans ALL its
 *  sub-markets simultaneously. It detects pricing inconsistencies
 *  between logically linked markets and trades the mispriced side.
 *
 *  ARBITRAGE LOGIC (examples from Germany vs Paraguay):
 *
 *  1. TOTAL GOALS LADDER ARBS
 *     Over 2.5 implies a price for Over 3.5 (must be ≤ Over 2.5).
 *     If Over 3.5 > Over 2.5 → Over 3.5 is mispriced HIGH → buy Under 3.5
 *     If Over 2.5 < Over 1.5 → Over 2.5 is mispriced LOW → buy Over 2.5
 *
 *  2. TEAM TOTAL vs MATCH TOTAL ARBS
 *     P(Match Over 2.5) ≥ P(Germany Over 2.5) since match includes both teams.
 *     When this breaks, buy the underpriced side.
 *
 *  3. BOTH TEAMS TO SCORE vs TEAM TOTALS
 *     P(BTTS Yes) ≤ P(GER scores) and P(BTTS Yes) ≤ P(PAR scores)
 *     BTTS requires BOTH teams to score — can never exceed either team's individual
 *     scoring probability. Trade the discrepancy.
 *
 *  4. HALFTIME vs FULLTIME
 *     P(HT GER lead) vs P(FT GER win) relationship.
 *     Large mismatches indicate mispricing.
 *
 *  5. FIRST HALF TOTALS vs MATCH TOTALS
 *     P(Match Over N) ≥ P(H1 Over N) — full game easier to hit.
 *
 *  6. SPREADS vs MONEYLINE
 *     GER -1.5 (win by 2+) must be ≤ GER ML (win by any margin).
 *
 *  7. CORNERS LADDER
 *     Same monotonicity rule as goals ladder for corner markets.
 *
 *  HOW SUB-MARKETS ARE FETCHED:
 *  Uses Gamma API /events?slug= endpoint which returns the parent
 *  event with ALL nested markets[] in a single call.
 *  Slug comes from the Polymarket URL path:
 *    /sports/world-cup/fifwc-ger-par-2026-06-29
 *    → MATCH_EVENT_SLUG = 'fifwc-ger-par-2026-06-29'
 *
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Target match slug — change via env or edit here ──
const MATCH_EVENT_SLUG = process.env.MATCH_SLUG || 'fifwc-ger-par-2026-06-29';

// ── Timing ──
const SCAN_EVERY_MS      = 15_000;
const TICK_MS            = 500;
const HARD_EXIT_MINS     = 5;
const MARKET_REFETCH_MS  = 300_000; // Re-fetch market list every 5 min

// ── Strategy ──
const MIN_EDGE         = 0.03;   // Minimum price discrepancy to trigger (3¢)
const SHARES_PER_ARB   = 10;     // Shares per arb leg
const MIN_LIQUIDITY    = 15;     // Min $ liquidity required
const MAX_POSITIONS    = 8;      // Max concurrent open arb positions
const STOP_LOSS_MULT   = 2;      // Stop loss at MIN_EDGE * this multiplier
const TIME_EXIT_SECS   = 600;    // Force exit after 10 minutes

// ── Env ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// ── State ──
let emitFn        = () => {};
let slog          = () => {};
let trader        = null;
let startBalance  = 500;
let startTime     = Date.now();
let lastScanAt    = 0;
let lastMarketFetch = 0;
let logs          = [];
let trades        = [];
let openPositions = new Map();
let realizedPnl   = 0;
let allMarkets    = [];
let priceCache    = new Map();
let matchEndTime  = null;
let arbRules      = [];

// ─────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  slog(line);
}

// ─────────────────────────────────────────
//  HTTP helper
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  STEP 1: Fetch all sub-markets for the match
//  Gamma /events?slug= returns parent event + all nested markets[]
// ─────────────────────────────────────────
async function fetchMatchMarkets() {
  log(`🔭 Fetching sub-markets: ${MATCH_EVENT_SLUG}`);
  try {
    const data = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(MATCH_EVENT_SLUG)}&limit=1`);
    const arr = Array.isArray(data) ? data : (data.data || data.events || [data]);
    if (!arr || arr.length === 0) {
      log(`❌ No event found for slug. Trying markets fallback...`);
      return await fetchMarketsViaMarketEndpoint();
    }
    const event = arr[0];
    const markets = event.markets || event.sub_markets || [];
    allMarkets = markets.filter(m => m.active !== false && !m.closed);

    // Capture match end time from event or latest market
    if (!matchEndTime && event.endDate) {
      matchEndTime = new Date(event.endDate).getTime();
    }
    if (!matchEndTime && allMarkets.length > 0) {
      const ends = allMarkets
        .map(m => new Date(m.endDate || m.endDateIso || 0).getTime())
        .filter(Boolean);
      if (ends.length) matchEndTime = Math.max(...ends);
    }

    log(`✅ ${allMarkets.length} active sub-markets loaded (event: ${event.title || event.slug})`);
    if (matchEndTime) log(`⏰ Match ends: ${new Date(matchEndTime).toISOString()}`);
    buildArbRules();
  } catch(e) {
    log(`⚠️  Event fetch error: ${e.message} — trying markets fallback`);
    await fetchMarketsViaMarketEndpoint();
  }
}

// Fallback: search markets directly by event_slug or tag
async function fetchMarketsViaMarketEndpoint() {
  try {
    const urls = [
      `${GAMMA}/markets?event_slug=${encodeURIComponent(MATCH_EVENT_SLUG)}&closed=false&limit=200`,
      `${GAMMA}/markets?tag_slug=${encodeURIComponent(MATCH_EVENT_SLUG)}&closed=false&limit=200`,
    ];
    let found = [];
    for (const url of urls) {
      try {
        const r = await getJSON(url);
        const arr = Array.isArray(r) ? r : (r.data || r.markets || []);
        found = found.concat(arr);
      } catch(_) {}
    }
    const seen = new Set();
    allMarkets = found.filter(m => {
      if (seen.has(m.id) || m.closed || m.active === false) return false;
      seen.add(m.id);
      return true;
    });
    log(`✅ Fallback: ${allMarkets.length} markets`);
    buildArbRules();
  } catch(e) {
    log(`❌ fetchMarketsViaMarketEndpoint: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  STEP 2: Parse markets into categories and build arb rules
// ─────────────────────────────────────────
function qOf(m) {
  return (m.question || m.groupItemTitle || m.title || '').toLowerCase();
}

function tokensOf(m) {
  return m.tokens || m.outcomes || [];
}

function buildArbRules() {
  arbRules = [];
  if (allMarkets.length === 0) return;

  // ── Categorize ──
  const totalsOver  = [];  // full-match total goals Over N
  const htTotals    = [];  // first half total goals Over N
  const h2Totals    = [];  // second half total goals Over N
  const gerTotals   = [];  // germany team total goals Over N
  const parTotals   = [];  // paraguay team total goals Over N
  const corners     = [];  // total corners Over N
  const gerCorners  = [];  // germany corners Over N
  const parCorners  = [];  // paraguay corners Over N
  let   btts        = null;
  let   bttsHT      = null;
  const spreads     = [];
  let   mlGer       = null;
  let   mlPar       = null;
  let   mlDraw      = null;
  let   htGer       = null;  // halftime result GER wins
  let   advanceGer  = null;  // GER to advance

  for (const m of allMarkets) {
    const q = qOf(m);
    const t = tokensOf(m);

    // Skip player props
    if (/goals\s*:\s*\d|assists|shots|cards|yellow|red/.test(q)) continue;

    const isFirstHalf  = q.includes('first half') || q.includes('1st half') || (q.includes('halftime') && !q.includes('second'));
    const isSecondHalf = q.includes('second half') || q.includes('2nd half');
    const isCorner     = q.includes('corner');
    const isGer        = q.includes('germany') || (q.includes('ger') && !q.includes('overall'));
    const isPar        = q.includes('paraguay') || q.includes('par ') || q.match(/\bpar\b/);

    // Over lines
    const overMatch = q.match(/over\s+([\d.]+)/i);
    const line = overMatch ? parseFloat(overMatch[1]) : null;

    if (q.includes('both') && q.includes('score')) {
      if (isFirstHalf) bttsHT = { m, t };
      else btts = { m, t };
      continue;
    }

    if (isCorner && line !== null) {
      if (isGer) gerCorners.push({ m, t, line });
      else if (isPar) parCorners.push({ m, t, line });
      else corners.push({ m, t, line });
      continue;
    }

    if (line !== null && !q.includes('shot') && !q.includes('assist')) {
      if (isFirstHalf) htTotals.push({ m, t, line });
      else if (isSecondHalf) h2Totals.push({ m, t, line });
      else if (isGer) gerTotals.push({ m, t, line });
      else if (isPar) parTotals.push({ m, t, line });
      else if (!q.includes('spread') && !q.match(/[+-]\d+\.5/)) {
        totalsOver.push({ m, t, line });
      }
    }

    // Spreads
    if (q.match(/[+-]\d+\.5/)) spreads.push({ m, t, q });

    // Moneyline / winner
    if ((q.includes('winner') || q.includes('moneyline') || (q.includes('win') && !q.includes('winning score')))
        && !isCorner && !line && !q.match(/[+-]\d+\.5/)) {
      if (q.includes('draw')) mlDraw = { m, t };
      else if (isGer) mlGer = { m, t };
      else if (isPar) mlPar = { m, t };
    }

    // Halftime result / HT winner
    if ((q.includes('halftime result') || q.includes('half time result') || q.includes('ht result'))
        && !isSecondHalf) {
      if (isGer) htGer = { m, t };
    }

    // Team to advance
    if (q.includes('advance') || q.includes('team to advance')) {
      if (isGer) advanceGer = { m, t };
    }
  }

  log(`📊 Parsed: ${totalsOver.length} total-overs, ${gerTotals.length} GER-totals, ${parTotals.length} PAR-totals, ${htTotals.length} H1, ${h2Totals.length} H2, ${corners.length} corners, btts=${!!btts}, mlGer=${!!mlGer}`);

  // ── Helper: sort by line ──
  const byLine = arr => [...arr].sort((a, b) => a.line - b.line);

  // ── Rule factory ──
  function ladderRule(type, label, lower, upper) {
    return {
      type, label,
      check: (prices) => {
        const lP = yesPrice(lower, prices);
        const uP = yesPrice(upper, prices);
        if (lP === null || uP === null) return null;
        if (yesLiq(lower, prices) < MIN_LIQUIDITY) return null;
        if (yesLiq(upper, prices) < MIN_LIQUIDITY) return null;
        if (uP > lP + MIN_EDGE) {
          // Upper line priced higher than lower — buy lower (it's cheaper, should be more likely)
          return { mktObj: lower, side: 'yes', edge: uP - lP,
            reason: `Over${lower.line}(${lP.toFixed(3)}) < Over${upper.line}(${uP.toFixed(3)}) — ladder violation` };
        }
        return null;
      },
    };
  }

  // 1. Full-match total goals ladder
  const st = byLine(totalsOver);
  for (let i = 0; i < st.length - 1; i++) ladderRule('LADDER_TOTAL', `Total: Over${st[i].line} ≥ Over${st[i+1].line}`, st[i], st[i+1]) && arbRules.push(ladderRule('LADDER_TOTAL', `Total: Over${st[i].line} ≥ Over${st[i+1].line}`, st[i], st[i+1]));

  // 2. Germany totals ladder
  const sg = byLine(gerTotals);
  for (let i = 0; i < sg.length - 1; i++) arbRules.push(ladderRule('LADDER_GER', `GER: Over${sg[i].line} ≥ Over${sg[i+1].line}`, sg[i], sg[i+1]));

  // 3. Paraguay totals ladder
  const sp = byLine(parTotals);
  for (let i = 0; i < sp.length - 1; i++) arbRules.push(ladderRule('LADDER_PAR', `PAR: Over${sp[i].line} ≥ Over${sp[i+1].line}`, sp[i], sp[i+1]));

  // 4. Corners ladder
  const sc = byLine(corners);
  for (let i = 0; i < sc.length - 1; i++) arbRules.push(ladderRule('LADDER_CORNERS', `Corners: Over${sc[i].line} ≥ Over${sc[i+1].line}`, sc[i], sc[i+1]));

  // 5. HT totals ladder
  const sh = byLine(htTotals);
  for (let i = 0; i < sh.length - 1; i++) arbRules.push(ladderRule('LADDER_HT', `H1: Over${sh[i].line} ≥ Over${sh[i+1].line}`, sh[i], sh[i+1]));

  // 6. H2 totals ladder
  const s2 = byLine(h2Totals);
  for (let i = 0; i < s2.length - 1; i++) arbRules.push(ladderRule('LADDER_H2', `H2: Over${s2[i].line} ≥ Over${s2[i+1].line}`, s2[i], s2[i+1]));

  // 7. Match total ≥ GER total (same line)
  const totalByLine = new Map(st.map(x => [x.line, x]));
  for (const g of gerTotals) {
    const matchMkt = totalByLine.get(g.line);
    if (!matchMkt) continue;
    arbRules.push({
      type: 'TEAM_VS_MATCH_GER',
      label: `Match Over${g.line} ≥ GER Over${g.line}`,
      check: (prices) => {
        const gP = yesPrice(g, prices);
        const mP = yesPrice(matchMkt, prices);
        if (gP === null || mP === null) return null;
        if (yesLiq(g, prices) < MIN_LIQUIDITY) return null;
        if (yesLiq(matchMkt, prices) < MIN_LIQUIDITY) return null;
        if (gP > mP + MIN_EDGE) {
          return { mktObj: matchMkt, side: 'yes', edge: gP - mP,
            reason: `GER Over${g.line}(${gP.toFixed(3)}) > Match Over${g.line}(${mP.toFixed(3)}) — buy match total` };
        }
        return null;
      },
    });
  }

  // 8. Match total ≥ PAR total (same line)
  for (const p of parTotals) {
    const matchMkt = totalByLine.get(p.line);
    if (!matchMkt) continue;
    arbRules.push({
      type: 'TEAM_VS_MATCH_PAR',
      label: `Match Over${p.line} ≥ PAR Over${p.line}`,
      check: (prices) => {
        const pP = yesPrice(p, prices);
        const mP = yesPrice(matchMkt, prices);
        if (pP === null || mP === null) return null;
        if (yesLiq(p, prices) < MIN_LIQUIDITY) return null;
        if (yesLiq(matchMkt, prices) < MIN_LIQUIDITY) return null;
        if (pP > mP + MIN_EDGE) {
          return { mktObj: matchMkt, side: 'yes', edge: pP - mP,
            reason: `PAR Over${p.line}(${pP.toFixed(3)}) > Match Over${p.line}(${mP.toFixed(3)}) — buy match total` };
        }
        return null;
      },
    });
  }

  // 9. BTTS ≤ GER Over 0.5 and BTTS ≤ PAR Over 0.5
  if (btts) {
    const ger05 = gerTotals.find(x => x.line === 0.5);
    if (ger05) arbRules.push({
      type: 'BTTS_VS_GER05',
      label: 'BTTS ≤ GER Over 0.5',
      check: (prices) => {
        const bP = yesPrice(btts, prices);
        const gP = yesPrice(ger05, prices);
        if (bP === null || gP === null) return null;
        if (yesLiq(btts, prices) < MIN_LIQUIDITY) return null;
        if (yesLiq(ger05, prices) < MIN_LIQUIDITY) return null;
        if (bP > gP + MIN_EDGE) {
          return { mktObj: ger05, side: 'yes', edge: bP - gP,
            reason: `BTTS(${bP.toFixed(3)}) > GER Over0.5(${gP.toFixed(3)}) — buy GER to score` };
        }
        return null;
      },
    });

    const par05 = parTotals.find(x => x.line === 0.5);
    if (par05) arbRules.push({
      type: 'BTTS_VS_PAR05',
      label: 'BTTS ≤ PAR Over 0.5',
      check: (prices) => {
        const bP = yesPrice(btts, prices);
        const pP = yesPrice(par05, prices);
        if (bP === null || pP === null) return null;
        if (yesLiq(btts, prices) < MIN_LIQUIDITY) return null;
        if (yesLiq(par05, prices) < MIN_LIQUIDITY) return null;
        if (bP > pP + MIN_EDGE) {
          return { mktObj: par05, side: 'yes', edge: bP - pP,
            reason: `BTTS(${bP.toFixed(3)}) > PAR Over0.5(${pP.toFixed(3)}) — buy PAR to score` };
        }
        return null;
      },
    });
  }

  // 10. GER ML ≥ GER -1.5 spread
  if (mlGer) {
    const gerMinus15 = spreads.find(s => s.q.includes('germany') && s.q.includes('-1.5'));
    if (gerMinus15) arbRules.push({
      type: 'SPREAD_VS_ML_GER',
      label: 'GER ML ≥ GER -1.5',
      check: (prices) => {
        const mlP  = yesPrice(mlGer, prices);
        const spdP = yesPrice(gerMinus15, prices);
        if (mlP === null || spdP === null) return null;
        if (yesLiq(mlGer, prices) < MIN_LIQUIDITY) return null;
        if (yesLiq(gerMinus15, prices) < MIN_LIQUIDITY) return null;
        if (spdP > mlP + MIN_EDGE) {
          return { mktObj: mlGer, side: 'yes', edge: spdP - mlP,
            reason: `GER -1.5(${spdP.toFixed(3)}) > GER ML(${mlP.toFixed(3)}) — buy GER ML` };
        }
        return null;
      },
    });
  }

  // 11. HT result vs FT moneyline
  if (htGer && mlGer) arbRules.push({
    type: 'HT_VS_FT_GER',
    label: 'FT GER ML vs HT GER lead',
    check: (prices) => {
      const htP = yesPrice(htGer, prices);
      const ftP = yesPrice(mlGer, prices);
      if (htP === null || ftP === null) return null;
      if (yesLiq(htGer, prices) < MIN_LIQUIDITY) return null;
      if (yesLiq(mlGer, prices) < MIN_LIQUIDITY) return null;
      // HT GER lead price >> FT GER win price is unusual — could mean FT is cheap
      if (htP > ftP + MIN_EDGE * 1.5) {
        return { mktObj: mlGer, side: 'yes', edge: htP - ftP,
          reason: `HT GER(${htP.toFixed(3)}) >> FT GER(${ftP.toFixed(3)}) — buy FT GER ML` };
      }
      return null;
    },
  });

  // 12. H1 total ≤ Match total (same line)
  for (const h of htTotals) {
    const matchMkt = totalByLine.get(h.line);
    if (!matchMkt) continue;
    arbRules.push({
      type: 'H1_VS_MATCH',
      label: `Match Over${h.line} ≥ H1 Over${h.line}`,
      check: (prices) => {
        const hP = yesPrice(h, prices);
        const mP = yesPrice(matchMkt, prices);
        if (hP === null || mP === null) return null;
        if (yesLiq(h, prices) < MIN_LIQUIDITY) return null;
        if (yesLiq(matchMkt, prices) < MIN_LIQUIDITY) return null;
        if (hP > mP + MIN_EDGE) {
          return { mktObj: matchMkt, side: 'yes', edge: hP - mP,
            reason: `H1 Over${h.line}(${hP.toFixed(3)}) > Match Over${h.line}(${mP.toFixed(3)}) — buy match total` };
        }
        return null;
      },
    });
  }

  // 13. GER advance ≥ GER ML (advance includes ET + pens, so it's easier)
  if (advanceGer && mlGer) arbRules.push({
    type: 'ADVANCE_VS_ML',
    label: 'GER Advance ≥ GER ML',
    check: (prices) => {
      const advP = yesPrice(advanceGer, prices);
      const mlP  = yesPrice(mlGer, prices);
      if (advP === null || mlP === null) return null;
      if (yesLiq(advanceGer, prices) < MIN_LIQUIDITY) return null;
      if (yesLiq(mlGer, prices) < MIN_LIQUIDITY) return null;
      // Advance must be >= ML (advance covers ET + pens = more paths to win)
      if (mlP > advP + MIN_EDGE) {
        return { mktObj: advanceGer, side: 'yes', edge: mlP - advP,
          reason: `GER ML(${mlP.toFixed(3)}) > GER Advance(${advP.toFixed(3)}) — buy advance` };
      }
      return null;
    },
  });

  // 14. GER corners + PAR corners ladder
  const sgc = byLine(gerCorners);
  for (let i = 0; i < sgc.length - 1; i++) arbRules.push(ladderRule('LADDER_GER_CORNERS', `GER Corners: Over${sgc[i].line} ≥ Over${sgc[i+1].line}`, sgc[i], sgc[i+1]));
  const spc = byLine(parCorners);
  for (let i = 0; i < spc.length - 1; i++) arbRules.push(ladderRule('LADDER_PAR_CORNERS', `PAR Corners: Over${spc[i].line} ≥ Over${spc[i+1].line}`, spc[i], spc[i+1]));

  log(`🎯 ${arbRules.length} arbitrage rules built`);
}

// ─────────────────────────────────────────
//  Price helpers
// ─────────────────────────────────────────
function yesToken(mktObj) {
  const tokens = mktObj.t || tokensOf(mktObj.m || mktObj);
  return tokens.find(t => (t.outcome || t.side || '').toLowerCase() === 'yes');
}

function yesTokenId(mktObj) {
  return yesToken(mktObj)?.token_id || yesToken(mktObj)?.id || null;
}

function yesPrice(mktObj, prices) {
  const tid = yesTokenId(mktObj);
  if (!tid) return null;
  const cached = prices.get(tid);
  if (cached) return cached.mid;
  // Fallback: inline price on token
  const tok = yesToken(mktObj);
  const p = parseFloat(tok?.price || 0);
  return p > 0 ? p : null;
}

function yesLiq(mktObj, prices) {
  const tid = yesTokenId(mktObj);
  if (!tid) return 0;
  return prices.get(tid)?.liq || 0;
}

// ─────────────────────────────────────────
//  STEP 3: Refresh live prices from CLOB
// ─────────────────────────────────────────
async function refreshPrices() {
  if (allMarkets.length === 0) return;
  const tokenIds = [];
  for (const m of allMarkets) {
    for (const t of tokensOf(m)) {
      const tid = t.token_id || t.id;
      if (tid) tokenIds.push(tid);
    }
  }
  if (tokenIds.length === 0) return;

  const newPrices = new Map();
  const batchSize = 25;

  // Try CLOB /prices (batch POST)
  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, i + batchSize);
    try {
      const data = await postJSON(`${CLOB}/prices`, { token_ids: batch });
      const arr = Array.isArray(data) ? data : Object.values(data);
      for (const item of arr) {
        const tid = item.token_id || item.asset_id || item.tokenId;
        const p = parseFloat(item.price || item.mid || 0);
        if (tid && p > 0) newPrices.set(tid, { mid: p, liq: parseFloat(item.liquidity || 0) || 50 });
      }
    } catch(_) {
      // Batch failed — try individual midpoint endpoints
      for (const tid of batch) {
        try {
          const d = await getJSON(`${CLOB}/midpoint?token_id=${tid}`);
          const p = parseFloat(d.mid || d.price || 0);
          if (p > 0) newPrices.set(tid, { mid: p, liq: 50 });
        } catch(_2) {}
      }
    }
  }

  // Fill gaps with inline token prices from market data
  for (const m of allMarkets) {
    for (const t of tokensOf(m)) {
      const tid = t.token_id || t.id;
      if (!tid || newPrices.has(tid)) continue;
      const p = parseFloat(t.price || 0);
      if (p > 0) newPrices.set(tid, { mid: p, liq: parseFloat(t.liquidity || 0) || 0 });
    }
  }

  if (newPrices.size > 0) {
    priceCache = newPrices;
    log(`💹 Prices: ${newPrices.size} tokens refreshed`);
  }
}

// ─────────────────────────────────────────
//  STEP 4: Scan arb rules and trade
// ─────────────────────────────────────────
async function scanArbs() {
  if (arbRules.length === 0) { log('⏳ No arb rules yet'); return; }
  if (priceCache.size === 0)  { log('⏳ Price cache empty'); return; }

  // Hard exit check
  if (matchEndTime) {
    const minsLeft = (matchEndTime - Date.now()) / 60000;
    if (minsLeft < HARD_EXIT_MINS && openPositions.size > 0) {
      log(`⏰ ${minsLeft.toFixed(1)}m to end — closing all positions`);
      await closeAllPositions('HARD_EXIT');
      return;
    }
  }

  let arbs = 0;
  for (const rule of arbRules) {
    const key = `${rule.type}::${rule.label}`;

    // Check exit for existing positions
    if (openPositions.has(key)) {
      await maybeExit(key);
      continue;
    }

    if (openPositions.size >= MAX_POSITIONS) continue;

    const signal = rule.check(priceCache);
    if (!signal) continue;

    log(`✨ ARB [${rule.type}] ${rule.label} | edge=${signal.edge.toFixed(4)} | ${signal.reason}`);
    await enterArb(key, rule, signal);
    arbs++;
  }

  if (arbs === 0 && priceCache.size > 0) {
    log(`🔍 ${arbRules.length} rules checked — no arbs above ¢${(MIN_EDGE * 100).toFixed(0)} threshold`);
  }
}

async function enterArb(key, rule, signal) {
  try {
    const tid = yesTokenId(signal.mktObj);
    if (!tid) { log(`❌ No token ID for ${rule.label}`); return; }
    const cached = priceCache.get(tid);
    const price = cached?.mid;
    if (!price) { log(`❌ No price for ${tid}`); return; }

    const cost = price * SHARES_PER_ARB;
    log(`📥 ENTER ${rule.type} | ${rule.label} | YES @ ${price.toFixed(4)} | ${SHARES_PER_ARB}sh | $${cost.toFixed(2)}`);

    if (!DRY_RUN && trader) {
      await trader.marketBuy(tid, SHARES_PER_ARB, price * 1.02);
    } else {
      log(`[DRY] BUY ${SHARES_PER_ARB}sh ${tid} @ ${price.toFixed(4)}`);
    }

    openPositions.set(key, {
      rule, signal, tid,
      shares: SHARES_PER_ARB,
      avgCost: price,
      entryEdge: signal.edge,
      enteredAt: Date.now(),
      label: rule.label,
      type: rule.type,
    });

    trades.push({
      time: new Date().toISOString().slice(11,19),
      label: rule.label,
      type: rule.type,
      side: 'YES',
      shares: SHARES_PER_ARB,
      price,
      cost,
      edge: signal.edge,
    });
    if (trades.length > 100) trades.shift();
  } catch(e) {
    log(`❌ enterArb: ${e.message}`);
  }
}

async function maybeExit(key) {
  const pos = openPositions.get(key);
  if (!pos) return;
  const cur = priceCache.get(pos.tid)?.mid;
  if (!cur) return;
  const pnl = (cur - pos.avgCost) * pos.shares;
  const secsOpen = (Date.now() - pos.enteredAt) / 1000;
  const takeProfit = cur > pos.avgCost + MIN_EDGE;
  const stopLoss   = cur < pos.avgCost - MIN_EDGE * STOP_LOSS_MULT;
  const timeExit   = secsOpen > TIME_EXIT_SECS;
  if (!takeProfit && !stopLoss && !timeExit) return;
  const reason = takeProfit ? 'TAKE_PROFIT' : stopLoss ? 'STOP_LOSS' : 'TIME_EXIT';
  log(`${takeProfit ? '💰' : '📉'} EXIT [${reason}] ${pos.label} | in=${pos.avgCost.toFixed(4)} cur=${cur.toFixed(4)} pnl=$${pnl.toFixed(2)}`);
  if (!DRY_RUN && trader) {
    try { await trader.marketSell(pos.tid, pos.shares, cur * 0.98); } catch(e) { log(`⚠️  Exit err: ${e.message}`); }
  } else {
    log(`[DRY] SELL ${pos.shares}sh @ ${cur.toFixed(4)} | PnL: $${pnl.toFixed(2)}`);
  }
  realizedPnl += pnl;
  openPositions.delete(key);
}

async function closeAllPositions(reason) {
  for (const [key, pos] of openPositions) {
    const cur = priceCache.get(pos.tid)?.mid || pos.avgCost;
    const pnl = (cur - pos.avgCost) * pos.shares;
    log(`🔒 ${reason} | ${pos.label} | pnl=$${pnl.toFixed(2)}`);
    if (!DRY_RUN && trader) {
      try { await trader.marketSell(pos.tid, pos.shares, cur * 0.98); } catch(e) {}
    } else {
      log(`[DRY] Close ${pos.shares}sh @ ${cur.toFixed(4)} | PnL: $${pnl.toFixed(2)}`);
    }
    realizedPnl += pnl;
    openPositions.delete(key);
  }
}

// ─────────────────────────────────────────
//  UI State
// ─────────────────────────────────────────
function buildState(balance) {
  const unrealized = [...openPositions.values()].reduce((sum, pos) => {
    const cur = priceCache.get(pos.tid)?.mid || pos.avgCost;
    return sum + (cur - pos.avgCost) * pos.shares;
  }, 0);
  return {
    dryRun: DRY_RUN,
    capital: balance,
    pnl: balance - startBalance + realizedPnl,
    realizedPnl,
    unrealized,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastScanAgo: Math.floor((Date.now() - lastScanAt) / 1000),
    eventSlug: MATCH_EVENT_SLUG,
    totalMarkets: allMarkets.length,
    arbRules: arbRules.length,
    pricesTracked: priceCache.size,
    matchEndTime: matchEndTime ? new Date(matchEndTime).toISOString() : null,
    minsToEnd: matchEndTime ? ((matchEndTime - Date.now()) / 60000).toFixed(1) : null,
    positions: [...openPositions.values()].map(pos => {
      const cur = priceCache.get(pos.tid)?.mid || pos.avgCost;
      return {
        label: pos.label,
        type: pos.type,
        shares: pos.shares,
        entry: pos.avgCost,
        current: cur,
        pnl: (cur - pos.avgCost) * pos.shares,
        secsOpen: Math.floor((Date.now() - pos.enteredAt) / 1000),
        edge: pos.entryEdge,
      };
    }),
    activeCount: openPositions.size,
    logs: logs.slice(-60),
    trades: trades.slice(-50),
  };
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
async function mainLoop() {
  let balance = startBalance;
  let tick = 0;
  while (true) {
    try {
      const now = Date.now();

      // Re-fetch markets every MARKET_REFETCH_MS
      if (now - lastMarketFetch > MARKET_REFETCH_MS) {
        await fetchMatchMarkets();
        lastMarketFetch = now;
      }

      // Refresh prices + scan arbs on interval
      if (now - lastScanAt > SCAN_EVERY_MS) {
        await refreshPrices();
        await scanArbs();
        lastScanAt = now;
      }

      if (trader && !DRY_RUN) {
        try { balance = await trader.getBalance(); } catch(_) {}
      }

      emitFn('state', buildState(balance));
    } catch(e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, TICK_MS));
    tick++;
  }
}

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog   = slogFn;
  log(`🚀 FIFA Cross-Market Arb Bot`);
  log(`🎯 Match: ${MATCH_EVENT_SLUG}`);
  log(`⚙️  Edge: ¢${(MIN_EDGE*100).toFixed(0)} | ${SHARES_PER_ARB}sh/arb | max ${MAX_POSITIONS} positions`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — $500 demo balance' : '🔴 LIVE MODE'}`);

  if (!DRY_RUN) {
    trader = new PolymarketTrader(privateKey);
    await trader.init();
    startBalance = await trader.getBalance();
  }

  log(`💰 Balance: $${startBalance.toFixed(2)}`);
  await fetchMatchMarkets();
  lastMarketFetch = Date.now();
  await refreshPrices();
  lastScanAt = Date.now();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init };
