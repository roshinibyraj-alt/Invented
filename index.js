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

// ── Stub routes (kept for compatibility) ──
app.post('/api/search-match',   async (req, res) => res.json({ ok: false, error: 'Auto-discovery mode' }));
app.get('/api/search-markets',  async (req, res) => res.json({ ok: false, error: 'Auto-discovery mode' }));
app.post('/api/load-market',    async (req, res) => res.json({ ok: false, error: 'Auto-discovery mode' }));

// ── Dashboard ──
app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>🎯 Expiry Sniper Bot</title>
  <style>
    :root {
      --bg:     #0e1117;
      --bg2:    #161b22;
      --bg3:    #1c2230;
      --border: #2a3441;
      --text:   #e2e8f0;
      --muted:  #64748b;
      --cyan:   #00d4ff;
      --green:  #00e676;
      --red:    #ff4757;
      --yellow: #ffd740;
      --purple: #a78bfa;
      --orange: #fb923c;
      --gold:   #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; }

    /* ── Header ── */
    .header {
      background: linear-gradient(135deg, #0e1117, #161b22);
      border-bottom: 1px solid #00d4ff33;
      padding: 14px 20px;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
    }
    .logo { font-size: 20px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
    .logo span { color: var(--cyan); }
    .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
    .mode-dry  { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
    .mode-live { background: #ff475722; color: var(--red);    border: 1px solid var(--red); animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
    .scan-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--cyan); margin-right: 6px; animation: blink 1.5s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }

    /* ── Strategy banner ── */
    .strategy-bar {
      background: var(--bg2); border-bottom: 1px solid var(--border);
      padding: 8px 20px; display: flex; gap: 24px; flex-wrap: wrap; align-items: center;
    }
    .sb-item { font-size: 10px; }
    .sb-label { color: var(--muted); margin-right: 5px; }
    .sb-val   { color: var(--cyan); font-weight: bold; }

    /* ── Stats ── */
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 14px 20px; }
    .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .stat-val   { font-size: 20px; font-weight: bold; }
    .stat-sub   { font-size: 9px; color: var(--muted); margin-top: 3px; }

    /* ── Positions grid ── */
    .section { padding: 0 20px 16px; }
    .section-hdr {
      font-size: 10px; color: var(--muted); text-transform: uppercase;
      letter-spacing: 2px; padding: 8px 0;
      display: flex; align-items: center; gap: 8px;
    }
    .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }

    .pos-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
    .pos-card {
      background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
    }
    .pos-card.tp-near   { border-color: var(--green); box-shadow: 0 0 0 1px #00e67622; }
    .pos-card.tp-mid    { border-color: var(--cyan); }
    .pos-card.tp-low    { border-color: var(--border); }
    .pos-hdr {
      background: #0d1520; padding: 8px 12px;
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
    }
    .pos-outcome { font-size: 11px; font-weight: bold; }
    .pos-time    { font-size: 10px; }
    .pos-body    { padding: 8px 12px; }
    .pos-q       { font-size: 10px; color: #94a3b8; margin-bottom: 8px; line-height: 1.4; }
    .pos-row     { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
    .pos-key     { color: var(--muted); }
    .pnl-bar     { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
    .pbar-track  { background: var(--bg3); border-radius: 4px; height: 4px; overflow: hidden; margin-top: 4px; }
    .pbar-fill   { height: 100%; border-radius: 4px; background: var(--cyan); transition: width .5s; }

    /* ── Bottom grid ── */
    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
    @media (max-width: 700px) { .bottom-grid { grid-template-columns: 1fr; } }
    .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 280px; overflow-y: auto; }
    .tbl { width: 100%; border-collapse: collapse; }
    .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
    .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
    .tbl tr:last-child td { border-bottom: none; }
    .log-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; height: 280px; overflow-y: auto; font-size: 11px; line-height: 1.7; }
    .empty { color: var(--muted); padding: 20px; text-align: center; font-size: 11px; }

    .c-cyan   { color: var(--cyan) !important; }
    .c-green  { color: var(--green) !important; }
    .c-red    { color: var(--red) !important; }
    .c-yellow { color: var(--yellow) !important; }
    .c-gold   { color: var(--gold) !important; }
  </style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div class="logo">🎯 Expiry<span>Sniper</span>Bot</div>
    <span style="color:var(--muted);font-size:10px">
      <span class="scan-dot"></span>
      <span id="scan-status">initialising…</span>
    </span>
  </div>
  <span id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? '⚠️ DRY RUN' : '🔴 LIVE'}</span>
</div>

<!-- Strategy bar -->
<div class="strategy-bar">
  <div class="sb-item"><span class="sb-label">Capital</span><span class="sb-val">$2,000</span></div>
  <div class="sb-item"><span class="sb-label">Per Trade</span><span class="sb-val">3% = $60</span></div>
  <div class="sb-item"><span class="sb-label">Signal</span><span class="sb-val">price &gt; 0.70</span></div>
  <div class="sb-item"><span class="sb-label">Window</span><span class="sb-val">≤ 60 min to expiry</span></div>
  <div class="sb-item"><span class="sb-label">Take Profit</span><span class="sb-val c-green">@ 0.99</span></div>
  <div class="sb-item"><span class="sb-label">Stop</span><span class="sb-val c-yellow">expiry (natural)</span></div>
</div>

<!-- Stats -->
<div class="stats-row">
  <div class="stat">
    <div class="stat-label">Portfolio Value</div>
    <div class="stat-val c-cyan" id="s-mark">—</div>
    <div class="stat-sub">mark-to-market</div>
  </div>
  <div class="stat">
    <div class="stat-label">Session P&L</div>
    <div class="stat-val" id="s-pnl">—</div>
    <div class="stat-sub">vs $2000 start</div>
  </div>
  <div class="stat">
    <div class="stat-label">Realized P&L</div>
    <div class="stat-val" id="s-realized">—</div>
    <div class="stat-sub">booked profits</div>
  </div>
  <div class="stat">
    <div class="stat-label">Unrealized P&L</div>
    <div class="stat-val" id="s-unrealized">—</div>
    <div class="stat-sub">open positions</div>
  </div>
  <div class="stat">
    <div class="stat-label">Cash Remaining</div>
    <div class="stat-val c-gold" id="s-cash">—</div>
    <div class="stat-sub" id="s-slots">—</div>
  </div>
  <div class="stat">
    <div class="stat-label">Open Positions</div>
    <div class="stat-val c-cyan" id="s-open">—</div>
    <div class="stat-sub" id="s-scan">next scan —</div>
  </div>
  <div class="stat">
    <div class="stat-label">Uptime</div>
    <div class="stat-val" id="s-uptime">—</div>
    <div class="stat-sub">hh:mm:ss</div>
  </div>
</div>

<!-- Positions -->
<div class="section">
  <div class="section-hdr">Open Positions</div>
  <div class="pos-grid" id="pos-grid">
    <div class="empty">🔭 Scanning for opportunities…</div>
  </div>
</div>

<!-- Trades + Logs -->
<div class="bottom-grid">
  <div>
    <div class="section-hdr" style="margin:0 0 8px">Trades</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Time</th><th>Type</th><th>Market</th><th>Outcome</th><th>Price</th><th>Shares</th><th>P&L</th></tr></thead>
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
  function pCls(v) { return v>=0?'c-green':'c-red'; }
  function fmtSecs(s) {
    if (s===null||s===undefined) return '—';
    if (s < 60) return s+'s';
    const m = Math.floor(s/60), sec = s%60;
    return m+'m '+sec+'s';
  }
  // Progress from entry to TP (0.70 → 0.99)
  function pct(entry, current) {
    const range = 0.99 - entry;
    if (range <= 0) return 100;
    return Math.min(100, Math.max(0, Math.round(((current - entry) / range) * 100)));
  }

  socket.on('state', s => {
    // Stats
    document.getElementById('s-mark').textContent     = '$'+(s.markValue||0).toFixed(2);
    const pnlEl = document.getElementById('s-pnl');
    pnlEl.textContent  = sgn(s.totalPnl||0);
    pnlEl.className    = 'stat-val '+pCls(s.totalPnl);
    const relEl = document.getElementById('s-realized');
    relEl.textContent  = sgn(s.totalRealized||0);
    relEl.className    = 'stat-val '+pCls(s.totalRealized);
    const unrEl = document.getElementById('s-unrealized');
    unrEl.textContent  = sgn(s.totalUnrealized||0);
    unrEl.className    = 'stat-val '+pCls(s.totalUnrealized);
    document.getElementById('s-cash').textContent     = '$'+(s.cash||0).toFixed(2);
    document.getElementById('s-slots').textContent    = Math.floor((s.cash||0)/60)+' slots left';
    document.getElementById('s-open').textContent     = s.openCount||0;
    document.getElementById('s-scan').textContent     = 'next scan in '+(s.nextScanIn||0)+'s';
    document.getElementById('s-uptime').textContent   = fmt(s.uptime||0);
    document.getElementById('scan-status').textContent = 'scanning every 30s • signal >' + s.minPrice + ' • TP ' + s.tpPrice;

    // Position cards
    const grid = document.getElementById('pos-grid');
    if (!s.positions || s.positions.length === 0) {
      grid.innerHTML = '<div class="empty">🔭 No open positions — next scan in '+(s.nextScanIn||0)+'s</div>';
    } else {
      grid.innerHTML = s.positions.map(p => {
        const progress = pct(p.entryPrice, p.currentPrice);
        const cardCls  = progress >= 80 ? 'pos-card tp-near' : progress >= 40 ? 'pos-card tp-mid' : 'pos-card tp-low';
        const unrCls   = p.unrealizedPnl >= 0 ? 'c-green' : 'c-red';
        const timeLeft = p.secsLeft !== null ? fmtSecs(p.secsLeft) : '—';
        const timeColor = (p.secsLeft !== null && p.secsLeft < 120) ? 'c-red' : 'c-yellow';
        return \`<div class="\${cardCls}">
          <div class="pos-hdr">
            <span class="pos-outcome c-cyan">\${p.outcome}</span>
            <span class="pos-time \${timeColor}">⏰ \${timeLeft}</span>
          </div>
          <div class="pos-body">
            <div class="pos-q">\${p.question || p.eventTitle}</div>
            <div class="pos-row">
              <span class="pos-key">Entry</span><span>\${(p.entryPrice||0).toFixed(3)}</span>
              <span class="pos-key">Now</span><span class="c-cyan">\${(p.currentPrice||0).toFixed(3)}</span>
              <span class="pos-key">TP</span><span class="c-green">\${p.tpPrice}</span>
            </div>
            <div class="pos-row">
              <span class="pos-key">Shares</span><span>\${(p.shares||0).toFixed(2)}</span>
              <span class="pos-key">Cost</span><span>$\${(p.cost||0).toFixed(2)}</span>
              <span class="pos-key">uPnL</span><span class="\${unrCls}">\${sgn(p.unrealizedPnl||0)}</span>
            </div>
            <div class="pnl-bar">
              <div style="display:flex;justify-content:space-between;font-size:9px">
                <span class="pos-key">Progress to TP</span><span class="c-cyan">\${progress}%</span>
              </div>
              <div class="pbar-track">
                <div class="pbar-fill" style="width:\${progress}%"></div>
              </div>
            </div>
          </div>
        </div>\`;
      }).join('');
    }

    // Trades table
    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const typeColor = t.type === 'BUY' ? '#ffd740'
                        : t.type === 'SELL_TP' ? '#00e676'
                        : '#ff9f0a';
        const pnlStr = t.pnl !== null && t.pnl !== undefined ? sgn(t.pnl) : '—';
        const pnlCls = t.pnl !== null ? pCls(t.pnl) : '';
        return '<tr>'+
          '<td>'+t.time+'</td>'+
          '<td style="color:'+typeColor+'">'+t.type+'</td>'+
          '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+t.market+'</td>'+
          '<td>'+t.outcome+'</td>'+
          '<td>'+(t.price||0).toFixed(3)+'</td>'+
          '<td>'+(t.shares||0).toFixed(2)+'</td>'+
          '<td class="'+pnlCls+'">'+pnlStr+'</td>'+
          '</tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>';
    }

    // Logs
    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('🚨') ? '#ff4757'
                  : l.includes('💰')||l.includes('✅') ? '#00e676'
                  : l.includes('🏁')||l.includes('⬆️') ? '#ffd740'
                  : l.includes('🔭')||l.includes('🎯')||l.includes('⏰') ? '#00d4ff'
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

console.log(`🎯 Expiry Sniper Bot`);
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo $2000 capital, simulated fills, real API for data');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
