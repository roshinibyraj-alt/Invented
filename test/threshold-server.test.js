'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {once}=require('node:events'),fs=require('node:fs'),vm=require('node:vm');
const {CalibratedBot}=require('../calibrated-bot'),startServer=require('../server');
test('HTTP serves matching 5m strategy, reset account, no model or 15m',async()=>{
  const bot=new CalibratedBot(),server=startServer(bot,0);await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const html=await (await fetch(base)).text();assert.match(html,/94¢ entry/);
    const s=await (await fetch(base+'/api/state')).json();assert.equal(s.accounts['5m'].cash,1500);
    assert.equal(s.accounts['15m'],undefined);assert.equal(s.model,undefined);
    assert.equal((await (await fetch(base+'/api/healthz')).json()).ok,true);
    assert.equal((await fetch(base+'/missing')).status,404);
  } finally {await new Promise(r=>server.close(r));}
});
test('dashboard renders quotes, stop, sizing, chart and closed trades without model UI',()=>{
  const html=fs.readFileSync(__dirname+'/../public/freqai-dashboard.html','utf8');
  const nodes=new Map(),element=()=>({textContent:'',innerHTML:'',className:'',classList:{add(){},remove(){}},
    querySelectorAll(){return[];},style:{},dataset:{}});
  const context={URL,Date,Number,Math,console,AbortSignal,setInterval(){},fetch:()=>new Promise(()=>{}),
    document:{baseURI:'https://example.test/',getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},querySelectorAll(){return[];}}};
  vm.createContext(context);vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  context.fixture=new CalibratedBot().snapshot();vm.runInContext('state=fixture;render()',context);
  const grid=nodes.get('grid').innerHTML;
  assert.match(grid,/BTC 5m/);assert.doesNotMatch(grid,/BTC 15m|Calibrated probability|No current prediction/);
  assert.match(grid,/300/);assert.match(grid,/90¢/);assert.match(grid,/No closed trades yet/);
  assert.match(nodes.get('explainBody').innerHTML,/official winning settlement payout/);
  assert.doesNotMatch(html,/animation:rise|@keyframes rise/);
});
