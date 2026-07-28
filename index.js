'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bucketBot   = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/hedge/status', (_, res) => {
  try { res.json(bucketBot.buildState()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (_, res) => {
  try { res.json(bucketBot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/resume', (_, res) => {
  try { res.json(bucketBot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(bucketBot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪙 BTC 5m Momentum Bucket Bot</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --gold: #b8860b;
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
  .causality-banner { margin: 10px 20px 0; padding: 10px 14px; border-radius: 8px; font-size: 11px; line-height: 1.5; }
  .causality-ok { background: #00a85422; border: 1px solid var(--green); color: #0a5c34; }
  .causality-bad { background: #e8304a22; border: 2px solid var(--red); color: #7a1020; }
  .causality-idle { background: var(--bg3); border: 1px solid var(--border); color: var(--muted); }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 10px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 17px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 20px; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .bucket-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 20px 16px; }
  @media (max-width: 760px) { .bucket-grid { grid-template-columns: 1fr; } }
  .bucket-card { background: var(--bg2); border: 2px solid var(--border); border-radius: 12px; overflow: hidden; }
  .bucket-card.active { border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan) inset; }
  .bucket-card.up-card.active { border-color: #4fc3f7; }
  .bucket-card.down-card.active { border-color: #b39ddb; }
  .bucket-hdr { background: #0d1d30; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
  .bucket-title { font-size: 13px; font-weight: bold; color: #ddd; }
  .bucket-sub { font-size: 9px; color: #8fb; }
  .bucket-badge { padding: 3px 10px; border-radius: 10px; font-size: 10px; font-weight: bold; }
  .badge-active { background: #0099cc33; color: #4fc3f7; border: 1px solid #4fc3f7; }
  .badge-paused { background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }
  .bucket-body { padding: 14px; text-align: center; }
  .bucket-balance { font-size: 26px; font-weight: bold; color: #12202e; }
  .bucket-wager { font-size: 10px; color: var(--muted); margin-top: 6px; }
  .bucket-flow { font-size: 8.5px; color: var(--muted); margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); font-weight: normal; }
  .current-window { margin: 0 20px 16px; background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; font-size: 10.5px; }
  .current-window .headline { font-size: 15px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed var(--border); }
  .current-window .row { display: flex; justify-content: space-between; padding: 3px 0; }
  .current-window .row span:last-child { color: #12202e; }
  .status-pill { font-size: 9px; padding: 2px 8px; border-radius: 9px; }
  .status-open { background: #0099cc22; color: var(--cyan); border: 1px solid var(--cyan); }
  .status-resting { background: #e6a80022; color: var(--yellow); border: 1px solid var(--yellow); }
  .status-idle { background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }
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
    <div class="logo">🪙 <span>BTC</span> 5m BUCKET BOT</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">⏸️ Pause Trading</button>
    <button id="resume-btn" class="resume">▶️ Resume Trading</button>
    <button id="live-btn" class="live-toggle">🔴 Switch to LIVE</button>
  </div>
  <div class="toolbar-status" id="toolbar-status"></div>
  <div id="boundary-banner" style="display:none;" class="boundary-banner"></div>
  <div id="causality-banner" style="display:none;" class="causality-banner"></div>

  <div class="stats-row" id="stats-row"></div>

  <div class="section-hdr">Momentum Buckets — the side that WON the last window trades this window; the other side's bucket is paused</div>
  <div class="bucket-grid" id="bucket-grid"><div class="empty">Loading…</div></div>

  <div class="section-hdr">Current Window</div>
  <div class="current-window" id="current-window">Loading…</div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr" style="padding:0 0 8px; margin:0;">Window History (resolved)</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Window</th><th>Winner</th><th>Method</th><th>Bet</th><th>Result</th><th>PnL</th><th>UP bucket</th><th>DOWN bucket</th></tr></thead>
          <tbody id="history-body"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr" style="padding:0 0 8px; margin:0;">Recent Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Window</th><th>Step</th><th>Side</th><th>Price</th><th>Shares</th><th>Cost/PnL</th></tr></thead>
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
    if (wantLive && !confirm('Switch to LIVE mode? This will place REAL market/taker buy orders with REAL money on the BTC 5-minute Up/Down market, sized from live bucket balances.')) return;
    fetch('/api/hedge/set-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: wantLive }) })
      .then(() => flash(wantLive ? 'Switched to LIVE' : 'Switched to DEMO'));
  };
  function flash(msg) { $('toolbar-status').textContent = msg; setTimeout(() => { $('toolbar-status').textContent = ''; }, 3000); }

  function fmtPx(n) { return n == null ? '—' : n.toFixed(3); }
  function fmt2(n) { return (n == null ? 0 : n).toFixed(2); }
  function pClass(n) { return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }
  function sgn(n) { return n == null ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

  function renderStats(s) {
    const stats = [
      ['Equity (MTM)', '$' + fmt2(s.equity), ''],
      ['Bankroll (cash)', '$' + fmt2(s.bankroll), ''],
      ['Realized P&amp;L', sgn(s.realizedPnl), pClass(s.realizedPnl)],
      ['Unrealized P&amp;L', sgn(s.unrealizedPnl), pClass(s.unrealizedPnl)],
      ['Wins / Losses', s.wins + ' / ' + s.losses, ''],
      ['Last Winner', s.lastWinner ? s.lastWinner.toUpperCase() : '—', ''],
      ['Pending Resolution', s.pendingResolutionCount || 0, ''],
    ];
    $('stats-row').innerHTML = stats.map(([label, val, cls]) =>
      '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-val ' + cls + '">' + val + '</div></div>'
    ).join('');
  }

  function bucketCard(side, s) {
    const opp = side === 'up' ? 'down' : 'up';
    const balance = s.buckets[side];
    const isActive = s.current.btc && s.current.btc.activeSide === side;
    const wager = balance / (s.bucketDivisor || 10);
    return '<div class="bucket-card ' + side + '-card' + (isActive ? ' active' : '') + '">' +
      '<div class="bucket-hdr"><div><div class="bucket-title">' + side.toUpperCase() + ' bucket</div>' +
        '<div class="bucket-sub">started at $' + fmt2(s.bucketStartingCapital) + '</div></div>' +
        '<span class="bucket-badge ' + (isActive ? 'badge-active' : 'badge-paused') + '">' + (isActive ? 'ACTIVE' : 'paused') + '</span></div>' +
      '<div class="bucket-body">' +
        '<div class="bucket-balance">$' + fmt2(balance) + '</div>' +
        '<div class="bucket-wager">' + (isActive ? 'wager this window: $' + fmt2(wager) : 'not trading this window') + '</div>' +
        '<div class="bucket-flow">if ' + side.toUpperCase() + ' wins → payout moves to ' + opp.toUpperCase() + ' bucket &nbsp;|&nbsp; if ' + side.toUpperCase() + ' loses → wager is simply gone</div>' +
      '</div>' +
    '</div>';
  }

  function renderBuckets(s) {
    $('bucket-grid').innerHTML = bucketCard('up', s) + bucketCard('down', s);
  }

  function renderCausality(s) {
    const el = $('causality-banner');
    const t = s.current.btc;
    if (!t) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (!t.activeSide) {
      el.className = 'causality-banner causality-idle';
      el.innerHTML = 'ℹ️ Bootstrap window — no prior winner yet, so no bucket is active this window.';
      return;
    }
    const expected = s.lastWinner;
    const ok = expected === t.activeSide;
    el.className = 'causality-banner ' + (ok ? 'causality-ok' : 'causality-bad');
    el.innerHTML = ok
      ? '✅ Last window\u2019s winner was <b>' + expected.toUpperCase() + '</b> → this window correctly trades the <b>' + t.activeSide.toUpperCase() + '</b> bucket.'
      : '⚠️ MISMATCH — last window\u2019s winner was <b>' + (expected ? expected.toUpperCase() : '—') + '</b> but this window is trading <b>' + t.activeSide.toUpperCase() + '</b>. This shouldn\u2019t happen — check the Live Log below for why.';
  }

  function renderCurrentWindow(s) {
    const t = s.current.btc;
    if (!t) { $('current-window').innerHTML = '<div class="empty">No active window yet</div>'; return; }
    const leg = t.leg;
    let headline, betLine;
    if (!t.activeSide) {
      headline = '⏳ Bootstrap window — no bet placed';
      betLine = '<span class="status-pill status-idle">watching this window resolve to seed the momentum signal</span>';
    } else if (t.position) {
      headline = (t.activeSide === 'up' ? '🔵' : '🟣') + ' Trading ' + t.activeSide.toUpperCase() + ' this window';
      betLine = '<span class="status-pill status-open">bought ' + t.position.shares.toFixed(2) + 'sh @' + fmtPx(t.position.entryPrice) + ' ($' + fmt2(t.position.cost) + ')</span>';
    } else if (t.betPlaced) {
      headline = '⏸ ' + t.activeSide.toUpperCase() + ' bucket active, but no bet placed';
      betLine = '<span class="status-pill status-idle">skipped — ' + (t.skipReason || 'no fill') + '</span>';
    } else {
      headline = (t.activeSide === 'up' ? '🔵' : '🟣') + ' Trading ' + t.activeSide.toUpperCase() + ' this window';
      betLine = '<span class="status-pill status-resting">bet pending — waiting for a price</span>';
    }
    $('current-window').innerHTML =
      '<div class="headline">' + headline + '</div>' +
      '<div class="row"><span>Window</span><span>' + (leg ? leg.slug.replace(/^btc-updown-5m-/, '') : '…') + '</span></div>' +
      '<div class="row"><span>State</span><span>' + t.state + '</span></div>' +
      '<div class="row"><span>Bet status</span>' + betLine + '</div>' +
      '<div class="row"><span>Live prices</span><span>UP ask ' + fmtPx(leg && leg.upAsk) + ' / bid ' + fmtPx(leg && leg.upBid) + ' · DOWN ask ' + fmtPx(leg && leg.downAsk) + ' / bid ' + fmtPx(leg && leg.downBid) + '</span></div>' +
      (t.position ? '<div class="row"><span>Unrealized P&amp;L</span><span class="' + pClass(t.unrealizedPnl) + '">' + sgn(t.unrealizedPnl) + '</span></div>' : '');
  }

  function methodLabel(m) {
    if (m === 'final-price') return 'instant (final price)';
    if (m === 'official') return 'official';
    if (m === 'high-confidence-price') return 'high-confidence (slow)';
    if (m === 'price-fallback') return 'fallback (slow)';
    return m || '—';
  }

  function renderHistory(list) {
    if (!list || !list.length) { $('history-body').innerHTML = '<tr><td colspan="8" class="empty">No resolved windows yet</td></tr>'; return; }
    $('history-body').innerHTML = list.map(h => {
      const betCell = !h.activeSide ? '—' : (h.betPlaced ? h.activeSide.toUpperCase() + ' ' + h.shares.toFixed(2) + 'sh @' + fmtPx(h.entryPrice) : h.activeSide.toUpperCase() + ' (skipped)');
      const resultCell = h.win == null ? '—' : (h.win ? 'WON' : 'LOST');
      return '<tr><td>' + h.slug.replace(/^btc-updown-5m-/, '') + '</td>' +
      '<td>' + (h.winner || '?').toUpperCase() + '</td>' +
      '<td>' + methodLabel(h.resolutionMethod) + '</td>' +
      '<td>' + betCell + '</td>' +
      '<td class="' + (h.win === true ? 'pnl-pos' : (h.win === false ? 'pnl-neg' : '')) + '">' + resultCell + '</td>' +
      '<td class="' + pClass(h.pnl) + '">' + sgn(h.pnl) + '</td>' +
      '<td>$' + fmt2(h.bucketsAfter ? h.bucketsAfter.up : null) + '</td>' +
      '<td>$' + fmt2(h.bucketsAfter ? h.bucketsAfter.down : null) + '</td></tr>';
    }).join('');
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
      '<td>' + (t.cost != null ? '$' + t.cost.toFixed(2) : (t.pnl != null ? sgn(t.pnl) : '—')) + '</td></tr>'
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
    renderBuckets(s);
    renderCausality(s);
    renderCurrentWindow(s);
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

console.log('🪙 BTC 5m Momentum Bucket Bot — two capital buckets, winner-of-last-window trades next, market/taker execution');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bucketBot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
