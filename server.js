'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'pressure-dashboard.html'));
function startServer(bot, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/api/healthz') {
      const state = bot.snapshot();
      const healthy = state.status !== 'blocked_or_error' && state.status !== 'ERROR';
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: healthy, mode: 'DEMO', status: state.status, now: state.now }));
      return;
    }
    if (pathname === '/api/state' || pathname === '/api/strategy/state') {
      const body = JSON.stringify(bot.snapshot());
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (pathname === '/api/closed-pair-logs' && typeof bot.closedPairLogPage === 'function') {
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 ||
          !Number.isInteger(offset) || offset < 0) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'limit must be 1–50 and offset must be a non-negative integer.' }));
        return;
      }
      const body = JSON.stringify(bot.closedPairLogPage(limit, offset));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, () => {
    console.log(`[dashboard] listening on :${port}`);
  });
  return server;
}

module.exports = startServer;
