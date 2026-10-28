'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'wick.html'));
const LIVE_BALANCE_URL = 'https://polymarket-btc-5m-bot-production.up.railway.app/api/live-balance';

function startServer(bot, port, fetcher=globalThis.fetch) {
  let liveBalanceCache=null,liveBalanceAt=0,liveBalanceRequest=null;
  async function getLiveBalance(){
    if(liveBalanceCache&&Date.now()-liveBalanceAt<10000)return liveBalanceCache;
    if(!liveBalanceRequest){
      liveBalanceRequest=fetcher(LIVE_BALANCE_URL,{signal:AbortSignal.timeout(8000)})
        .then(async response=>{
          if(!response.ok)throw new Error(`Live account service returned ${response.status}`);
          const value=await response.json();
          liveBalanceCache=value;liveBalanceAt=Date.now();return value;
        }).finally(()=>{liveBalanceRequest=null});
    }
    return liveBalanceRequest;
  }
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
    if(pathname==='/api/real-balance'){
      getLiveBalance().then(body=>{
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(body));
      }).catch(()=>{
        res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify({status:'unavailable',collateral:null,positionValue:null,equity:null,asOf:null}));
      });
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
