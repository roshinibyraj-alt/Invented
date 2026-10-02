'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

function startServer(bot, port) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
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
