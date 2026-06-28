'use strict';

const _proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (_proxyUrl) {
  try {
    const { ProxyAgent, fetch: _uFetch } = require('undici');
    const _agent = new ProxyAgent({ uri: _proxyUrl, requestTls: { rejectUnauthorized: false } });
    globalThis.fetch = (url, opts = {}) => _uFetch(url, { ...opts, dispatcher: _agent });
    console.log('🌐 Proxy active:', _proxyUrl.replace(/:[^:@]*@/, ':***@'));
  } catch(e) {
    console.log('⚠️ Proxy setup error:', e.message);
  }
}

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const accumBot = require('./polymarket-bot');
const crashBot = require('./crash-bot');

process.on('unhandledRejection', (err) => console.error('❌', err?.message));
process.on('uncaughtException',  (err) => console.error('❌', err?.message));

const PORT = process.env.PORT || 3000;
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname)));

app.options('/api/set-dry-run', (_req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(204);
});

app.get('/api/snapshot', (_req, res) => {
  try {
    res.json({
      accum: accumBot.snapshot(),
      crash: crashBot.snapshot(),
    });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/set-dry-run', express.json(), async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  try {
    await accumBot.setDryRun(req.body?.dryRun);
    await crashBot.setDryRun(req.body?.dryRun);
    res.json({ ok: true, dryRun: accumBot.getDryRun() });
  } catch(e) {
    res.json({ error: e.message });
  }
});

let lastEmit = 0;
function broadcast(snapshot) {
  const now = Date.now();
  if (now - lastEmit < 500) return;
  lastEmit = now;
  io.emit('snapshot', snapshot);
}

io.on('connection', (socket) => {
  console.log(`🔌 Client ${socket.id}`);
  try {
    socket.emit('snapshot', {
      accum: accumBot.snapshot(),
      crash: crashBot.snapshot(),
    });
  } catch (_) {}
  socket.on('disconnect', () => console.log(`🔌 Left ${socket.id}`));
});

async function main() {
  await Promise.all([
    accumBot.start(
      (event, data) => { if (event === 'snapshot') broadcast({ accum: data, crash: crashBot.snapshot() }); },
      (msg) => console.log(msg),
    ),
    crashBot.start(
      (event, data) => { if (event === 'snapshot') broadcast({ accum: accumBot.snapshot(), crash: data }); },
      (msg) => console.log(msg),
    ),
  ]);
  server.listen(PORT, () => console.log(`🌐 Bot server running on http://0.0.0.0:${PORT}`));
}

main();
