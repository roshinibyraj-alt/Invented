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

app.post('/api/set-pairs', (req, res) => {
  const { pairs } = req.body || {};
  if (!Array.isArray(pairs) || !pairs.length) return res.status(400).json({ ok: false, error: 'Missing pairs array, e.g. ["BTC","ETH"]' });
  try { res.json(bot.setPairs(pairs)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
<title>🪜 BTC/ETH Grid-Ladder Bot — 15m Up/Down</title>
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
  .window-strip { padding: 10px 20px 0; font-size: 11px; color: var(--muted); }
  .window-strip b { color: var(--cyan); }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 20px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .ladder-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px; }
  .ladder-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .ladder-card.has-pos { border-color: var(--cyan); box-shadow: 0 0 0 1px #00d4ff22; }
  .ladder-card.untradable { opacity: .55; }
  .ladder-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
  .ladder-sym { font-size: 13px; font-weight: bold; color: #ddd; }
  .ladder-sym.up { color: #6fe08a; }
  .ladder-sym.down { color: #ff8a8a; }
  .ladder-price { font-size: 10px; color: var(--cyan); }
  .ladder-body { padding: 6px 10px; max-height: 340px; overflow-y: auto; }
  .ladder-summary { display: flex; justify-content: space-between; font-size: 9px; color: var(--muted); padding: 4px 2px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  .level-row { display: grid; grid-template-columns: 44px 1fr 60px 28px; align-items: center; gap: 6px; padding: 3px 2px; font-size: 9.5px; border-bottom: 1px solid #ffffff00; }
  .level-row.empty { opacity: .35; }
  .level-row.watching { color: var(--yellow); }
  .level-row.filled { color: var(--text); background: #00990911; border-radius: 4px; }
  .level-row.tp-pending { color: var(--green); background: #00a85411; border-radius: 4px; }
  .level-price { font-family: ui-monospace, monospace; }
  .level-state { color: var(--muted); }
  .level-tp { text-align: right; font-family: ui-monospace, monospace; }
  .level-re { text-align: right; color: var(--purple); }
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
  .real-wrap { background: #241a08; border: 1px solid #6b4a12; border-radius: 10px; padding: 12px 14px; margin: 0 20px 14px; }
  .real-wrap.disabled { opacity: .5; }
  .real-hdr { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; flex-wrap: wrap; gap: 6px; }
  .real-hdr .title { font-size: 10px; color: #ffb74d; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; }
  .real-hdr .wallet { font-size: 9px; color: #8a7350; font-family: ui-monospace, monospace; }
  .real-stats { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 8px; }
  .real-stat .label { font-size: 8px; color: #8a7350; text-transform: uppercase; letter-spacing: .5px; }
  .real-stat .val { font-size: 15px; font-weight: 700; color: #ffd180; }
  .real-tbl { width: 100%; border-collapse: collapse; font-size: 10px; }
  .real-tbl th { color: #8a7350; text-align:left; padding: 4px 6px; font-size: 9px; text-transform: uppercase; }
  .real-tbl td { padding: 4px 6px; border-bottom: 1px solid #3a2a10; }
  .real-error { color: #ff8a65; font-size: 10px; margin-top: 6px; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🪜 GRID<span>-LADDER</span> BOT — 15m Up/Down</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>
  <div class="toolbar">
    <button id="pause-btn" class="pause">⏸️ Pause</button>
    <button id="resume-btn" class="resume">▶️ Resume</button>
    <button id="live-btn" class="live-toggle">🔴 Go LIVE</button>
  </div>
  <div class="toolbar-status" id="toolbar-status"></div>
  <div class="window-strip" id="window-strip"></div>

  <div class="stats-row" id="stats-row"></div>

  <div class="equity-wrap">
    <div class="equity-hdr"><div class="title">Equity Curve</div><div class="val" id="equity-val">—</div></div>
    <svg class="equity-svg" id="equity-svg"></svg>
  </div>

  <div class="real-wrap disabled" id="real-wrap">
    <div class="real-hdr"><div class="title">🔴 Real On-Chain Wallet</div><div class="wallet" id="real-wallet">—</div></div>
    <div id="real-body"></div>
  </div>

  <div class="section">
    <div class="section-hdr">Grid Ladders (independent — BTC-Up / BTC-Down / ETH-Up / ETH-Down)</div>
    <div class="ladder-grid" id="ladder-grid"></div>
  </div>

  <div class="bottom-grid">
    <div class="section">
      <div class="section-hdr">Trade Log</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Ladder</th><th>Level</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="section">
      <div class="section-hdr">System Log</div>
      <div class="logs-wrap" id="logs"></div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const $ = id => document.getElementById(id);

  $('pause-btn').onclick = () => fetch('/api/pause', { method: 'POST' }).then(() => flash('Paused'));
  $('resume-btn').onclick = () => fetch('/api/resume', { method: 'POST' }).then(() => flash('Resumed'));
  $('live-btn').onclick = () => {
    const wantLive = !$('live-btn').classList.contains('is-live');
    if (wantLive && !confirm('Switch to LIVE mode? This will place REAL market orders with REAL money.')) return;
    fetch('/api/set-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: wantLive }) })
      .then(() => flash(wantLive ? 'Switched to LIVE' : 'Switched to DEMO'));
  };
  function flash(msg) { $('toolbar-status').textContent = msg; setTimeout(() => { $('toolbar-status').textContent = ''; }, 3000); }

  function fmtSecs(s) {
    if (s == null) return '—';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }
  function sgn(n) { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2); }
  function pClass(n) { return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }

  function drawEquity(curve) {
    const svg = $('equity-svg');
    if (!curve || curve.length < 2) { svg.innerHTML = ''; return; }
    const w = svg.clientWidth || 600, h = 90;
    const vals = curve.map(p => p.equity);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = (max - min) || 1;
    const pts = curve.map((p, i) => {
      const x = (i / (curve.length - 1)) * w;
      const y = h - ((p.equity - min) / range) * (h - 10) - 5;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = vals[vals.length - 1], first = vals[0];
    const color = last >= first ? '#00a854' : '#e8304a';
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.innerHTML = '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2"/>';
  }

  socket.on('state', (s) => {
    $('mode-badge').textContent = s.dryRun ? 'DEMO' : 'LIVE';
    $('mode-badge').className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    $('live-btn').classList.toggle('is-live', !s.dryRun);
    $('live-btn').textContent = s.dryRun ? '🔴 Go LIVE' : '🟡 Back to DEMO';
    $('pause-btn').style.display = s.tradingEnabled ? '' : 'none';
    $('resume-btn').style.display = s.tradingEnabled ? 'none' : '';

    $('window-strip').innerHTML = s.tradable
      ? ('15m window ends in <b>' + fmtSecs(s.secsToEnd) + '</b> | BTC: ' + (s.markets.BTC.slug || '—') + ' | ETH: ' + (s.markets.ETH.slug || '—'))
      : 'Loading window…';

    const stats = [
      ['Bankroll', '$' + s.bankroll.toFixed(2), ''],
      ['Mark Value', '$' + s.markValue.toFixed(2), ''],
      ['Total P&amp;L', sgn(s.totalPnl), pClass(s.totalPnl)],
      ['Realized P&amp;L', sgn(s.realizedPnl), pClass(s.realizedPnl)],
      ['Unrealized P&amp;L', sgn(s.unrealizedPnl), pClass(s.unrealizedPnl)],
      ['Win Rate', s.winRate != null ? s.winRate + '%' : '—', ''],
      ['Wins / Losses', s.wins + ' / ' + s.losses, ''],
      ['Fees Paid', '$' + s.feesPaid.toFixed(2), ''],
    ];
    $('stats-row').innerHTML = stats.map(([label, val, cls]) =>
      '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-val ' + cls + '">' + val + '</div></div>'
    ).join('');

    $('equity-val').textContent = '$' + s.markValue.toFixed(2);
    $('equity-val').className = 'val ' + pClass(s.totalPnl);
    drawEquity(s.equityCurve);

    // Real wallet panel
    const real = s.real || {};
    const wrap = $('real-wrap');
    const walletEl = $('real-wallet');
    const body = $('real-body');
    walletEl.textContent = real.wallet ? (real.wallet.slice(0,6)+'…'+real.wallet.slice(-4)) : '—';
    if (!real.enabled) {
      wrap.className = 'real-wrap disabled';
      body.innerHTML = '<div class="empty" style="padding:4px 0">Only available in LIVE mode — demo mode shows simulated bankroll above, not a real wallet.</div>';
    } else {
      wrap.className = 'real-wrap';
      let html = '<div class="real-stats">'+
        '<div class="real-stat"><div class="label">Real USDC Balance</div><div class="val">'+(real.balance!==null?'$'+real.balance.toFixed(2):'loading…')+'</div></div>'+
        '<div class="real-stat"><div class="label">Open Positions</div><div class="val">'+(real.positions?real.positions.length:0)+'</div></div>'+
        '<div class="real-stat"><div class="label">Last Synced</div><div class="val" style="font-size:11px">'+(real.lastUpdated?new Date(real.lastUpdated).toLocaleTimeString():'—')+'</div></div>'+
      '</div>';
      if (real.error) html += '<div class="real-error">⚠️ '+real.error+'</div>';
      if (real.positions && real.positions.length) {
        html += '<table class="real-tbl"><thead><tr><th>Market</th><th>Outcome</th><th>Size</th><th>Avg Price</th><th>Cur Price</th><th>Value</th><th>Cash P&amp;L</th></tr></thead><tbody>'+
          real.positions.map(p => '<tr><td>'+(p.title||p.slug||'—')+'</td><td>'+(p.outcome||'—')+'</td><td>'+(p.size||0).toFixed(2)+'</td><td>'+(p.avgPrice!=null?p.avgPrice.toFixed(3):'—')+'</td><td>'+(p.curPrice!=null?p.curPrice.toFixed(3):'—')+'</td><td>$'+(p.currentValue!=null?p.currentValue.toFixed(2):'—')+'</td><td class="'+pClass(p.cashPnl)+'">'+sgn(p.cashPnl||0)+'</td></tr>').join('') +
          '</tbody></table>';
      } else if (!real.error) {
        html += '<div class="empty" style="padding:4px 0">No open positions on-chain right now.</div>';
      }
      body.innerHTML = html;
    }

    // Ladder cards
    const grid = $('ladder-grid');
    if (!s.ladders || !s.ladders.length) {
      grid.innerHTML = '<div class="empty">Loading ladders…</div>';
    } else {
      grid.innerHTML = s.ladders.map(l => {
        const hasPos = l.levels.some(lv => lv.position && !lv.position.closed);
        const openCount = l.levels.filter(lv => lv.position && !lv.position.closed).length;
        const watchingCount = l.levels.filter(lv => lv.entryPending).length;
        const totalReentries = l.levels.reduce((a, lv) => a + (lv.reentries || 0), 0);
        const sideCls = l.side === 'Up' ? 'up' : 'down';
        const rows = l.levels.slice().reverse().map(lv => {
          let rowCls = 'empty', stateTxt = 'idle';
          if (lv.position && !lv.position.closed) {
            rowCls = lv.position.tpPending ? 'tp-pending' : 'filled';
            stateTxt = 'holding ' + lv.position.shares + 'sh @ ' + lv.position.entryPrice.toFixed(2);
          } else if (lv.entryPending) {
            rowCls = 'watching';
            stateTxt = 'watching for trigger';
          }
          const tpTxt = lv.position ? ('TP ' + lv.position.tpPrice.toFixed(2)) : '';
          return '<div class="level-row ' + rowCls + '">' +
            '<div class="level-price">' + lv.level.toFixed(2) + '</div>' +
            '<div class="level-state">' + stateTxt + '</div>' +
            '<div class="level-tp">' + tpTxt + '</div>' +
            '<div class="level-re">' + (lv.reentries > 0 ? 'x' + lv.reentries : '') + '</div>' +
          '</div>';
        }).join('');
        return '<div class="ladder-card ' + (hasPos ? 'has-pos' : '') + (s.tradable ? '' : ' untradable') + '">' +
          '<div class="ladder-hdr"><div class="ladder-sym ' + sideCls + '">' + l.key + '</div><div class="ladder-price">ask ' + (l.ask!=null?l.ask.toFixed(2):'—') + ' / bid ' + (l.bid!=null?l.bid.toFixed(2):'—') + '</div></div>' +
          '<div class="ladder-body">' +
            '<div class="ladder-summary"><span>' + openCount + ' open</span><span>' + watchingCount + ' watching</span><span>' + totalReentries + ' filled</span></div>' +
            rows +
          '</div></div>';
      }).join('');
    }

    // Trade log
    const tb = $('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? pClass(t.profit) : '';
        const sideColor = t.reason === 'ENTRY' ? '#ffd740' : (t.reason === 'RESOLUTION' ? '#00d4ff' : '#00e676');
        return '<tr><td>' + t.time + '</td><td style="color:' + sideColor + '">' + (t.ladder || '—') + '</td>' +
          '<td>' + (t.level != null ? t.level.toFixed(2) : '—') + '</td>' +
          '<td>' + (t.reason || '—') + '</td>' +
          '<td>' + (t.price || 0).toFixed(3) + '</td>' +
          '<td>' + (t.shares || 0) + '</td>' +
          '<td class="' + pnlCls + '">' + pnlStr + '</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>';
    }

    // System log
    const logEl = $('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('💥') ? '#ff4757'
                  : l.includes('💰')||l.includes('✅') ? '#00e676'
                  : l.includes('🔭')||l.includes('⏰') ? '#00d4ff'
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

console.log('🪜 15-Minute BTC/ETH Grid-Ladder Bot — 4 Independent Up/Down Ladders');
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo $2000 capital, simulated fills, real API for data/orders');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
