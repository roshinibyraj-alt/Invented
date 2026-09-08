from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

from .strategy import PoolBot

app = FastAPI(title="Polymarket 4-Engine Pooled Bot (paper)")
bot: PoolBot = None  # set by main.py


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/status")
async def status():
    if bot is None:
        return JSONResponse({"status": "not started"}, status_code=503)
    return bot.status()


DASHBOARD_HTML = """
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Polymarket 4-Engine Pooled Bot</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0a0e14; --panel: #10151d; --panel2: #141b25; --border: #1f2733;
    --text: #e6edf3; --muted: #7d8899; --up: #26d07c; --down: #ff5470;
    --accent: #58a6ff; --amber: #ffb454; --shadow: 0 1px 0 rgba(255,255,255,0.03) inset;
    --e1: #22d3ee; --e2: #f472b6; --e3: #4ade80; --e4: #facc15;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, Segoe UI, Roboto, sans-serif;
    background: radial-gradient(1200px 600px at 20% -10%, #131b26 0%, var(--bg) 60%);
    color: var(--text); margin: 0; padding: 18px; min-height: 100vh;
  }
  .top { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
  h1 { font-size: 17px; font-weight:600; margin:0; }
  .badge { background:#3a1d00; color:var(--amber); border:1px solid #5c3400; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:600; }
  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--up); margin-right:6px; animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%{opacity:1} 50%{opacity:0.25} 100%{opacity:1} }

  .summary { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:10px; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:12px 14px; box-shadow:var(--shadow); }
  .card .label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
  .card .val { font-size:21px; font-weight:700; }
  .pnl-pos { color:var(--up); } .pnl-neg { color:var(--down); }

  .section-title { font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.6px; margin: 22px 0 10px; }

  .markets { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); gap:14px; }
  .mcard { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; }
  .mcard .mhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:12px; }
  .mcard .mhead .asset { font-size:16px; font-weight:700; }
  .mcard .mhead .timer { font-variant-numeric: tabular-nums; font-size:13px; color:var(--amber); font-weight:600; }
  .outrow { display:flex; align-items:center; gap:12px; margin: 8px 0; }
  .outlabel { width:52px; font-weight:700; font-size:13px; }
  .outlabel.up { color:var(--up); } .outlabel.down { color:var(--down); }
  .barwrap { flex:1; height: 22px; background:#0d1219; border-radius:6px; overflow:hidden; border:1px solid var(--border); position:relative; }
  .bar { height:100%; }
  .bar.up { background: linear-gradient(90deg, #0f4a30, var(--up)); }
  .bar.down { background: linear-gradient(90deg, #4a0f22, var(--down)); }
  .barval { position:absolute; right:6px; top:0; bottom:0; display:flex; align-items:center; font-size:12px; font-weight:700; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
  .subprices { width:150px; text-align:right; font-size:11px; color:var(--muted); font-variant-numeric: tabular-nums; }

  .engines { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px,1fr)); gap:14px; }
  .ecard { background:var(--panel); border-radius:14px; padding:16px; border-top:3px solid var(--e1); }
  .ecard.e1 { border-top-color: var(--e1); } .ecard.e2 { border-top-color: var(--e2); }
  .ecard.e3 { border-top-color: var(--e3); } .ecard.e4 { border-top-color: var(--e4); }
  .ehead { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .ename { font-weight:700; font-size:13px; }
  .chip { font-size:10px; padding:2px 8px; border-radius:20px; font-weight:700; }
  .chip.armed { background:#1c2430; color:var(--muted); }
  .chip.holding { background:#123424; color:var(--up); border:1px solid #1e5c3d; }
  .chip.settled { background:#2a2410; color:var(--amber); border:1px solid #5c4a14; }
  .erow { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin:4px 0; }
  .erow b { color: var(--text); font-variant-numeric: tabular-nums; }
  .tpslbar { height:10px; border-radius:5px; background:#0d1219; border:1px solid var(--border); margin:8px 0; position:relative; overflow:hidden; }
  .tpslfill { position:absolute; top:0; bottom:0; background: linear-gradient(90deg, var(--down), var(--muted), var(--up)); }
  .tpslmarker { position:absolute; top:-2px; width:2px; height:14px; background:var(--text); }

  .pos { border-left:3px solid var(--accent); margin:8px 0; padding:10px 12px; background:var(--panel2); border-radius:8px; font-size:13px; }
  .empty { color: var(--muted); font-size: 13px; padding: 8px 0; }

  table { width:100%; border-collapse: collapse; font-size: 12.5px; background:var(--panel); border-radius:12px; overflow:hidden; }
  td, th { padding:8px 10px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:10.5px; }
  tr:last-child td { border-bottom:none; }

  .footer { color: var(--muted); font-size: 11px; margin-top:24px; text-align:center; }
</style>
</head>
<body>
  <div class="top">
    <h1><span class="pulse"></span>Polymarket 4-Engine Pooled Bot</h1>
    <span class="badge">PAPER / DEMO MODE — NO REAL ORDERS</span>
  </div>

  <div class="summary" id="summary"></div>

  <div class="section-title">Live Market — BTC &amp; ETH Up/Down (current window)</div>
  <div class="markets" id="markets"></div>

  <div class="section-title">4 Engines — $100 flat entry, TP/SL, pooled P&amp;L</div>
  <div class="engines" id="engines"></div>

  <div class="section-title">Pending Pool Settlements</div>
  <div id="pending"></div>

  <div class="section-title">Recent Redistributions</div>
  <table id="cohorts"><thead><tr><th>Window</th><th>Per-engine raw P&amp;L</th><th>Balance deltas</th></tr></thead><tbody></tbody></table>

  <div class="section-title">Recent Trades</div>
  <table id="recent"><thead><tr><th>Engine</th><th>Status</th><th>Raw P&amp;L</th></tr></thead><tbody></tbody></table>

  <div class="footer" id="footer"></div>

<script>
function fmt(n, d=3) { return (n === null || n === undefined) ? '&mdash;' : Number(n).toFixed(d); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function mmss(s) { s = Math.max(0, Math.floor(s)); const m = Math.floor(s/60); const r = s%60; return m + ':' + String(r).padStart(2,'0'); }
const engineClass = {"E1_BTC_UP":"e1","E2_BTC_DOWN":"e2","E3_ETH_UP":"e3","E4_ETH_DOWN":"e4"};

async function refresh() {
  let d;
  try {
    const r = await fetch('/status');
    d = await r.json();
  } catch (e) { return; }
  if (!d || d.status === 'not started') return;

  const totalPnl = (d.total_capital ?? 0) - (d.starting_total_capital ?? 0);
  document.getElementById('summary').innerHTML = `
    <div class="card"><div class="label">Status</div><div class="val">${d.status ?? '-'}</div></div>
    <div class="card"><div class="label">Total capital (4 engines)</div><div class="val">$${fmt(d.total_capital,2)}</div></div>
    <div class="card"><div class="label">Starting total</div><div class="val">$${fmt(d.starting_total_capital,2)}</div></div>
    <div class="card"><div class="label">Total P&amp;L</div><div class="val ${totalPnl>=0?'pnl-pos':'pnl-neg'}">${totalPnl>=0?'+':''}$${fmt(totalPnl,2)}</div></div>
    <div class="card"><div class="label">Entry / engine / window</div><div class="val">$${fmt(d.config?.entry_dollars,0)}</div></div>
    <div class="card"><div class="label">TP / SL</div><div class="val">${d.config?.take_profit_price} / ${d.config?.stop_loss_price}</div></div>
  `;

  const markets = d.markets || {};
  document.getElementById('markets').innerHTML = Object.entries(markets).map(([asset, m]) => {
    const rows = Object.entries(m.outcomes || {}).map(([name, o]) => {
      const isUp = name.toLowerCase() === 'up';
      const mid = o.mid ?? 0;
      const w = clamp(mid*100, 2, 100);
      return `
        <div class="outrow">
          <div class="outlabel ${isUp?'up':'down'}">${name}</div>
          <div class="barwrap"><div class="bar ${isUp?'up':'down'}" style="width:${w}%"></div>
            <div class="barval">${fmt(o.mid,3)}</div>
          </div>
          <div class="subprices">bid ${fmt(o.best_bid,3)} / ask ${fmt(o.best_ask,3)}</div>
        </div>`;
    }).join('');
    return `
      <div class="mcard">
        <div class="mhead">
          <span class="asset">${asset.toUpperCase()}</span>
          <span class="timer">${mmss(m.seconds_left)} left &middot; ${m.slug}</span>
        </div>
        ${rows || '<div class="empty">waiting for order book&hellip;</div>'}
      </div>`;
  }).join('') || '<div class="empty">discovering current window&hellip;</div>';

  const engines = d.engines || {};
  document.getElementById('engines').innerHTML = Object.entries(engines).map(([label, e]) => {
    const cls = engineClass[label] || 'e1';
    const isHolding = e.state === 'HOLDING';
    const chipClass = isHolding ? 'holding' : (e.state.startsWith('ARMED') ? 'armed' : 'settled');
    const pnl = e.unrealized_pnl ?? e.settled_raw_pnl;
    const tp = e.take_profit, sl = e.stop_loss;
    const livePct = e.live_price != null ? clamp((e.live_price - sl) / (tp - sl) * 100, 0, 100) : 50;
    return `
      <div class="ecard ${cls}">
        <div class="ehead">
          <span class="ename">${label.replace(/_/g,' ')}</span>
          <span class="chip ${chipClass}">${e.state}</span>
        </div>
        <div class="erow"><span>Balance</span><b>$${fmt(e.balance,2)}</b></div>
        <div class="erow"><span>Entry price</span><b>${fmt(e.entry_price)}</b></div>
        <div class="erow"><span>Live price</span><b>${fmt(e.live_price)}</b></div>
        <div class="tpslbar">
          <div class="tpslfill" style="left:0;width:100%;"></div>
          <div class="tpslmarker" style="left:${livePct}%;"></div>
        </div>
        <div class="erow" style="font-size:10px;"><span>SL ${sl}</span><span>TP ${tp}</span></div>
        <div class="erow"><span>${isHolding ? 'Unrealized' : 'Raw P&amp;L (pre-pool)'}</span>
          <b class="${(pnl||0)>=0?'pnl-pos':'pnl-neg'}">${pnl!=null ? ((pnl>=0?'+':'')+'$'+fmt(pnl,3)) : '&mdash;'}</b></div>
      </div>`;
  }).join('') || '<div class="empty">starting up&hellip;</div>';

  document.getElementById('pending').innerHTML = (d.pending_cohorts||[]).map(c => `
    <div class="pos" style="border-left-color:var(--amber);">
      <b>Window ${c.window_start}</b> &middot; fired: ${c.engines_fired.join(', ') || 'none yet'}
      &middot; settled: ${c.engines_settled.join(', ') || 'none yet'} / 4
    </div>`).join('') || '<div class="empty">No windows waiting on pool settlement.</div>';

  document.querySelector('#cohorts tbody').innerHTML = (d.recent_cohorts||[]).map(c => `
    <tr><td>${c.window_start}</td>
    <td>${Object.entries(c.per_engine_raw_pnl).map(([k,v])=>`${k.split('_')[0]}: ${v>=0?'+':''}$${v.toFixed(2)}`).join('&nbsp;&nbsp;')}</td>
    <td>${Object.entries(c.per_engine_balance_delta).map(([k,v])=>`${k.split('_')[0]}: ${v>=0?'+':''}$${v.toFixed(2)}`).join('&nbsp;&nbsp;')}</td></tr>
  `).join('') || '<tr><td colspan="3" class="empty">No redistributions yet.</td></tr>';

  document.querySelector('#recent tbody').innerHTML = (d.recent_trades||[]).map(t => `
    <tr><td>${t.engine_label.replace(/_/g,' ')}</td><td>${t.status}</td>
    <td class="${(t.raw_pnl||0)>=0?'pnl-pos':'pnl-neg'}">${(t.raw_pnl||0)>=0?'+':''}$${fmt(t.raw_pnl,3)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty">No trades yet.</td></tr>';

  document.getElementById('footer').innerText = `tick #${d.tick} &middot; updated ${new Date().toLocaleTimeString()}`;
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return DASHBOARD_HTML
