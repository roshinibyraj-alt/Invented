'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CalibratedBot } = require('../calibrated-bot');
const startServer = require('../server');

test('new public dashboard and API expose separate paper accounts without legacy strategy', async () => {
  const bot = new CalibratedBot({ worker: { snapshot: () => ({status:'TRAINING',models:{}}) } });
  const server = startServer(bot,0);
  await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const htmlResponse = await fetch(base);
    const html = await htmlResponse.text();
    assert.match(html,/BTC Calibrated Edge/);
    assert.match(html,/Binance proxy|Binance BTCUSDT window labels/);
    assert.doesNotMatch(html,/one flip max|repeatedReversals|closed-anchor-oneflip/);
    assert.equal(htmlResponse.headers.get('cache-control'),'no-store');
    const state = await (await fetch(base+'/api/state')).json();
    assert.equal(state.mode,'PAPER');
    assert.equal(state.accounts['5m'].cash,1500);
    assert.equal(state.accounts['15m'].cash,1500);
    assert.equal(state.model.status,'TRAINING');
    const health = await (await fetch(base+'/api/healthz')).json();
    assert.equal(health.mode,'PAPER');
    assert.equal(health.modelStatus,'TRAINING');
    assert.equal((await fetch(base+'/not-a-route')).status,404);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('dashboard rendering handles training, missing marks, and model validation', () => {
  const html=fs.readFileSync(path.join(__dirname,'../public/freqai-dashboard.html'),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes=new Map();
  function element() {return { textContent:'',innerHTML:'',className:'',classList:{add(){},remove(){}},
    querySelectorAll(){return [];},style:{},dataset:{} };}
  const context={ URL,Date,Number,Math,console,AbortSignal,
    setInterval(){},fetch:()=>new Promise(()=>{}),
    document:{baseURI:'https://example.test/',getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},
      querySelectorAll(){return [];} } };
  vm.createContext(context);vm.runInContext(script,context);
  const bot=new CalibratedBot({worker:{snapshot:()=>({status:'TRAINING',models:{}})}});
  context.fixture=bot.snapshot();
  vm.runInContext('state=fixture;render()',context);
  assert.match(nodes.get('grid').innerHTML,/BTC 5m/);
  assert.match(nodes.get('grid').innerHTML,/BTC 15m/);
  assert.match(nodes.get('grid').innerHTML,/No resolved trades yet/);
  assert.match(nodes.get('explainBody').innerHTML,/Chainlink/);
  context.fixture.accounts['5m'].equity=null;
  context.fixture.accounts['5m'].valuationComplete=false;
  vm.runInContext('state=fixture;render()',context);
  assert.match(nodes.get('grid').innerHTML,/unknown/);
});
