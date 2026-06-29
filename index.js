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

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>⚽ FIFA Arb Bot</title>
  <style>
    :root {
      --bg:     #070c10;
      --bg2:    #0d1520;
      --bg3:    #111d2b;
      --border: #1a2d42;
      --text:   #c9d8e8;
      --muted:  #3d5066;
      --cyan:   #00d4ff;
      --green:  #00e676;
      --red:    #ff4757;
      --yellow: #ffd740;
      --purple: #bf5af2;
      --orange: #ff9f0a;
      --gold:   #f5c518;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; }

    /* Header */
    .header {
      background: linear-gradient(135deg, #081428, #0c1e38);
      border-bottom: 2px solid #00d4ff33;
      padding: 14px 20px;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
    }
    .logo { font-size: 22px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
    .logo span { color: var(--cyan); }
    .match-tag {
      font-size: 11px; background: #00d4ff11; color: var(--cyan);
      border: 1px solid #00d4ff33; border-radius: 20px; padding: 4px 12px;
    }
    .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
    .mode-dry  { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
    .mode-live { background: #ff475722; color: var(--red);    border: 1px solid var(--red); animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

    /* Stats row */
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 14px 20px; }
    .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .stat-val   { font-size: 20px; font-weight: bold; color: #fff; }
    .stat-sub   { font-size: 9px; color: var(--muted); margin-top: 3px; }

    /* Match info bar */
    .match-bar {
      background: var(--bg2); border: 1px solid var(--border);
      margin: 0 20px 14px; border-radius: 10px; padding: 10px 16px;
      display: flex; gap: 24px; flex-wrap: wrap; align-items: center;
    }
    .match-bar-item { font-size: 10px; }
    .match-bar-label { color: var(--muted); margin-right: 6px; }
    .match-bar-val { color: var(--cyan); font-weight: bold; }

    /* Arb rule types legend */
    .legend {
      display: flex; flex-wrap: wrap; gap: 6px;
      padding: 0 20px 14px;
    }
    .leg-item {
      font-size: 9px; padding: 2px 8px; border-radius: 8px;
      background: #ffffff08; border: 1px solid #ffffff15; color: #aaa;
    }

    /* Positions grid */
    .section { padding: 0 20px 16px; }
    .section-hdr {
      font-size: 10px; color: var(--muted); text-transform: uppercase;
      letter-spacing: 2px; padding: 8px 0 8px;
      display: flex; align-items: center; gap: 8px;
    }
    .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }

    .pos-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
    .pos-card {
      background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
    }
    .pos-card.profit { border-color: #00e67633; }
    .pos-card.loss   { border-color: #ff475733; }
    .pos-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
    .pos-type { font-size: 9px; color: var(--purple); background: #bf5af211; border: 1px solid #bf5af233; border-radius: 6px; padding: 1px 6px; }
    .pos-label { font-size: 10px; color: #ccc; flex: 1; margin-right: 8px; }
    .pos-body { padding: 8px 12px; }
    .pos-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
    .pos-key { color: var(--muted); }
    .pnl-pos { color: var(--green); }
    .pnl-neg { color: var(--red); }

    /* Trade/log tables */
    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
    @media (max-width: 700px) { .bottom-grid { grid-template-columns: 1fr; } }
    .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 280px; overflow-y: auto; }
    .tbl { width: 100%; border-collapse: collapse; }
    .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
    .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
    .tbl tr:last-child td { border-bottom: none; }
    .log-wrap { background: #040810; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; height: 280px; overflow-y: auto; font-size: 11px; line-height: 1.7; }
    .scan-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--cyan); margin-right: 6px; animation: blink 1.5s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
    .empty { color: var(--muted); padding: 20px; text-align: center; font-size: 11px; }

    .c-cyan   { color: var(--cyan) !important; }
    .c-green  { color: var(--green) !important; }
    .c-red    { color: var(--red) !important; }
    .c-yellow { color: var(--yellow) !important; }
    .c-gold   { color: var(--gold) !important; }
    .c-purple { color: var(--purple) !important; }
  </style>
</head>
<body>

<div class="header">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div class="logo">⚽ FIFA <span>Arb</span>Bot</div>
    <div class="match-tag" id="match-slug">loading…</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="color:var(--muted);font-size:10px"><span class="scan-dot"></span><span id="scan-ago">scanning…</span></span>
    <span id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? '⚠️ DRY RUN' : '🔴 LIVE'}</span>
  </div>
</div>

<!-- Stats -->
<div class="stats-row">
  <div class="stat"><div class="stat-label">Balance</div><div class="stat-val c-cyan" id="capital">—</div><div class="stat-sub">USDC</div></div>
  <div class="stat"><div class="stat-label">Session P&L</div><div class="stat-val" id="pnl">—</div><div class="stat-sub">vs start</div></div>
  <div class="stat"><div class="stat-label">Realized P&L</div><div class="stat-val" id="realized">—</div><div class="stat-sub">closed</div></div>
  <div class="stat"><div class="stat-label">Open Positions</div><div class="stat-val c-purple" id="active-count">—</div><div class="stat-sub" id="rules-count">— arb rules</div></div>
  <div class="stat"><div class="stat-label">Markets</div><div class="stat-val c-gold" id="markets-count">—</div><div class="stat-sub" id="prices-count">— prices</div></div>
  <div class="stat"><div class="stat-label">Match Ends</div><div class="stat-val c-yellow" id="mins-to-end">—</div><div class="stat-sub">minutes</div></div>
  <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">—</div><div class="stat-sub">hh:mm:ss</div></div>
</div>

<!-- Match bar -->
<div class="match-bar">
  <div class="match-bar-item"><span class="match-bar-label">Event:</span><span class="match-bar-val" id="bar-slug">—</span></div>
  <div class="match-bar-item"><span class="match-bar-label">Arb Rules:</span><span class="match-bar-val" id="bar-rules">—</span></div>
  <div class="match-bar-item"><span class="match-bar-label">Unrealized:</span><span class="match-bar-val" id="bar-unrealized">—</span></div>
  <div class="match-bar-item"><span class="match-bar-label">End Time:</span><span class="match-bar-val" id="bar-endtime">—</span></div>
</div>

<!-- Arb type legend -->
<div class="legend">
  <span class="leg-item" style="color:#00d4ff">LADDER_TOTAL: Goals over-line ladder</span>
  <span class="leg-item" style="color:#00e676">TEAM_VS_MATCH: Team total vs match total</span>
  <span class="leg-item" style="color:#bf5af2">BTTS_VS_*: Both teams to score vs team scoring</span>
  <span class="leg-item" style="color:#ffd740">SPREAD_VS_ML: Spread vs moneyline</span>
  <span class="leg-item" style="color:#ff9f0a">HT_VS_FT: Halftime vs fulltime</span>
  <span class="leg-item" style="color:#f5c518">LADDER_CORNERS: Corners over-line ladder</span>
  <span class="leg-item" style="color:#ff4757">LADDER_GER/PAR: Team total ladders</span>
  <span class="leg-item" style="color:#aaa">H1_VS_MATCH: Half total vs match total</span>
</div>

<!-- Open positions -->
<div class="section">
  <div class="section-hdr">Open Arb Positions</div>
  <div class="pos-grid" id="pos-grid"><div class="empty">🔭 No open positions — scanning for arbs…</div></div>
</div>

<!-- Trades + Logs -->
<div class="bottom-grid">
  <div>
    <div class="section-hdr" style="margin:0 0 8px">Arb Trades</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Time</th><th>Type</th><th>Label</th><th>Shares</th><th>Entry</th><th>Edge</th><th>Cost</th></tr></thead>
        <tbody id="trade-body"><tr><td colspan="7" class="empty">No trades yet</td></tr></tbody>
      </table>
    </div>
  </div>
  <div>
    <div class="section-hdr" style="margin:0 0 8px">Bot Logs</div>
    <div class="log-wrap" id="logs"></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  function fmt(s) {
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
    return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');
  }
  function sgn(v) { return (v>=0?'+':'')+(v||0).toFixed(2); }
  function pClass(v) { return v>=0?'c-green':'c-red'; }

  const TYPE_COLORS = {
    LADDER_TOTAL:'#00d4ff', LADDER_GER:'#ff4757', LADDER_PAR:'#ff4757',
    LADDER_CORNERS:'#f5c518', LADDER_HT:'#aaa', LADDER_H2:'#aaa',
    LADDER_GER_CORNERS:'#ff9f0a', LADDER_PAR_CORNERS:'#ff9f0a',
    TEAM_VS_MATCH_GER:'#00e676', TEAM_VS_MATCH_PAR:'#00e676',
    BTTS_VS_GER05:'#bf5af2', BTTS_VS_PAR05:'#bf5af2',
    SPREAD_VS_ML_GER:'#ffd740', HT_VS_FT_GER:'#ff9f0a',
    ADVANCE_VS_ML:'#f5c518', H1_VS_MATCH:'#aaa',
  };

  socket.on('state', s => {
    // Stats
    document.getElementById('capital').textContent = '$'+(s.capital||0).toFixed(2);
    const pnlEl = document.getElementById('pnl');
    pnlEl.textContent = sgn(s.pnl||0);
    pnlEl.className = 'stat-val '+pClass(s.pnl);
    const relEl = document.getElementById('realized');
    relEl.textContent = sgn(s.realizedPnl||0);
    relEl.className = 'stat-val '+pClass(s.realizedPnl);
    document.getElementById('active-count').textContent = s.activeCount??'—';
    document.getElementById('rules-count').textContent = (s.arbRules||0)+' arb rules';
    document.getElementById('markets-count').textContent = s.totalMarkets||'—';
    document.getElementById('prices-count').textContent = (s.pricesTracked||0)+' prices cached';
    document.getElementById('mins-to-end').textContent = s.minsToEnd ? s.minsToEnd+'m' : '—';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    document.getElementById('scan-ago').textContent = 'last scan '+(s.lastScanAgo||0)+'s ago';
    document.getElementById('match-slug').textContent = s.eventSlug||'—';
    document.getElementById('bar-slug').textContent = s.eventSlug||'—';
    document.getElementById('bar-rules').textContent = (s.arbRules||0)+' rules';
    const unrelEl = document.getElementById('bar-unrealized');
    unrelEl.textContent = sgn(s.unrealized||0);
    unrelEl.className = 'match-bar-val '+(s.unrealized>=0?'c-green':'c-red');
    document.getElementById('bar-endtime').textContent = s.matchEndTime ? s.matchEndTime.slice(0,19).replace('T',' ')+'Z' : 'unknown';

    // Positions
    const grid = document.getElementById('pos-grid');
    if (!s.positions || s.positions.length === 0) {
      grid.innerHTML = '<div class="empty">🔭 No open positions — scanning '+( s.arbRules||0)+' arb rules…</div>';
    } else {
      grid.innerHTML = s.positions.map(p => {
        const col = TYPE_COLORS[p.type] || '#aaa';
        const pClass2 = p.pnl >= 0 ? 'profit' : 'loss';
        return \`<div class="pos-card \${pClass2}">
          <div class="pos-hdr">
            <div class="pos-label">\${p.label}</div>
            <span class="pos-type" style="border-color:\${col}33;color:\${col}">\${p.type}</span>
          </div>
          <div class="pos-body">
            <div class="pos-row"><span class="pos-key">Shares</span><span>\${p.shares}</span></div>
            <div class="pos-row"><span class="pos-key">Entry</span><span>\${(p.entry||0).toFixed(4)}</span><span class="pos-key">Current</span><span>\${(p.current||0).toFixed(4)}</span></div>
            <div class="pos-row"><span class="pos-key">P&L</span><span class="\${p.pnl>=0?'pnl-pos':'pnl-neg'}">\${sgn(p.pnl)}</span><span class="pos-key">Edge</span><span style="color:var(--gold)">¢\${((p.edge||0)*100).toFixed(1)}</span></div>
            <div class="pos-row"><span class="pos-key">Open</span><span>\${p.secsOpen}s</span></div>
          </div>
        </div>\`;
      }).join('');
    }

    // Trades
    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.slice().reverse().map(t => {
        const col = TYPE_COLORS[t.type] || '#aaa';
        return '<tr>'+
          '<td>'+t.time+'</td>'+
          '<td style="font-size:9px;color:'+col+'">'+t.type+'</td>'+
          '<td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+t.label+'">'+t.label.slice(0,18)+'</td>'+
          '<td>'+t.shares+'</td>'+
          '<td>'+(t.price||0).toFixed(4)+'</td>'+
          '<td style="color:var(--gold)">¢'+((t.edge||0)*100).toFixed(1)+'</td>'+
          '<td>$'+(t.cost||0).toFixed(2)+'</td>'+
          '</tr>';
      }).join('');
    }

    // Logs
    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('🚨')||l.includes('📉') ? '#ff4757'
                  : l.includes('💰')||l.includes('✅')||l.includes('✨') ? '#00e676'
                  : l.includes('📥')||l.includes('[DRY')||l.includes('🎯') ? '#ffd740'
                  : l.includes('💹')||l.includes('🔭')||l.includes('📊') ? '#00d4ff'
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

console.log(`⚽ FIFA Cross-Market Arb Bot`);
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo mode, no real orders');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
