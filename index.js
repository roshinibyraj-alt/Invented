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

app.post('/api/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(bot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⏱️ BTC 5-Minute Dual Limit-Order Bot</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --purple: #7c3aed; --gold: #b8860b;
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
  .toolbar button.live-toggle { background: var(--red); color: #fff; }
  .toolbar button.live-toggle.is-live { background: var(--muted); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .toolbar-status { padding: 6px 20px 0; font-size: 10px; color: var(--muted); min-height: 14px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 20px; font-weight: bold; color: #12202e; }
  .stat-sub { font-size: 9px; color: var(--muted); margin-top: 3px; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .win-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
  .win-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .win-card.has-pos { border-color: var(--cyan); box-shadow: 0 0 0 1px #00d4ff22; }
  .win-card.untradable { opacity: .55; }
  .win-card.resolved { opacity: .7; }
  .win-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
  .win-sym { font-size: 12px; font-weight: bold; color: #ddd; }
  .win-timer { font-size: 10px; color: var(--cyan); }
  .win-body { padding: 8px 12px; }
  .strat-hdr { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin: 8px 0 4px; border-top: 1px solid var(--border); padding-top: 6px; }
  .strat-hdr:first-child { margin-top: 0; border-top: none; padding-top: 0; }
  .side-row { display: flex; justify-content: space-between; margin-bottom: 3px; font-size: 10px; }
  .side-up { color: var(--green); }
  .side-down { color: var(--red); }
  .side-key { color: var(--muted); }
  .trig-note { font-size: 9px; color: #8aa; margin-bottom: 4px; }
  .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
  @media (max-width: 800px) { .bottom-grid { grid-template-columns: 1fr; } }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .logs-wrap { background: #0d1420; border: 1px solid var(--border); border-radius: 10px; padding: 10px; max-height: 320px; overflow-y: auto; font-size: 10px; }
  .logs-wrap div { padding: 1px 0; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 10px; }
  .equity-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin: 0 20px 14px; }
  .equity-hdr { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .equity-hdr .title { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .equity-hdr .val { font-size: 13px; }
  .equity-svg { width: 100%; height: 90px; display: block; }
  .config-strip { padding: 0 20px 10px; font-size: 9px; color: var(--muted); display: flex; gap: 18px; flex-wrap: wrap; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">⏱️ <span>BTC 5m</span> DUAL LIMIT-ORDER BOT</div>
    <div id="mode-badge" class="mode-badge ${bot.getStatus().dryRun ? 'mode-dry' : 'mode-live'}">${bot.getStatus().dryRun ? 'DEMO' : '🔴 LIVE'}</div>
    <div id="experiment-badge" class="mode-badge mode-dry">STRAT1 0.30→0.70/0.10 | STRAT2 0.70 TRIGGER→0.70/0.30</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">Pause</button>
    <button id="resume-btn" class="resume">Resume</button>
    <button id="mode-toggle-btn" class="live-toggle">Switch to LIVE</button>
  </div>
  <div id="toolbar-status" class="toolbar-status"></div>
  <div id="config-strip" class="config-strip"></div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Mark Value</div><div class="stat-val" id="total-mark">$0.00</div></div>
    <div class="stat"><div class="stat-label">Total P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Realized</div><div class="stat-val" id="realized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Unrealized</div><div class="stat-val" id="unrealized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val" id="total-bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Fees Paid</div><div class="stat-val pnl-neg" id="total-fees">$0.00</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val" id="win-rate">—</div><div class="stat-sub" id="win-loss-sub">0W / 0L</div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">0s</div></div>
    <div class="stat"><div class="stat-label">Trading</div><div class="stat-val" id="trading-flag">—</div></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr">
      <div class="title">Equity Curve</div>
      <div class="val" id="equity-val">$0.00</div>
    </div>
    <svg id="equity-chart" class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none"></svg>
  </div>

  <div class="section">
    <div class="section-hdr">5-Minute Windows</div>
    <div class="win-grid" id="win-grid"><div class="empty">Loading…</div></div>
  </div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr">Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Strat</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="7" class="empty">No trades yet</td></tr></tbody>
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
  function fmt(s) { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60; return (h?h+'h ':'')+(m?m+'m ':'')+ss+'s'; }
  function fmtSecs(s) { if (s === null || s === undefined) return '—'; const m = Math.floor(s/60), ss = s%60; return m+'m '+String(ss).padStart(2,'0')+'s'; }

  // Build an SVG polyline + fill path from an equity curve [{t,equity}],
  function buildEquitySvg(points, width, height, startVal) {
    if (!points || points.length < 2) {
      return '<line x1="0" y1="'+(height/2)+'" x2="'+width+'" y2="'+(height/2)+'" stroke="#3a4a60" stroke-width="1" stroke-dasharray="3,3"/>';
    }
    const vals = points.map(p => p.equity);
    let min = Math.min(...vals, startVal != null ? startVal : vals[0]);
    let max = Math.max(...vals, startVal != null ? startVal : vals[0]);
    if (max - min < 0.01) { max += 1; min -= 1; }
    const n = points.length;
    const coords = points.map((p, i) => {
      const x = (i / (n - 1)) * width;
      const y = height - ((p.equity - min) / (max - min)) * height;
      return [x, y];
    });
    const up = vals[vals.length - 1] >= vals[0];
    const color = up ? '#00c853' : '#ff4757';
    const linePath = 'M' + coords.map(c => c[0].toFixed(1)+','+c[1].toFixed(1)).join(' L');
    const fillPath = linePath + ' L' + width + ',' + height + ' L0,' + height + ' Z';
    let baseline = '';
    if (startVal != null) {
      const by = height - ((startVal - min) / (max - min)) * height;
      baseline = '<line x1="0" y1="'+by.toFixed(1)+'" x2="'+width+'" y2="'+by.toFixed(1)+'" stroke="#5a6b80" stroke-width="1" stroke-dasharray="2,3"/>';
    }
    return baseline +
      '<path d="'+fillPath+'" fill="'+color+'22" stroke="none"/>' +
      '<path d="'+linePath+'" fill="none" stroke="'+color+'" stroke-width="1.6"/>';
  }

  document.getElementById('pause-btn').addEventListener('click', async () => {
    await fetch('/api/pause', { method: 'POST' });
  });
  document.getElementById('resume-btn').addEventListener('click', async () => {
    await fetch('/api/resume', { method: 'POST' });
  });
  document.getElementById('mode-toggle-btn').addEventListener('click', async () => {
    const btn = document.getElementById('mode-toggle-btn');
    const goingLive = btn.textContent.includes('LIVE');
    const msg = goingLive
      ? 'Switch to LIVE trading? This places real orders with real money.'
      : 'Switch back to DEMO mode? New orders will be simulated again.';
    if (!confirm(msg)) return;
    const statusEl = document.getElementById('toolbar-status');
    try {
      const r = await fetch('/api/set-mode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ live: goingLive }) });
      const d = await r.json();
      statusEl.textContent = d.ok ? ('✅ Now in ' + (d.dryRun ? 'DEMO' : 'LIVE') + ' mode') : ('❌ ' + (d.error||'failed'));
    } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });

  function sideLabelClass(label) { return label === 'Up' ? 'side-up' : 'side-down'; }

  function sideStatusHtml(label, s) {
    let stateHtml;
    switch (s.state) {
      case 'idle':                 stateHtml = 'not placed yet'; break;
      case 'resting':               stateHtml = 'resting order…'; break;
      case 'filled':                 stateHtml = 'holding '+(s.shares!=null?s.shares.toFixed(2):'—')+'sh @ '+(s.entryFillPrice!=null?s.entryFillPrice.toFixed(2):'—'); break;
      case 'tp_filled':             stateHtml = 'TP hit @ '+(s.exitPrice!=null?s.exitPrice.toFixed(2):'—')+' → '+sgn(s.pnl); break;
      case 'sl_exit':                stateHtml = 'SL hit @ '+(s.exitPrice!=null?s.exitPrice.toFixed(2):'—')+' → '+sgn(s.pnl); break;
      case 'holding_to_resolution':  stateHtml = 'holding to resolution…'; break;
      case 'resolved':               stateHtml = (s.pnl>=0?'won':'lost')+' → '+sgn(s.pnl); break;
      case 'expired_unfilled':      stateHtml = 'never filled'; break;
      default:                       stateHtml = s.state || '—';
    }
    const cls = (s.pnl != null) ? pClass(s.pnl) : '';
    return '<div class="side-row"><span class="side-key '+sideLabelClass(label)+'">'+label+'</span><span class="'+cls+'">'+stateHtml+'</span></div>';
  }

  socket.on('state', s => {
    const modeBadge = document.getElementById('mode-badge');
    modeBadge.className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    modeBadge.textContent = s.dryRun ? 'DEMO' : '🔴 LIVE';
    const toggleBtn = document.getElementById('mode-toggle-btn');
    toggleBtn.textContent = s.dryRun ? 'Switch to LIVE' : 'Switch to DEMO';
    toggleBtn.className = 'live-toggle' + (s.dryRun ? '' : ' is-live');

    if (s.config) {
      const c1 = s.config.strat1, c2 = s.config.strat2;
      document.getElementById('config-strip').innerHTML =
        '<span>Strat1: buy @'+c1.buyPrice+' · TP @'+c1.tpPrice+' · SL @'+c1.slPrice+' · $'+c1.bet+'/side</span>' +
        '<span>Strat2: trigger @'+c2.triggerPrice+' · buy @'+c2.buyPrice+' · SL @'+c2.slPrice+' · $'+c2.bet+'/side</span>';
    }

    document.getElementById('total-mark').textContent = '$'+(s.markValue||0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl); pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    const relEl = document.getElementById('realized-pnl');
    relEl.textContent = sgn(s.realizedPnl); relEl.className = 'stat-val ' + pClass(s.realizedPnl);
    const unrelEl = document.getElementById('unrealized-pnl');
    unrelEl.textContent = sgn(s.unrealizedPnl); unrelEl.className = 'stat-val ' + pClass(s.unrealizedPnl);
    document.getElementById('total-bankroll').textContent = '$'+(s.bankroll||0).toFixed(2);
    document.getElementById('total-fees').textContent = '$'+(s.feesPaid||0).toFixed(4);
    document.getElementById('win-rate').textContent = (s.winRate!==null && s.winRate!==undefined) ? s.winRate+'%' : '—';
    document.getElementById('win-loss-sub').textContent = (s.wins||0)+'W / '+(s.losses||0)+'L';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    const tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ON' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');

    const eqVal = document.getElementById('equity-val');
    eqVal.textContent = '$'+(s.markValue||0).toFixed(2);
    eqVal.className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = buildEquitySvg(s.equityCurve, 600, 90, s.totalCapital);

    const grid = document.getElementById('win-grid');
    if (!s.windows || s.windows.length === 0) {
      grid.innerHTML = '<div class="empty">Loading window…</div>';
    } else {
      grid.innerHTML = s.windows.map(w => {
        const hasPos = [w.strat1.up, w.strat1.down, w.strat2.up, w.strat2.down].some(x => x.state === 'filled' || x.state === 'holding_to_resolution');
        const trigNote = w.strat2.triggered
          ? '<div class="trig-note">⚡ triggered by '+w.strat2.triggerSide+' @ '+(w.strat2.triggerPrice!=null?w.strat2.triggerPrice.toFixed(2):'—')+'</div>'
          : '<div class="trig-note" style="opacity:.6">watching for 0.70 tick…</div>';
        return '<div class="win-card '+(hasPos?'has-pos':'')+' '+(w.tradable?'':'untradable')+' '+(w.resolved?'resolved':'')+'">'+
          '<div class="win-hdr"><div class="win-sym">'+w.id+'</div><div class="win-timer">'+(w.resolved?'resolved':(w.tradable?fmtSecs(w.secsToEnd):'loading…'))+'</div></div>'+
          '<div class="win-body">'+
            '<div class="strat-hdr">Strategy 1 — buy 0.30 / TP 0.70 / SL 0.10</div>'+
            sideStatusHtml('Up', w.strat1.up) +
            sideStatusHtml('Down', w.strat1.down) +
            '<div class="strat-hdr">Strategy 2 — trigger 0.70 / SL 0.30 / TP by resolution</div>'+
            trigNote +
            sideStatusHtml('Up', w.strat2.up) +
            sideStatusHtml('Down', w.strat2.down) +
          '</div></div>';
      }).join('');
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? pClass(t.profit) : '';
        const sideColor = t.side === 'BUY' ? '#ffd740' : (t.reason === 'SL' ? '#ff4757' : (t.reason==='TP'?'#00e676':'#00d4ff'));
        return '<tr><td>'+t.time+'</td><td>S'+(t.strategy||'—')+'</td>'+
          '<td style="color:'+sideColor+'">'+t.side+(t.outcome?(' '+t.outcome):'')+'</td>'+
          '<td>'+(t.reason||'—')+'</td>'+
          '<td>'+(t.price||0).toFixed(3)+'</td>'+
          '<td>'+(t.shares||0).toFixed(2)+'</td>'+
          '<td class="'+pnlCls+'">'+pnlStr+'</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>';
    }

    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('💥') ? '#ff4757'
                  : l.includes('💰')||l.includes('✅') ? '#00e676'
                  : l.includes('🎯')||l.includes('⚡') ? '#ffd740'
                  : l.includes('🪟')||l.includes('⏳') ? '#00d4ff'
                  : l.includes('⚠️') ? '#ff9f0a'
                  : '#4a6080';
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

console.log(`⏱️ BTC 5-Minute Dual Limit-Order Bot`);
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — simulated fills, real API for market/price data');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
