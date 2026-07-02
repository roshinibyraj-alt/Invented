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
  if (!Array.isArray(pairs) || !pairs.length) return res.status(400).json({ ok: false, error: 'Missing pairs array, e.g. ["BTC","ETH","SOL"]' });
  try { res.json(bot.setPairs(pairs)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
<title>🔗 5m Merge-Arb Bot</title>
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
  .toolbar input { flex: 1; min-width: 220px; background: var(--bg2); border: 1px solid var(--border); color: var(--text); padding: 10px 14px; border-radius: 8px; font-family: inherit; font-size: 12px; }
  .toolbar button { background: var(--cyan); color: #001018; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .toolbar-status { padding: 6px 20px 0; font-size: 10px; color: var(--muted); min-height: 14px; }
  .config-strip { margin: 10px 20px 0; padding: 8px 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; font-size: 9px; color: var(--muted); line-height: 1.6; }
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
  .pair-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
  .pair-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .pair-card.has-cycle { border-color: var(--cyan); box-shadow: 0 0 0 1px #00d4ff22; }
  .pair-card.has-leftover { border-color: var(--yellow); }
  .pair-card.untradable { opacity: .55; }
  .pair-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
  .pair-sym { font-size: 13px; font-weight: bold; color: #ddd; }
  .pair-timer { font-size: 10px; color: var(--cyan); }
  .pair-body { padding: 8px 12px; }
  .pair-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
  .pair-key { color: var(--muted); }
  .side-up { color: var(--green); }
  .side-down { color: var(--red); }
  .cycle-box { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 6px; font-size: 9px; }
  .cycle-leg-filled { color: var(--green); }
  .cycle-leg-open { color: var(--yellow); }
  .inv-box { margin-top: 4px; font-size: 9px; color: #567; }
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
  .spark-box { margin-top: 6px; }
  .spark-box svg { width: 100%; height: 34px; display: block; }
  .spark-label { font-size: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🔗 <span>5M</span> MERGE-ARB BOT</div>
    <div id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? 'DRY RUN' : '🔴 LIVE'}</div>
  </div>

  <div class="toolbar">
    <input id="pairs-input" placeholder="BTC,ETH,SOL" />
    <button id="set-pairs-btn">Set Pairs</button>
    <button id="pause-btn" class="pause">Pause</button>
    <button id="resume-btn" class="resume">Resume</button>
  </div>
  <div id="toolbar-status" class="toolbar-status"></div>
  <div id="config-strip" class="config-strip"></div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Total Mark Value</div><div class="stat-val" id="total-mark">$0.00</div></div>
    <div class="stat"><div class="stat-label">Total P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Realized</div><div class="stat-val" id="realized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Merged Pairs / Profit</div><div class="stat-val" id="merged-total">0</div><div class="stat-sub" id="merged-profit"></div></div>
    <div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val" id="total-bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Fees / Rebates</div><div class="stat-val" id="total-fees">$0.00</div><div class="stat-sub" id="total-rebates"></div></div>
    <div class="stat"><div class="stat-label">Win Rate (leftover/resolution)</div><div class="stat-val" id="win-rate">—</div><div class="stat-sub" id="win-loss-sub"></div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">0s</div></div>
    <div class="stat"><div class="stat-label">Trading</div><div class="stat-val" id="trading-flag">—</div></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr"><div class="title">Portfolio Equity</div><div class="val" id="equity-val">$0.00</div></div>
    <svg class="equity-svg" id="equity-chart" viewBox="0 0 600 90" preserveAspectRatio="none"></svg>
  </div>

  <div class="section">
    <div class="section-hdr">Pairs</div>
    <div class="pair-grid" id="pair-grid"></div>
  </div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr">Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Sym</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
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
  const socket = new WebSocket ? io() : null;
  const sgn = n => (n>=0?'+':'') + '$'+(n||0).toFixed(2);
  const pClass = n => n>0?'pnl-pos':(n<0?'pnl-neg':'');
  const fmt = s => { s=Math.max(0,Math.floor(s)); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60; return (h?h+'h ':'')+(m?m+'m ':'')+ss+'s'; };
  const fmtSecs = s => { s=Math.max(0,Math.floor(s)); const m=Math.floor(s/60), ss=String(s%60).padStart(2,'0'); return m+':'+ss; };

  function buildEquitySvg(curve, w, h, capitalLine) {
    if (!curve || curve.length < 2) return '';
    const vals = curve.map(p => p.equity);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (capitalLine != null) { min = Math.min(min, capitalLine); max = Math.max(max, capitalLine); }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max-min)*0.08; min -= pad; max += pad;
    const n = curve.length;
    const pts = curve.map((p,i) => {
      const x = (i/(n-1))*w;
      const y = h - ((p.equity-min)/(max-min))*h;
      return x.toFixed(1)+','+y.toFixed(1);
    }).join(' ');
    const last = vals[vals.length-1];
    const color = capitalLine != null ? (last>=capitalLine?'#00a854':'#e8304a') : (last>=vals[0]?'#00a854':'#e8304a');
    let extra = '';
    if (capitalLine != null) {
      const y0 = h - ((capitalLine-min)/(max-min))*h;
      extra = '<line x1="0" y1="'+y0.toFixed(1)+'" x2="'+w+'" y2="'+y0.toFixed(1)+'" stroke="#7a8fa8" stroke-width="1" stroke-dasharray="3,3"/>';
    }
    return extra + '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="1.5"/>';
  }

  document.getElementById('set-pairs-btn').addEventListener('click', async () => {
    const raw = document.getElementById('pairs-input').value.trim();
    const pairs = raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    const statusEl = document.getElementById('toolbar-status');
    if (!pairs.length) { statusEl.textContent = '⚠️ Enter at least one pair (e.g. BTC,ETH,SOL)'; return; }
    try {
      const r = await fetch('/api/set-pairs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ pairs }) });
      const d = await r.json();
      statusEl.textContent = d.ok ? ('✅ Now tracking: ' + d.pairs.join(', ') + ' ($'+d.perPairCapital.toFixed(2)+'/pair)') : ('❌ ' + (d.error||'failed'));
    } catch (e) { statusEl.textContent = '❌ ' + e.message; }
  });
  document.getElementById('pause-btn').addEventListener('click', async () => {
    await fetch('/api/pause', { method: 'POST' });
  });
  document.getElementById('resume-btn').addEventListener('click', async () => {
    await fetch('/api/resume', { method: 'POST' });
  });

  let configPrinted = false;

  socket.on('state', s => {
    document.getElementById('total-mark').textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl); pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    const relEl = document.getElementById('realized-pnl');
    relEl.textContent = sgn(s.totalRealizedPnl); relEl.className = 'stat-val ' + pClass(s.totalRealizedPnl);
    document.getElementById('merged-total').textContent = (s.totalMergedPairs||0).toFixed(0)+' sh';
    const mp = document.getElementById('merged-profit');
    mp.textContent = sgn(s.totalMergedProfit||0)+' locked in'; mp.className = 'stat-sub ' + pClass(s.totalMergedProfit);
    document.getElementById('total-bankroll').textContent = '$'+(s.totalBankroll||0).toFixed(2);
    document.getElementById('total-fees').textContent = '-$'+(s.totalFeesPaid||0).toFixed(4);
    document.getElementById('total-rebates').textContent = '+$'+(s.totalRebatesEarned||0).toFixed(4)+' rebates';
    document.getElementById('win-rate').textContent = (s.winRate!==null && s.winRate!==undefined) ? s.winRate+'%' : '—';
    document.getElementById('win-loss-sub').textContent = (s.totalWins||0)+'W / '+(s.totalLosses||0)+'L';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    const tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ON' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');

    if (!configPrinted && s.config) {
      const c = s.config;
      document.getElementById('config-strip').innerHTML =
        'Every '+c.cycleIntervalSec+'s: 2×'+c.orderSizeShares+'sh maker limit buys at mid−'+c.entryDiscount.toFixed(2)+' on Up &amp; Down &nbsp;|&nbsp; cancel unfilled @ T+'+c.cycleCancelOffsetSec+'s &nbsp;|&nbsp; trade band ['+c.priceBandMin+','+c.priceBandMax+'] &nbsp;|&nbsp; new cycles stop after '+(c.tradingCutoffSec/60).toFixed(0)+'m of 5 &nbsp;|&nbsp; leftover cleanup sell @ '+c.leftoverSellPrice+' &nbsp;|&nbsp; crypto taker fee '+(c.cryptoTakerFeeRate*100).toFixed(0)+'%, maker rebate '+(c.cryptoMakerRebateShare*100).toFixed(0)+'% of that (makers always pay $0)';
      configPrinted = true;
    }

    const eqVal = document.getElementById('equity-val');
    eqVal.textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    eqVal.className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = buildEquitySvg(s.totalEquityCurve, 600, 90, s.totalCapital);

    const grid = document.getElementById('pair-grid');
    if (!s.pairStates || s.pairStates.length === 0) {
      grid.innerHTML = '<div class="empty">No pairs configured</div>';
    } else {
      grid.innerHTML = s.pairStates.map(p => {
        const cycleHtml = p.cycle ? (
          '<div class="cycle-box">Cycle #'+p.cycle.idx+' (cancel in '+p.cycle.secsToCancel+'s)<br>'+
          '<span class="'+(p.cycle.upFilled?'cycle-leg-filled':'cycle-leg-open')+'">Up '+(p.cycle.upFilled?'✓ filled':'…open')+' @ '+p.cycle.upPrice.toFixed(2)+'</span> · '+
          '<span class="'+(p.cycle.downFilled?'cycle-leg-filled':'cycle-leg-open')+'">Down '+(p.cycle.downFilled?'✓ filled':'…open')+' @ '+p.cycle.downPrice.toFixed(2)+'</span>'+
          '</div>'
        ) : (p.sellOrder ? (
          '<div class="cycle-box">📌 leftover cleanup: <span class="'+(p.sellOrder.side==='Up'?'side-up':'side-down')+'">'+p.sellOrder.side+'</span> '+p.sellOrder.shares.toFixed(0)+'sh resting SELL @ '+p.sellOrder.price.toFixed(2)+'</div>'
        ) : '<div class="cycle-box">no active cycle'+(p.secsToCutoff!=null && p.secsToCutoff>0 ? ' — next slot in queue' : ' — past minute 4, waiting on resolution')+'</div>');
        const invHtml = (p.upShares>0 || p.downShares>0) ?
          '<div class="inv-box">Unmerged: <span class="side-up">Up '+p.upShares.toFixed(0)+'sh</span> / <span class="side-down">Down '+p.downShares.toFixed(0)+'sh</span></div>' :
          '<div class="inv-box">Unmerged: none (fully matched)</div>';
        const eqCurve = buildEquitySvg(p.equityCurve, 280, 34, null);
        return '<div class="pair-card '+(p.cycle?'has-cycle':'')+' '+(p.sellOrder?'has-leftover':'')+' '+(p.tradable?'':'untradable')+'">'+
          '<div class="pair-hdr"><div class="pair-sym">'+p.symbol+'</div><div class="pair-timer">'+(p.tradable?fmtSecs(p.secsToEnd):'loading…')+'</div></div>'+
          '<div class="pair-body">'+
            '<div class="pair-row"><span class="pair-key">Spot</span><span>'+(p.spot?p.spot.toFixed(4):'—')+'</span><span class="pair-key">Open</span><span>'+(p.openSpot?p.openSpot.toFixed(4):'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Up ask/bid</span><span>'+(p.upAsk?.toFixed(2)||'—')+' / '+(p.upBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Down ask/bid</span><span>'+(p.downAsk?.toFixed(2)||'—')+' / '+(p.downBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Bankroll</span><span>$'+p.bankroll.toFixed(2)+'</span><span class="pair-key">Realized</span><span class="'+pClass(p.realizedPnl)+'">'+sgn(p.realizedPnl)+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Cycles</span><span>'+p.cyclesRun+' run ('+p.cyclesFilledBoth+' both / '+p.cyclesFilledOne+' one / '+p.cyclesFilledNone+' none)</span></div>'+
            '<div class="pair-row"><span class="pair-key">Merged</span><span>'+p.mergedPairsTotal.toFixed(0)+'sh · <span class="'+pClass(p.mergedProfitTotal)+'">'+sgn(p.mergedProfitTotal)+'</span></span></div>'+
            '<div class="pair-row"><span class="pair-key">Fees / Rebates</span><span class="pnl-neg">-$'+(p.feesPaid||0).toFixed(4)+'</span><span class="pnl-pos">+$'+(p.rebatesEarned||0).toFixed(4)+'</span></div>'+
            cycleHtml + invHtml +
            '<div class="spark-box"><svg viewBox="0 0 280 34" preserveAspectRatio="none">'+eqCurve+'</svg><div class="spark-label">Equity curve ($'+p.markValue.toFixed(2)+')</div></div>'+
          '</div></div>';
      }).join('');
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? pClass(t.profit) : '';
        const sideColor = t.side === 'BUY' ? '#ffd740' : (t.side === 'MERGE' ? '#7c3aed' : (t.side === 'RESOLVE' ? '#00d4ff' : '#ff8a3d'));
        return '<tr><td>'+t.time+'</td><td>'+t.symbol+'</td>'+
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
                  : l.includes('🎯') ? '#ffd740'
                  : l.includes('🔭')||l.includes('⏰') ? '#00d4ff'
                  : l.includes('📌') ? '#b388ff'
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

console.log(`🔗 5-Minute Crypto Up/Down Merge-Arbitrage Bot`);
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
