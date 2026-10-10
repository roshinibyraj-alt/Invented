'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'arb.html'));

function startServer(bot, port) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/healthz') {
      const state = bot.snapshot();
      const healthy = state.status !== 'blocked_or_error';
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: healthy, mode: 'DEMO', status: state.status, now: state.now }));
      return;
    }
    if (pathname === '/api/state') {
      const body = JSON.stringify(bot.snapshot());
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
