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
<title>📊 Momentum Re-Entry Ladder — Independent Up/Down</title>
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
  .toolbar button:hover { opacity: .85; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 20px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }

  .config-wrap { margin: 0 20px 14px; background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
  .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px 14px; }
  .config-item { font-size: 9px; color: var(--muted); display: flex; justify-content: space-between; }
  .config-item span:last-child { color: var(--text); }

  .pair-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 10px; }
  .pair-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .pair-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
  .pair-sym { font-size: 13px; font-weight: bold; color: #ddd; }
  .pair-timer { font-size: 10px; color: var(--cyan); }
  .pair-phase { font-size: 9px; padding: 2px 8px; border-radius: 10px; }
  .phase-open { background: #00a85433; color: var(--green); }
  .phase-closed { background: #e6a80033; color: var(--yellow); }
  .phase-sweep { background: #e8304a33; color: var(--red); }
  .pair-body { padding: 10px 12px; }
  .pair-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
  .pair-key { color: var(--muted); }

  .side-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .side-box { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg); }
  .side-box .side-title { font-size: 11px; font-weight: bold; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .side-box.up .side-title { color: var(--green); }
  .side-box.down .side-title { color: var(--red); }
  .side-box .tick-badge { font-size: 8px; color: var(--muted); font-weight: normal; }
  .side-box .side-row { font-size: 9px; color: var(--muted); display: flex; justify-content: space-between; margin-bottom: 3px; }
  .side-box .side-row span:last-child { color: var(--text); font-weight: bold; }
  .order-list { margin-top: 4px; border-top: 1px dashed var(--border); padding-top: 4px; }
  .order-list-title { font-size: 8px; color: var(--muted); text-transform: uppercase; margin-bottom: 2px; }
  .order-line { font-size: 9px; display: flex; justify-content: space-between; padding: 1px 0; }
  .order-line .tag-ticker { color: var(--cyan); }
  .order-line .tag-counter { color: var(--purple); }
  .order-line .sizedup { color: var(--gold); }
  .order-line .expiry { color: var(--red); }
  .order-empty { font-size: 9px; color: var(--muted); font-style: italic; }
  .pnl-mini { font-size: 9px; }

  .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 340px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .logs-wrap { background: #0d1420; border: 1px solid var(--border); border-radius: 10px; padding: 10px; max-height: 340px; overflow-y: auto; font-size: 10px; }
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
    <div class="logo">📊 <span>MOMENTUM RE-ENTRY LADDER</span> — INDEPENDENT UP/DOWN</div>
    <div id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? 'DRY RUN' : '🔴 LIVE'}</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">Pause</button>
    <button id="resume-btn" class="resume">Resume</button>
  </div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Total Asset Value</div><div class="stat-val" id="total-mark">$0.00</div></div>
    <div class="stat"><div class="stat-label">Total Net P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Account Bankroll</div><div class="stat-val" id="total-bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Rebates Received</div><div class="stat-val pnl-pos" id="total-rebates">$0.00</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val" id="win-rate">—</div></div>
    <div class="stat"><div class="stat-label">System State</div><div class="stat-val" id="trading-flag">—</div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">0s</div></div>
  </div>

  <div class="config-wrap">
    <div class="section-hdr" style="padding-top:0;">Strategy Config</div>
    <div class="config-grid" id="config-grid"></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr">
      <div class="title">Performance Curve</div>
      <div class="val" id="equity-val">$0.00</div>
    </div>
    <svg id="equity-chart" class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none"></svg>
  </div>

  <div class="section">
    <div class="section-hdr">Active Metric Matrix</div>
    <div class="pair-grid" id="pair-grid"><div class="empty">Loading Live Asset Configurations...</div></div>
  </div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr">Trade Logs</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Asset</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="7" class="empty">No executions recorded yet</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr">Console Output</div>
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
    return '<path d="'+fillPath+'" fill="'+color+'22" stroke="none"/>' + '<path d="'+linePath+'" fill="none" stroke="'+color+'" stroke-width="1.6"/>';
  }

  function rungLine(r) {
    const tpTxt = r.tpPrice != null ? r.tpPrice.toFixed(2) : (r.triggerPrice + 0.03).toFixed(2);
    const cycles = r.fillsCount ? ' · '+r.fillsCount+'x done' : '';
    if (r.status === 'holding') {
      return '<div class="order-line"><span><span class="tag-ticker">HOLD</span> #'+r.id+' entry '+r.entryPrice.toFixed(2)+' → TP '+tpTxt+cycles+'</span><span>'+(r.shares||0).toFixed(0)+'sh</span></div>';
    }
    if (r.status === 'pending') {
      return '<div class="order-line"><span><span class="tag-counter">BUY</span> #'+r.id+' resting @ '+r.pendingOrderPrice.toFixed(2)+' (trigger '+r.triggerPrice.toFixed(2)+')</span><span>—</span></div>';
    }
    return '<div class="order-line"><span class="order-empty">#'+r.id+' idle, trigger @ '+r.triggerPrice.toFixed(2)+cycles+'</span><span>—</span></div>';
  }

  function rungsList(s) {
    if (!s.rungs || s.rungs.length === 0) return '<div class="order-empty">no ladder data</div>';
    return s.rungs.map(rungLine).join('');
  }

  function sideBox(label, cls, s) {
    if (!s) s = {};
    return '<div class="side-box '+cls+'">'+
      '<div class="side-title"><span>'+label+'</span></div>'+
      '<div class="side-row"><span>Held (open rungs)</span><span>'+(s.heldShares||0).toFixed(0)+'sh ($'+(s.heldCost||0).toFixed(2)+')</span></div>'+
      '<div class="side-row"><span>Entries · TP · SL</span><span>'+(s.entries||0)+' · '+(s.tpHits||0)+' · '+(s.slHits||0)+'</span></div>'+
      '<div class="side-row pnl-mini"><span>Side W/L · P&amp;L</span><span class="'+pClass(s.realizedPnl)+'">'+(s.wins||0)+'W/'+(s.losses||0)+'L · '+sgn(s.realizedPnl)+'</span></div>'+
      '<div class="order-list"><div class="order-list-title">Ladder (9 rungs, re-entry on)</div>'+rungsList(s)+'</div>'+
    '</div>';
  }

  document.getElementById('pause-btn').addEventListener('click', async () => { await fetch('/api/pause', { method: 'POST' }); });
  document.getElementById('resume-btn').addEventListener('click', async () => { await fetch('/api/resume', { method: 'POST' }); });

  let configRendered = false;

  socket.on('state', s => {
    document.getElementById('total-mark').textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl); pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    document.getElementById('total-bankroll').textContent = '$'+(s.totalBankroll||0).toFixed(2);
    document.getElementById('total-rebates').textContent = '$'+(s.totalRebatesEarned||0).toFixed(4);
    document.getElementById('win-rate').textContent = (s.winRate != null ? s.winRate.toFixed(1)+'%' : '—') + ' ('+(s.totalWins||0)+'W/'+(s.totalLosses||0)+'L)';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    const tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ACTIVE' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');

    if (!configRendered && s.config) {
      const c = s.config;
      const ladderTxt = (c.ladderLevels||[]).map(l => l.triggerPrice.toFixed(2)+'→'+l.tpPrice.toFixed(2)).join(', ');
      const rows = [
        ['Ladder (both sides, independent)', ladderTxt],
        ['Rungs', (c.ladderLevels||[]).length + ' triggers, unlimited re-entry each'],
        ['TP Offset', 'entry + '+c.tpOffset.toFixed(2)],
        ['Size / Entry', c.baseShares+' fixed shares (cost = shares × price)'],
        ['Entry Placement', 'resting buy @ ask − '+c.entryOffset.toFixed(2)+' once trigger reached'],
        ['Hard Stop-Loss', c.hardSlPrice.toFixed(2)+' (flattens whole side, taker exit)'],
        ['Re-Entry', c.reEntry ? 'on — idle rung re-arms after TP or SL' : 'off'],
        ['Sweep At', c.sweepSecs+'s (cancels pending orders only)'],
        ['Entry Grace', 'first '+c.entryGraceSecs+'s of window ignored (thin/junk book)'],
        ['After Sweep', 'holding rungs ride untouched — TP & hard SL stay live'],
        ['Maker Rebate', (c.cryptoMakerRebateShare*100).toFixed(0)+'% of fee'],
      ];
      document.getElementById('config-grid').innerHTML = rows.map(r =>
        '<div class="config-item"><span>'+r[0]+'</span><span>'+r[1]+'</span></div>'
      ).join('');
      configRendered = true;
    }

    const eqVal = document.getElementById('equity-val');
    eqVal.textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    eqVal.className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = buildEquitySvg(s.totalEquityCurve, 600, 90, s.totalCapital);

    const grid = document.getElementById('pair-grid');
    if (!s.pairStates || s.pairStates.length === 0) {
      grid.innerHTML = '<div class="empty">No Asset Data</div>';
    } else {
      grid.innerHTML = s.pairStates.map(p => {
        const phaseCls = p.phase === 'LADDER ARMED' ? 'phase-open' : (p.phase === 'SWEPT / RESOLVING' ? 'phase-sweep' : (p.phase === 'GRACE PERIOD' ? 'phase-sweep' : 'phase-closed'));
        return '<div class="pair-card">'+
          '<div class="pair-hdr"><div class="pair-sym">'+p.symbol+' (5M Market)</div><div style="display:flex;gap:8px;align-items:center;"><div class="pair-phase '+phaseCls+'">'+p.phase+'</div><div class="pair-timer">'+fmtSecs(p.secsToEnd)+' left</div></div></div>'+
          '<div class="pair-body">'+
            '<div class="pair-row"><span class="pair-key">Up Ask/Bid</span><span>'+(p.upAsk?.toFixed(2)||'—')+' / '+(p.upBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Down Ask/Bid</span><span>'+(p.downAsk?.toFixed(2)||'—')+' / '+(p.downBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Bankroll</span><span>$'+(p.bankroll||0).toFixed(2)+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Realized / Unrealized P&amp;L</span><span class="'+pClass(p.realizedPnl)+'">'+sgn(p.realizedPnl)+' / <span class="'+pClass(p.unrealizedPnl)+'">'+sgn(p.unrealizedPnl)+'</span></span></div>'+
            '<div class="side-grid">'+sideBox('UP','up',p.sides?.Up)+sideBox('DOWN','down',p.sides?.Down)+'</div>'+
          '</div></div>';
      }).join('');
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlTxt = t.profit != null ? sgn(t.profit) : '—';
        const pnlCls = t.profit != null ? pClass(t.profit) : '';
        return '<tr><td>'+t.time+'</td><td>'+t.symbol+'</td><td>'+t.outcome+'</td><td>'+(t.reason||'')+'</td><td>'+(t.price||0).toFixed(3)+'</td><td>'+(t.shares||0).toFixed(2)+'</td><td class="'+pnlCls+'">'+pnlTxt+'</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No executions recorded yet</td></tr>';
    }

    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌') ? '#ff4757' : l.includes('✅') || l.includes('💰') ? '#00e676' : (l.includes('🛑') || l.includes('⏭️') ? '#e6a800' : (l.includes('🔁') ? '#b98cff' : '#00d4ff'));
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
if (!PK) { console.error('❌ PRIVATE_KEY environment variable missing'); process.exit(1); }

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard Online: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Initialization failure:', e.message);
    process.exit(1);
  });
});
