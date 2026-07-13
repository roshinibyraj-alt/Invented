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
<title>🎯 BTC 0.96 Breakout + Recovery Bot</title>
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
  .mode-recovery { background: #7c3aed22; color: var(--purple); border: 1px solid var(--purple); }
  .mode-base { background: #00a85422; color: var(--green); border: 1px solid var(--green); }
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

  .market-panel { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin: 0 20px 16px; }
  .market-hdr { background: #0d1d30; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .market-sym { font-size: 16px; font-weight: bold; color: #ddd; }
  .phase-badge { padding: 3px 12px; border-radius: 14px; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .phase-waiting { background: #7a8fa822; color: #aab8c9; border: 1px solid #7a8fa8; }
  .phase-watching { background: #e6a80022; color: var(--yellow); border: 1px solid var(--yellow); animation: pulse 1.5s infinite; }
  .phase-holding { background: #0099cc22; color: var(--cyan); border: 1px solid var(--cyan); }
  .phase-closed { background: #4a608022; color: #8aa0bb; border: 1px solid #4a6080; }
  .market-timer { font-size: 11px; color: var(--cyan); }
  .market-body { padding: 14px 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 700px) { .market-body { grid-template-columns: 1fr; } }
  .price-box { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .price-box-hdr { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .price-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 11px; }
  .price-key { color: var(--muted); }
  .side-up { color: var(--green); }
  .side-down { color: var(--red); }
  .trigger-line { font-size: 9px; color: var(--gold); margin-top: 4px; }
  .pos-box { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .pos-empty { color: var(--muted); font-size: 10px; text-align: center; padding: 10px 0; }
  .pos-tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; margin-left: 6px; }
  .tag-base { background: #00a85422; color: var(--green); }
  .tag-recovery { background: #7c3aed22; color: var(--purple); }
  .sl-line { color: var(--red); font-size: 9px; margin-top: 4px; }

  .recovery-panel { margin: 0 20px 16px; background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
  .recovery-panel.armed { border-color: var(--purple); box-shadow: 0 0 0 1px #7c3aed22; }
  .recovery-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }

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
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🎯 <span>BTC</span> 0.96 BREAKOUT BOT</div>
    <div id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? 'DEMO' : '🔴 LIVE'}</div>
    <div id="recovery-badge" class="mode-badge mode-base">BASE</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">Pause</button>
    <button id="resume-btn" class="resume">Resume</button>
    <button id="mode-toggle-btn" class="live-toggle">Switch to LIVE</button>
  </div>
  <div id="toolbar-status" class="toolbar-status"></div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Mark Value</div><div class="stat-val" id="total-mark">$0.00</div></div>
    <div class="stat"><div class="stat-label">Total P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Realized</div><div class="stat-val" id="realized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Unrealized</div><div class="stat-val" id="unrealized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val" id="total-bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Fees Paid</div><div class="stat-val" id="total-fees">$0.00</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val" id="win-rate">—</div><div class="stat-sub" id="win-loss-sub">0W / 0L</div></div>
    <div class="stat"><div class="stat-label">Trading</div><div class="stat-val" id="trading-flag">ON</div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">0s</div></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr"><div class="title">Equity Curve</div><div class="val" id="equity-val">$0.00</div></div>
    <div id="equity-chart"><svg class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none"></svg></div>
  </div>

  <div class="section"><div class="section-hdr">Market</div></div>
  <div id="market-panel" class="market-panel"></div>

  <div class="section"><div class="section-hdr">Recovery Status</div></div>
  <div id="recovery-panel" class="recovery-panel"></div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr" style="padding:0 0 8px">Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="6" class="empty">No trades yet</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr" style="padding:0 0 8px">Logs</div>
      <div class="logs-wrap" id="logs"></div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const statusEl = document.getElementById('toolbar-status');
  const sgn = v => (v >= 0 ? '+$' : '-$') + Math.abs(v || 0).toFixed(2);
  const pClass = v => (v >= 0 ? 'pnl-pos' : 'pnl-neg');
  const fmt = s => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60); return (h?h+'h ':'')+(m?m+'m ':'')+sec+'s'; };
  const fmtSecs = s => { const m = Math.floor(s/60), sec = s%60; return m+'m '+String(sec).padStart(2,'0')+'s'; };

  function buildEquitySvg(curve, w, h, capitalLine) {
    if (!curve || curve.length < 2) return '';
    const vals = curve.map(p => p.equity);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (capitalLine != null) { min = Math.min(min, capitalLine); max = Math.max(max, capitalLine); }
    const pad = (max - min) * 0.1 || 1;
    min -= pad; max += pad;
    const pts = curve.map((p, i) => {
      const x = (i / (curve.length - 1)) * w;
      const y = h - ((p.equity - min) / (max - min)) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = vals[vals.length - 1], first = vals[0];
    const color = last >= first ? '#00a854' : '#e8304a';
    let extra = '';
    if (capitalLine != null) {
      const y = h - ((capitalLine - min) / (max - min)) * h;
      extra = '<line x1="0" y1="'+y.toFixed(1)+'" x2="'+w+'" y2="'+y.toFixed(1)+'" stroke="#7a8fa8" stroke-width="1" stroke-dasharray="3,3" />';
    }
    return extra + '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="2" />';
  }

  document.getElementById('pause-btn').addEventListener('click', async () => {
    try { const r = await fetch('/api/pause', { method: 'POST' }); const d = await r.json(); statusEl.textContent = d.ok ? '⏸️ Paused' : '❌ ' + (d.error||'failed'); } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });
  document.getElementById('resume-btn').addEventListener('click', async () => {
    try { const r = await fetch('/api/resume', { method: 'POST' }); const d = await r.json(); statusEl.textContent = d.ok ? '▶️ Resumed' : '❌ ' + (d.error||'failed'); } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });
  document.getElementById('mode-toggle-btn').addEventListener('click', async () => {
    const btn = document.getElementById('mode-toggle-btn');
    const goingLive = btn.textContent.includes('LIVE');
    if (goingLive && !confirm('Switch to LIVE mode? This will place real orders with real money.')) return;
    try {
      const r = await fetch('/api/set-mode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ live: goingLive }) });
      const d = await r.json();
      statusEl.textContent = d.ok ? ('✅ Now in ' + (d.dryRun ? 'DEMO' : 'LIVE') + ' mode') : ('❌ ' + (d.error||'failed'));
    } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });

  socket.on('state', s => {
    const modeBadge = document.getElementById('mode-badge');
    modeBadge.className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    modeBadge.textContent = s.dryRun ? 'DEMO' : '🔴 LIVE';
    const toggleBtn = document.getElementById('mode-toggle-btn');
    toggleBtn.textContent = s.dryRun ? 'Switch to LIVE' : 'Switch to DEMO';
    toggleBtn.className = 'live-toggle' + (s.dryRun ? '' : ' is-live');

    const recBadge = document.getElementById('recovery-badge');
    if (s.recovery && s.recovery.armed) {
      recBadge.className = 'mode-badge mode-recovery';
      recBadge.textContent = 'RECOVERY ARMED (' + s.recovery.targetShares + 'sh)';
    } else {
      recBadge.className = 'mode-badge mode-base';
      recBadge.textContent = 'BASE';
    }

    document.getElementById('total-mark').textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl); pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    const relEl = document.getElementById('realized-pnl');
    relEl.textContent = sgn(s.totalRealizedPnl); relEl.className = 'stat-val ' + pClass(s.totalRealizedPnl);
    const unrelEl = document.getElementById('unrealized-pnl');
    unrelEl.textContent = sgn(s.totalUnrealizedPnl); unrelEl.className = 'stat-val ' + pClass(s.totalUnrealizedPnl);
    document.getElementById('total-bankroll').textContent = '$'+(s.totalBankroll||0).toFixed(2);
    document.getElementById('total-fees').textContent = '$'+(s.totalFeesPaid||0).toFixed(4);
    document.getElementById('win-rate').textContent = (s.winRate!==null && s.winRate!==undefined) ? s.winRate+'%' : '—';
    document.getElementById('win-loss-sub').textContent = (s.totalWins||0)+'W / '+(s.totalLosses||0)+'L';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    const tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ON' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');

    const eqVal = document.getElementById('equity-val');
    eqVal.textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    eqVal.className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = '<svg class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none">'+buildEquitySvg(s.totalEquityCurve, 600, 90, s.totalCapital)+'</svg>';

    const p = s.pairState;
    const marketPanel = document.getElementById('market-panel');
    if (!p) {
      marketPanel.innerHTML = '<div class="empty">Loading market…</div>';
    } else {
      const phaseLabel = { waiting: 'WAITING (' + (p.secsToWatch!=null ? fmtSecs(p.secsToWatch) + ' to watch phase' : '…') + ')', watching: 'WATCHING for 0.96', holding: 'HOLDING position', closed: 'WINDOW CLOSED' }[p.phase] || p.phase;
      const posHtml = p.position
        ? '<div class="pos-box">'+
            '<div class="price-box-hdr">Open Position <span class="pos-tag '+(p.position.mode==='recovery'?'tag-recovery':'tag-base')+'">'+p.position.mode.toUpperCase()+'</span></div>'+
            '<div class="price-row"><span class="price-key">Side</span><span class="'+(p.position.side==='Up'?'side-up':'side-down')+'">'+p.position.side+'</span></div>'+
            '<div class="price-row"><span class="price-key">Shares</span><span>'+p.position.shares+'sh @ '+p.position.entryPrice.toFixed(2)+'</span></div>'+
            '<div class="price-row"><span class="price-key">Cost</span><span>$'+p.position.cost.toFixed(2)+'</span></div>'+
            '<div class="sl-line">Stop-loss armed at '+(s.config?s.config.slPrice.toFixed(2):'0.50')+'</div>'+
          '</div>'
        : '<div class="pos-box"><div class="pos-empty">No open position'+(p.phase==='watching'?' — watching for either side to hit '+(s.config?s.config.entryPrice.toFixed(2):'0.96'):'')+'</div></div>';
      marketPanel.innerHTML =
        '<div class="market-hdr">'+
          '<div class="market-sym">'+p.symbol+'</div>'+
          '<div class="phase-badge phase-'+p.phase+'">'+phaseLabel+'</div>'+
          '<div class="market-timer">'+(p.tradable?fmtSecs(p.secsToEnd):'loading…')+' left in window</div>'+
        '</div>'+
        '<div class="market-body">'+
          '<div class="price-box">'+
            '<div class="price-box-hdr">Live Prices</div>'+
            '<div class="price-row"><span class="price-key side-up">Up ask/bid</span><span>'+(p.upAsk?.toFixed(2)||'—')+' / '+(p.upBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="price-row"><span class="price-key side-down">Down ask/bid</span><span>'+(p.downAsk?.toFixed(2)||'—')+' / '+(p.downBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="trigger-line">Entry trigger: either ask ≥ '+(s.config?s.config.entryPrice.toFixed(2):'0.96')+'</div>'+
          '</div>'+
          posHtml+
        '</div>';
    }

    const recPanel = document.getElementById('recovery-panel');
    recPanel.className = 'recovery-panel' + (s.recovery && s.recovery.armed ? ' armed' : '');
    if (s.recovery && s.recovery.armed) {
      recPanel.innerHTML = '<div class="recovery-row">'+
        '<div>🔁 Recovery armed for next entry — <b>'+s.recovery.targetShares+' shares</b> @ '+(s.config?s.config.entryPrice.toFixed(2):'0.96')+'</div>'+
        '<div>Covering loss of <span class="pnl-neg">$'+s.recovery.lossToCover.toFixed(2)+'</span> + $'+s.recovery.extraProfit.toFixed(2)+' target profit</div>'+
      '</div>';
    } else {
      recPanel.innerHTML = '<div class="recovery-row"><div>No recovery armed — next entry uses base size ('+(s.config?s.config.baseShares:6)+' shares)</div></div>';
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? pClass(t.profit) : '';
        const sideColor = t.side === 'BUY' ? '#ffd740' : (t.reason === 'SL' ? '#ff4757' : (t.reason==='RESOLUTION'?'#00e676':'#00d4ff'));
        return '<tr><td>'+t.time+'</td>'+
          '<td style="color:'+sideColor+'">'+t.side+(t.outcome?(' '+t.outcome):'')+'</td>'+
          '<td>'+(t.reason||'—')+'</td>'+
          '<td>'+(t.price||0).toFixed(3)+'</td>'+
          '<td>'+(t.shares||0)+'</td>'+
          '<td class="'+pnlCls+'">'+pnlStr+'</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
    }

    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('💥') ? '#ff4757'
                  : l.includes('💰')||l.includes('✅') ? '#00e676'
                  : l.includes('🎯')||l.includes('🧯') ? '#ffd740'
                  : l.includes('🔭')||l.includes('⏰') ? '#00d4ff'
                  : l.includes('🔁') ? '#7c3aed'
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

console.log(`🎯 BTC 0.96 Breakout + Recovery Bot`);
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo capital, simulated fills, real API for data/orders');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
