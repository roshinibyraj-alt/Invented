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
<title>⏱️ BTC Time Decay Overreversion</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --gold: #b8860b;
    --up: #00c853; --down: #ff5252;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#f0f4f8,#e4ecf5); border-bottom: 2px solid #0099cc44; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 22px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
  .logo span { color: var(--cyan); }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #ff475722; color: var(--red); border: 1px solid var(--red); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--cyan); color: #001018; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 20px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .pair-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); gap: 10px; }
  .pair-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .pair-card.has-trades { border-color: var(--cyan); box-shadow: 0 0 0 1px #00d4ff33; }
  .pair-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
  .pair-sym { font-size: 13px; font-weight: bold; color: #ddd; }
  .pair-timer { font-size: 10px; color: var(--cyan); }
  .pair-body { padding: 8px 12px; }
  .pair-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
  .pair-key { color: var(--muted); }
  .tf-bar { height: 4px; background: var(--bg3); border-radius: 2px; margin: 6px 0; overflow: hidden; }
  .tf-fill { height: 100%; background: linear-gradient(90deg, var(--red), var(--yellow), var(--green)); border-radius: 2px; transition: width 1s; }
  .mid-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 6px 0; }
  .mid-box { padding: 6px 8px; border-radius: 6px; font-size: 10px; text-align: center; }
  .mid-up { background: #c8f0d4; color: #004d1a; }
  .mid-down { background: #fcd8dc; color: #8b1a2b; }
  .mid-title { font-size: 11px; font-weight: bold; }
  .mid-price { font-size: 13px; margin: 2px 0; }
  .mid-dev { font-size: 9px; opacity: 0.7; }
  .trade-list { margin-top: 6px; }
  .trade-item { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px; margin: 2px 0; border-radius: 4px; font-size: 9px; }
  .trade-resting { background: #d0e4f022; }
  .trade-filled { background: #c8f0d444; }
  .trade-tp-sl { background: #fff3c0; }
  .trade-tp-filled { background: #c8f0d4; color: #004d1a; }
  .trade-sl-filled { background: #fcd8dc; color: #8b1a2b; }
  .trade-resolved { background: var(--bg3); }
  .trade-side-up, .trade-side-down { font-weight: bold; }
  .trade-side-up { color: var(--up); }
  .trade-side-down { color: var(--down); }
  .trade-tp { color: var(--green); }
  .trade-sl { color: var(--red); }
  .empty { color: var(--muted); text-align: center; padding: 20px; font-size: 11px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 10px; }
  .tbl th { background: var(--bg3); text-align: left; padding: 4px 8px; border-bottom: 2px solid var(--border); font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .tbl td { padding:4px 8px; border-bottom:1px solid var(--bg3); }
  .equity-wrap { margin: 10px 20px; background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .equity-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .equity-hdr .title { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .equity-hdr .val { font-size: 18px; font-weight: bold; }
  .equity-svg { display: block; width: 100%; height: 90px; }
  .bottom-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 0 20px 20px; }
  @media (max-width:700px) { .bottom-wrap { grid-template-columns:1fr; } }
  .tbl-wrap { max-height: 260px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
  .logs-wrap { max-height: 260px; overflow-y: auto; background: #0d1d30; color: #b0c4d8; padding: 10px; border-radius: 6px; font-size: 10px; line-height: 1.5; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">⏱️ Time<span>Decay</span></div>
    <div class="mode-badge" id="mode-badge">loading…</div>
  </div>
  <div class="toolbar">
    <button class="pause" id="pause-btn">⏸ Pause</button>
    <button class="resume" id="resume-btn">▶ Resume</button>
  </div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Total P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Realized</div><div class="stat-val" id="realized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Unrealized</div><div class="stat-val" id="unrealized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val" id="total-bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Mark Value</div><div class="stat-val" id="total-mark">$0.00</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val" id="win-rate">—</div><div class="stat-sub" id="win-loss-sub">0W / 0L</div></div>
    <div class="stat"><div class="stat-label">Rebates</div><div class="stat-val pnl-pos" id="total-rebates">$0.00</div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">0s</div></div>
    <div class="stat"><div class="stat-label">Trading</div><div class="stat-val" id="trading-flag">—</div></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr">
      <div class="title">Portfolio Equity Curve</div>
      <div class="val" id="equity-val">$2000.00</div>
    </div>
    <svg id="equity-chart" class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none"></svg>
  </div>

  <div class="section">
    <div class="section-hdr">Overreversion Trades</div>
    <div class="pair-grid" id="pair-grid"><div class="empty">Loading…</div></div>
  </div>

  <div class="bottom-wrap">
    <div>
      <div class="section-hdr">Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="6" class="empty">No trades yet</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr">Logs</div>
      <div class="logs-wrap" id="logs"></div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  function sgn(n) { n = n || 0; return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
  function pClass(n) { return (n || 0) >= 0 ? 'pnl-pos' : 'pnl-neg'; }
  function fmt(s) { var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return (h?h+'h ':'')+(m?m+'m ':'')+ss+'s'; }
  function fmtSecs(s) { if (s==null) return '—'; var m=Math.floor(Math.abs(s)/60),ss=Math.abs(s)%60; return (s<0?'-':'')+m+'m '+String(ss).padStart(2,'0')+'s'; }

  function buildEquitySvg(points, width, height, startVal) {
    if (!points || points.length < 2) return '<line x1="0" y1="'+(height/2)+'" x2="'+width+'" y2="'+(height/2)+'" stroke="#3a4a60" stroke-width="1" stroke-dasharray="3,3"/>';
    var vals = points.map(function(p){return p.equity;});
    var min = Math.min.apply(null, vals.concat(startVal != null ? startVal : vals[0]));
    var max = Math.max.apply(null, vals.concat(startVal != null ? startVal : vals[0]));
    if (max - min < 0.01) { max += 1; min -= 1; }
    var n = points.length;
    var coords = points.map(function(p,i){
      var x = (i/(n-1))*width;
      var y = height - ((p.equity-min)/(max-min))*height;
      return [x,y];
    });
    var up = vals[vals.length-1] >= vals[0];
    var color = up ? '#00c853' : '#ff4757';
    var linePath = 'M'+coords.map(function(c){return c[0].toFixed(1)+','+c[1].toFixed(1);}).join(' L');
    var fillPath = linePath + ' L'+width+','+height+' L0,'+height+' Z';
    var baseline = '';
    if (startVal != null) {
      var by = height - ((startVal-min)/(max-min))*height;
      baseline = '<line x1="0" y1="'+by.toFixed(1)+'" x2="'+width+'" y2="'+by.toFixed(1)+'" stroke="#5a6b80" stroke-width="1" stroke-dasharray="2,3"/>';
    }
    return baseline + '<path d="'+fillPath+'" fill="'+color+'22" stroke="none"/>' + '<path d="'+linePath+'" fill="none" stroke="'+color+'" stroke-width="1.6"/>';
  }

  document.getElementById('pause-btn').addEventListener('click', function(){ fetch('/api/pause',{method:'POST'}); });
  document.getElementById('resume-btn').addEventListener('click', function(){ fetch('/api/resume',{method:'POST'}); });

  socket.on('state', function(s){
    document.getElementById('total-mark').textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    var pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl); pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    var relEl = document.getElementById('realized-pnl');
    relEl.textContent = sgn(s.totalRealizedPnl); relEl.className = 'stat-val ' + pClass(s.totalRealizedPnl);
    var unrelEl = document.getElementById('unrealized-pnl');
    unrelEl.textContent = sgn(s.totalUnrealizedPnl); unrelEl.className = 'stat-val ' + pClass(s.totalUnrealizedPnl);
    document.getElementById('total-bankroll').textContent = '$'+(s.totalBankroll||0).toFixed(2);
    document.getElementById('total-rebates').textContent = '$'+(s.totalRebatesEarned||0).toFixed(4);
    document.getElementById('win-rate').textContent = (s.winRate != null ? s.winRate.toFixed(1)+'%' : '—');
    document.getElementById('win-loss-sub').textContent = (s.totalWins||0)+'W / '+(s.totalLosses||0)+'L';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    var tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ACTIVE' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');
    document.getElementById('mode-badge').textContent = s.dryRun ? 'DRY RUN' : 'LIVE';
    document.getElementById('mode-badge').className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');

    var eqVal = document.getElementById('equity-val');
    eqVal.textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    eqVal.className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = buildEquitySvg(s.totalEquityCurve, 600, 90, s.totalCapital);

    var grid = document.getElementById('pair-grid');
    if (!s.pairStates || s.pairStates.length === 0) {
      grid.innerHTML = '<div class="empty">No pairs</div>';
    } else {
      grid.innerHTML = s.pairStates.map(function(p){
        var elapsed = p.windowElapsed || 0;
        var tfPct = Math.round((p.timeDecayFactor || 0) * 100);
        var hasTrades = p.tradesPlaced > 0;

        // Mid price boxes
        function midBox(side, label, mid, dev) {
          var cls = side === 'Up' ? 'mid-up' : 'mid-down';
          var midStr = mid != null ? mid.toFixed(4) : '—';
          var devStr = dev != null ? (dev * 100).toFixed(1)+'% from 0.50' : '';
          var arrow = mid != null ? (mid >= 0.50 ? '▲' : '▼') : '';
          return '<div class="mid-box '+cls+'"><div class="mid-title">'+label+' '+arrow+'</div><div class="mid-price">'+midStr+'</div><div class="mid-dev">'+devStr+'</div></div>';
        }

        // Active trades list
        var tradeHtml = '';
        if (p.activeTrades && p.activeTrades.length > 0) {
          tradeHtml = '<div class="trade-list">'+p.activeTrades.map(function(t){
            var stateCls = t.state === 'resting' ? 'trade-resting' : (t.state === 'filled' ? 'trade-filled' : 'trade-tp-sl');
            var sideCls = 'trade-side-' + t.side.toLowerCase();
            var tpStr = t.tpPrice != null ? '<span class="trade-tp">TP '+t.tpPrice.toFixed(4)+'</span>' : '';
            var slStr = t.slPrice != null ? '<span class="trade-sl">SL '+t.slPrice.toFixed(4)+'</span>' : '';
            return '<div class="trade-item '+stateCls+'"><span><span class="'+sideCls+'">'+t.side+'</span> '+t.shares+'sh @ '+t.entryPrice.toFixed(4)+'</span><span>'+tpStr+' '+slStr+'</span></div>';
          }).join('')+'</div>';
        } else if (p.tradesPlaced > 0) {
          tradeHtml = '<div style="color:var(--muted);font-size:9px;padding:4px;">All trades closed</div>';
        }
        if (p.tradesPlaced === 0 && p.tradable && elapsed > 10) {
          tradeHtml = '<div style="color:var(--muted);font-size:9px;padding:4px;">Waiting for overreaction…</div>';
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
            tradeHtml +
          '</div></div>';
      }).join('');
    }

    var tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(function(t){
        var pnlTxt = t.profit != null ? sgn(t.profit) : '—';
        var pnlCls = t.profit != null ? pClass(t.profit) : '';
        return '<tr><td>'+t.time+'</td><td>'+ (t.outcome||'') +'</td><td>'+(t.reason||'')+'</td><td>'+(t.price||0).toFixed(3)+'</td><td>'+(t.shares||0).toFixed(2)+'</td><td class="'+pnlCls+'">'+pnlTxt+'</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
    }

    var logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(function(l){
        var col = l.includes('❌') ? '#ff4757' : l.includes('💰')||l.includes('✅') ? '#00e676' : l.includes('🛑') ? '#e6a800' : l.includes('🔴')||l.includes('🟢') ? '#00d4ff' : '#4a6080';
        return '<div style="color:'+col+'">'+l+'</div>';
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }
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
