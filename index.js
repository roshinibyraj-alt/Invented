'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const updown5mBot = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

// ── BTC+ETH gap-monitoring engine API (single automatic engine, no manual match management) ──
app.get('/api/btc5m/status', (_, res) => {
  try { res.json(updown5mBot.buildState()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/btc5m/pause', (_, res) => {
  try { res.json(updown5mBot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/btc5m/resume', (_, res) => {
  try { res.json(updown5mBot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/btc5m/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(updown5mBot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪙 BTC/ETH Gap Bot</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --purple: #7c3aed; --gold: #b8860b;
    --eth: #7c6cf0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#f0f4f8,#e4ecf5); border-bottom: 2px solid #0099cc44; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 20px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
  .logo span { color: var(--cyan); }
  .logo span.eth { color: var(--eth); }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #ff475722; color: var(--red); border: 1px solid var(--red); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--cyan); color: #001018; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button.live-toggle { background: var(--red); color: #fff; }
  .toolbar button.live-toggle.is-live { background: var(--muted); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .toolbar-status { padding: 6px 20px 0; font-size: 10px; color: var(--muted); min-height: 14px; }
  .boundary-banner { margin: 10px 20px 0; padding: 10px 14px; background: #e6a80022; border: 1px solid var(--yellow); border-radius: 8px; font-size: 10.5px; color: #7a5c00; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 10px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 17px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .window-meta { margin: 0 20px 10px; font-size: 10px; color: var(--muted); }
  .assets-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 20px 16px; }
  @media (max-width: 700px) { .assets-grid { grid-template-columns: 1fr; } }
  .asset-card { background: var(--bg2); border: 2px solid var(--cyan); border-radius: 12px; overflow: hidden; }
  .asset-card.eth { border-color: var(--eth); }
  .asset-hdr { background: #0d1d30; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
  .asset-title { font-size: 13px; font-weight: bold; color: #ddd; }
  .asset-status { font-size: 9px; padding: 3px 9px; border-radius: 10px; text-transform: uppercase; }
  .st-discovering { background: #e6a80022; color: var(--yellow); border: 1px solid var(--yellow); }
  .st-trading { background: #00a85422; color: var(--green); border: 1px solid var(--green); }
  .st-resolved { background: #7a8fa822; color: var(--muted); border: 1px solid var(--muted); }
  .asset-body { padding: 10px 14px; }
  .price-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
  .price-box { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; text-align: center; }
  .price-box .side-label { font-size: 9px; color: var(--muted); text-transform: uppercase; }
  .price-box .side-price { font-size: 15px; margin: 2px 0; }
  .price-box.up .side-price { color: var(--green); }
  .price-box.down .side-price { color: var(--red); }
  .price-box .side-sub { font-size: 9px; color: var(--muted); }
  .pos-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pos-box { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; font-size: 9.5px; }
  .pos-box .pos-label { color: var(--muted); font-size: 9px; text-transform: uppercase; margin-bottom: 4px; }
  .asset-unrl { margin-top: 8px; font-size: 10px; text-align: right; }
  .entries-wrap { margin: 0 20px 16px; }
  .entry-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .entry-card { flex: 1; min-width: 200px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 10px; }
  .entry-card.armed { border-color: var(--green); background: #00a85411; }
  .entry-card.locked { border-color: var(--muted); background: #7a8fa811; }
  .entry-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .entry-tag { color: var(--text); font-weight: bold; font-size: 11px; }
  .entry-badge { font-size: 9px; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
  .entry-badge.armed { background: #00a85422; color: var(--green); border: 1px solid var(--green); }
  .entry-badge.locked { background: #7a8fa822; color: var(--muted); border: 1px solid var(--muted); }
  .entry-badge.locked-bought { background: #7a8fa822; color: var(--gold); border: 1px solid var(--gold); }
  .entry-detail { color: var(--muted); }
  .entry-detail .bought { color: var(--green); font-weight: bold; }
  .bottom-grid { display: grid; grid-template-columns: 1fr; gap: 16px; padding: 0 20px 20px; }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 10px; }
  .log-panel { background: #0d1420; color: #cfe8ff; border-radius: 10px; padding: 10px 12px; max-height: 220px; overflow-y: auto; font-size: 9.5px; margin: 0 20px 20px; }
  .log-panel div { padding: 1px 0; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🪙 <span>BTC</span>/<span class="eth">ETH</span> GAP BOT</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">⏸️ Pause Trading</button>
    <button id="resume-btn" class="resume">▶️ Resume Trading</button>
    <button id="live-btn" class="live-toggle">🔴 Switch to LIVE</button>
  </div>
  <div class="toolbar-status" id="toolbar-status"></div>
  <div id="boundary-banner" style="display:none;" class="boundary-banner"></div>

  <div class="stats-row" id="stats-row"></div>

  <div class="section">
    <div class="section-hdr">Current Window</div>
  </div>
  <div class="window-meta" id="window-meta"></div>
  <div class="assets-grid" id="assets-grid"><div class="empty">Loading…</div></div>

  <div class="section">
    <div class="section-hdr">Window Entry Status (either leg &gt; 0.70 → buy the cheaper leg · no combined-price requirement · first side to fire locks, other side stays open)</div>
  </div>
  <div class="entries-wrap" id="entries-wrap"><div class="empty">Loading…</div></div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr" style="padding:0 0 8px;">Window History</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Asset</th><th>Window</th><th>Winner</th><th>Up sh/cost</th><th>Down sh/cost</th><th>Payout</th><th>Fees</th><th>P&amp;L</th><th>Resolved via</th></tr></thead>
          <tbody id="history-body"><tr><td colspan="9" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr" style="padding:0 0 8px;">Recent Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Asset</th><th>Window</th><th>Step</th><th>Side</th><th>Price</th><th>Shares</th><th>Cost/Fee</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="section-hdr" style="margin:0 20px;">Live Log</div>
  <div class="log-panel" id="log-panel"><div class="empty">Loading…</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const $ = id => document.getElementById(id);

  $('pause-btn').onclick = () => fetch('/api/btc5m/pause', { method: 'POST' }).then(() => flash('Trading paused'));
  $('resume-btn').onclick = () => fetch('/api/btc5m/resume', { method: 'POST' }).then(() => flash('Trading resumed'));
  $('live-btn').onclick = () => {
    const wantLive = !$('live-btn').classList.contains('is-live');
    if (wantLive && !confirm('Switch to LIVE mode? This will place REAL crossing-the-spread buys with REAL money whenever either leg of a BTC+ETH pair prices above 0.70, buying the cheaper leg (50 shares per pair per window — first side to fire locks, the other side stays open for one more entry). No combined-price requirement.')) return;
    fetch('/api/btc5m/set-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: wantLive }) })
      .then(() => flash(wantLive ? 'Switched to LIVE' : 'Switched to DEMO'));
  };
  function flash(msg) { $('toolbar-status').textContent = msg; setTimeout(() => { $('toolbar-status').textContent = ''; }, 3000); }

  function fmtPx(n) { return n == null ? '—' : n.toFixed(3); }
  function fmt2(n) { return (n == null ? 0 : n).toFixed(2); }
  function pClass(n) { return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }
  function sgn(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
  function mmss(sec) { sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec / 60); const s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }

  function renderStats(s) {
    const stats = [
      ['Equity (MTM)', '$' + fmt2(s.equity), ''],
      ['Bankroll (cash)', '$' + fmt2(s.bankroll), ''],
      ['Realized P&amp;L', sgn(s.realizedPnl), pClass(s.realizedPnl)],
      ['Unrealized P&amp;L', sgn(s.unrealizedPnl), pClass(s.unrealizedPnl)],
      ['Fees Paid', '$' + (s.feesPaid || 0).toFixed(4), ''],
      ['Wins / Losses', s.wins + ' / ' + s.losses, ''],
      ['Pending Resolution', s.pendingResolutionCount || 0, ''],
    ];
    $('stats-row').innerHTML = stats.map(([label, val, cls]) =>
      '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-val ' + cls + '">' + val + '</div></div>'
    ).join('');
  }

  function assetCard(a, cls) {
    if (!a) return '<div class="asset-card ' + cls + '"><div class="empty">No data</div></div>';
    const statusCls = a.status === 'trading' ? 'st-trading' : (a.status === 'resolved' ? 'st-resolved' : 'st-discovering');
    const priceRow =
      '<div class="price-row">' +
        '<div class="price-box up"><div class="side-label">Up</div><div class="side-price">' + fmtPx(a.upAsk) + '</div><div class="side-sub">bid ' + fmtPx(a.upBid) + '</div></div>' +
        '<div class="price-box down"><div class="side-label">Down</div><div class="side-price">' + fmtPx(a.downAsk) + '</div><div class="side-sub">bid ' + fmtPx(a.downBid) + '</div></div>' +
      '</div>';
    const posRow =
      '<div class="pos-row">' +
        '<div class="pos-box"><div class="pos-label">Up position</div>' + (a.positions.up.shares > 0 ? a.positions.up.shares.toFixed(2) + 'sh · $' + a.positions.up.cost.toFixed(2) + ' cost' : '—') + '</div>' +
        '<div class="pos-box"><div class="pos-label">Down position</div>' + (a.positions.down.shares > 0 ? a.positions.down.shares.toFixed(2) + 'sh · $' + a.positions.down.cost.toFixed(2) + ' cost' : '—') + '</div>' +
      '</div>';
    const unrl = '<div class="asset-unrl ' + pClass(a.unrealizedPnl) + '">Unrealized: ' + sgn(a.unrealizedPnl) + '</div>';
    return '<div class="asset-card ' + cls + '">' +
      '<div class="asset-hdr"><div class="asset-title">' + a.label + '</div><div class="asset-status ' + statusCls + '">' + a.status + '</div></div>' +
      '<div class="asset-body">' + priceRow + posRow + unrl + '</div>' +
    '</div>';
  }

  function entryTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : ''; }

  function renderWindow(s) {
    const w = s.window;
    if (!w) { $('assets-grid').innerHTML = '<div class="empty">No window yet…</div>'; $('window-meta').textContent = ''; $('entries-wrap').innerHTML = ''; return; }
    const remaining = s.windowSeconds - w.elapsedSec;
    $('window-meta').textContent = 'Window t=' + w.windowTs + ' · elapsed ' + mmss(w.elapsedSec) + ' / ' + mmss(s.windowSeconds) + ' · ' + mmss(remaining) + ' left';
    $('assets-grid').innerHTML = assetCard(w.assets.btc, '') + assetCard(w.assets.eth, 'eth');

    const entries = w.entries || { up: {}, down: {} };
    const entryCard = (pairName) => {
      const e = entries[pairName] || {};
      const isLocked = !!e.done;
      const cardCls = isLocked ? 'locked' : 'armed';
      let badgeCls, badgeLabel, detailHtml;
      if (isLocked && e.boughtAsset) {
        badgeCls = 'locked-bought'; badgeLabel = '🔒 LOCKED · BOUGHT';
        detailHtml = 'Bought <span class="bought">' + e.boughtAsset.toUpperCase() + '-' + pairName.toUpperCase() + '</span> at ' + entryTime(e.ts) +
          ' — one leg priced above 0.70 (sum was ' + (e.sum != null ? e.sum.toFixed(2) : '?') + ' at the time, for context)';
      } else if (isLocked) {
        badgeCls = 'locked'; badgeLabel = '🔒 LOCKED · SKIPPED';
        detailHtml = 'Condition hit but trading was paused at the time — no re-fire this window.';
      } else {
        badgeCls = 'armed'; badgeLabel = '🟢 ARMED';
        detailHtml = 'Watching continuously — will buy the cheaper leg the instant either leg prices above 0.70.';
      }
      return '<div class="entry-card ' + cardCls + '">' +
        '<div class="entry-head"><span class="entry-tag">' + pairName.toUpperCase() + '-pair</span><span class="entry-badge ' + badgeCls + '">' + badgeLabel + '</span></div>' +
        '<div class="entry-detail">' + detailHtml + '</div>' +
      '</div>';
    };
    $('entries-wrap').innerHTML = '<div class="entry-row">' + entryCard('up') + entryCard('down') + '</div>';
  }

  function renderHistory(list) {
    if (!list || !list.length) { $('history-body').innerHTML = '<tr><td colspan="9" class="empty">No resolved windows yet</td></tr>'; return; }
    $('history-body').innerHTML = list.map(h =>
      '<tr><td>' + (h.label || h.asset || '').toUpperCase() + '</td>' +
      '<td>' + h.slug.replace(/^(btc|eth)-updown-5m-/, '') + '</td>' +
      '<td>' + h.winningSide.toUpperCase() + '</td>' +
      '<td>' + h.upShares.toFixed(2) + ' / $' + h.upCost.toFixed(2) + '</td>' +
      '<td>' + h.downShares.toFixed(2) + ' / $' + h.downCost.toFixed(2) + '</td>' +
      '<td>$' + h.payout.toFixed(2) + '</td>' +
      '<td>$' + h.totalFees.toFixed(4) + '</td>' +
      '<td class="' + pClass(h.pnl) + '">' + sgn(h.pnl) + '</td>' +
      '<td>' + (h.resolutionMethod === 'price-fallback' ? '📡 live price' : '✅ official') + '</td></tr>'
    ).join('');
  }

  function renderTrades(list) {
    if (!list || !list.length) { $('trade-body').innerHTML = '<tr><td colspan="8" class="empty">No trades yet</td></tr>'; return; }
    $('trade-body').innerHTML = list.map(t =>
      '<tr><td>' + t.time + '</td>' +
      '<td>' + (t.asset || '').toUpperCase() + '</td>' +
      '<td>' + (t.slug || '').replace(/^(btc|eth)-updown-5m-/, '') + '</td>' +
      '<td>' + (t.step || '') + '</td>' +
      '<td>' + (t.side || '').toUpperCase() + '</td>' +
      '<td>' + (t.price != null ? t.price.toFixed(3) : '—') + '</td>' +
      '<td>' + (t.shares != null ? t.shares.toFixed(2) : '—') + '</td>' +
      '<td>' + (t.cost != null ? '$' + t.cost.toFixed(2) + (t.fee ? ' +$' + t.fee.toFixed(4) : '') : (t.pnl != null ? sgn(t.pnl) : '—')) + '</td></tr>'
    ).join('');
  }

  function renderLogs(list) {
    if (!list || !list.length) { $('log-panel').innerHTML = '<div class="empty">No logs yet</div>'; return; }
    $('log-panel').innerHTML = list.map(l => '<div>' + l.replace(/</g, '&lt;') + '</div>').join('');
  }

  socket.on('btc5mState', (s) => {
    $('mode-badge').className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    $('mode-badge').textContent = s.dryRun ? 'DEMO' : 'LIVE';
    $('live-btn').classList.toggle('is-live', !s.dryRun);
    $('live-btn').textContent = s.dryRun ? '🔴 Switch to LIVE' : '⚠️ Switch to DEMO';

    const banner = $('boundary-banner');
    if (s.waitingForBoundary) { banner.style.display = 'block'; banner.textContent = '⏳ Started mid-window — waiting for the next fresh 5-minute boundary before trading begins (no mid-window entries).'; }
    else banner.style.display = 'none';

    renderStats(s);
    renderWindow(s);
    renderHistory(s.history);
    renderTrades(s.trades);
    renderLogs(s.logs);
  });

</script>
</body>
</html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('🪙 BTC + ETH 5-Minute Gap-Monitoring Bot (continuous threshold trigger, fully automatic)');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  updown5mBot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
