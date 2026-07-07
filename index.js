'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./polymarket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => {
  try { res.json(bot.getStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/pause', (_, res) => {
  try { res.json(bot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/resume', (_, res) => {
  try { res.json(bot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔄 BTC 5m Mean Reversion</title>
<style>
  :root {
    --bg: #0a0e17; --bg2: #111827; --bg3: #1a2332; --border: #2a3a4e;
    --text: #d1d8e0; --muted: #6b7f99; --cyan: #00bcd4; --green: #00c853;
    --red: #ff5252; --yellow: #ffd740; --gold: #ffb300;
    --up: #00c853; --down: #ff5252;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; }
  .header { background: linear-gradient(135deg,#0f1a2e,#162032); border-bottom: 2px solid #00bcd444; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 20px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
  .logo span { color: var(--cyan); }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #ff475722; color: var(--red); border: 1px solid var(--red); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: #00838f; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); color: #111; }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 20px; font-weight: bold; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .pair-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 10px; }
  .pair-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .pair-card.has-trades { border-color: var(--cyan); box-shadow: 0 0 0 1px #00bcd433; }
  .pair-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
  .pair-sym { font-size: 13px; font-weight: bold; color: #d1d8e0; }
  .pair-timer { font-size: 10px; color: var(--cyan); }
  .pair-body { padding: 8px 12px; }
  .pair-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
  .pair-key { color: var(--muted); }
  .tf-bar { height: 4px; background: var(--bg3); border-radius: 2px; margin: 6px 0; overflow: hidden; }
  .tf-fill { height: 100%; background: linear-gradient(90deg, var(--red), var(--yellow), var(--green)); border-radius: 2px; transition: width 1s; }
  .mid-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 6px 0; }
  .mid-box { padding: 6px 8px; border-radius: 6px; font-size: 10px; text-align: center; }
  .mid-up { background: #0a2e1a; color: var(--up); }
  .mid-down { background: #2e0a14; color: var(--down); }
  .mid-title { font-size: 11px; font-weight: bold; }
  .mid-price { font-size: 13px; margin: 2px 0; }
  .mid-dev { font-size: 9px; opacity: 0.7; }
  .mid-arrow { font-size: 14px; }
  .trade-list { margin: 6px 0; display: flex; flex-direction: column; gap: 3px; }
  .trade-item { background: var(--bg3); border-radius: 4px; padding: 4px 8px; display: flex; justify-content: space-between; font-size: 9px; }
  .trade-resting { border-left: 3px solid var(--cyan); }
  .trade-filled { border-left: 3px solid var(--yellow); }
  .trade-tp-sl { border-left: 3px solid var(--green); }
  .trade-side-up { color: var(--up); }
  .trade-side-down { color: var(--down); }
  .trade-tp { color: var(--green); margin-left: 4px; }
  .trade-sl { color: var(--red); margin-left: 4px; }
  .trade-overreact { color: var(--muted); font-size: 8px; }
  .empty { color: var(--muted); font-size: 11px; text-align: center; padding: 20px; }
  .logs-box { background: #050a14; border: 1px solid var(--border); border-radius: 10px; padding: 12px; max-height: 300px; overflow-y: auto; font-size: 10px; line-height: 1.6; }
  .logs-box div { padding: 1px 0; }
  .trade-table { width: 100%; border-collapse: collapse; font-size: 10px; }
  .trade-table th { background: #0f1a2e; color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; }
  .trade-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .reversion-info { font-size: 8px; color: var(--muted); margin-top: 2px; }
</style>
</head>
<body>

<div class="header">
  <div class="logo">🔄 <span>MEAN REVERSION</span> BTC 5m</div>
  <div style="display:flex;align-items:center;gap:12px;">
    <span id="uptime" style="font-size:10px;color:var(--muted);"></span>
    <span id="modeBadge" class="mode-badge mode-dry"></span>
  </div>
</div>

<div class="toolbar">
  <button onclick="fetch('/api/pause',{method:'POST'})" class="pause">⏸ Pause</button>
  <button onclick="fetch('/api/resume',{method:'POST'})" class="resume">▶ Resume</button>
  <span id="tradingStatus" style="font-size:10px;color:var(--muted);margin-left:8px;"></span>
</div>

<div class="stats-row" id="stats">
  <div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val" id="stat-bankroll">—</div></div>
  <div class="stat"><div class="stat-label">Mark Value</div><div class="stat-val" id="stat-mark">—</div></div>
  <div class="stat"><div class="stat-label">Realized PnL</div><div class="stat-val" id="stat-pnl">—</div></div>
  <div class="stat"><div class="stat-label">Total PnL</div><div class="stat-val" id="stat-totalPnl">—</div></div>
  <div class="stat"><div class="stat-label">W / L</div><div class="stat-val" id="stat-wl">—</div></div>
  <div class="stat"><div class="stat-label">Rebates</div><div class="stat-val" id="stat-rebates">—</div></div>
</div>

<div class="section">
  <div class="section-hdr">Live Windows</div>
  <div class="pair-grid" id="pairGrid"></div>
</div>

<div class="section">
  <div class="section-hdr">Recent Trades</div>
  <table class="trade-table">
    <thead><tr><th>Time</th><th>Action</th><th>Side</th><th>Price</th><th>Shares</th><th>PnL</th></tr></thead>
    <tbody id="trade-body"><tr><td colspan="6" class="empty">No trades yet</td></tr></tbody>
  </table>
</div>

<div class="section">
  <div class="section-hdr">Logs</div>
  <div class="logs-box" id="logs"><div style="color:var(--muted);">Waiting for data…</div></div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket = io();

function fmtSecs(s) {
  if (s == null || isNaN(s)) return '—';
  var m = Math.floor(Math.abs(s) / 60);
  var sec = Math.abs(s) % 60;
  return (s < 0 ? '-' : '') + m + 'm' + (sec < 10 ? '0' : '') + sec + 's';
}
function sgn(v) { return v == null ? '—' : (v >= 0 ? '+$' + v.toFixed(2) : '-$' + Math.abs(v).toFixed(2)); }
function pClass(v) { return v == null ? '' : (v >= 0 ? 'pnl-pos' : 'pnl-neg'); }

socket.on('state', function(s) {
  // Mode badge
  var modeEl = document.getElementById('modeBadge');
  if (s.dryRun) {
    modeEl.textContent = '⚠ DRY RUN';
    modeEl.className = 'mode-badge mode-dry';
  } else {
    modeEl.textContent = '🔴 LIVE';
    modeEl.className = 'mode-badge mode-live';
  }

  document.getElementById('tradingStatus').textContent = s.tradingEnabled ? '▶ Trading' : '⏸ Paused';
  document.getElementById('uptime').textContent = 'Up ' + fmtSecs(s.uptime);

  // Stats
  document.getElementById('stat-bankroll').textContent = '$' + s.totalBankroll.toFixed(2);
  document.getElementById('stat-mark').textContent = '$' + s.totalMarkValue.toFixed(2);
  var pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent = sgn(s.totalRealizedPnl);
  pnlEl.className = 'stat-val ' + pClass(s.totalRealizedPnl);
  var tpEl = document.getElementById('stat-totalPnl');
  tpEl.textContent = sgn(s.totalPnl);
  tpEl.className = 'stat-val ' + pClass(s.totalPnl);
  document.getElementById('stat-wl').textContent = s.totalWins + ' / ' + s.totalLosses + (s.winRate != null ? ' (' + s.winRate + '%)' : '');
  document.getElementById('stat-rebates').textContent = '$' + s.totalRebatesEarned.toFixed(2);

  // Pair cards
  var grid = document.getElementById('pairGrid');
  if (!s.pairStates || s.pairStates.length === 0) {
    grid.innerHTML = '<div class="empty">No pairs configured</div>';
  } else {
    grid.innerHTML = s.pairStates.map(function(p){
      var elapsed = p.windowElapsed || 0;
      var tfPct = Math.round((p.timeDecayFactor || 0) * 100);
      var hasTrades = p.tradesPlaced > 0;

      function midBox(side, label, mid, dev) {
        var cls = side === 'Up' ? 'mid-up' : 'mid-down';
        var midStr = mid != null ? mid.toFixed(4) : '—';
        var devStr = dev != null ? (dev * 100).toFixed(1)+'%' : '';
        var arrow = mid != null ? (mid >= 0.50 ? '▲' : '▼') : '';
        var overreact = dev != null && dev >= (s.config ? s.config.overreactionThreshold || 0.04 : 0.04) ? ' ⚠️' : '';
        return '<div class="mid-box '+cls+'"><div class="mid-title">'+label+' '+arrow+overreact+'</div><div class="mid-price">'+midStr+'</div><div class="mid-dev">'+devStr+' from 0.50</div></div>';
      }

      // Active trades list
      var tradeHtml = '';
      if (p.activeTrades && p.activeTrades.length > 0) {
        tradeHtml = '<div class="trade-list">'+p.activeTrades.map(function(t){
          var stateCls = t.state === 'resting' ? 'trade-resting' : (t.state === 'filled' ? 'trade-filled' : 'trade-tp-sl');
          var sideCls = 'trade-side-' + t.side.toLowerCase();
          var tpStr = t.tpPrice != null ? '<span class="trade-tp">TP '+t.tpPrice.toFixed(4)+'</span>' : '';
          var slStr = t.slPrice != null ? '<span class="trade-sl">SL '+t.slPrice.toFixed(4)+'</span>' : '';
          var overStr = t.overreactedSide ? '<span class="trade-overreact">(vs '+t.overreactedSide+'▲)</span>' : '';
          return '<div class="trade-item '+stateCls+'"><span><span class="'+sideCls+'">'+t.side+'</span> '+t.shares+'sh @ '+t.entryPrice.toFixed(4)+' '+overStr+'</span><span>'+tpStr+' '+slStr+'</span></div>';
        }).join('')+'</div>';
      } else if (p.tradesPlaced > 0) {
        tradeHtml = '<div style="color:var(--muted);font-size:9px;padding:4px;">All trades closed</div>';
      }
      if (p.tradesPlaced === 0 && p.tradable && elapsed > 10) {
        tradeHtml = '<div style="color:var(--muted);font-size:9px;padding:4px;">Waiting for overreaction…</div>';
      }

      // Determine which side is overreacting (for display)
      var upAlert = p.upDeviation != null && p.upDeviation >= (s.config ? s.config.overreactionThreshold || 0.04 : 0.04);
      var downAlert = p.downDeviation != null && p.downDeviation >= (s.config ? s.config.overreactionThreshold || 0.04 : 0.04);
      var reversionMsg = '';
      if (upAlert && p.upMid > p.downMid) {
        reversionMsg = '<div class="reversion-info">🔄 UP overreacted → Buy DOWN</div>';
      } else if (downAlert && p.downMid > p.upMid) {
        reversionMsg = '<div class="reversion-info">🔄 DOWN overreacted → Buy UP</div>';
      }

      return '<div class="pair-card '+(hasTrades?'has-trades':'')+'">'+
        '<div class="pair-hdr">'+
          '<div class="pair-sym">'+p.symbol+' 5m</div>'+
          '<div style="display:flex;gap:12px;align-items:center;">'+
            '<div style="font-size:9px;color:#888;">tf: '+tfPct+'%</div>'+
            '<div class="pair-timer">'+fmtSecs(p.secsToEnd)+' left</div>'+
          '</div>'+
        '</div>'+
        '<div class="pair-body">'+
          '<div class="tf-bar"><div class="tf-fill" style="width:'+tfPct+'%"></div></div>'+
          '<div class="pair-row"><span class="pair-key">Elapsed</span><span>'+fmtSecs(elapsed)+'</span><span class="pair-key">Trades</span><span>'+p.tradesPlaced+'/'+p.maxTrades+'</span></div>'+
          '<div class="pair-row"><span class="pair-key">Bankroll</span><span>$'+p.bankroll.toFixed(2)+'</span><span class="pair-key">W/L</span><span>'+p.wins+'/'+p.losses+'</span></div>'+
          '<div class="pair-row"><span class="pair-key">Realized</span><span class="'+pClass(p.realizedPnl)+'">'+sgn(p.realizedPnl)+'</span><span class="pair-key">Unrealized</span><span class="'+pClass(p.unrealizedPnl)+'">'+sgn(p.unrealizedPnl)+'</span></div>'+
          '<div class="mid-panel">'+midBox('Up','UP',p.upMid,p.upDeviation)+midBox('Down','DOWN',p.downMid,p.downDeviation)+'</div>'+
          reversionMsg +
          tradeHtml +
        '</div></div>';
    }).join('');
  }

  var tb = document.getElementById('trade-body');
  if (s.trades && s.trades.length > 0) {
    tb.innerHTML = s.trades.map(function(t){
      var pnlTxt = t.profit != null ? sgn(t.profit) : '—';
      var pnlCls = t.profit != null ? pClass(t.profit) : '';
      var reasonIcon = t.reason === 'REVERSION' ? '🔄' : t.reason === 'TP' ? '💰' : t.reason === 'SL' ? '🛑' : t.reason === 'RESOLUTION' ? '📊' : '';
      return '<tr><td>'+t.time+'</td><td>'+reasonIcon+' '+(t.reason||'')+'</td><td>'+(t.outcome||'')+'</td><td>'+(t.price||0).toFixed(4)+'</td><td>'+(t.shares||0).toFixed(2)+'</td><td class="'+pnlCls+'">'+pnlTxt+'</td></tr>';
    }).join('');
  } else {
    tb.innerHTML = '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
  }

  var logEl = document.getElementById('logs');
  if (s.logs && s.logs.length > 0) {
    logEl.innerHTML = s.logs.map(function(l){
      var col = l.includes('❌') ? '#ff4757' : l.includes('💰')||l.includes('✅') ? '#00e676' : l.includes('🛑') ? '#e6a800' : l.includes('🔄') ? '#00bcd4' : l.includes('🎯') ? '#ffd740' : l.includes('💥') ? '#ff5252' : l.includes('📊') ? '#ffb300' : '#6b7f99';
      return '<div style="color:'+col+'">'+l+'</div>';
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Reconnect pair grid animation
  // (handled by CSS transition on tf-fill)
});
</script>
</body>
</html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
