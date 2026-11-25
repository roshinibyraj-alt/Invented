'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(require('node:path').join(__dirname,'../public/pressure-dashboard.html'),'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
async function render(state) {
  const elements = new Map();
  const element = () => ({textContent:'',innerHTML:'',className:'',style:{},dataset:{},
    addEventListener(){},setAttribute(){},classList:{add(){},remove(){}},querySelectorAll(){return [];}});
  const context = {document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    addEventListener(){},visibilityState:'visible'},fetch:async()=>({ok:true,json:async()=>state}),
    setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},AbortController,Date,Intl,console,
    navigator:{onLine:true},window:{addEventListener(){}}};
  vm.runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  return elements;
}
test('dashboard renders current holdings, completed TP and resolved history separately',async()=>{
  const p={asset:'BTC',side:'UP',windowStart:1800000000000,windowEnd:1800000300000,shares:50,entryPrice:.4,originalShares:100,unrealizedPnl:2,realizedPnl:20,exitPrice:.9};
  const e=await render({now:1800000001000,status:'RUNNING',account:{cash:3000,equity:3020,initialCapital:3000},
    markets:[{asset:'BTC',timeframe:'5m',start:p.windowStart,end:p.windowEnd,sideStates:{UP:{bestBid:.44,bestAsk:.45,mid:.445,fresh:true}},ladders:{UP:[{limitPrice:.4,tpPrice:.9,filledShares:100,soldShares:50,remainingShares:50,requestedShares:100,status:'OPEN'}]}}],
    positions:[{...p,status:'OPEN'},{...p,id:'closed',status:'TAKE_PROFIT'},{...p,id:'resolved',status:'RESOLVED_WIN'},{...p,id:'pending',status:'PENDING_RESOLUTION'}],
    events:[{type:'FIRST',message:'<script>bad</script>'},{type:'SECOND',message:'next'}]});
  assert.match(e.get('markets').innerHTML,/Holding <b>50/);
  assert.equal(e.get('pendCount').textContent,1);
  assert.equal(e.get('closedCount').textContent,2);
  assert.match(e.get('closed').innerHTML,/0\.90/);
  assert.doesNotMatch(e.get('events').innerHTML,/<script>bad/);
  assert.match(e.get('events').innerHTML,/&lt;script&gt;/);
  assert.ok(e.get('events').innerHTML.indexOf('FIRST')<e.get('events').innerHTML.indexOf('SECOND'));
});
