'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const dipBot      = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

// ── BTC 5m price-dip engine API ──
app.get('/api/hedge/status', (_, res) => {
  try { res.json(dipBot.buildState()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (_, res) => {
  try { res.json(dipBot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/resume', (_, res) => {
  try { res.json(dipBot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(dipBot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪙 BTC 5m Dip Bot</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --purple: #7c3aed; --gold: #b8860b;
    --down: #7c6cf0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#f0f4f8,#e4ecf5); border-bottom: 2px solid #0099cc44; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 20px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
  .logo span { color: var(--cyan); }
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
  .watch-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 20px 16px; }
  @media (max-width: 760px) { .watch-grid { grid-template-columns: 1fr; } }
  .watch-card { background: var(--bg2); border: 2px solid var(--cyan); border-radius: 12px; overflow: hidden; }
  .watch-card.down { border-color: var(--down); }
  .watch-hdr { background: #0d1d30; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
  .watch-title { font-size: 13px; font-weight: bold; color: #ddd; }
  .watch-sub { font-size: 9px; color: #8fb; }
  .watch-body { padding: 10px 14px; }
  .px { padding: 4px 6px; border-radius: 6px; background: var(--bg3); text-align: center; font-size: 9.5px; margin-bottom: 8px; }
  .fill-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; font-size: 10px; display: flex; justify-content: space-between; }
  .fill-empty { color: var(--muted); font-size: 10px; padding: 4px 0; }
  .side-pnl { text-align: right; margin-top: 4px; font-size: 10.5px; }
  .asset-unrl { margin-top: 8px; font-size: 10px; text-align: right; }
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
    <div class="logo">🪙 <span>BTC</span> 5m DIP BOT</div>
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
    <div class="section-hdr" id="strategy-hdr">Current Window — UP checks every 20s / DOWN checks every 40s, independently</div>
  </div>
  <div class="watch-grid" id="watch-grid"><div class="empty">Loading…</div></div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr" style="padding:0 0 8px;">Window History (resolved)</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Window</th><th>Winner</th><th>Method</th><th>Up Fills</th><th>Up PnL</th><th>Down Fills</th><th>Down PnL</th><th>Combined</th></tr></thead>
          <tbody id="history-body"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr" style="padding:0 0 8px;">Recent Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Window</th><th>Step</th><th>Side</th><th>Price</th><th>Shares</th><th>Cost/Fee/PnL</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
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

  $('pause-btn').onclick = () => fetch('/api/hedge/pause', { method: 'POST' }).then(() => flash('Trading paused'));
  $('resume-btn').onclick = () => fetch('/api/hedge/resume', { method: 'POST' }).then(() => flash('Trading resumed'));
  $('live-btn').onclick = () => {
    const wantLive = !$('live-btn').classList.contains('is-live');
    if (wantLive && !confirm('Switch to LIVE mode? This will place REAL FOK limit buy orders with REAL money on the BTC 5-minute Up/Down market whenever a dip trigger fires.')) return;
    fetch('/api/hedge/set-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: wantLive }) })
      .then(() => flash(wantLive ? 'Switched to LIVE' : 'Switched to DEMO'));
  };
  function flash(msg) { $('toolbar-status').textContent = msg; setTimeout(() => { $('toolbar-status').textContent = ''; }, 3000); }

  function fmtPx(n) { return n == null ? '—' : n.toFixed(3); }
  function fmt2(n) { return (n == null ? 0 : n).toFixed(2); }
  function pClass(n) { return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }
  function sgn(n) { return n == null ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
  function fmtSecs(ms) { return ms == null ? '—' : Math.ceil(ms / 1000) + 's'; }

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

  function fillRow(p) {
    return '<div class="fill-card"><span>' + p.shares.toFixed(2) + 'sh @' + fmtPx(p.entryPrice) + ' ($' + fmt2(p.cost) + (p.fee ? ' +$' + p.fee.toFixed(4) + ' fee' : '') + ')</span>' +
      '<span class="' + pClass(p.pnl) + '">' + (p.pnl == null ? 'open' : sgn(p.pnl)) + '</span></div>';
  }

  function watchCard(t, side, cls) {
    const watch = side === 'up' ? (t && t.upWatch) : (t && t.downWatch);
    const positions = side === 'up' ? (t && t.upPositions) : (t && t.downPositions);
    const ask = t && t.leg ? (side === 'up' ? t.leg.upAsk : t.leg.downAsk) : null;
    const label = side.toUpperCase();
    const sub = watch
      ? 'prev check ' + fmtPx(watch.prevAsk) + ' · next check in ' + fmtSecs(watch.nextCheckInMs) + ' · ' + watch.checks + ' checks'
      : '—';
    const sidePnl = positions && positions.length ? positions.reduce((s, p) => s + (p.pnl || 0), 0) : null;
    return '<div class="watch-card ' + cls + '">' +
      '<div class="watch-hdr"><div class="watch-title">' + label + '</div><div class="watch-sub">' + sub + '</div></div>' +
      '<div class="watch-body">' +
        '<div class="px">current ask ' + fmtPx(ask) + '</div>' +
        (positions && positions.length ? positions.map(fillRow).join('') : '<div class="fill-empty">No fills yet this window</div>') +
        (sidePnl != null ? '<div class="side-pnl ' + pClass(sidePnl) + '">' + label + ' total ' + sgn(sidePnl) + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function renderCurrent(s) {
    const t = s.current.btc;
    if (!t) { $('watch-grid').innerHTML = '<div class="empty">No active window yet</div>'; return; }
    $('watch-grid').innerHTML = watchCard(t, 'up', '') + watchCard(t, 'down', 'down');
    $('strategy-hdr').textContent = 'Window ' + (t.leg ? t.leg.slug.replace(/^btc-updown-5m-/, '') : '…') + ' — state: ' + t.state + (t.unrealizedPnl != null ? ' — unrealized ' : '');
  }

  function renderHistory(list) {
    if (!list || !list.length) { $('history-body').innerHTML = '<tr><td colspan="8" class="empty">No resolved windows yet</td></tr>'; return; }
    $('history-body').innerHTML = list.map(h =>
      '<tr><td>' + h.slug.replace(/^btc-updown-5m-/, '') + '</td>' +
      '<td>' + (h.winner || '?').toUpperCase() + '</td>' +
      '<td>' + (h.resolutionMethod || '—') + '</td>' +
      '<td>' + h.upFills + ' (' + h.upShares.toFixed(1) + 'sh)</td>' +
      '<td class="' + pClass(h.upPnl) + '">' + sgn(h.upPnl) + '</td>' +
      '<td>' + h.downFills + ' (' + h.downShares.toFixed(1) + 'sh)</td>' +
      '<td class="' + pClass(h.downPnl) + '">' + sgn(h.downPnl) + '</td>' +
      '<td class="' + pClass(h.combinedPnl) + '">' + sgn(h.combinedPnl) + '</td></tr>'
    ).join('');
  }

  function renderTrades(list) {
    if (!list || !list.length) { $('trade-body').innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>'; return; }
    $('trade-body').innerHTML = list.map(t =>
      '<tr><td>' + t.time + '</td>' +
      '<td>' + (t.slug || '').replace(/^btc-updown-5m-/, '') + '</td>' +
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

  socket.on('hedgeState', (s) => {
    $('mode-badge').className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    $('mode-badge').textContent = s.dryRun ? 'DEMO' : 'LIVE';
    $('live-btn').classList.toggle('is-live', !s.dryRun);
    $('live-btn').textContent = s.dryRun ? '🔴 Switch to LIVE' : '⚠️ Switch to DEMO';

    const banner = $('boundary-banner');
    if (s.waitingForBoundary) { banner.style.display = 'block'; banner.textContent = '⏳ Started mid-window — waiting for the next fresh 5-minute boundary before trading begins (no mid-window entries).'; }
    else banner.style.display = 'none';

    renderStats(s);
    renderCurrent(s);
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

console.log('🪙 BTC 5m Price-Dip Bot — independent UP(20s)/DOWN(40s) dip-triggered limit buys');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  dipBot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
