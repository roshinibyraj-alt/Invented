'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/hedge/status', (_, res) => {
  try { res.json(bot.buildState()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (req, res) => {
  const engine = (req.body && req.body.engine) || undefined;
  try { res.json(bot.pauseTrading(engine)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/resume', (req, res) => {
  const engine = (req.body && req.body.engine) || undefined;
  try { res.json(bot.resumeTrading(engine)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/set-mode', (req, res) => {
  const { live, engine } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(bot.setMode(live, engine)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪙 BTC Hedge Bot — 15m &amp; 5m</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --gold: #b8860b; --purple: #7c5cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#f0f4f8,#e4ecf5); border-bottom: 2px solid #0099cc44; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 19px; font-weight: bold; color: var(--gold); letter-spacing: .5px; }
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
  .toolbar-note { padding: 6px 20px 0; font-size: 9.5px; color: var(--muted); }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 14px 20px; }
  @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: var(--bg2); border: 2px solid var(--border); border-radius: 12px; overflow: hidden; }
  .panel-hdr { background: #0d1d30; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; }
  .panel-title { font-size: 14px; color: #ddd; }
  .panel-body { padding: 12px 14px; }
  .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }
  .shared-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 10px 20px 0; }
  @media (max-width: 700px) { .shared-stats { grid-template-columns: repeat(2, 1fr); } }
  .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 9px; }
  .stat-label { font-size: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
  .stat-val { font-size: 14px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .model-box { background: var(--bg); border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 9.5px; }
  .candle-row { display: flex; gap: 8px; }
  .candle-box { flex: 1; border-radius: 8px; padding: 8px 10px; border: 1px solid var(--border); background: var(--bg2); text-align: center; }
  .candle-box.up { background: #00a85414; border-color: var(--green); }
  .candle-box.down { background: #e8304a14; border-color: var(--red); }
  .candle-num { font-size: 11px; font-weight: bold; margin-bottom: 4px; }
  .candle-box.up .candle-num { color: var(--green); }
  .candle-box.down .candle-num { color: var(--red); }
  .candle-body { font-size: 10px; }
  .candle-sub { font-size: 8px; color: var(--muted); margin-top: 2px; }
  .candle-pred { margin-top: 8px; font-size: 10.5px; }
  .candle-meta { margin-top: 3px; font-size: 8.5px; color: var(--muted); }
  .current-window { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 10px; margin-bottom: 10px; }
  .current-window .headline { font-size: 12.5px; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px dashed var(--border); }
  .current-window .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .status-pill { font-size: 8.5px; padding: 2px 7px; border-radius: 9px; }
  .status-open { background: #0099cc22; color: var(--cyan); border: 1px solid var(--cyan); }
  .status-resting { background: #e6a80022; color: var(--yellow); border: 1px solid var(--yellow); }
  .status-idle { background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }
  .panel-buttons { display: flex; gap: 6px; margin-bottom: 10px; }
  .panel-buttons button { flex: 1; font-size: 9.5px; padding: 6px 4px; border-radius: 6px; border: none; cursor: pointer; font-family: inherit; font-weight: bold; }
  .panel-buttons .pause { background: var(--yellow); }
  .panel-buttons .resume { background: var(--green); color: #fff; }
  .tbl-wrap { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; max-height: 220px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 5px 6px; text-align: left; font-size: 8px; text-transform: uppercase; position: sticky; top: 0; }
  .tbl td { padding: 4px 6px; border-bottom: 1px solid var(--border); font-size: 9px; }
  .empty { padding: 16px; text-align: center; color: var(--muted); font-size: 9.5px; }
  .log-panel { background: #0d1420; color: #cfe8ff; border-radius: 10px; padding: 10px 12px; max-height: 240px; overflow-y: auto; font-size: 9.5px; margin: 0 20px 20px; }
  .log-panel div { padding: 1px 0; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🪙 <span>BTC</span> HEDGE BOT — 15m &amp; 5m</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">⏸️ Pause Both</button>
    <button id="resume-btn" class="resume">▶️ Resume Both</button>
    <button id="live-btn" class="live-toggle">🔴 Switch Both to LIVE</button>
  </div>
  <div class="toolbar-note">Each panel below has its own pause/resume — the buttons above control the whole combined engine at once.</div>

  <div class="shared-stats" id="shared-stats"></div>

  <div class="panels">
    <div class="panel" id="panel-m5"></div>
    <div class="panel" id="panel-m15"></div>
  </div>

  <div class="log-panel" id="log-panel"><div class="empty">No logs yet</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  function $(id) { return document.getElementById(id); }
  function fmt2(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(2); }
  function fmtPx(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(3); }
  function fmtPct(n) { return (n == null || isNaN(n)) ? '—' : (Number(n) * 100).toFixed(1) + '%'; }
  function sgn(n) { if (n == null) return '—'; return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
  function pClass(n) { if (n == null) return ''; return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }

  function currentWindowHtml(s) {
    const t = s.current.btc;
    if (!t) return '<div class="empty">No active window yet</div>';
    const leg = t.leg;
    let headline, betLine;
    if (!t.signalSide) {
      headline = '⏸ No bet this window';
      betLine = '<span class="status-pill status-idle">' + (t.skipReason || 'no signal') + ' (confidence ' + fmtPct(t.confidence) + ')</span>';
    } else if (t.position) {
      headline = (t.signalSide === 'up' ? '🔵' : '🟣') + ' Trading ' + t.signalSide.toUpperCase() + ' — ' + (t.signalNote || '') + ' (3-candle ref ' + fmtPct(t.confidence) + ')';
      betLine = '<span class="status-pill status-open">bought ' + t.position.shares.toFixed(2) + 'sh @' + fmtPx(t.position.entryPrice) + ' ($' + fmt2(t.position.cost) + ')</span>';
    } else if (t.betPlaced) {
      headline = '⏸ ' + t.signalSide.toUpperCase() + ' signal, but no bet placed';
      betLine = '<span class="status-pill status-idle">skipped — ' + (t.skipReason || 'no fill') + '</span>';
    } else {
      headline = (t.signalSide === 'up' ? '🔵' : '🟣') + ' Signal: ' + t.signalSide.toUpperCase() + ' — ' + (t.signalNote || '') + ' (3-candle ref ' + fmtPct(t.confidence) + ')';
      const targetPrice = t.signalSide === 'up' ? (leg && leg.upAsk) : (leg && leg.downAsk);
      betLine = '<span class="status-pill status-resting">placing ' + t.signalSide.toUpperCase() + ' immediately at market' + (targetPrice != null ? ' — ask $' + fmtPx(targetPrice) : '') + '</span>';
    }
    return '<div class="current-window">' +
      '<div class="headline">' + headline + '</div>' +
      '<div class="row"><span>Window</span><span>' + (leg ? leg.slug : '…') + '</span></div>' +
      '<div class="row"><span>State</span><span>' + t.state + '</span></div>' +
      '<div class="row"><span>Bet status</span>' + betLine + '</div>' +
      '<div class="row"><span>Live prices</span><span>UP ' + fmtPx(leg && leg.upAsk) + ' / DOWN ' + fmtPx(leg && leg.downAsk) + '</span></div>' +
      (s.skipRemaining != null ? '<div class="row"><span>5m skip next</span><span>' + s.skipRemaining + ' window(s)</span></div>' : '') +
      (t.position ? '<div class="row"><span>Unrealized P&amp;L</span><span class="' + pClass(t.unrealizedPnl) + '">' + sgn(t.unrealizedPnl) + '</span></div>' : '') +
    '</div>';
  }

  function historyRowsHtml(list) {
    if (!list || !list.length) return '<tr><td colspan="5" class="empty">No resolved windows yet</td></tr>';
    return list.slice(0, 25).map(h => {
      const betCell = !h.side ? '—' : (h.betPlaced ? h.side.toUpperCase() + ' @' + fmtPx(h.entryPrice) : h.side.toUpperCase() + ' (skip)');
      const resultCell = h.win == null ? '—' : (h.win ? 'WON' : 'LOST');
      return '<tr><td>' + h.slug.split('-').pop() + '</td>' +
      '<td>' + (h.winner || '?').toUpperCase() + '</td>' +
      '<td>' + betCell + '</td>' +
      '<td class="' + (h.win === true ? 'pnl-pos' : (h.win === false ? 'pnl-neg' : '')) + '">' + resultCell + '</td>' +
      '<td class="' + pClass(h.pnl) + '">' + sgn(h.pnl) + '</td></tr>';
    }).join('');
  }

  function candleModelHtml(s) {
    const candles = s.lastCandles || [];
    const t = s.current && s.current.btc;
    const pred = t && t.model;
    let candleRow;
    if (!candles.length) {
      candleRow = '<div class="candle-row"><div class="empty">Waiting for candles…</div></div>';
    } else {
      candleRow = '<div class="candle-row">' + candles.map((k, i) => {
        const bull = k.up;
        return '<div class="candle-box ' + (bull ? 'up' : 'down') + '">' +
          '<div class="candle-num">' + (i + 1) + (bull ? ' ▲' : ' ▼') + '</div>' +
          '<div class="candle-body">' + fmt2(k.open) + ' → ' + fmt2(k.close) + '</div>' +
          '<div class="candle-sub">H ' + fmt2(k.high) + ' · L ' + fmt2(k.low) + '</div>' +
        '</div>';
      }).join('') + '</div>';
    }
    const predLine = pred && pred.side
      ? '3-candle reference: <b>' + pred.side.toUpperCase() + '</b> — confidence ' + fmtPct(pred.confidence) + ' · score ' + pred.score +
        (pred.sub ? ' (majority ' + pred.sub.majority + ' / momentum ' + pred.sub.momentum + ' / lastBody ' + pred.sub.lastBody + ')' : '')
      : '3-candle reference: waiting for 3 closed candles';
    const metaLine = 'Fixed bet: $' + fmt2(s.baseBetDollars) + ' per window' +
      (s.totalFeesPaid > 0 ? ' · fees $' + fmt2(s.totalFeesPaid) + (s.totalRebatesEarned > 0 ? ' (rebate $' + fmt2(s.totalRebatesEarned) + ')' : '') : '');
    return '<div class="model-box">' + candleRow +
      '<div class="candle-pred">' + predLine + '</div>' +
      '<div class="candle-meta">' + metaLine + '</div>' +
    '</div>';
  }

  function panelHtml(key, title, s) {
    if (!s) return '<div class="panel-hdr"><div class="panel-title">' + title + '</div></div><div class="panel-body"><div class="empty">Waiting for data…</div></div>';
    const winRate = s.winRate;
    return '<div class="panel-hdr">' +
        '<div class="panel-title">' + title + '</div>' +
        '<div class="mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live') + '" style="font-size:9px;">' + (s.dryRun ? 'DEMO' : 'LIVE') + '</div>' +
      '</div>' +
      '<div class="panel-body">' +
        '<div class="panel-buttons">' +
          '<button class="pause" onclick="pauseOne(\\'' + key + '\\')">⏸️ Pause</button>' +
          '<button class="resume" onclick="resumeOne(\\'' + key + '\\')">▶️ Resume</button>' +
        '</div>' +
        '<div class="stats-row">' +
          '<div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val ' + pClass(winRate != null ? winRate - 0.5 : null) + '">' + fmtPct(winRate) + '</div></div>' +
          '<div class="stat"><div class="stat-label">Realized P&amp;L</div><div class="stat-val ' + pClass(s.realizedPnl) + '">' + sgn(s.realizedPnl) + '</div></div>' +
          '<div class="stat"><div class="stat-label">Wins / Losses</div><div class="stat-val">' + s.wins + ' / ' + s.losses + '</div></div>' +
          '<div class="stat"><div class="stat-label">BTC Price</div><div class="stat-val">$' + fmt2(s.latestBtcPrice) + '</div></div>' +
        '</div>' +
        candleModelHtml(s) +
        currentWindowHtml(s) +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Window</th><th>Result</th><th>Bet</th><th>W/L</th><th>PnL</th></tr></thead>' +
        '<tbody>' + historyRowsHtml(s.history) + '</tbody></table></div>' +
      '</div>';
  }

  let latest = { m5: null, m15: null };

  function sharedStatsHtml(s) {
    if (!s) return '';
    return '<div class="stat"><div class="stat-label">Bankroll (shared)</div><div class="stat-val">$' + fmt2(s.bankroll) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Equity</div><div class="stat-val">$' + fmt2(s.equity) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Total Realized P&amp;L</div><div class="stat-val ' + pClass(s.realizedPnlTotal) + '">' + sgn(s.realizedPnlTotal) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Fees Paid</div><div class="stat-val">$' + fmt2(s.totalFeesPaid) + '</div></div>';
  }

  function render() {
    $('shared-stats').innerHTML = sharedStatsHtml(latest.m15 || latest.m5);
    $('panel-m5').innerHTML = panelHtml('m5', 'BTC 5-Minute', latest.m5);
    $('panel-m15').innerHTML = panelHtml('m15', 'BTC 15-Minute', latest.m15);
    const any = latest.m5 || latest.m15;
    if (any) {
      const anyLive = (latest.m5 && !latest.m5.dryRun) || (latest.m15 && !latest.m15.dryRun);
      $('mode-badge').className = 'mode-badge ' + (anyLive ? 'mode-live' : 'mode-dry');
      $('mode-badge').textContent = anyLive ? 'LIVE' : 'DEMO';
      $('live-btn').classList.toggle('is-live', anyLive);
      $('live-btn').textContent = anyLive ? '⚠️ Switch Both to DEMO' : '🔴 Switch Both to LIVE';
    }
  }

  function pauseOne(key) { fetch('/api/hedge/pause', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ engine: key }) }); }
  function resumeOne(key) { fetch('/api/hedge/resume', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ engine: key }) }); }

  $('pause-btn').onclick = () => fetch('/api/hedge/pause', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  $('resume-btn').onclick = () => fetch('/api/hedge/resume', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  $('live-btn').onclick = () => {
    const anyLive = (latest.m5 && !latest.m5.dryRun) || (latest.m15 && !latest.m15.dryRun);
    const wantLive = !anyLive;
    if (wantLive && !confirm('Switch BOTH engines to LIVE mode? This will place REAL money orders on both the BTC 5-minute and 15-minute Up/Down markets.')) return;
    fetch('/api/hedge/set-mode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ live: wantLive }) });
  };

  const allLogs = [];
  function renderLogs() {
    const el = $('log-panel');
    if (!allLogs.length) { el.innerHTML = '<div class="empty">No logs yet</div>'; return; }
    el.innerHTML = allLogs.slice(-120).map(l => '<div>' + l.replace(/</g, '&lt;') + '</div>').join('');
    el.scrollTop = el.scrollHeight;
  }

  socket.on('hedgeState:BTC-5m', (s) => { latest.m5 = s; render(); });
  socket.on('hedgeState:BTC-15m', (s) => { latest.m15 = s; render(); });
  socket.on('log', (line) => { allLogs.push(line); if (allLogs.length > 300) allLogs.shift(); renderLogs(); });

  render();
</script>
</body>
</html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('🪙 BTC Hedge Bot — combined 15m/5m strategy, single shared bankroll');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
