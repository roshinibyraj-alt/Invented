'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const sportsBot  = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;
const DRY_RUN = (process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

// ── Sports ladder API (cricket + tennis + crypto Up/Down, multi-match) ──
app.get('/api/sports/status', (_, res) => {
  try { res.json(sportsBot.getStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/sports/lookup', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !String(url).trim()) return res.status(400).json({ ok: false, error: 'Missing "url" field' });
  try { res.json(await sportsBot.lookupMatchByUrl(url)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/sports/add', (req, res) => {
  const { sport, label, tokenId, conditionId, eventSlug, outcomeLabel, capital, rearmSeconds } = req.body || {};
  try { res.json(sportsBot.addMatch({ sport, label, tokenId, conditionId, eventSlug, outcomeLabel, capital, rearmSeconds })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/sports/:id/remove', (req, res) => {
  try { res.json(sportsBot.removeMatch(req.params.id)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/sports/:id/pause', (req, res) => {
  try { res.json(sportsBot.pauseMatch(req.params.id)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/sports/:id/resume', (req, res) => {
  try { res.json(sportsBot.resumeMatch(req.params.id)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/sports/pause-all', (_, res) => {
  try { res.json(sportsBot.pauseAll()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/sports/resume-all', (_, res) => {
  try { res.json(sportsBot.resumeAll()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/sports/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(sportsBot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🏟️ Sports Ladder Bot — Cricket &amp; Tennis</title>
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
  .toolbar button.remove { background: var(--red); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .toolbar-status { padding: 6px 20px 0; font-size: 10px; color: var(--muted); min-height: 14px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 10px 0; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 17px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .add-match-form { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin: 0 20px 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; align-items: end; }
  .add-match-form .field { display: flex; flex-direction: column; gap: 4px; }
  .add-match-form label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
  .add-match-form input, .add-match-form select { font-family: inherit; font-size: 11px; padding: 7px 8px; border-radius: 6px; border: 1px solid var(--border); background: #fff; color: var(--text); font-weight: bold; }
  .add-match-form .hint { grid-column: 1 / -1; font-size: 9px; color: var(--muted); font-weight: normal; }
  .add-match-form button { grid-column: 1 / -1; background: var(--green); color: #fff; border: none; padding: 10px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; }
  .add-match-status { grid-column: 1 / -1; font-size: 10px; }
  .add-match-status.err { color: var(--red); }
  .add-match-status.ok { color: var(--green); }
  .matches-wrap { display: flex; flex-direction: column; gap: 14px; padding: 0 20px 16px; }
  .match-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .match-card.has-pos { border-color: var(--cyan); box-shadow: 0 0 0 1px #00d4ff22; }
  .match-card.resolved { opacity: .6; }
  .match-hdr { background: #0d1d30; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .match-title { font-size: 13px; font-weight: bold; color: #ddd; }
  .match-tag { font-size: 9px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; text-transform: uppercase; }
  .tag-cricket { background: #00996922; color: #4ade80; border: 1px solid #4ade8055; }
  .tag-tennis { background: #f59e0b22; color: #fbbf24; border: 1px solid #fbbf2455; }
  .tag-crypto { background: #8b5cf622; color: #c4b5fd; border: 1px solid #c4b5fd55; }
  .match-price { font-size: 10px; color: var(--cyan); }
  .match-status-strip { padding: 8px 14px 0; font-size: 10px; color: var(--muted); }
  .match-body { padding: 10px 14px; }
  .level-row { display: grid; grid-template-columns: 44px 1fr 90px 28px; align-items: center; gap: 6px; padding: 3px 2px; font-size: 9.5px; border-bottom: 1px solid #ffffff00; }
  .level-row.empty { opacity: .55; }
  .level-row.watching { color: var(--yellow); }
  .level-row.filled { color: var(--text); background: #00990911; border-radius: 4px; }
  .level-row.tp-pending { color: var(--green); background: #00a85411; border-radius: 4px; }
  .level-price { font-family: ui-monospace, monospace; }
  .level-state { color: var(--muted); }
  .level-tp { text-align: right; font-family: ui-monospace, monospace; }
  .level-re { text-align: right; color: var(--purple); }
  .match-toolbar { display: flex; gap: 6px; padding: 8px 14px 12px; flex-wrap: wrap; }
  .match-toolbar button { font-size: 10px; padding: 6px 10px; }
  .match-log { background: #0d1420; border-top: 1px solid var(--border); padding: 8px 12px; max-height: 110px; overflow-y: auto; font-size: 9.5px; }
  .match-log div { padding: 1px 0; }
  .bottom-grid { display: grid; grid-template-columns: 1fr; gap: 16px; padding: 0 20px 20px; }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 10px; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🏟️ SPORTS <span>LADDER</span> BOT — Cricket &amp; Tennis</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>
  <div class="toolbar">
    <button id="pause-all-btn" class="pause">⏸️ Pause All</button>
    <button id="resume-all-btn" class="resume">▶️ Resume All</button>
    <button id="live-btn" class="live-toggle">🔴 Go LIVE</button>
  </div>
  <div class="toolbar-status" id="toolbar-status"></div>

  <div class="section">
    <div class="section-hdr">Add by Match URL</div>
    <div class="add-match-form" id="lookup-form" style="grid-template-columns: 1fr 130px 140px;">
      <div class="field">
        <label>Polymarket match URL</label>
        <input id="f-url" placeholder="https://polymarket.com/sports/atp/atp-baez-kecmano-2026-07-20">
      </div>
      <div class="field">
        <label>Self-healing (sec)</label>
        <input id="f-rearm-lookup" type="number" min="2" max="300" step="1" value="120" title="How often an idle/unfilled rung re-anchors to the live price. Range: 2 sec - 300 sec (5 min).">
      </div>
      <button id="lookup-btn" type="button" style="grid-column:auto;">🔎 Look Up</button>
      <div class="hint">Paste any cricket, tennis, or crypto Up/Down (BTC/ETH/SOL/XRP 5m/15m) match page URL. This finds the event, the primary market, and shows live ask/bid for both sides — pick one to add it (uses its exact Token ID + Condition ID, the most reliable path).</div>
      <div class="hint" style="color:#c4b5fd;">Note on crypto Up/Down markets: each window (e.g. btc-updown-15m-...) resolves in minutes and is a one-shot slug — the bot trades it like any match until it resolves, but does <b>not</b> currently auto-roll into the next window on its own.</div>
      <div class="add-match-status" id="lookup-status"></div>
      <div id="lookup-results" style="grid-column:1/-1;"></div>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr">Add Manually (Token ID / Event Slug)</div>
    <form class="add-match-form" id="add-match-form">
      <div class="field">
        <label>Sport</label>
        <select id="f-sport"><option value="cricket">Cricket</option><option value="tennis">Tennis</option><option value="crypto">Crypto (Up/Down)</option></select>
      </div>
      <div class="field">
        <label>Label (optional)</label>
        <input id="f-label" placeholder="e.g. Djokovic vs Alcaraz">
      </div>
      <div class="field">
        <label>Token ID (recommended)</label>
        <input id="f-token" placeholder="CLOB token ID to trade">
      </div>
      <div class="field">
        <label>Condition ID (for auto-resolution)</label>
        <input id="f-condition" placeholder="optional but recommended">
      </div>
      <div class="field">
        <label>OR Event Slug</label>
        <input id="f-slug" placeholder="if no Token ID">
      </div>
      <div class="field">
        <label>Outcome to back</label>
        <input id="f-outcome" placeholder="e.g. Nepal, Djokovic (needed with slug)">
      </div>
      <div class="field">
        <label>Starting Capital ($)</label>
        <input id="f-capital" type="number" placeholder="200">
      </div>
      <div class="field">
        <label>Self-healing (sec)</label>
        <input id="f-rearm" type="number" min="2" max="300" step="1" value="120" title="How often an idle/unfilled rung re-anchors to the live price. Range: 2 sec - 300 sec (5 min).">
      </div>
      <div class="hint">Provide a <b>Token ID</b> directly (most reliable), ideally with its <b>Condition ID</b> so the bot can detect when the match resolves. Or provide an <b>Event Slug</b> + the <b>Outcome</b> you want to back and the bot will find the matching market/token itself — double-check the log line after adding before trusting it with real money. Every match added here runs the exact same trailing-grid ladder strategy (2 rungs, $0.05 apart, TP = entry + $0.10, trailing re-entry, and a self-healing rearm to the live price on the interval you set above, 2 sec - 5 min).</div>
      <div class="add-match-status" id="add-match-status"></div>
      <button type="submit">➕ Add Match</button>
    </form>
  </div>

  <div class="section">
    <div class="section-hdr">Active Matches</div>
    <div class="matches-wrap" id="matches-wrap"><div class="empty">Loading…</div></div>
  </div>

  <div class="bottom-grid">
    <div class="section">
      <div class="section-hdr">All Trades (every match)</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Match</th><th>Sport</th><th>Rung</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const $ = id => document.getElementById(id);

  $('pause-all-btn').onclick = () => fetch('/api/sports/pause-all', { method: 'POST' }).then(() => flash('All matches paused'));
  $('resume-all-btn').onclick = () => fetch('/api/sports/resume-all', { method: 'POST' }).then(() => flash('All matches resumed'));
  $('live-btn').onclick = () => {
    const wantLive = !$('live-btn').classList.contains('is-live');
    if (wantLive && !confirm('Switch to LIVE mode? This will place REAL resting limit orders with REAL money for every match.')) return;
    fetch('/api/sports/set-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: wantLive }) })
      .then(() => flash(wantLive ? 'Switched to LIVE' : 'Switched to DEMO'));
  };
  function flash(msg) { $('toolbar-status').textContent = msg; setTimeout(() => { $('toolbar-status').textContent = ''; }, 3000); }

  $('add-match-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = {
      sport: $('f-sport').value,
      label: $('f-label').value || undefined,
      tokenId: $('f-token').value || undefined,
      conditionId: $('f-condition').value || undefined,
      eventSlug: $('f-slug').value || undefined,
      outcomeLabel: $('f-outcome').value || undefined,
      capital: $('f-capital').value ? Number($('f-capital').value) : undefined,
      rearmSeconds: $('f-rearm').value ? Math.min(300, Math.max(2, Number($('f-rearm').value))) : undefined,
    };
    const statusEl = $('add-match-status');
    statusEl.textContent = 'Adding…'; statusEl.className = 'add-match-status';
    fetch('/api/sports/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json())
      .then(res => {
        if (res.ok) {
          statusEl.textContent = '✅ Match added (id: ' + res.id + ')';
          statusEl.className = 'add-match-status ok';
          $('add-match-form').reset();
          $('f-sport').value = body.sport;
        } else {
          statusEl.textContent = '❌ ' + res.error;
          statusEl.className = 'add-match-status err';
        }
      })
      .catch(e => { statusEl.textContent = '❌ ' + e.message; statusEl.className = 'add-match-status err'; });
  });

  function fmtPx(n) { return n == null ? '—' : n.toFixed(3); }

  function renderLookupResult(r) {
    if (!r.ok) return '<div class="add-match-status err">❌ ' + r.error + '</div>';
    const rows = r.outcomes.map(o => {
      const payload = {
        sport: r.sport,
        label: r.eventTitle + ' — ' + o.outcome,
        tokenId: o.tokenId,
        conditionId: r.conditionId || undefined,
      };
      return '<div class="level-row" style="grid-template-columns: 1fr 80px 80px 90px;">' +
        '<div class="level-price">' + o.outcome + '</div>' +
        '<div class="level-state">ask ' + fmtPx(o.ask) + '</div>' +
        '<div class="level-state">bid ' + fmtPx(o.bid) + '</div>' +
        '<div><button type="button" onclick=\\'addFromLookup(' + JSON.stringify(payload).replace(/'/g, "&#39;") + ')\\'>➕ Add this side</button></div>' +
      '</div>';
    }).join('');
    return '<div class="add-match-status ok">✅ Found: ' + r.eventTitle + ' | ' + r.marketQuestion + ' (' + r.sport + ')</div>' + rows;
  }

  function addFromLookup(payload) {
    const statusEl = $('lookup-status');
    const rearmVal = $('f-rearm-lookup').value ? Math.min(300, Math.max(2, Number($('f-rearm-lookup').value))) : undefined;
    const fullPayload = { ...payload, rearmSeconds: rearmVal };
    statusEl.textContent = 'Adding…'; statusEl.className = 'add-match-status';
    fetch('/api/sports/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fullPayload) })
      .then(r => r.json())
      .then(res => {
        statusEl.textContent = res.ok ? ('✅ Match added (id: ' + res.id + ')') : ('❌ ' + res.error);
        statusEl.className = 'add-match-status ' + (res.ok ? 'ok' : 'err');
      })
      .catch(e => { statusEl.textContent = '❌ ' + e.message; statusEl.className = 'add-match-status err'; });
  }

  $('lookup-btn').onclick = () => {
    const url = $('f-url').value.trim();
    const statusEl = $('lookup-status');
    const resultsEl = $('lookup-results');
    resultsEl.innerHTML = '';
    if (!url) { statusEl.textContent = '❌ Paste a match URL first'; statusEl.className = 'add-match-status err'; return; }
    statusEl.textContent = 'Looking up…'; statusEl.className = 'add-match-status';
    fetch('/api/sports/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
      .then(r => r.json())
      .then(res => {
        statusEl.textContent = '';
        resultsEl.innerHTML = renderLookupResult(res);
      })
      .catch(e => { statusEl.textContent = '❌ ' + e.message; statusEl.className = 'add-match-status err'; });
  };

  function matchAction(id, action) {
    fetch('/api/sports/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
  }
  function removeMatch(id) {
    if (!confirm('Remove this match from the dashboard? Any already-resting orders are left as-is.')) return;
    matchAction(id, 'remove');
  }

  function sgn(n) { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2); }
  function pClass(n) { return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }

  const STATUS_TXT = {
    discovering: 'Finding the market…',
    'awaiting-price': 'Market found, waiting for a live price to anchor the grid…',
    trading: 'Trading',
    resolved: 'Match resolved',
    error: 'Could not lock onto the market — check the log below',
  };

  function renderMatchCard(m) {
    const st = m.market.status;
    const hasPos = m.rungs.some(r => r.position && !r.position.closed);
    const cardCls = 'match-card' + (hasPos ? ' has-pos' : '') + (st === 'resolved' ? ' resolved' : '');
    const tagCls = m.sport === 'cricket' ? 'tag-cricket' : (m.sport === 'tennis' ? 'tag-tennis' : 'tag-crypto');
    const statusTxt = (STATUS_TXT[st] || st) + (st === 'resolved' ? (' — ' + (m.market.resolvedWinner || 'unknown')) : '') +
      (m.market.marketQuestion ? (' | ' + m.market.marketQuestion) : '');

    const rows = m.rungs.map(r => {
      let rowCls = 'empty', stateTxt = 'idle';
      if (r.position && !r.position.closed) {
        rowCls = r.position.tpPending ? 'tp-pending' : 'filled';
        stateTxt = 'holding ' + r.position.shares.toFixed(2) + 'sh @ ' + r.position.entryPrice.toFixed(2);
      } else if (r.maxedOut) {
        stateTxt = 'maxed out for now';
      } else if (r.entryPending) {
        rowCls = 'watching';
        stateTxt = 'watching for trigger';
      }
      const tpTxt = r.position ? ('TP ' + r.position.tpPrice.toFixed(2)) : (r.nextEntryPrice != null ? 'next entry ' + r.nextEntryPrice.toFixed(2) : '—');
      return '<div class="level-row ' + rowCls + '">' +
        '<div class="level-price">' + r.id + '</div>' +
        '<div class="level-state">' + stateTxt + '</div>' +
        '<div class="level-tp">' + tpTxt + '</div>' +
        '<div class="level-re">' + (r.fills > 0 ? 'x' + r.fills : '') + '</div>' +
      '</div>';
    }).join('');

    const stats = [
      ['Bankroll', '$' + m.bankroll.toFixed(2), ''],
      ['Mark Value', '$' + m.markValue.toFixed(2), pClass(m.totalPnl)],
      ['Total P&amp;L', sgn(m.totalPnl), pClass(m.totalPnl)],
      ['Wins / Losses', m.wins + ' / ' + m.losses, ''],
      ['Rebates', '$' + m.rebatesEarned.toFixed(4), 'pnl-pos'],
      ['Self-heal', Math.round((m.rearmIntervalMs || 0) / 1000) + 's', ''],
    ];
    const statsHtml = stats.map(([label, val, cls]) =>
      '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-val ' + cls + '">' + val + '</div></div>'
    ).join('');

    const logHtml = (m.logs || []).slice(-8).map(l => {
      const col = l.includes('❌')||l.includes('💥')||l.includes('🛑') ? '#ff4757'
                : l.includes('💰')||l.includes('✅')||l.includes('🎯') ? '#00e676'
                : l.includes('🔁') ? '#00d4ff'
                : l.includes('⚠️') ? '#ff9f0a'
                : '#4a6080';
      return '<div style="color:'+col+'">'+l+'</div>';
    }).join('');

    return '<div class="' + cardCls + '" data-id="' + m.id + '">' +
      '<div class="match-hdr">' +
        '<div><span class="match-title">' + m.label + '</span><span class="match-tag ' + tagCls + '">' + m.sport + '</span></div>' +
        '<div class="match-price">ask ' + (m.market.ask != null ? m.market.ask.toFixed(2) : '—') + ' / bid ' + (m.market.bid != null ? m.market.bid.toFixed(2) : '—') + '</div>' +
      '</div>' +
      '<div class="match-status-strip">' + statusTxt + '</div>' +
      '<div class="match-body">' +
        '<div class="stats-row">' + statsHtml + '</div>' +
        rows +
      '</div>' +
      '<div class="match-toolbar">' +
        '<button class="pause" onclick="matchAction(\\'' + m.id + '\\',\\'pause\\')">⏸️ Pause</button>' +
        '<button class="resume" onclick="matchAction(\\'' + m.id + '\\',\\'resume\\')">▶️ Resume</button>' +
        '<button class="remove" onclick="removeMatch(\\'' + m.id + '\\')">🗑️ Remove</button>' +
      '</div>' +
      '<div class="match-log">' + (logHtml || '<div style="color:#4a6080">No log lines yet…</div>') + '</div>' +
    '</div>';
  }

  socket.on('sportsState', (s) => {
    $('mode-badge').textContent = s.dryRun ? 'DEMO' : 'LIVE';
    $('mode-badge').className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    $('live-btn').classList.toggle('is-live', !s.dryRun);
    $('live-btn').textContent = s.dryRun ? '🔴 Go LIVE' : '🟡 Back to DEMO';

    const wrap = $('matches-wrap');
    if (!s.matches || !s.matches.length) {
      wrap.innerHTML = '<div class="empty">No matches yet — add one above.</div>';
    } else {
      wrap.innerHTML = s.matches.map(renderMatchCard).join('');
    }

    const tb = $('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? pClass(t.profit) : '';
        const sideColor = t.reason === 'ENTRY' ? '#ffd740' : (t.reason === 'RESOLUTION' ? '#00d4ff' : '#00e676');
        return '<tr><td>' + t.time + '</td><td style="color:' + sideColor + '">' + (t.match || '—') + '</td>' +
          '<td>' + (t.sport || '—') + '</td>' +
          '<td>' + (t.rung || '—') + '</td>' +
          '<td>' + (t.reason || '—') + '</td>' +
          '<td>' + (t.price || 0).toFixed(3) + '</td>' +
          '<td>' + (t.shares || 0).toFixed(2) + '</td>' +
          '<td class="' + pnlCls + '">' + pnlStr + '</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="8" class="empty">No trades yet</td></tr>';
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

console.log('🏟️  Sports Ladder Bot — Cricket & Tennis (resting limit orders + maker rebates, multi-match)');
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo capital per match, simulated fills, real API for data/orders');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  sportsBot.init(PK, emit, slog).catch(e => {
    console.error('❌ Sports bot init failed:', e.message);
    process.exit(1);
  });
});
