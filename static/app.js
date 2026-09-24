function fmtSecs(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function fmtMoney(v) {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
function fmtPrice(v) {
  return v === null || v === undefined ? '—' : v.toFixed(3);
}
function timeAgo(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour12: false });
}

function pnlClass(v) { return v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : 'flat'); }
function pnlSign(v) { return v > 0.004 ? '+' : ''; }

function renderPositions(snap) {
  const wrap = document.getElementById('positionsWrap');
  const countEl = document.getElementById('posCount');
  const positions = snap.open_positions || [];
  countEl.textContent = positions.length ? `${positions.length} open` : '';

  if (!positions.length) {
    wrap.innerHTML = `<div class="positions-empty">No open positions right now — all rungs are either resting orders or flat.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="positions-grid">${positions.map(p => {
    const cls = pnlClass(p.unrealized_pnl);
    const sideCls = p.side === 'UP' ? 'side-up' : 'side-down';
    const shadowCls = p.is_shadow ? 'is-shadow' : '';
    const pnlLabel = p.is_shadow ? 'HYPOTHETICAL P&amp;L' : 'FLOATING P&amp;L';
    const shadowBadge = p.is_shadow ? `<span class="shadow-tag"><span class="dot"></span>SHADOW</span>` : '';
    return `
      <div class="position-card ${sideCls} ${shadowCls} pulse" data-key="${p.window_slug}-${p.rung_price}">
        <div class="prow">
          <span class="rung-tag mono">rung ${p.rung_price.toFixed(2)}</span>
          <span style="display:flex; gap:6px; align-items:center;">
            ${shadowBadge}
            <span class="side-tag ${p.side.toLowerCase()}">${p.side}</span>
          </span>
        </div>
        <div class="pnl-row">
          <span class="pnl-label">${pnlLabel}</span>
          <span class="pnl-value ${cls}">${pnlSign(p.unrealized_pnl)}${fmtMoney(p.unrealized_pnl)}</span>
        </div>
        <div class="sub-row">
          <span>${p.size} sh @ <b>${p.entry_price.toFixed(2)}</b></span>
          <span>mark <b>${fmtPrice(p.mark_price)}</b></span>
          <span>closes ${fmtSecs(p.window_remaining)}</span>
        </div>
      </div>`;
  }).join('')}</div>`;
}

function renderRungs(snap) {
  const board = document.getElementById('rungBoard');
  const win = snap.active_windows.find(w => w.slug === snap.current_window.slug) || snap.active_windows[0];

  board.innerHTML = snap.rungs.map(r => {
    const priceKey = r.price.toFixed(2);
    const rungData = win ? win.rungs[priceKey] : null;
    const position = rungData ? rungData.position : null;
    const isShadowWindow = rungData ? rungData.is_shadow : (r.mode === 'SHADOW');

    let statusHtml;
    let stateClass = isShadowWindow ? 'state-shadow' : '';
    if (position) {
      const sideCls = position.side.toLowerCase();
      stateClass = isShadowWindow ? 'state-shadow' : `state-position side-${sideCls}`;
      const shadowTag = isShadowWindow ? `<span class="shadow-tag"><span class="dot"></span>SHADOW</span>` : '';
      statusHtml = `
        <div class="status-position">
          ${shadowTag}
          <span class="side-badge ${sideCls}">${position.side}</span>
          <span class="entry">entry ${position.entry_price.toFixed(2)}</span>
          <span class="arrow">→</span>
          <span class="mark">mark ${fmtPrice(position.mark_price)}</span>
        </div>`;
    } else if (rungData) {
      const upChip = rungData.up.status === 'CANCELLED'
        ? `<span class="order-chip cancelled">UP cancelled</span>`
        : `<span class="order-chip resting up"><span class="dot"></span>UP resting @ ${priceKey}</span>`;
      const downChip = rungData.down.status === 'CANCELLED'
        ? `<span class="order-chip cancelled">DOWN cancelled</span>`
        : `<span class="order-chip resting down"><span class="dot"></span>DOWN resting @ ${priceKey}</span>`;
      const shadowTag = isShadowWindow ? `<span class="shadow-tag"><span class="dot"></span>SHADOW — observing, no capital at risk</span>` : '';
      statusHtml = `<div class="status-resting">${shadowTag}${upChip}${downChip}</div>`;
    } else {
      statusHtml = `<span class="status-idle">waiting for window to open…</span>`;
    }

    const floatingPnl = (position && !isShadowWindow) ? position.unrealized_pnl : null;
    const floatCls = floatingPnl === null ? 'flat' : pnlClass(floatingPnl);
    let floatText;
    if (isShadowWindow && position) {
      floatText = `<span style="color:var(--muted); font-weight:400;">hypothetical, not counted</span>`;
    } else if (floatingPnl === null) {
      floatText = `${fmtMoney(r.total_pnl)} <span style="color:var(--muted); font-weight:400;">realized</span>`;
    } else {
      floatText = `${pnlSign(floatingPnl)}${fmtMoney(floatingPnl)} <span style="color:var(--muted); font-weight:400;">floating</span>`;
    }

    const modeLine = r.mode === 'SHADOW'
      ? `shadow record <b>${r.shadow_wins}W / ${r.shadow_losses}L / ${r.shadow_no_fills}NF</b>`
      : `streak <b>${r.win_streak}</b> · ${r.win_rate}% (${r.total_trades})`;

    return `
      <div class="rung ${stateClass}">
        <div class="price-col">
          <div class="price">${priceKey}</div>
          <div class="streak">${modeLine}</div>
        </div>
        <div class="status-col">${statusHtml}</div>
        <div class="size-col">
          <span class="size-now">${r.size}<span style="font-size:11px;color:var(--muted)">&nbsp;sh</span></span>
          <span class="size-next">flat, every rung</span>
        </div>
        <div class="pnl-col">
          <div class="floating ${floatCls}">${floatText}</div>
          <div class="meta">bankroll <b>${fmtMoney(r.capital_balance)}</b> ($${r.capital_start} start)</div>
        </div>
      </div>`;
  }).join('');
}

function renderAgg(snap) {
  const a = snap.aggregate;
  const el = document.getElementById('aggStrip');
  const realClass = pnlClass(a.realized_pnl);
  const floatClass = pnlClass(a.floating_pnl);
  const combClass = pnlClass(a.combined_pnl);
  const roiClass = pnlClass(a.roi_pct);
  el.innerHTML = `
    <div class="cell"><div class="label">REALIZED P&amp;L</div><div class="value ${realClass}">${pnlSign(a.realized_pnl)}${fmtMoney(a.realized_pnl)}</div></div>
    <div class="cell"><div class="label">FLOATING P&amp;L</div><div class="value ${floatClass}">${pnlSign(a.floating_pnl)}${fmtMoney(a.floating_pnl)}</div></div>
    <div class="cell"><div class="label">COMBINED P&amp;L · ROI</div><div class="value ${combClass}">${pnlSign(a.combined_pnl)}${fmtMoney(a.combined_pnl)} <span style="font-size:13px">(${a.roi_pct > 0 ? '+' : ''}${a.roi_pct}%)</span></div></div>
    <div class="cell"><div class="label">TRADES / WIN RATE</div><div class="value">${a.total_trades} · ${a.win_rate}%</div></div>
  `;
}

function renderTicker(snap) {
  document.getElementById('tWindow').textContent = snap.current_window.slug.replace('btc-updown-5m-', '#');
  document.getElementById('tWindowRemaining').textContent = fmtSecs(snap.current_window.window_remaining);
  const cutoffEl = document.getElementById('tCutoff');
  cutoffEl.textContent = snap.current_window.past_cutoff ? 'CLOSED' : fmtSecs(snap.current_window.cutoff_remaining);
  cutoffEl.className = 'value ' + (snap.current_window.past_cutoff ? 'warn' : (snap.current_window.cutoff_remaining < 30 ? 'warn' : ''));

  const win = snap.active_windows.find(w => w.slug === snap.current_window.slug);
  document.getElementById('tUpPrice').textContent = win ? fmtPrice(win.last_up_price) : '—';
  document.getElementById('tDownPrice').textContent = win ? fmtPrice(win.last_down_price) : '—';
}

function renderLog(snap) {
  const body = document.getElementById('logBody');
  body.innerHTML = snap.recent_trades.map(t => `
    <tr>
      <td>${timeAgo(t.settled_at)}</td>
      <td>${t.window_slug.replace('btc-updown-5m-', '#')}</td>
      <td>${t.rung_price.toFixed(2)}</td>
      <td>${t.side_filled ? `<span class="${t.side_filled === 'UP' ? 'up' : 'down'}">${t.side_filled}</span>` : '—'}</td>
      <td>${t.size}</td>
      <td>${fmtMoney(t.cost)}</td>
      <td><span class="tag ${t.outcome}">${t.outcome}</span></td>
      <td class="${t.pnl > 0 ? 'up' : (t.pnl < 0 ? 'down' : '')}">${fmtMoney(t.pnl)}</td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="color:var(--muted)">No settlements yet.</td></tr>`;
}

function renderEvents(snap) {
  const body = document.getElementById('eventsBody');
  const rows = [...snap.events].reverse();
  body.innerHTML = rows.map(e => `
    <div class="event-row ${e.level === 'error' ? 'error' : ''}">
      <span class="t mono">${timeAgo(e.ts)}</span><span>${e.text}</span>
    </div>
  `).join('') || `<div class="event-row">No events yet.</div>`;
}

function render(snap) {
  document.getElementById('modePill').textContent = snap.mode;
  renderTicker(snap);
  renderPositions(snap);
  renderRungs(snap);
  renderAgg(snap);
  renderLog(snap);
  renderEvents(snap);
  document.getElementById('footUptime').textContent = `uptime ${fmtSecs(snap.uptime_seconds)}`;
}

function setConn(state) {
  const el = document.getElementById('connStatus');
  const txt = document.getElementById('connText');
  el.className = 'conn ' + state;
  txt.textContent = state === 'live' ? 'live' : (state === 'down' ? 'disconnected — retrying' : 'connecting…');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setConn('live');
  ws.onmessage = (ev) => render(JSON.parse(ev.data));
  ws.onclose = () => { setConn('down'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}
connect();
